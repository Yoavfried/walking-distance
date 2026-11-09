"""Export the exact result units used by the local demo for browser estimation."""

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server import ELECTION, ElectionIndex, REPO
from shapely.geometry import mapping


def main():
    index = ElectionIndex(REPO / "web/app/public/data/v2")
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
    snapshot = {"buildId": index.build_id, "election": ELECTION, "parties": parties, "units": units}
    with Path(sys.argv[1]).open("w", encoding="utf-8") as handle:
        json.dump(snapshot, handle, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
