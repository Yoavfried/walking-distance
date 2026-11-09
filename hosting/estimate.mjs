import earcut, { flatten } from 'earcut'
import clip from 'polygon-clipping'
import proj4 from 'proj4'

const equalArea = proj4('EPSG:4326', '+proj=cea +lat_ts=30 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs')
const intersect = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
const containsBounds = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3]

function ringArea(ring) {
  const [x, y] = ring[0]
  let area = 0
  for (let i = 1; i + 1 < ring.length; i++) {
    const [ax, ay] = ring[i]
    const [bx, by] = ring[i + 1]
    area += (ax - x) * (by - y) - (ay - y) * (bx - x)
  }
  return Math.abs(area) / 2
}

function areaOf(polygons) {
  return polygons.reduce((sum, [outer, ...holes]) => (
    sum + ringArea(outer) - holes.reduce((area, ring) => area + ringArea(ring), 0)
  ), 0)
}

function boundsOf(polygons) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [outer] of polygons) {
    for (const [x, y] of outer) {
      bounds[0] = Math.min(bounds[0], x)
      bounds[1] = Math.min(bounds[1], y)
      bounds[2] = Math.max(bounds[2], x)
      bounds[3] = Math.max(bounds[3], y)
    }
  }
  return bounds
}

function roundVotes(weights, total) {
  const integers = weights.map(Math.floor)
  const remainders = weights.map((n, i) => [n - integers[i], i])
  remainders.sort(([a, ai], [b, bi]) => b - a || ai - bi)
  const remaining = total - integers.reduce((sum, n) => sum + n, 0)
  for (let i = 0; i < remaining; i++) integers[remainders[i][1]]++
  return integers
}

function sampler(polygons, seed) {
  let randomState = 2166136261
  for (const ch of seed) randomState = Math.imul(randomState ^ ch.charCodeAt(0), 16777619)
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
    return randomState / 4294967296
  }

  let total = 0
  const triangles = []
  for (const polygon of polygons) {
    const { vertices, holes } = flatten(polygon.map((ring) => ring.slice(0, -1)))
    const indices = earcut(vertices, holes)
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = indices.slice(i, i + 3).map((j) => 2 * j)
      const x = vertices[a], y = vertices[a + 1]
      const dx = vertices[b] - x, dy = vertices[b + 1] - y
      const ex = vertices[c] - x, ey = vertices[c + 1] - y
      const area = Math.abs(dx * ey - dy * ex) / 2
      if (area > 0) {
        total += area
        triangles.push([total, x, y, dx, dy, ex, ey])
      }
    }
  }
  return () => {
    const target = total * random()
    let lo = 0, hi = triangles.length - 1
    while (lo < hi) {
      const middle = (lo + hi) >>> 1
      if (triangles[middle][0] > target) hi = middle
      else lo = middle + 1
    }
    const [, x, y, dx, dy, ex, ey] = triangles[lo]
    let u = random(), v = random()
    if (u + v > 1) { u = 1 - u; v = 1 - v }
    return equalArea.inverse([x + u * dx + v * ex, y + u * dy + v * ey])
  }
}

export function estimate(snapshot, walk, minutes = 15) {
  const { geometry } = walk
  if (!['Polygon', 'MultiPolygon'].includes(geometry?.type)) throw new Error('Invalid walking contour')
  const outline = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  const projected = outline.map((poly) => poly.map((ring) => ring.map((p) => equalArea.forward(p))))
  const merged = projected.length > 1 ? clip.union(...projected) : projected
  const walkArea = areaOf(merged)
  if (!walkArea) throw new Error('Empty walking contour')
  const bounds = boundsOf(merged)
  const hasHoles = merged.some((polygon) => polygon.length > 1)
  let filled
  const parties = [...snapshot.parties].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const raw = parties.map(() => 0)
  const contributors = []
  const overlaps = []
  for (const unit of snapshot.units) {
    if (!intersect(unit.bounds, bounds)) continue
    const polygons = clip.intersection(merged, unit.polygons)
    let fraction = Math.min(1, areaOf(polygons) / unit.area)
    if (!(fraction > 0)) continue
    if (hasHoles && fraction < 1 && containsBounds(bounds, unit.bounds)) {
      // Use the hole-free outline only to check enclosure, never for placing dots.
      filled ??= clip.union(...merged.map(([outer]) => [outer]))
      if (areaOf(clip.difference(unit.polygons, filled)) <= unit.area * 1e-9) fraction = 1
    }
    const weights = parties.map((party, i) => {
      const value = (unit.votes[party.id] ?? 0) * fraction
      raw[i] += value
      return value
    })
    contributors.push({ polygons, weights, id: unit.id })
    overlaps.push({
      type: 'Feature',
      id: unit.id,
      properties: { name: unit.name, kind: unit.kind, fraction },
      geometry: { type: 'MultiPolygon', coordinates: polygons.map((poly) => poly.map((ring) => ring.map((p) => equalArea.inverse(p)))) },
    })
  }

  const total = Math.round(raw.reduce((sum, n) => sum + n, 0))
  const votes = roundVotes(raw, total)
  const countsByParty = votes.map((n, i) => roundVotes(contributors.map(({ weights }) => weights[i]), n))
  const dots = parties.map(() => [])
  for (let j = 0; j < contributors.length; j++) {
    const { id, polygons } = contributors[j]
    if (!countsByParty.some((counts) => counts[j])) continue
    const sample = sampler(polygons, id)
    countsByParty.forEach((counts, i) => {
      for (let k = 0; k < counts[j]; k++) dots[i].push(sample())
    })
  }
  return {
    buildId: snapshot.buildId,
    election: snapshot.election,
    minutes,
    votes: total,
    areaKm2: walkArea / 1_000_000,
    parties: parties.map((party, i) => ({ ...party, votes: votes[i], share: total ? votes[i] / total : 0, raw: raw[i] }))
      .sort((a, b) => b.votes - a.votes || b.raw - a.raw)
      .map(({ raw: _, ...party }) => party),
    walk,
    overlaps: { type: 'FeatureCollection', features: overlaps },
    dots: {
      type: 'FeatureCollection',
      features: parties.flatMap((party, i) => dots[i].length ? [{
        type: 'Feature', properties: { party: party.id, color: party.color },
        geometry: { type: 'MultiPoint', coordinates: dots[i] },
      }] : []),
    },
  }
}
