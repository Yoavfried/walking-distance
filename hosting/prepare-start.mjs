import { mkdir, writeFile } from 'node:fs/promises'
import { readWalkingGrid } from './contour.mjs'
import { fetchWalkingGrid } from './routing.mjs'

const start = [34.7748, 32.0776]
const response = await fetchWalkingGrid(...start)
if (!response.ok) throw new Error('Default walking grid unavailable: ' + response.status)
const grid = await response.arrayBuffer()
if (!(await readWalkingGrid(grid, start))(15)) throw new Error('Default grid has no walking contour')
await mkdir(new URL('./.checks/', import.meta.url), { recursive: true })
await writeFile(new URL('./.checks/initial-grid.tiff', import.meta.url), Buffer.from(grid))
