"""Reference estimator and reader for the election map's generated data."""

import json
from math import floor, fsum
from os import environ
from pathlib import Path
from random import Random
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / ".deps"))

from pyproj import Transformer
from shapely import STRtree, constrained_delaunay_triangles, make_valid, transform, union_all
from shapely.geometry import Point, Polygon, mapping, shape

REPO = Path(environ.get("WALK_VOTE_REPO", Path.home() / "Desktop" / "Side Projects" / "israel-election-map"))
ELECTION = "K26"
TO_METERS = Transformer.from_crs(4326, 6933, always_xy=True).transform
TO_DEGREES = Transformer.from_crs(6933, 4326, always_xy=True).transform


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def polygon_parts(geometry):
    if geometry.is_empty:
        return
    if geometry.geom_type == "Polygon":
        yield geometry
    elif hasattr(geometry, "geoms"):
        for part in geometry.geoms:
            yield from polygon_parts(part)


def polygon_only(geometry):
    return union_all(list(polygon_parts(geometry if geometry.is_valid else make_valid(geometry))))


def apportion_votes(estimates, target=None):
    """Round the total once, then assign remaining votes by fractional remainder."""
    whole = {key: floor(value) for key, value in estimates.items()}
    if target is None:
        target = floor(fsum(estimates.values()) + 0.5)
    remaining = target - sum(whole.values())
    order = sorted(estimates, key=lambda key: (-(estimates[key] - whole[key]), key))
    for key in order[:remaining]:
        whole[key] += 1
    return whole


def measure_overlap(walk, area, filled=None):
    clipped = polygon_only(walk.intersection(area))
    fraction = min(1.0, clipped.area / area.area)
    if filled is not None and 0 < fraction < 1 and area.difference(filled).area <= area.area * 1e-9:
        fraction = 1.0
    return clipped, fraction


def sample_dots(geometry, count, seed):
    """Sample equal-area triangles so even narrow polygons and holes stay accurate."""
    rng = Random(seed)
    triangles = constrained_delaunay_triangles(geometry).geoms
    vertices = [list(triangle.exterior.coords)[:3] for triangle in triangles]
    selected = rng.choices(vertices, weights=[triangle.area for triangle in triangles], k=count)
    x, y = [], []
    for (ax, ay), (bx, by), (cx, cy) in selected:
        u, v = rng.random(), rng.random()
        if u + v > 1:
            u, v = 1 - u, 1 - v
        x.append(ax + u * (bx - ax) + v * (cx - ax))
        y.append(ay + u * (by - ay) + v * (cy - ay))
    lon, lat = TO_DEGREES(x, y)
    return [[round(a, 8), round(b, 8)] for a, b in zip(lon, lat)]


def vote_dots(rounded, contributions, areas, source_ids, parties):
    dots_by_party = {party: [] for party, votes in rounded.items() if votes}
    by_area = [{} for _ in areas]
    for party in dots_by_party:
        for i, votes in apportion_votes(contributions[party], rounded[party]).items():
            if votes:
                by_area[i][party] = votes
    for counts, area, seed in zip(by_area, areas, source_ids):
        if not counts:
            continue
        dots = sample_dots(area, sum(counts.values()), seed)
        start = 0
        for party, count in counts.items():
            dots_by_party[party].extend(dots[start:start + count])
            start += count
    return {"type": "FeatureCollection", "features": [
        {
            "type": "Feature",
            "properties": {"party": party, "color": parties[party]["color"]},
            "geometry": {"type": "MultiPoint", "coordinates": dots},
        }
        for party, dots in dots_by_party.items()
    ]}


class ElectionIndex:
    def __init__(self, root):
        catalog = read_json(root / "catalog.json")
        election = next(row for row in catalog["elections"] if row["id"] == ELECTION)
        self.build_id = catalog["buildId"]
        data = read_json(root / election["resultUrls"]["statistical-area"])
        self.parties = {row["id"]: row for row in data["parties"]}
        hidden = set(data["hiddenGeographyIds"])
        geo = read_json(root / election["geographiesByMode"]["statistical-area"]["geometryUrl"])
        features = {f["id"]: f for f in geo["features"] if f["id"] not in hidden}
        self.units = []
        self.geometries = []
        seen = set()
        for row in data["records"]:
            key = row["id"]
            if key in seen:
                raise ValueError(f"Duplicate result record: {key}")
            seen.add(key)
            direct = row["geographyType"] == "statistical-area"
            grouped = row["geographyType"] == "custom" and key.startswith("display:")
            fallback = row["geographyType"] == "municipality-fallback"
            if key not in features or not (direct or grouped or fallback):
                continue
            feature = features[key]
            if feature["properties"].get("displayMode") != "polygon":
                continue
            geometry = polygon_only(transform(shape(feature["geometry"]), TO_METERS, interleaved=False))
            if geometry.is_empty or not geometry.area:
                continue
            if fallback:
                kind = "fallback"
            elif grouped:
                kind = "representative" if row.get("notice") else "grouped"
            elif row.get("notice"):
                kind = "disclosed"
            else:
                kind = "individual"
            self.units.append((row, kind))
            self.geometries.append(geometry)
        self.tree = STRtree(self.geometries)

    def estimate(self, walk):
        parts = list(polygon_parts(walk))
        filled = union_all([Polygon(part.exterior) for part in parts]) if any(part.interiors for part in parts) else None
        raw = {key: 0.0 for key in self.parties}
        contributions = {key: {} for key in self.parties}
        included = []
        features = []
        areas = []
        for i in sorted(self.tree.query(walk, predicate="intersects")):
            row, kind = self.units[i]
            overlap, fraction = measure_overlap(walk, self.geometries[i], filled)
            if overlap.is_empty or not fraction:
                continue
            for party, votes in row["partyVotes"].items():
                if votes:
                    weight = votes * fraction
                    raw[party] += weight
                    contributions[party][len(areas)] = weight
            areas.append(overlap)
            item = {
                "id": row["id"], "name": row["names"]["en"], "kind": kind,
                "fraction": fraction, "estimatedVotes": row["totals"]["validVotes"] * fraction,
                "notice": (row.get("notice") or {}).get("en"),
            }
            included.append(item)
            features.append({
                "type": "Feature", "id": row["id"],
                "properties": item, "geometry": mapping(transform(overlap, TO_DEGREES, interleaved=False)),
            })
        rounded = apportion_votes(raw)
        total = sum(rounded.values())
        parties = [{
            "id": key, "name": self.parties[key]["names"]["en"],
            "nameHe": self.parties[key]["names"]["he"], "color": self.parties[key]["color"],
            "votes": rounded[key], "share": rounded[key] / total if total else 0,
        } for key in sorted(raw, key=lambda key: (-rounded[key], -raw[key], key))]
        covered = min(1.0, union_all(areas).area / walk.area) if areas else 0.0
        return {
            "votes": total, "areaKm2": walk.area / 1_000_000, "areaCoverage": covered,
            "parties": parties, "sources": sorted(included, key=lambda row: -row["estimatedVotes"]),
            "overlaps": {"type": "FeatureCollection", "features": features},
            "dots": vote_dots(rounded, contributions, areas, [item["id"] for item in included], self.parties),
            "walk": {"type": "Feature", "geometry": mapping(transform(walk, TO_DEGREES, interleaved=False)), "properties": {}},
            "buildId": self.build_id, "election": ELECTION,
        }
