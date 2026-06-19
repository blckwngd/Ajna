// StreetNav — Wegenetz-Navigation für autonome Figuren.
//
// Reine Geo-/Graph-Mathematik, ohne DOM oder Netz: importierbar von Node
// (agents/world-director.mjs) wie vom Browser. Quelle der Wege ist die
// Geo-API (AjnaGeo.waysNear → GeoJSON-artige Features mit `coordinates`
// als [[lat,lon], …]-Polyline).
//
// Pipeline:
//   buildWayGraph(features)  → Knoten/Kanten, an geteilten OSM-Vertices
//                              (identische Koordinaten an Kreuzungen)
//                              automatisch verknüpft
//   planRoute(features, lat, lon)
//                            → { path: [[lat,lon],…], lengthM } zu einem
//                              zufälligen erreichbaren Ziel im lokalen Netz
//   stepAlongPath(path, cursor, distM)
//                            → Cursor um distM Meter entlang der Polyline
//                              vorrücken (kein Ping-Pong: hält am Ziel an)
//
// Die Lauf-Mathematik (Segment-Interpolation, Bearing→Heading) entspricht
// der Demo in client/agent.js, hier aber als pure, testbare Funktionen.

const EARTH_R = 6371000

/** Großkreis-Distanz in Metern. */
export function haversine(aLat, aLon, bLat, bLon) {
  const phi1 = aLat * Math.PI / 180
  const phi2 = bLat * Math.PI / 180
  const dPhi = (bLat - aLat) * Math.PI / 180
  const dLam = (bLon - aLon) * Math.PI / 180
  const s = Math.sin(dPhi / 2) ** 2 +
            Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2
  return EARTH_R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s))
}

/** Kompass-Bearing in Radianten: 0 = Nord, +π/2 = Ost (im Uhrzeigersinn). */
export function bearingRad(aLat, aLon, bLat, bLon) {
  const phi1 = aLat * Math.PI / 180
  const phi2 = bLat * Math.PI / 180
  const dLam = (bLon - aLon) * Math.PI / 180
  const y = Math.sin(dLam) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) -
            Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam)
  return Math.atan2(y, x)
}

// ───────────────────────────────────────────────────────────────────────
//  Path-Stepping
// ───────────────────────────────────────────────────────────────────────

/**
 * Rückt einen Cursor um `distM` Meter entlang einer Polyline vor.
 * @param {Array<[number,number]>} path  [[lat,lon], …]
 * @param {{segIdx:number, segT:number}} cursor  Segment-Index + Fortschritt [0..1]
 * @param {number} distM  zurückzulegende Distanz in Metern
 * @returns {{lat:number, lon:number, headingRad:number, segIdx:number, segT:number, done:boolean}}
 *   done=true, sobald das Pfad-Ende erreicht ist (kein Ping-Pong).
 */
export function stepAlongPath(path, cursor, distM) {
  if (!Array.isArray(path) || path.length === 0) {
    return { lat: 0, lon: 0, headingRad: 0, segIdx: 0, segT: 0, done: true }
  }
  if (path.length === 1) {
    return { lat: path[0][0], lon: path[0][1], headingRad: 0, segIdx: 0, segT: 0, done: true }
  }

  let segIdx = cursor.segIdx ?? 0
  let segT = cursor.segT ?? 0
  let remaining = Math.max(0, distM)
  let headingRad = 0

  while (true) {
    const from = path[segIdx]
    const to = path[segIdx + 1]
    if (!to) {
      // Pfad-Ende erreicht.
      return { lat: from[0], lon: from[1], headingRad, segIdx, segT: 0, done: true }
    }
    const segLen = haversine(from[0], from[1], to[0], to[1])
    headingRad = bearingRad(from[0], from[1], to[0], to[1])
    if (segLen < 1e-3) { segIdx++; segT = 0; continue }  // entartetes Segment

    const remainOnSeg = (1 - segT) * segLen
    if (remaining >= remainOnSeg) {
      // Zum nächsten Stützpunkt springen, Restdistanz weitertragen.
      remaining -= remainOnSeg
      segIdx++
      segT = 0
    } else {
      // Innerhalb des Segments interpolieren.
      segT += remaining / segLen
      return {
        lat: from[0] + (to[0] - from[0]) * segT,
        lon: from[1] + (to[1] - from[1]) * segT,
        headingRad, segIdx, segT, done: false
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────
//  Wegegraph
// ───────────────────────────────────────────────────────────────────────

const keyOf = (lat, lon, p) => `${lat.toFixed(p)},${lon.toFixed(p)}`

/**
 * Baut aus Way-Features einen ungerichteten Graphen. Stützpunkte mit
 * (quantisiert) identischen Koordinaten sind derselbe Knoten — so werden
 * Wege an Kreuzungen automatisch verbunden (OSM teilt dort exakt einen Node).
 * @param {Array<{coordinates:Array<[number,number]>}>} features
 * @returns {{nodes: Map<string,{lat,lon}>, adj: Map<string, Array<{key,w}>>}}
 */
export function buildWayGraph(features, { precision = 7 } = {}) {
  const nodes = new Map()
  const adj = new Map()
  const ensure = (lat, lon) => {
    const k = keyOf(lat, lon, precision)
    if (!nodes.has(k)) { nodes.set(k, { lat, lon }); adj.set(k, []) }
    return k
  }
  const link = (ka, kb) => {
    if (ka === kb) return
    const a = nodes.get(ka), b = nodes.get(kb)
    const w = haversine(a.lat, a.lon, b.lat, b.lon)
    if (!adj.get(ka).some(e => e.key === kb)) adj.get(ka).push({ key: kb, w })
    if (!adj.get(kb).some(e => e.key === ka)) adj.get(kb).push({ key: ka, w })
  }
  for (const f of (features || [])) {
    const coords = f?.coordinates
    if (!Array.isArray(coords) || coords.length < 2) continue
    let prev = ensure(coords[0][0], coords[0][1])
    for (let i = 1; i < coords.length; i++) {
      const k = ensure(coords[i][0], coords[i][1])
      link(prev, k)
      prev = k
    }
  }
  return { nodes, adj }
}

/** Knoten-Key, der `lat/lon` am nächsten liegt (oder null bei leerem Graph). */
export function nearestNodeKey(graph, lat, lon) {
  let best = null, bestD = Infinity
  for (const [k, n] of graph.nodes) {
    const d = haversine(lat, lon, n.lat, n.lon)
    if (d < bestD) { bestD = d; best = k }
  }
  return best
}

// Dijkstra ab fromKey. Liefert dist-Map (+ prev-Map für Pfadrekonstruktion).
// O(V²)-Selektion genügt — die lokalen Netze haben typ. < paar hundert Knoten.
function dijkstra(graph, fromKey, toKey = null) {
  const dist = new Map(), prev = new Map(), visited = new Set()
  for (const k of graph.nodes.keys()) dist.set(k, Infinity)
  if (!dist.has(fromKey)) return { dist, prev }
  dist.set(fromKey, 0)

  while (true) {
    let u = null, best = Infinity
    for (const [k, d] of dist) { if (!visited.has(k) && d < best) { best = d; u = k } }
    if (u === null || best === Infinity) break
    visited.add(u)
    if (u === toKey) break
    for (const e of (graph.adj.get(u) || [])) {
      if (visited.has(e.key)) continue
      const nd = dist.get(u) + e.w
      if (nd < dist.get(e.key)) { dist.set(e.key, nd); prev.set(e.key, u) }
    }
  }
  return { dist, prev }
}

/** Kürzester Pfad als [[lat,lon], …] oder null, wenn toKey unerreichbar. */
export function shortestPath(graph, fromKey, toKey) {
  if (fromKey === toKey) {
    const n = graph.nodes.get(fromKey)
    return n ? [[n.lat, n.lon]] : null
  }
  const { dist, prev } = dijkstra(graph, fromKey, toKey)
  if (!Number.isFinite(dist.get(toKey))) return null

  const path = []
  let cur = toKey
  while (cur !== undefined) {
    const n = graph.nodes.get(cur)
    path.unshift([n.lat, n.lon])
    if (cur === fromKey) break
    cur = prev.get(cur)
  }
  return path.length >= 2 ? path : null
}

/**
 * Zufälliger, von fromKey aus erreichbarer Zielknoten. Bevorzugt Knoten in
 * [minDistM, maxDistM]; gibt es keine, fällt es auf irgendeinen erreichbaren
 * zurück. rng() für Testbarkeit injizierbar.
 */
export function randomReachableTarget(graph, fromKey, { minDistM = 40, maxDistM = Infinity, rng = Math.random } = {}) {
  const { dist } = dijkstra(graph, fromKey)
  const inBand = [], anyReach = []
  for (const [k, d] of dist) {
    if (k === fromKey || !Number.isFinite(d)) continue
    anyReach.push(k)
    if (d >= minDistM && d <= maxDistM) inBand.push(k)
  }
  const pool = inBand.length ? inBand : anyReach
  if (!pool.length) return null
  return pool[Math.floor(rng() * pool.length)]
}

/**
 * Komfort: aus Way-Features eine Route von (lat,lon) zu einem zufälligen
 * erreichbaren Ziel planen. Liefert null, wenn kein begehbares Netz da ist.
 * @returns {{path:Array<[number,number]>, lengthM:number, targetKey:string}|null}
 */
export function planRoute(features, lat, lon, { minDistM = 40, maxDistM = Infinity, rng = Math.random, precision = 7 } = {}) {
  const graph = buildWayGraph(features, { precision })
  if (graph.nodes.size < 2) return null
  const startKey = nearestNodeKey(graph, lat, lon)
  if (!startKey) return null
  const targetKey = randomReachableTarget(graph, startKey, { minDistM, maxDistM, rng })
  if (!targetKey) return null
  const path = shortestPath(graph, startKey, targetKey)
  if (!path || path.length < 2) return null

  let lengthM = 0
  for (let i = 1; i < path.length; i++) lengthM += haversine(path[i-1][0], path[i-1][1], path[i][0], path[i][1])
  return { path, lengthM, targetKey }
}
