import { fetchWalkingGrid } from './routing.mjs'

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

    const visitor = await env.VISITOR_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' })
    if (!visitor.success) return json(503, { error: 'Try again in a moment.' })
    const demo = await env.DEMO_LIMIT.limit({ key: 'isochrone' })
    if (!demo.success) return json(503, { error: 'The preview is busy.' })

    try {
      const upstream = await fetchWalkingGrid(lon, lat)
      if (upstream.status === 429 || upstream.status === 503) return json(503, { error: 'The walking service is busy.' })
      if (upstream.status === 400 || upstream.status === 404) return json(422, { error: 'No walking route found.' })
      if (!upstream.ok) return json(502, { error: 'The walking service is unavailable.' })
      if (!upstream.headers.get('Content-Type')?.startsWith('image/tiff')) {
        return json(502, { error: 'The walking service returned an unexpected response.' })
      }
      return new Response(upstream.body, { headers: { ...headers, 'Content-Type': 'image/tiff' } })
    } catch {
      return json(502, { error: 'The walking service is unavailable.' })
    }
  },
}
