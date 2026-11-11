import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import proj4 from 'proj4'
import { estimate } from './estimate.mjs'
import { readWalkingGrid, walkingGrid } from './contour.mjs'
import { createSnapshotLoader, snapshotFile } from './snapshots.mjs'
import worker from './worker.mjs'

const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))
const { vars, assets } = await read('./wrangler.json')

test('Election snapshots load on demand, are keyed by election, and keep only two recent entries', async () => {
  const fetches = []
  const load = createSnapshotLoader(async (path) => {
    fetches.push(path)
    const election = path.match(/k([0-9]+)/)[1]
    return Response.json({ election: 'K' + election, parties: [], units: [] })
  })
  assert.deepEqual(fetches, [])
  const initial = load('K26')
  assert.equal(load('K26'), initial)
  assert.equal((await initial).election, 'K26')
  assert.equal((await load('K25')).election, 'K25')
  assert.equal((await load('K17')).election, 'K17')
  assert.equal((await load('K26')).election, 'K26')
  assert.deepEqual(fetches, ['./k26-results.json', './k25-results.json', './k17-results.json', './k26-results.json'])
})

test('Unavailable or mismatched election data can be retried', async () => {
  const responses = [
    new Response(null, { status: 404 }),
    Response.json({ election: 'K26', parties: [], units: [] }),
    Response.json({ election: 'K25', parties: [], units: [] }),
  ]
  const load = createSnapshotLoader(async () => responses.shift())
  assert.throws(() => load('../k26'))
  await assert.rejects(load('K25'), /Could not load/)
  await assert.rejects(load('K25'), /Unexpected election/)
  assert.equal((await load('K25')).election, 'K25')
})

test('Every published election has its own usable snapshot and the same walking contour', { skip: !process.env.WALK_VOTE_PARITY }, async () => {
  const path = assets.directory + vars.BASE_PATH + '/'
  const catalog = await read(path + 'elections.json')
  assert.deepEqual(catalog.map(({ id }) => id), Array.from({ length: 10 }, (_, i) => 'K' + (26 - i)))
  assert.match(catalog.find(({ id }) => id === 'K22').label.en, /Sep 2019/)
  assert.match(catalog.find(({ id }) => id === 'K21').label.en, /Apr 2019/)
  const bytes = await readFile(new URL('./.checks/initial-grid.tiff', import.meta.url))
  const contour = await readWalkingGrid(Uint8Array.from(bytes).buffer, [34.7748, 32.0776])
  const walk = contour(15)
  const totals = new Set()
  for (const { id } of catalog) {
    const snapshot = await read(path + snapshotFile(id))
    assert.equal(snapshot.election, id)
    assert.ok(snapshot.units.length > 1000, id)
    const result = estimate(snapshot, walk, 15)
    assert.ok(result.votes > 0, id)
    assert.equal(result.election, id)
    assert.equal(result.walk, walk)
    totals.add(result.votes)
  }
  assert.equal(totals.size, catalog.length)
})

for (const name of ['initial', 'shapira', 'isfiya']) {
  test('Browser estimate matches Python reference: ' + name, { skip: !process.env.WALK_VOTE_PARITY }, async () => {
    const snapshot = await read(assets.directory + vars.BASE_PATH + '/k26-results.json')
    const reference = await read('./.checks/' + name + '.json')
    const result = estimate(snapshot, reference.walk)
    assert.equal(result.buildId, reference.buildId)
    assert.equal(result.votes, reference.votes)
    assert.ok(Math.abs(result.areaKm2 - reference.areaKm2) < 1e-6)
    const counts = (parties) => Object.fromEntries(parties.map((p) => [p.id, p.votes]))
    assert.deepEqual(counts(result.parties), counts(reference.parties))
    assert.deepEqual(
      Object.fromEntries(result.dots.features.map((f) => [f.properties.party, f.geometry.coordinates.length])),
      Object.fromEntries(result.parties.filter((p) => p.votes).map((p) => [p.id, p.votes])),
    )
    assert.deepEqual(result.overlaps.features.map((f) => f.id).sort(), reference.overlaps.features.map((f) => f.id).sort())
  })
}

test('One walking grid supports each minute and excludes nodata', () => {
  const contour = walkingGrid({
    width: 3, height: 3, lon: 34, lat: 32, dx: 0.001, dy: -0.001, noData: 65535,
    seconds: [65535, 90, 65535, 90, 0, 90, 65535, 90, 65535],
  })
  assert.equal(contour(0), null)
  assert.equal(contour(31), null)
  assert.notDeepEqual(contour(1), contour(2))
  assert.deepEqual(contour(2), contour(30))
  for (const [lon, lat] of contour(30).geometry.coordinates[0][0]) {
    assert.ok(lon >= 34 && lon <= 34.003)
    assert.ok(lat >= 31.997 && lat <= 32)
  }
})

test('A single missing cell creates a diamond-shaped hole', () => {
  const contour = walkingGrid({
    width: 3, height: 3, lon: 34, lat: 32, dx: 1, dy: -1, noData: 65535,
    seconds: [0, 0, 0, 0, 65535, 0, 0, 0, 0],
  })
  const [, hole] = contour(15).geometry.coordinates[0]
  assert.equal(hole.length, 5)
  assert.deepEqual(hole.slice(0, -1).map((point) => point.join(',')).sort(),
    ['35,30.5', '35.5,30', '35.5,31', '36,30.5'])
})

test('A reachable cell beside missing data is not collapsed to a point', () => {
  const contour = walkingGrid({
    width: 3, height: 3, lon: 34, lat: 32, dx: 1, dy: -1, noData: 65535,
    seconds: [65535, 65535, 65535, 65535, 0, 65535, 65535, 65535, 65535],
  })
  const [outer] = contour(1).geometry.coordinates[0]
  assert.deepEqual(outer.slice(0, -1).map((point) => point.join(',')).sort(),
    ['35,30.5', '35.5,30', '35.5,31', '36,30.5'])
})

test('Contour still interpolates between measured walk times', () => {
  const contour = walkingGrid({
    width: 3, height: 3, lon: 34, lat: 32, dx: 1, dy: -1, noData: 65535,
    seconds: [180, 180, 180, 180, 0, 180, 180, 180, 180],
  })
  const [outer] = contour(1).geometry.coordinates[0]
  const east = Math.max(...outer.map(([lon]) => lon))
  assert.ok(Math.abs(east - (35.5 + 1 / 3)) < 1e-8)
})

test('Corrects a north-shifted Valhalla grid without moving an already aligned grid', () => {
  const grid = {
    width: 3, height: 3, lon: 34, lat: 32, dx: 0.001, dy: -0.001, noData: 65535,
    seconds: [65535, 90, 65535, 90, 0, 90, 65535, 90, 65535],
  }
  const start = [34.0015, 31.9975]
  const aligned = { ...grid, lat: grid.lat + grid.dy }
  for (const minutes of [1, 5, 15, 30]) {
    const corrected = walkingGrid(grid, start)(minutes)
    assert.notDeepEqual(corrected, walkingGrid(grid)(minutes))
    assert.deepEqual(corrected, walkingGrid(aligned)(minutes))
    assert.deepEqual(corrected, walkingGrid(aligned, start)(minutes))
    assert.deepEqual(corrected, walkingGrid(grid, [34.001504, 31.997495])(minutes))
    assert.deepEqual(walkingGrid(grid, [34.0017, 31.9975])(minutes), walkingGrid(grid)(minutes))
  }
})

test('Only fully enclosed result areas with reachable land recover votes lost to holes', () => {
  const rectangle = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]
  const toMeters = proj4('EPSG:4326', '+proj=cea +lat_ts=30 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs')
  const unit = (id, ...rings) => {
    const polygons = rings.map((ring) => [ring.map((p) => toMeters.forward(p))])
    const points = polygons.flat(2)
    const xs = points.map(([x]) => x)
    const ys = points.map(([, y]) => y)
    const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    const area = polygons.reduce((sum, [ring]) => sum + (ring[1][0] - ring[0][0]) * (ring[2][1] - ring[0][1]), 0)
    return { id, polygons, bounds, area, votes: { A: 100 } }
  }
  const walk = { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [
    [rectangle(34.70, 32, 34.80, 32.10), rectangle(34.73, 32.02, 34.79, 32.08)],
    [rectangle(34.82, 32, 34.86, 32.10)],
  ] } }
  const cases = [
    unit('enclosed', rectangle(34.72, 32.03, 34.76, 32.05)),
    unit('partial', rectangle(34.75, 32.03, 34.83, 32.05)),
    unit('hole-only', rectangle(34.74, 32.03, 34.76, 32.05)),
    unit('separate-parts', rectangle(34.77, 32.03, 34.79, 32.05), rectangle(34.83, 32.03, 34.85, 32.05)),
    unit('outside-part', rectangle(34.83, 32.03, 34.85, 32.05), rectangle(34.805, 32.03, 34.815, 32.05)),
  ]
  const estimateUnit = (row) => estimate({ parties: [{ id: 'A' }], units: [row] }, walk)
  const [enclosed, partial, holeOnly, separateParts, outsidePart] = cases.map(estimateUnit)
  assert.equal(enclosed.votes, 100)
  assert.equal(partial.votes, 25)
  assert.equal(holeOnly.votes, 0)
  assert.equal(separateParts.votes, 100)
  assert.equal(outsidePart.votes, 67)
  assert.equal(enclosed.walk, walk)
  assert.equal(enclosed.areaKm2, holeOnly.areaKm2)
  assert.equal(enclosed.overlaps.features[0].properties.fraction, 1)
  const dots = enclosed.dots.features[0].geometry.coordinates
  assert.equal(dots.length, 100)
  assert.ok(dots.every(([lon]) => lon >= 34.72 && lon <= 34.73))
})

test('The real starting grid returns increasing area and estimated votes', { skip: !process.env.WALK_VOTE_PARITY }, async () => {
  const bytes = await readFile(new URL('./.checks/initial-grid.tiff', import.meta.url))
  const contour = await readWalkingGrid(Uint8Array.from(bytes).buffer, [34.7748, 32.0776])
  const snapshot = await read(assets.directory + vars.BASE_PATH + '/k26-results.json')
  let previous = { areaKm2: 0, votes: 0 }
  for (const minutes of [1, 14, 15, 16, 29, 30]) {
    const next = estimate(snapshot, contour(minutes), minutes)
    assert.ok(next.areaKm2 > previous.areaKm2)
    assert.ok(next.votes > previous.votes)
    assert.equal(next.minutes, minutes)
    previous = next
  }
})

test('The route endpoint rejects cross-origin and over-limit requests', async () => {
  const base = 'https://yoavfried.com'
  const body = '{"lon":34.7748,"lat":32.0776}'
  const request = (origin) => new Request('https://walk-vote-unlisted.example.workers.dev' + vars.BASE_PATH + '/api/isochrone', {
    method: 'POST', body, headers: {
      Origin: origin, 'Content-Type': 'application/json', 'Content-Length': String(body.length),
    },
  })
  assert.equal((await worker.fetch(request('https://example.com'), vars)).status, 403)
  const rejected = await worker.fetch(request(base), { ...vars, VISITOR_LIMIT: { limit: async () => ({ success: false }) } })
  assert.equal(rejected.status, 503)
  assert.match(rejected.headers.get('X-Robots-Tag'), /noindex/)
})

test('The public URL serves the app with or without a trailing slash', async () => {
  const env = { ...vars, ASSETS: { fetch: ({ url }) => new Response(new URL(url).pathname) } }
  for (const suffix of ['', '/']) {
    const response = await worker.fetch(new Request('https://yoavfried.com' + vars.BASE_PATH + suffix), env)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), vars.BASE_PATH + '/index.html')
  }
})

test('Each pin requests one 30-minute pedestrian grid', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('grid', { headers: { 'Content-Type': 'image/tiff' } }))
  const body = '{"lon":34.7748,"lat":32.0776}'
  const request = new Request(vars.PUBLIC_ORIGIN + vars.BASE_PATH + '/api/isochrone', {
    method: 'POST', body, headers: {
      Origin: vars.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'Content-Length': String(body.length),
    },
  })
  const limiter = { limit: async () => ({ success: true }) }
  const response = await worker.fetch(request, { ...vars, VISITOR_LIMIT: limiter, DEMO_LIMIT: limiter })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Content-Type'), 'image/tiff')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(mock.mock.callCount(), 1)
  const [url, options] = mock.mock.calls[0].arguments
  const query = JSON.parse(new URL(url).searchParams.get('json'))
  assert.deepEqual(query.contours, [{ time: 30 }])
  assert.equal(query.costing, 'pedestrian')
  assert.equal(query.format, 'geotiff')
  assert.ok(options.headers['X-Client-Id'])
})

const hostedEnv = {
  ...vars,
  WALKING_ROUTER_URL: 'https://test-router.vercel.app/api/grid',
  WALKING_ROUTER_BYPASS: 'test-secret',
  HOSTED_VISITOR_LIMIT: { limit: async () => ({ success: true }) },
  HOSTED_LIMIT: { limit: async () => ({ success: true }) },
}

function pinRequest() {
  const body = '{"lon":34.7748067,"lat":32.0776}'
  return new Request(vars.PUBLIC_ORIGIN + vars.BASE_PATH + '/api/isochrone', {
    method: 'POST', body, headers: {
      Origin: vars.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'Content-Length': String(body.length),
      'x-vercel-protection-bypass': 'untrusted-client-header',
    },
  })
}

test('The Worker sends only the rounded pin and server key to the hosted router', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('grid', { headers: {
    'Content-Type': 'image/tiff', 'Set-Cookie': 'private=1', 'x-vercel-protection-bypass': 'private',
  } }))
  const response = await worker.fetch(pinRequest(), hostedEnv)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('X-Walking-Router'), 'hosted')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(response.headers.get('Set-Cookie'), null)
  assert.equal(response.headers.get('x-vercel-protection-bypass'), null)
  assert.equal(mock.mock.callCount(), 1)
  const [url, options] = mock.mock.calls[0].arguments
  assert.equal(String(url), hostedEnv.WALKING_ROUTER_URL)
  assert.equal(options.redirect, 'manual')
  assert.equal(options.headers['x-vercel-protection-bypass'], hostedEnv.WALKING_ROUTER_BYPASS)
  assert.deepEqual(JSON.parse(options.body), { lon: 34.77481, lat: 32.0776 })
})

test('Hosted routing never falls back to the public service', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('forbidden', { status: 401 }))
  assert.equal((await worker.fetch(pinRequest(), { ...hostedEnv, WALKING_ROUTER_BYPASS: '' })).status, 502)
  assert.equal((await worker.fetch(pinRequest(), { ...hostedEnv, WALKING_ROUTER_URL: 'https://evil.example/api/grid' })).status, 502)
  const blocked = { ...hostedEnv, HOSTED_LIMIT: { limit: async () => ({ success: false }) } }
  assert.equal((await worker.fetch(pinRequest(), blocked)).status, 503)
  assert.equal(mock.mock.callCount(), 0)
  assert.equal((await worker.fetch(pinRequest(), hostedEnv)).status, 502)
  assert.equal(mock.mock.callCount(), 1)
})

test('A hosted router redirect is rejected without forwarding its destination', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.redirect('https://example.invalid'))
  const response = await worker.fetch(pinRequest(), hostedEnv)
  assert.equal(response.status, 502)
  assert.equal(response.headers.get('Location'), null)
  assert.equal(mock.mock.callCount(), 1)
})
