import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import proj4 from 'proj4'
import { estimate } from './estimate.mjs'
import { readWalkingGrid, walkingGrid } from './contour.mjs'
import worker from './worker.mjs'

const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))
const { vars, assets } = await read('./wrangler.json')

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
    ['34.5,30.5', '35.5,29.5', '35.5,31.5', '36.5,30.5'])
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
  const contour = await readWalkingGrid(Uint8Array.from(bytes).buffer)
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
