// Regression test for UwbMultilateration (model B). Synthetic anchors + tag:
// compute true ranges, solve, check recovered position.
// Run: node client/core/UwbMultilateration.test.mjs
import { solvePositionFromRanges } from './UwbMultilateration.js'

const R = 6378137, PI = Math.PI
const origin = { lat: 50.3560, lon: 7.5890 }
const offToLL = (E, N, alt = 0) => {
  const lat = origin.lat + (N / R) * 180 / PI
  const meanLat = (lat + origin.lat) / 2 * PI / 180
  const lon = origin.lon + (E / (R * Math.cos(meanLat))) * 180 / PI
  return { lat, lon, altitude: alt }
}
const llToOff = (lat, lon) => {
  const dLat = (lat - origin.lat) * PI / 180, dLon = (lon - origin.lon) * PI / 180
  const meanLat = (lat + origin.lat) / 2 * PI / 180
  return { E: dLon * R * Math.cos(meanLat), N: dLat * R }
}
// True range consistent with the solver's equirectangular ENU.
const rangeTo = (a, tag) => {
  const oa = llToOff(a.lat, a.lon), ot = llToOff(tag.lat, tag.lon)
  return Math.hypot(ot.E - oa.E, ot.N - oa.N, (tag.altitude || 0) - (a.altitude || 0))
}
const errTo = (sol, tag) => {
  const os = llToOff(sol.lat, sol.lon), ot = llToOff(tag.lat, tag.lon)
  return Math.hypot(os.E - ot.E, os.N - ot.N, (sol.altitude || 0) - (tag.altitude || 0))
}

let ok = true

// ── 2D: coplanar anchors, tag in-plane ──
{
  const anchors = [[0, 0], [12, 0], [0, 9], [12, 9]].map(([E, N]) => offToLL(E, N))
  const tag = offToLL(4, 3)
  const ranges = anchors.map(a => rangeTo(a, tag))
  const sol = solvePositionFromRanges({ anchors, ranges })
  const e = sol ? errTo(sol, tag) : Infinity
  console.log(`2D exact:      dim=${sol?.dim} err=${(e * 100).toFixed(2)} cm gdop=${sol?.gdop?.toFixed(2)}`)
  ok = e < 0.002 && sol?.dim === 2 && ok
  const noisy = ranges.map((r, i) => r + (((i * 37) % 11) - 5) / 100)   // ±5 cm
  const s2 = solvePositionFromRanges({ anchors, ranges: noisy })
  const e2 = s2 ? errTo(s2, tag) : Infinity
  console.log(`2D noisy ±5cm: dim=${s2?.dim} err=${(e2 * 100).toFixed(2)} cm`)
  ok = e2 < 0.30 && ok
}

// ── 3D: anchors at varying heights, tag above the floor ──
{
  const anchors = [[0, 0, 0], [12, 0, 3], [0, 9, 3], [12, 9, 0]].map(([E, N, A]) => offToLL(E, N, A))
  const tag = offToLL(5, 4, 1.6)
  const ranges = anchors.map(a => rangeTo(a, tag))
  const sol = solvePositionFromRanges({ anchors, ranges })
  const e = sol ? errTo(sol, tag) : Infinity
  console.log(`3D exact:      dim=${sol?.dim} err=${(e * 100).toFixed(2)} cm alt=${sol?.altitude?.toFixed(2)} gdop=${sol?.gdop?.toFixed(2)}`)
  ok = e < 0.01 && sol?.dim === 3 && ok
  const noisy = ranges.map((r, i) => r + (((i * 29) % 9) - 4) / 100)    // ±4 cm
  const s2 = solvePositionFromRanges({ anchors, ranges: noisy })
  const e2 = s2 ? errTo(s2, tag) : Infinity
  console.log(`3D noisy ±4cm: dim=${s2?.dim} err=${(e2 * 100).toFixed(2)} cm`)
  ok = e2 < 0.6 && ok
}

console.log(ok ? '\nPASS ✅' : '\nFAIL ❌')
process.exit(ok ? 0 : 1)
