// Validation for StreetNav (Wegegraph + Routing + Path-Stepping).
// Synthetisches Netz aus zwei Wegen, die sich an einem geteilten Vertex
// kreuzen — prüft Stitching, Dijkstra über die Kreuzung und das Stepping.
// Run: node client/core/StreetNav.test.mjs
import {
  haversine, bearingRad, stepAlongPath,
  buildWayGraph, nearestNodeKey, shortestPath, randomReachableTarget, planRoute
} from './StreetNav.js'

let failures = 0
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`) }
  else { console.error(`  ✗ ${msg}`); failures++ }
}
const approx = (a, b, tol) => Math.abs(a - b) <= tol

// Deterministischer RNG (LCG) — kein Math.random für stabilen Test.
let seed = 987654321
const rng = () => { seed = (1103515245 * seed + 12345) & 0x7fffffff; return seed / 0x7fffffff }

// ── Synthetisches Netz: Weg A horizontal, Weg B vertikal, geteilter Vertex
//    bei (50.0000, 7.0010). ──────────────────────────────────────────────
const wayA = { coordinates: [
  [50.0000, 7.0000], [50.0000, 7.0005], [50.0000, 7.0010], [50.0000, 7.0015], [50.0000, 7.0020]
] }
const wayB = { coordinates: [
  [49.9990, 7.0010], [49.9995, 7.0010], [50.0000, 7.0010], [50.0005, 7.0010], [50.0010, 7.0010]
] }
const features = [wayA, wayB]

console.log('haversine / bearing:')
assert(approx(haversine(50.0, 7.0000, 50.0, 7.0010), 71.6, 3), 'haversine ~71.6 m über 0.001° lon @50°N')
assert(approx(bearingRad(50.0, 7.0, 50.0, 7.001), Math.PI / 2, 0.02), 'bearing nach Osten ≈ +π/2')
assert(approx(bearingRad(50.0, 7.0, 50.001, 7.0), 0, 0.02), 'bearing nach Norden ≈ 0')

console.log('buildWayGraph (Stitching):')
const graph = buildWayGraph(features)
assert(graph.nodes.size === 9, `9 Knoten (5+5−1 geteilt), ist ${graph.nodes.size}`)
const interKey = nearestNodeKey(graph, 50.0000, 7.0010)
assert(graph.adj.get(interKey).length === 4, `Kreuzungsknoten hat 4 Nachbarn, ist ${graph.adj.get(interKey).length}`)

console.log('shortestPath über die Kreuzung:')
const startKey = nearestNodeKey(graph, 50.0000, 7.0000)   // Weg-A-Anfang
const endKey   = nearestNodeKey(graph, 50.0010, 7.0010)   // Weg-B-Ende
const path = shortestPath(graph, startKey, endKey)
assert(Array.isArray(path) && path.length >= 4, `Pfad gefunden (${path?.length} Punkte)`)
assert(approx(path[0][0], 50.0, 1e-6) && approx(path[0][1], 7.0, 1e-6), 'Pfad startet am Weg-A-Anfang')
const last = path[path.length - 1]
assert(approx(last[0], 50.0010, 1e-6) && approx(last[1], 7.0010, 1e-6), 'Pfad endet am Weg-B-Ende')
assert(path.some(p => approx(p[0], 50.0, 1e-6) && approx(p[1], 7.0010, 1e-6)), 'Pfad läuft durch die Kreuzung')
let routeLen = 0
for (let i = 1; i < path.length; i++) routeLen += haversine(path[i-1][0], path[i-1][1], path[i][0], path[i][1])
assert(approx(routeLen, 182, 25), `Routenlänge ~182 m, ist ${routeLen.toFixed(1)}`)

console.log('shortestPath: unerreichbares Ziel → null:')
const isolated = buildWayGraph([wayA, { coordinates: [[51.0, 8.0], [51.0, 8.001]] }])
const aKey = nearestNodeKey(isolated, 50.0, 7.0)
const farKey = nearestNodeKey(isolated, 51.0, 8.001)
assert(shortestPath(isolated, aKey, farKey) === null, 'getrennte Komponente liefert null')

console.log('stepAlongPath:')
const straight = [[50.0, 7.0000], [50.0, 7.0010]]   // ~71.6 m, rein nach Osten
let cur = { segIdx: 0, segT: 0 }
const s1 = stepAlongPath(straight, cur, 10)
assert(!s1.done && s1.lon > 7.0 && s1.lon < 7.001, '10 m-Schritt bleibt im Segment')
assert(approx(s1.headingRad, Math.PI / 2, 0.02), 'Heading nach Osten während des Schritts')
// In kleinen Schritten bis zum Ende laufen und Gesamtdistanz prüfen.
cur = { segIdx: 0, segT: 0 }
let acc = 0, guard = 0
while (true) {
  const prevLat = stepLat(straight, cur), prevLon = stepLon(straight, cur)
  const st = stepAlongPath(straight, cur, 5)
  acc += haversine(prevLat, prevLon, st.lat, st.lon)
  cur = { segIdx: st.segIdx, segT: st.segT }
  if (st.done) break
  if (++guard > 1000) { assert(false, 'Stepping terminiert'); break }
}
assert(approx(acc, 71.6, 4), `inkrementelles Stepping summiert ~71.6 m, ist ${acc.toFixed(1)}`)
const over = stepAlongPath(straight, { segIdx: 0, segT: 0 }, 500)
assert(over.done && approx(over.lon, 7.0010, 1e-6), 'Überschuss-Distanz endet am Pfadende (done)')

console.log('planRoute (deterministisch via seeded rng):')
const route = planRoute(features, 50.0000, 7.0001, { minDistM: 20, rng })
assert(route && route.path.length >= 2, 'planRoute liefert eine gültige Route')
assert(route && route.lengthM > 20, `Routenlänge > 20 m, ist ${route?.lengthM.toFixed(1)}`)

// Helfer: aktuelle Cursor-Position auf einer Polyline (für die Distanzsumme).
function stepLat(p, c) { const f = p[c.segIdx], t = p[c.segIdx + 1] || f; return f[0] + (t[0] - f[0]) * (c.segT || 0) }
function stepLon(p, c) { const f = p[c.segIdx], t = p[c.segIdx + 1] || f; return f[1] + (t[1] - f[1]) * (c.segT || 0) }

console.log(failures === 0 ? '\nAll StreetNav tests passed.' : `\n${failures} test(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
