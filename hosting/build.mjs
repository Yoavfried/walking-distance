import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = import.meta.dirname
const read = (path) => readFile(path, 'utf8')
const { vars: { BASE_PATH, PUBLIC_ORIGIN }, assets: { directory } } = JSON.parse(await read(resolve(root, 'wrangler.json')))
if (!/^\/[a-z][a-z-]*$/.test(BASE_PATH)) throw new Error('Unexpected site path')
const dist = resolve(root, directory)
const target = resolve(dist, BASE_PATH.slice(1))
const repo = resolve(process.env.WALK_VOTE_REPO ?? resolve(homedir(), 'Desktop', 'Side Projects', 'israel-election-map'), 'web', 'app')
const python = process.env.WALK_VOTE_PYTHON || 'python'
const copy = (source, destination) => copyFile(source, resolve(target, destination))
await mkdir(target, { recursive: true })

execFileSync(python, [resolve(root, 'export-data.py'), resolve(target, 'k26-results.json')], { stdio: 'inherit' })
await copy(resolve(root, '.checks', 'initial-grid.tiff'), 'initial-grid.tiff')

const html = await read(resolve(root, '..', 'index.html'))
await writeFile(resolve(target, 'index.html'), html
  .replace('<head>', '<head>\n  <base href="' + BASE_PATH + '/">\n  <link rel="canonical" href="' + PUBLIC_ORIGIN + BASE_PATH + '">'))

await Promise.all([
  copy(resolve(root, '..', 'app.js'), 'app.js'),
  copy(resolve(root, '..', 'style.css'), 'style.css'),
  copy(resolve(repo, 'node_modules/maplibre-gl/dist/maplibre-gl.js'), 'maplibre.js'),
  copy(resolve(repo, 'node_modules/maplibre-gl/dist/maplibre-gl.css'), 'maplibre.css'),
  copy(resolve(repo, 'node_modules/@mapbox/mapbox-gl-rtl-text/dist/mapbox-gl-rtl-text.js'), 'map-rtl.js'),
  copy(resolve(repo, 'public/data/v2/geographies/map-context-footprint.geojson'), 'map-context.geojson'),
  build({
    entryPoints: [resolve(root, 'estimate-worker.mjs')],
    outfile: resolve(target, 'estimate-worker.js'),
    bundle: true, minify: true, platform: 'browser', target: 'es2022',
    legalComments: 'linked',
  }),
])

await mkdir(resolve(target, 'licenses'), { recursive: true })
await Promise.all([
  ['maplibre-gl', resolve(repo, 'node_modules/maplibre-gl/LICENSE.txt')],
  ['mapbox-gl-rtl-text', resolve(repo, 'node_modules/@mapbox/mapbox-gl-rtl-text/LICENSE.md')],
  ...[
    ['earcut', 'LICENSE'], ['polygon-clipping', 'LICENSE.md'], ['proj4', 'LICENSE.md'],
    ['robust-predicates', 'LICENSE'], ['mgrs', 'license.md'], ['wkt-parser', 'LICENSE.md'],
    ['splaytree', 'Readme.md'], ['d3-contour', 'LICENSE'], ['d3-array', 'LICENSE'],
    ['internmap', 'LICENSE'], ['geotiff', 'LICENSE'], ['@petamoriken/float16', 'LICENSE'],
    ['lerc', 'README.md'], ['pako', 'LICENSE'], ['parse-headers', 'LICENCE'],
    ['quick-lru', 'license'], ['web-worker', 'LICENSE'], ['xml-utils', 'LICENSE'], ['zstddec', 'LICENSE'],
  ].map(([name, license]) => [name, resolve(root, 'node_modules', name, license)]),
].map(([name, source]) => copy(source, 'licenses/' + name.split('/').at(-1) + '.txt')))

await writeFile(resolve(dist, '_headers'), [
  '/*',
  '  Referrer-Policy: no-referrer',
  '  X-Content-Type-Options: nosniff',
  '',
].join('\n'))
console.log('Built Walking Distance.')
