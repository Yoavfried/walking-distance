import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, extname } from 'node:path'
import { MAX_MINUTES } from './routing.mjs'

const port = Number(process.env.WALK_VOTE_DEMO_PORT ?? 4187)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose an unprivileged demo port')
const origin = new URL('http://127.0.0.1:' + port)
const { vars: { BASE_PATH } } = JSON.parse(await readFile(new URL('./wrangler.json', import.meta.url)))
const root = join(import.meta.dirname, 'dist', 'demo', BASE_PATH)
const localRouter = process.env.WALK_VOTE_LOCAL_VALHALLA_URL && new URL(process.env.WALK_VOTE_LOCAL_VALHALLA_URL)
if (localRouter && (localRouter.protocol !== 'http:' || localRouter.hostname !== '127.0.0.1' ||
    localRouter.pathname !== '/isochrone' || localRouter.username || localRouter.password ||
    localRouter.search || localRouter.hash)) {
  throw new Error('WALK_VOTE_LOCAL_VALHALLA_URL must be a loopback Valhalla /isochrone URL')
}

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.geojson': 'application/geo+json', '.tiff': 'image/tiff',
  '.txt': 'text/plain; charset=utf-8',
}

async function localGrid(request, response) {
  if (request.headers.origin !== origin.origin || !request.headers['content-type']?.startsWith('application/json')) {
    return response.writeHead(403).end()
  }
  if (!localRouter) return response.writeHead(422).end()
  const length = Number(request.headers['content-length'])
  if (!(length > 0 && length <= 256)) return response.writeHead(400).end()
  let point
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    point = JSON.parse(Buffer.concat(chunks))
  } catch {
    return response.writeHead(400).end()
  }
  const { lon, lat } = point ?? {}
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < 34.16 || lon > 35.92 || lat < 29.45 || lat > 33.36) {
    return response.writeHead(400).end()
  }
  const upstream = await fetch(localRouter, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'image/tiff' },
    body: JSON.stringify({
      locations: [{ lon, lat }], costing: 'pedestrian', contours: [{ time: MAX_MINUTES }], format: 'geotiff',
    }),
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  })
  if (!upstream.ok || !upstream.headers.get('content-type')?.startsWith('image/tiff')) {
    return response.writeHead(422).end()
  }
  response.writeHead(200, { 'Content-Type': 'image/tiff' }).end(Buffer.from(await upstream.arrayBuffer()))
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  if (request.headers.host !== origin.host) return response.writeHead(403).end()
  try {
    const { pathname } = new URL(request.url, origin)
    if (pathname === BASE_PATH + '/api/isochrone' && request.method === 'POST') {
      return await localGrid(request, response)
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return response.writeHead(405).end()
    const file = [BASE_PATH, BASE_PATH + '/'].includes(pathname) ? 'index.html' : pathname.slice(BASE_PATH.length + 1)
    if (!pathname.startsWith(BASE_PATH + '/') && pathname !== BASE_PATH ||
        !/^(?:licenses\/)?[a-z0-9.-]+\.(?:html|css|js|json|geojson|tiff|txt)$/i.test(file)) {
      return response.writeHead(404).end()
    }
    const bytes = await readFile(join(root, file))
    response.writeHead(200, { 'Content-Type': types[extname(file)], 'Content-Length': bytes.length })
      .end(request.method === 'HEAD' ? undefined : bytes)
  } catch (error) {
    if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 502)
    response.end()
  }
})
server.listen(port, '127.0.0.1', () => {
  console.log(origin.origin + BASE_PATH + '/')
  if (!localRouter) console.log('Bundled starting pin only. Set WALK_VOTE_LOCAL_VALHALLA_URL to enable new pins.')
})
