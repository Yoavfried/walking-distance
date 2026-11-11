import { estimate } from './estimate.mjs'
import { readWalkingGrid } from './contour.mjs'
import { createSnapshotLoader } from './snapshots.mjs'

const loadSnapshot = createSnapshotLoader()
let point
let latest
self.onmessage = async ({ data: { id, pin, grid, start, minutes, election } }) => {
  if (grid) {
    const contour = readWalkingGrid(grid, start).catch(() => null)
    point = { pin, contour }
    return
  }
  latest = id
  const current = () => latest === id && point?.pin === pin
  try {
    const contour = point?.pin === pin && await point.contour
    if (!current()) return
    const walk = contour && contour(minutes)
    if (!walk) {
      self.postMessage({ id, error: 'noRoute' })
      return
    }
    self.postMessage({ id, walk })
    const data = await loadSnapshot(election).catch(() => null)
    if (!current()) return
    if (!data) self.postMessage({ id, error: 'electionUnavailable' })
    else self.postMessage({ id, result: estimate(data, walk, minutes) })
  } catch {
    if (current()) self.postMessage({ id, error: 'failed' })
  }
}
