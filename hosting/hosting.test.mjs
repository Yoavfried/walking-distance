import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
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
