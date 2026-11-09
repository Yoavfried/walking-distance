export const ROUTER = 'https://valhalla1.openstreetmap.de/isochrone'
export const MAX_MINUTES = 30

export async function fetchWalkingGrid(lon, lat) {
  const query = new URLSearchParams({ json: JSON.stringify({
    locations: [{ lon: Number(lon.toFixed(5)), lat: Number(lat.toFixed(5)) }],
    costing: 'pedestrian', contours: [{ time: MAX_MINUTES }], format: 'geotiff',
  }) })
  return fetch(ROUTER + '?' + query, {
    headers: { 'X-Client-Id': 'yoavfried.com/walking-distance', Accept: 'image/tiff' },
    signal: AbortSignal.timeout(10_000),
  })
}
