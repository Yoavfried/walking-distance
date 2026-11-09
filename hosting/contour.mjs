import { contours } from 'd3-contour'
import { fromArrayBuffer } from 'geotiff'
import { MAX_MINUTES } from './routing.mjs'

export async function readWalkingGrid(bytes) {
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
  return walkingGrid({ width, height, lon, lat, dx, dy, seconds, noData })
}

export function walkingGrid({ width, height, lon, lat, dx, dy, seconds, noData }) {
  // D3 contours values above a threshold; negate seconds to select reachable cells.
  const values = Float32Array.from(seconds, (value) => (
    Number.isFinite(value) && value >= 0 && value !== noData ? -value : NaN
  ))
  const generator = contours().size([width, height])
  return (minutes) => {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) return null
    const { coordinates } = generator.contour(values, -60 * minutes)
    if (!coordinates.length) return null
    return {
      type: 'Feature', properties: {},
      geometry: {
        type: 'MultiPolygon',
        coordinates: coordinates.map((polygon) => polygon.map((ring) =>
          ring.map(([x, y]) => [lon + x * dx, lat + y * dy]))),
      },
    }
  }
}
