import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readWalkingGrid } from './contour.mjs'
import { fetchWalkingGrid } from './routing.mjs'

const start = [34.7748, 32.0776]
async function fetchDefault() {
  const response = await fetchWalkingGrid(...start)
  if (!response.ok) throw new Error('Default walking grid unavailable: ' + response.status)
  return response.arrayBuffer()
}
const file = process.argv[2]
const grid = file ? Uint8Array.from(await readFile(file)).buffer : await fetchDefault()
if (!(await readWalkingGrid(grid, start))(15)) throw new Error('Default grid has no walking contour')
await mkdir(new URL('./.checks/', import.meta.url), { recursive: true })
await writeFile(new URL('./.checks/initial-grid.tiff', import.meta.url), Buffer.from(grid))
