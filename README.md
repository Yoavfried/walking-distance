# Walking Distance / מרחק הליכה

[Open Walking Distance](https://yoavfried.com/walking-distance) · [Report an issue](https://github.com/Yoavfried/walking-distance/issues)

Drop a pin in Israel and set a walking time from 0 to 30 minutes. The map shows
the estimated area reachable on foot and how the 2026 Knesset election results
break down within it. It is available in Hebrew and English.

## How The Estimate Works

1. [Valhalla](https://valhalla.github.io/valhalla/api/isochrone/api-reference/)
   returns one 30-minute pedestrian travel-time grid per pin. The browser turns
   that grid into a boundary for each selected minute; moving the slider does
   not send another routing request. The initial pin uses a bundled grid.
2. The [Israeli Election Map](https://github.com/Yoavfried/israel-election-map)
   supplies the K26 results. We use the visible statistical-area and grouped
   result polygons, or whole-locality polygons where the election map does not
   have a split. We don't count a group and its components twice. Marker-only
   results, unassigned ballots and double envelopes are excluded.
3. For each party, we count the fraction of its votes proportional to the
   fraction of each result polygon covered by the walk, measured in EPSG:6933.
   For example, 10% of a polygon with 600 valid votes contributes about 60 votes.
   We assume the votes are spread evenly across the polygon. If a result polygon
   is entirely inside the walk's outer boundary and partly reachable, interior
   holes do not reduce its count. A polygon entirely inside a hole contributes
   nothing. Largest-remainder rounding keeps the party counts whole and their
   sum equal to the rounded total.
4. Each dot is one estimated vote, placed within the reachable part of a
   contributing polygon. The dots do not show where individual voters live.

## Limits

- The walking boundary is an estimate, not street-by-street directions. In the
  grids tested, cells were about 100 meters across; two streets on opposite
  sides of a barrier can share one cell even when their walking times differ.
  A small diamond-shaped hole can be a grid artifact, not a real obstacle.
- The browser corrects the known [north-shifted Valhalla GeoTIFF origin](https://github.com/valhalla/valhalla/blob/3.9.1/src/tyr/isochrone_serializer.cc#L316-L328)
  when the zero-minute cell confirms the shift. It interpolates between known
  times but does not assign a time to cells with missing data.
- Election polygons can cover more than one statistical area, and some results
  are not mapped. The tool cannot recover exact results for arbitrary streets
  or tell where any individual voted.

## Sources And Privacy

Street tiles are provided by [OpenFreeMap](https://openfreemap.org/) from
[OpenStreetMap](https://www.openstreetmap.org/copyright). The public
[Valhalla service](https://valhalla.openstreetmap.de/) uses OpenStreetMap for
routing. For election-data provenance and downloads, see the
[election data documentation](https://github.com/Yoavfried/israel-election-map/tree/main/data).

The app is ad-free. It doesn't store selected pins; new pin coordinates are
sent to the site's routing endpoint and its routing provider to calculate the
walk. The app stores only the language preference in browser storage.
The browser also loads map tiles from OpenFreeMap and fonts from Google Fonts.

## Build And Test

The JavaScript unit tests run with Node.js 22+ and don't require deployment
credentials or a copy of the election data:

```sh
cd hosting
npm ci
npm test
```

A full local preview also needs Python 3.12+, a checkout of
[Israeli Election Map](https://github.com/Yoavfried/israel-election-map) with
generated data under `web/app/public/data/v2/`, and that checkout's web
dependencies installed. Follow its build instructions, then set
`WALK_VOTE_REPO` to the election-map checkout's root. If needed, set
`WALK_VOTE_PYTHON` to the Python executable to use for export.

From the Walking Distance repository root:
```sh
python -m pip install --target .deps shapely==2.2.0 pyproj==3.8.0
python -m unittest test_estimation
cd hosting
npm ci
npm run prepare:start
npm run build
npx wrangler dev --port 4187 --var PUBLIC_ORIGIN:http://127.0.0.1:4187
```

Open [the local preview](http://127.0.0.1:4187/walking-distance/).
`prepare:start` fetches the initial walking grid. `npm run build` writes
the browser assets and generated K26 snapshot to `hosting/dist-public/`.
Generated data, local caches and deployment credentials are not committed.

The hosted app uses a Cloudflare Worker for static assets and rate-limited
routing requests. The public Valhalla instance is shared infrastructure;
read its [usage guidance](https://github.com/valhalla/valhalla#public-servers)
before deploying another public instance. Election data and third-party
components retain their own terms.
