import unittest

from server import ElectionIndex, REPO, TO_METERS, apportion_votes, measure_overlap, read_json, sample_dots
from shapely.geometry import MultiPolygon, Point, Polygon, box
from shapely import STRtree, transform


class EstimationTests(unittest.TestCase):
    def test_overlap_is_fraction_of_result_area_not_walk(self):
        _, fraction = measure_overlap(box(0, 0, 2, 10), box(0, 0, 20, 10))
        self.assertAlmostEqual(fraction, 0.1)

    def test_touching_boundary_does_not_contribute(self):
        _, fraction = measure_overlap(box(0, 0, 1, 1), box(1, 0, 2, 1))
        self.assertEqual(fraction, 0)

    def test_interior_hole_reduces_dot_area_but_not_enclosed_vote_count(self):
        outer = box(0, 0, 10, 10)
        hole = box(2, 2, 8, 8)
        walk = Polygon(outer.exterior, [hole.exterior])
        overlap, fraction = measure_overlap(walk, box(1, 3, 3, 5), outer)
        self.assertEqual(fraction, 1)
        self.assertEqual(overlap.area, 2)
        self.assertEqual(measure_overlap(walk, box(3, 3, 5, 5), outer)[1], 0)
        self.assertAlmostEqual(measure_overlap(walk, box(7, 3, 11, 5), outer)[1], 0.5)

    def test_rounding_preserves_rounded_total(self):
        self.assertEqual(apportion_votes({"A": 1.6, "B": 1.5, "C": 1.4}), {"A": 2, "B": 2, "C": 1})

    def test_dots_stay_inside_disconnected_polygons_and_avoid_holes(self):
        outer = box(0, 0, 100, 100)
        hole = box(10, 10, 90, 90)
        area = MultiPolygon([Polygon(outer.exterior, [hole.exterior]), box(200, 0, 201, 100)])
        coords = sample_dots(area, 1000, "example")
        self.assertEqual(len(coords), 1000)
        self.assertEqual(coords, sample_dots(area, 1000, "example"))
        points = [transform(Point(*coord), TO_METERS, interleaved=False) for coord in coords]
        self.assertTrue(all(area.covers(point) for point in points))
        self.assertTrue(any(point.x > 200 for point in points))

    def test_estimate_weights_group_and_locality_fallback_once(self):
        idx = ElectionIndex.__new__(ElectionIndex)
        idx.build_id = "test"
        idx.election = "K25"
        idx.parties = {
            key: {"names": {"en": key, "he": key}, "color": "#000000"}
            for key in ("A", "B")
        }
        idx.units = [
            ({"id": "group", "names": {"en": "Group"}, "partyVotes": {"A": 100, "B": 30}, "totals": {"validVotes": 130}}, "representative"),
            ({"id": "city", "names": {"en": "City"}, "partyVotes": {"A": 500}, "totals": {"validVotes": 500}}, "fallback"),
        ]
        idx.geometries = [box(0, 0, 20, 10), box(0, 10, 20, 20)]
        idx.tree = STRtree(idx.geometries)
        result = idx.estimate(box(0, 0, 2, 20))
        self.assertEqual(result["election"], "K25")
        self.assertEqual([row["votes"] for row in result["parties"]], [60, 3])
        self.assertEqual(result["votes"], 63)
        self.assertEqual(result["areaCoverage"], 1)
        self.assertEqual([area["kind"] for area in result["sources"]], ["fallback", "representative"])
        points = {
            feature["properties"]["party"]: [
                transform(Point(*coord), TO_METERS, interleaved=False)
                for coord in feature["geometry"]["coordinates"]
            ]
            for feature in result["dots"]["features"]
        }
        self.assertEqual({key: len(items) for key, items in points.items()}, {"A": 60, "B": 3})
        self.assertEqual(sum(point.y < 10 for point in points["A"]), 10)
        self.assertTrue(all(box(0, 0, 2, 10).covers(point) for point in points["B"]))

    def test_real_snapshot_indexes_visible_geographies(self):
        root = REPO / "web" / "app" / "public" / "data" / "v2"
        index = ElectionIndex(root)
        self.assertGreater(len(index.units), 2200)
        self.assertTrue(any(kind == "representative" for _, kind in index.units))
        localities = {row["id"]: row for row in read_json(root / "results/k26/localities.json")["records"]}
        fallbacks = {row["localityId"]: row for row, kind in index.units if kind == "fallback"}
        self.assertIn("loc:534", fallbacks)
        for locality_id, row in fallbacks.items():
            self.assertEqual(row["partyVotes"], localities[locality_id]["partyVotes"])
        for row, kind in index.units:
            if kind != "fallback":
                self.assertNotIn(row["localityId"], fallbacks)
                if row["id"].startswith("display:"):
                    self.assertNotIn(f"loc:{row['id'].split(':')[3]}", fallbacks)

    def test_current_k26_reviews_and_new_footprints_are_used(self):
        root = REPO / "web" / "app" / "public" / "data" / "v2"
        index = ElectionIndex(root)
        by_id = {row["id"]: (i, row, kind) for i, (row, kind) in enumerate(index.units)}
        self.assertEqual(index.build_id, read_json(root / "catalog.json")["buildId"])
        area, row, kind = by_id["display:reviewed-site-move:K26:5000:824"]
        self.assertEqual((row["totals"]["validVotes"], kind), (1455, "grouped"))
        result = index.estimate(index.geometries[area])
        self.assertEqual(result["votes"], 1455)
        self.assertEqual(sum(len(f["geometry"]["coordinates"]) for f in result["dots"]["features"]), 1455)
        self.assertEqual(result["sources"][0]["id"], row["id"])
        _, row, kind = by_id["display:joined-locality:K26:3555:3620"]
        self.assertEqual((row["totals"]["validVotes"], kind), (188, "representative"))
        self.assertNotIn("stat2022:35550001", by_id)
        self.assertNotIn("stat2022:36200001", by_id)
        self.assertNotIn("stat2022:50000824", by_id)
        self.assertNotIn("stat2022:5548", by_id)
        self.assertNotIn("custom:tribal_negev", by_id)
        for key in ("stat2022:38150001", "stat2022:38610001", "stat2022:38640001", "stat2022:38690001"):
            self.assertEqual(by_id[key][2], "individual")
        self.assertEqual(by_id["municipality-fallback:2022:loc:534"][2], "fallback")


if __name__ == "__main__":
    unittest.main()
