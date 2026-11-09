import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = import.meta.dirname
const read = (path) => readFile(path, 'utf8')
const { vars: { BASE_PATH, PUBLIC_ORIGIN }, assets: { directory } } = JSON.parse(await read(resolve(root, 'wrangler.json')))
if (!/^\/[a-z][a-z-]*$/.test(BASE_PATH)) throw new Error('Unexpected site path')
const demo = process.argv.includes('--demo')
const dist = resolve(root, demo ? 'dist/demo' : directory)
const target = resolve(dist, BASE_PATH.slice(1))
const repo = resolve(process.env.WALK_VOTE_REPO ?? resolve(homedir(), 'Desktop', 'Side Projects', 'israel-election-map'), 'web', 'app')
const python = process.env.WALK_VOTE_PYTHON || 'python'
const copy = (source, destination) => copyFile(source, resolve(target, destination))
await mkdir(target, { recursive: true })

const mapAssets = [
  ['maplibre.js', 'node_modules/maplibre-gl/dist/maplibre-gl.js', '45a9b07a9189ce56054c620a947ccf41e291e58c95e9b61533b740aaa65ee5cb'],
  ['maplibre.css', 'node_modules/maplibre-gl/dist/maplibre-gl.css', 'ab1e70d59ec40465bae7e7030da2f3ccf28133fd502e62bd598eefbadfd7a732'],
  ['map-rtl.js', 'node_modules/@mapbox/mapbox-gl-rtl-text/dist/mapbox-gl-rtl-text.js', 'd1c69035295613baaf83fe23fd9266b0eaed7e5e472e9632b0b5438afc3f589e'],
  ['map-context.geojson', 'public/data/v2/geographies/map-context-footprint.geojson'],
]

async function downloadDemoAsset(file, sha256) {
  const response = await fetch(PUBLIC_ORIGIN + BASE_PATH + '/' + file, {
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error('Could not download demo asset: ' + file + ' (' + response.status + ')')
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 16 * 1024 * 1024) throw new Error('Oversized demo asset: ' + file)
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  if (sha256 && createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error('Vendor file does not match the pinned digest: ' + file)
  }
  await writeFile(resolve(target, file), bytes)
}

if (demo) {
  await Promise.all([
    ...mapAssets.map(([file, , hash]) => downloadDemoAsset(file, hash)),
    downloadDemoAsset('k26-results.json'),
    downloadDemoAsset('initial-grid.tiff'),
  ])
} else {
  execFileSync(python, [resolve(root, 'export-data.py'), resolve(target, 'k26-results.json')], { stdio: 'inherit' })
  await copy(resolve(root, '.checks', 'initial-grid.tiff'), 'initial-grid.tiff')
  await Promise.all(mapAssets.map(([file, path]) => copy(resolve(repo, path), file)))
}

const html = await read(resolve(root, '..', 'index.html'))
await writeFile(resolve(target, 'index.html'), html
  .replace('<head>', '<head>\n  <base href="' + BASE_PATH + '/">\n  <link rel="canonical" href="' + PUBLIC_ORIGIN + BASE_PATH + '">'))

await Promise.all([
  copy(resolve(root, '..', 'app.js'), 'app.js'),
  copy(resolve(root, '..', 'style.css'), 'style.css'),
  build({
    entryPoints: [resolve(root, 'estimate-worker.mjs')],
    outfile: resolve(target, 'estimate-worker.js'),
    bundle: true, minify: true, platform: 'browser', target: 'es2022',
    legalComments: 'linked',
  }),
])

await mkdir(resolve(target, 'licenses'), { recursive: true })
const mapLicenses = [
  ['maplibre-gl', 'node_modules/maplibre-gl/LICENSE.txt'],
  ['mapbox-gl-rtl-text', 'node_modules/@mapbox/mapbox-gl-rtl-text/LICENSE.md'],
]
await Promise.all([
  ...mapLicenses.map(([name, path]) => demo
    ? downloadDemoAsset('licenses/' + name + '.txt')
    : copy(resolve(repo, path), 'licenses/' + name + '.txt')),
  ...[
    ['earcut', 'LICENSE'], ['polygon-clipping', 'LICENSE.md'], ['proj4', 'LICENSE.md'],
    ['robust-predicates', 'LICENSE'], ['mgrs', 'license.md'], ['wkt-parser', 'LICENSE.md'],
    ['splaytree', 'Readme.md'], ['d3-contour', 'LICENSE'], ['d3-array', 'LICENSE'],
    ['internmap', 'LICENSE'], ['geotiff', 'LICENSE'], ['@petamoriken/float16', 'LICENSE'],
    ['lerc', 'README.md'], ['pako', 'LICENSE'], ['parse-headers', 'LICENCE'],
    ['quick-lru', 'license'], ['web-worker', 'LICENSE'], ['xml-utils', 'LICENSE'], ['zstddec', 'LICENSE'],
  ].map(([name, license]) => copy(resolve(root, 'node_modules', name, license),
    'licenses/' + name.split('/').at(-1) + '.txt')),
])

await writeFile(resolve(dist, '_headers'), [
  '/*',
  '  Referrer-Policy: no-referrer',
  '  X-Content-Type-Options: nosniff',
  '',
].join('\n'))
console.log('Built Walking Distance.')
