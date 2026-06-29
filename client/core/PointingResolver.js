// PointingResolver — "what is the wand pointing at?" computed ON-DEVICE.
//
// Casts a ray from an origin (the wand's UWB position, or a fallback position)
// along the wand's world-frame pointing direction, and picks the object with the
// smallest angular deviation within a cone + range. No raw coordinates leave the
// device — only the resolved object id is later used for interact().
//
// Pure + dependency-free (no BABYLON). Frame: local ENU metres around the origin
// (E, N, U), matching GeoTransformer/UwbManager conventions; the pointing
// direction is the world ENU unit vector produced by WandManager.

const EARTH_R = 6378137

/**
 * Tolerant target pick with HYSTERESIS to absorb orientation/position
 * inaccuracy and stop flicker at cone edges: a new (different) object is only
 * acquired inside the narrow `coneDeg`, while the currently-selected object is
 * held until it leaves the wider `releaseDeg`.
 *
 * @param {object} args
 * @param {{lat:number,lon:number,altitude?:number}} args.origin  ray start
 * @param {[number,number,number]} args.direction  world ENU unit vector [E,N,U]
 * @param {Array<{id:string,lat:number,lon:number,altitude?:number}>} args.objects  (caller pre-filters to visible)
 * @param {number} [args.coneDeg=12]      acquire cone (new target)
 * @param {number} [args.releaseDeg]      release cone (keep current); default coneDeg*1.6
 * @param {number} [args.maxRangeM=50]    ignore objects farther than this
 * @param {string|null} [args.currentId]  currently selected id (for hysteresis)
 * @returns {{id:string, angleDeg:number, distanceM:number}|null}
 */
export function resolvePointingTarget({ origin, direction, objects, coneDeg = 12, releaseDeg, maxRangeM = 50, currentId = null }) {
  if (!origin || !Array.isArray(direction) || !objects?.length) return null
  // 2D-Auswahl: Treffer rein HORIZONTAL bestimmen (Höhe ignorieren). Der Stab-
  // Origin liegt auf Spieler-Höhe, viele Objekte aber am Boden (alt 0) — in 3D
  // sprengt dieser Höhenversatz den Kegel, obwohl der Strahl horizontal genau
  // aufs Objekt zeigt. (Für Mehrstöckiges — viele Geräte übereinander — später
  // wieder eine 3D-/Etagen-Auflösung erwägen.)
  const dh = Math.hypot(direction[0], direction[1])
  if (dh < 1e-6) return null
  const d = [direction[0] / dh, direction[1] / dh]   // horizontale Richtung [E,N]
  const release = releaseDeg ?? coneDeg * 1.6

  let bestNarrow = null   // best within the acquire cone
  let currentEntry = null // the current target, if still within the release cone
  for (const o of objects) {
    if (!Number.isFinite(o?.lat) || !Number.isFinite(o?.lon)) continue
    const v = wgs84ToEnu(origin, o.lat, o.lon, o.altitude || 0)
    const dist = Math.hypot(v.E, v.N)   // horizontale Distanz (Höhe ignoriert)
    if (dist < 1e-3 || dist > maxRangeM) continue
    const dot = (v.E * d[0] + v.N * d[1]) / dist
    const angle = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI
    if (angle > release) continue
    const entry = { id: o.id, angleDeg: angle, distanceM: dist }
    if (o.id === currentId) currentEntry = entry
    if (angle <= coneDeg) {
      const score = angle + dist * 0.05
      if (!bestNarrow || score < (bestNarrow.angleDeg + bestNarrow.distanceM * 0.05)) bestNarrow = entry
    }
  }
  // Switch only when a DIFFERENT object enters the acquire cone; otherwise keep
  // the current target while it stays inside the wider release cone.
  if (bestNarrow && bestNarrow.id !== currentId) return bestNarrow
  if (currentEntry) return currentEntry
  return bestNarrow
}

/**
 * World position `rangeM` along the pointing direction from `origin` — the
 * endpoint of the visual ray. direction = world ENU unit vector [E,N,U].
 */
export function rayEndpointWgs84(origin, direction, rangeM = 30) {
  const dl = Math.hypot(direction[0], direction[1], direction[2]) || 1
  const E = (direction[0] / dl) * rangeM
  const N = (direction[1] / dl) * rangeM
  const U = (direction[2] / dl) * rangeM
  const lat = origin.lat + (N / EARTH_R) * 180 / Math.PI
  const meanLat = (lat + origin.lat) / 2 * Math.PI / 180
  const lon = origin.lon + (E / (EARTH_R * Math.cos(meanLat))) * 180 / Math.PI
  return { lat, lon, altitude: (origin.altitude || 0) + U }
}

function wgs84ToEnu(origin, lat, lon, altitude) {
  const dLat = (lat - origin.lat) * Math.PI / 180
  const dLon = (lon - origin.lon) * Math.PI / 180
  const meanLat = (lat + origin.lat) / 2 * Math.PI / 180
  return {
    E: dLon * EARTH_R * Math.cos(meanLat),
    N: dLat * EARTH_R,
    U: (altitude || 0) - (origin.altitude || 0)
  }
}
