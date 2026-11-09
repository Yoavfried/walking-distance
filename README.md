# Walking Distance / מרחק הליכה

[Open Walking Distance](https://yoavfried.com/walking-distance) · [Yoav Fried](https://yoavfried.com/)

Choose a starting point in Israel and a walking time between 0 and 30 minutes.
The map shows the area reachable on foot and estimates the votes cast there
in the 2026 Knesset election. The app is available in Hebrew and English.

## How It Works

- [Valhalla](https://valhalla.github.io/valhalla/api/isochrone/api-reference/)
  computes one 30-minute pedestrian travel-time grid per pin from OpenStreetMap.
  The browser extracts a contour for each selected minute. Moving the slider
  does not send another routing request. The initial pin uses a bundled grid.
- The election snapshot comes from the [Israeli Election Map](https://github.com/Yoavfried/israel-election-map).
  It uses that map's K26 result polygons and, where no statistical-area breakdown
  is available, whole-locality polygons. It does not count both a combined area
  and its components. Marker-only results, unassigned ballots and double
  envelopes are excluded.
- For each polygon, each party's votes are multiplied by the fraction of the
  polygon's area inside the walk, measured in EPSG:6933. Largest-remainder
  rounding keeps counts whole and their sum equal to the rounded total.
  This assumes uniform vote density; it does not model where people live.
- Each dot represents one estimated vote. Dots are generated within the
  contributing polygons, not from real voter locations.

Street tiles come from [OpenFreeMap](https://openfreemap.org/) and
[OpenStreetMap contributors](https://www.openstreetmap.org/copyright).
Selected coordinates are sent to the rate-limited routing endpoint and its
Valhalla provider; this app does not store selected pins.
The public Valhalla instance is shared infrastructure. See its
[usage guidance](https://github.com/valhalla/valhalla#public-servers)
before operating another public instance of this app or increasing traffic.

## Build And Test

Use Node.js 22+, Python 3.12+, and an election-map checkout with its built K26
web data and installed MapLibre dependencies. Set `WALK_VOTE_REPO` to that
checkout and optionally set `WALK_VOTE_PYTHON` to the Python executable.
Generated data and deployment credentials are not in this repository.

```sh
python -m pip install --target .deps shapely==2.2.0 pyproj==3.8.0
cd hosting
npm ci
npm test
npm run prepare:start
npm run build
npx wrangler dev --port 4187 --var PUBLIC_ORIGIN:http://127.0.0.1:4187
```

Open [the local preview](http://127.0.0.1:4187/walking-distance). For a hosted
deployment, configure the public origin, path and rate limits in
`hosting/wrangler.json`. The repository contains application source; election
data and third-party components retain their own terms.
