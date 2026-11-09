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

export function fetchHostedWalkingGrid(endpoint, bypass, lon, lat) {
  const url = new URL(endpoint)
  if (!bypass || url.protocol !== 'https:' || !/^[a-z0-9-]+\.vercel\.app$/.test(url.hostname) ||
      url.port || url.username || url.password || url.pathname !== '/api/grid' || url.search || url.hash) {
    throw new Error('Invalid hosted router configuration')
  }
  return fetch(url.href, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'image/tiff',
      'x-vercel-protection-bypass': bypass,
    },
    body: JSON.stringify({ lon: Number(lon.toFixed(5)), lat: Number(lat.toFixed(5)) }),
    // Workers only support follow or manual; never forward the bypass key to a redirect.
    redirect: 'manual',
    signal: AbortSignal.timeout(14_000),
  })
}
