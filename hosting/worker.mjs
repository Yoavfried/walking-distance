import { fetchHostedWalkingGrid, fetchWalkingGrid } from './routing.mjs'

const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

function json(status, body) {
  return Response.json(body, { status, headers: { ...headers, 'X-Robots-Tag': 'noindex' } })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if ([env.BASE_PATH, env.BASE_PATH + '/'].includes(url.pathname) && ['GET', 'HEAD'].includes(request.method)) {
      url.pathname = env.BASE_PATH + '/index.html'
      return env.ASSETS.fetch(new Request(url, request))
    }
    if (url.pathname !== env.BASE_PATH + '/api/isochrone') return env.ASSETS.fetch(request)
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
    if (request.headers.get('Origin') !== env.PUBLIC_ORIGIN ||
      !request.headers.get('Content-Type')?.startsWith('application/json')) return json(403, { error: 'Forbidden.' })

    let lon, lat
    try {
      const size = Number(request.headers.get('Content-Length'))
      if (!(size > 0 && size <= 256)) return json(400, { error: 'Invalid request size.' })
      const point = await request.json()
      lon = point.lon
      lat = point.lat
      if (!Number.isFinite(lon) || !Number.isFinite(lat) ||
        lon < 34.16 || lon > 35.92 || lat < 29.45 || lat > 33.36) {
        return json(400, { error: 'Choose a point within the map.' })
      }
    } catch {
      return json(400, { error: 'Invalid starting point.' })
    }

    const hosted = Boolean(env.WALKING_ROUTER_URL)
    if (hosted && !env.WALKING_ROUTER_BYPASS) return json(502, { error: 'The walking service is unavailable.' })
    const visitorLimit = hosted ? env.HOSTED_VISITOR_LIMIT : env.VISITOR_LIMIT
    const sharedLimit = hosted ? env.HOSTED_LIMIT : env.DEMO_LIMIT
    const visitor = await visitorLimit.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' })
    if (!visitor.success) return json(503, { error: 'Try again in a moment.' })
    const shared = await sharedLimit.limit({ key: 'isochrone' })
    if (!shared.success) return json(503, { error: 'The walking service is busy.' })

    try {
      const upstream = hosted
        ? await fetchHostedWalkingGrid(env.WALKING_ROUTER_URL, env.WALKING_ROUTER_BYPASS, lon, lat)
        : await fetchWalkingGrid(lon, lat)
      if (upstream.status === 429 || upstream.status === 503 || (hosted && upstream.status === 402)) {
        return json(503, { error: 'The walking service is busy.' })
      }
      if (upstream.status === 422 || (!hosted && [400, 404].includes(upstream.status))) {
        return json(422, { error: 'No walking route found.' })
      }
      if (!upstream.ok) return json(502, { error: 'The walking service is unavailable.' })
      if (!upstream.headers.get('Content-Type')?.startsWith('image/tiff')) {
        return json(502, { error: 'The walking service returned an unexpected response.' })
      }
      return new Response(upstream.body, { headers: {
        ...headers,
        'Content-Type': 'image/tiff',
        'X-Walking-Router': hosted ? 'hosted' : 'public',
      } })
    } catch {
      return json(502, { error: 'The walking service is unavailable.' })
    }
  },
}
