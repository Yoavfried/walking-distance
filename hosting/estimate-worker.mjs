import { estimate } from './estimate.mjs'
import { readWalkingGrid } from './contour.mjs'

let snapshot
let point
self.onmessage = async ({ data: { id, pin, grid, start, minutes } }) => {
  if (grid) {
    const contour = readWalkingGrid(grid, start).catch(() => null)
    point = { pin, contour }
    return
  }
  try {
    const contour = point?.pin === pin && await point.contour
    if (point?.pin !== pin) return
    const walk = contour && contour(minutes)
    if (!walk) {
      self.postMessage({ id, error: 'noRoute' })
      return
    }
    self.postMessage({ id, walk })
    snapshot ??= fetch('./k26-results.json').then((response) => {
      if (!response.ok) throw new Error('Could not load election results')
      return response.json()
    }).catch((error) => {
      snapshot = undefined
      throw error
    })
    const data = await snapshot
    if (point?.pin === pin) self.postMessage({ id, result: estimate(data, walk, minutes) })
  } catch {
    self.postMessage({ id, error: true })
  }
}
