import { contours } from 'd3-contour'
import { fromArrayBuffer } from 'geotiff'
import { MAX_MINUTES } from './routing.mjs'

function interpolateBoundary(edge, before, after, threshold) {
  // A missing sample has no travel time. Keep the boundary halfway to it.
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) return edge
  return edge + (threshold - before) / (after - before) - 0.5
}

export async function readWalkingGrid(bytes, start) {
  const image = await (await fromArrayBuffer(bytes)).getImage()
  const width = image.getWidth()
  const height = image.getHeight()
  const [lon, lat] = image.getOrigin()
  const [dx, dy] = image.getResolution()
  const noData = image.getGDALNoData()
  if (width < 2 || height < 2 || width * height > 250_000 ||
    image.getGeoKeys().GeographicTypeGeoKey !== 4326 ||
    !Number.isFinite(lon) || !Number.isFinite(lat) || !(dx > 0) || !(dy < 0)) {
    throw new Error('Unexpected walking grid')
  }
  const [seconds] = await image.readRasters({ samples: [0] })
  return walkingGrid({ width, height, lon, lat, dx, dy, seconds, noData }, start)
}

export function walkingGrid({ width, height, lon, lat, dx, dy, seconds, noData }, start) {
  if (start) {
    const column = (start[0] - lon) / dx - 0.5
    const row = (start[1] - lat) / dy - 0.5
    const x = Math.round(column), y = Math.round(row)
    // Some Valhalla versions anchor the TIFF one row north of its data.
    // The zero-minute cell identifies that offset without relying on a version header.
    if (Math.abs(x - column) <= 0.02 && Math.abs(y - row) <= 0.02 &&
      x >= 0 && x < width && y >= 1 && y <= height &&
      seconds[(y - 1) * width + x] === 0 && seconds[y * width + x] !== 0) {
      lat += dy
    }
  }
  // D3 contours values above a threshold; negate seconds to select reachable cells.
  const values = Float32Array.from(seconds, (value) => (
    Number.isFinite(value) && value >= 0 && value !== noData ? -value : NaN
  ))
  const generator = contours().size([width, height]).smooth(false)
  return (minutes) => {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) return null
    const threshold = -60 * minutes
    const { coordinates } = generator.contour(values, threshold)
    if (!coordinates.length) return null
    return {
      type: 'Feature', properties: {},
      geometry: {
        type: 'MultiPolygon',
        coordinates: coordinates.map((polygon) => polygon.map((ring) =>
          ring.map(([x, y]) => {
            const i = Math.floor(y) * width + Math.floor(x)
            const sx = Number.isInteger(x) && x > 0 && x < width
              ? interpolateBoundary(x, values[i - 1], values[i], threshold) : x
            const sy = Number.isInteger(y) && y > 0 && y < height
              ? interpolateBoundary(y, values[i - width], values[i], threshold) : y
            return [lon + sx * dx, lat + sy * dy]
          }))),
      },
    }
  }
}
