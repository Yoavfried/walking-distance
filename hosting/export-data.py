"""Export the exact result units used by the local demo for browser estimation."""

import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server import ElectionIndex, REPO, read_json
from shapely.geometry import mapping


def export_snapshot(index, path):
    units = []
    for (row, kind), geometry in zip(index.units, index.geometries):
        coordinates = mapping(geometry)["coordinates"]
        units.append({
            "id": row["id"],
            "name": row["names"]["en"],
            "kind": kind,
            "area": geometry.area,
            "bounds": geometry.bounds,
            "polygons": [coordinates] if geometry.geom_type == "Polygon" else coordinates,
            "votes": {party: votes for party, votes in row["partyVotes"].items() if votes},
        })
    parties = [
        {"id": party["id"], "name": party["names"]["en"], "nameHe": party["names"]["he"], "color": party["color"]}
        for party in index.parties.values()
    ]
    snapshot = {"buildId": index.build_id, "election": index.election, "parties": parties, "units": units}
    with path.open("w", encoding="utf-8") as handle:
        json.dump(snapshot, handle, ensure_ascii=False, separators=(",", ":"))
    print(f"{path.name}: {len(units):,} result polygons")


def main():
    root = REPO / "web/app/public/data/v2"
    target = Path(sys.argv[1])
    catalog = read_json(root / "catalog.json")
    elections = []
    for row in catalog["elections"]:
        if not (row.get("resultUrls", {}).get("statistical-area")
                and row.get("geographiesByMode", {}).get("statistical-area", {}).get("geometryUrl")):
            continue
        election = row["id"]
        if not re.fullmatch(r"K[1-9][0-9]*", election):
            raise ValueError(f"Invalid election ID: {election}")
        index = ElectionIndex(root, election)
        if not index.units:
            raise ValueError(f"No result polygons for {election}")
        export_snapshot(index, target / f"{election.lower()}-results.json")
        elections.append({"id": election, "label": row["label"]})

    with (target / "elections.json").open("w", encoding="utf-8") as handle:
        json.dump(elections, handle, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
