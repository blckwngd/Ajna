// UwbMultilateration — model B: compute the tag's world position ON-DEVICE from
// raw UWB ranges to anchors whose world positions are stored in Ajna.
//
// Unlike model A (the DWM onboard Location Engine + frame alignment), here the
// anchors' world positions ARE the frame, so the result is directly in WGS84 —
// no separate alignment transform. Ajna is the single source of anchor truth.
//
// Method: anchors → local ENU metres (equirectangular, like GeoTransformer),
// a linearized least-squares fix, then a few Gauss-Newton iterations to refine.
// 2D (E,N): assumes the tag is roughly in the anchor plane (typical RTLS); ≥3
// anchors with non-collinear geometry required. Pure + dependency-free.

const EARTH_R = 6378137

// Min vertical spread of anchors (m) for a 3D solve to be well-conditioned.
const MIN_3D_ALT_SPREAD = 0.5

/**
 * @param {object} args
 * @param {Array<{lat:number,lon:number,altitude?:number}>} args.anchors  matched anchor world positions
 * @param {number[]} args.ranges  measured distances to those anchors, METRES (same order)
 * @param {boolean} [args.refine=true]  run Gauss-Newton refinement
 * @param {'auto'|'2d'|'3d'} [args.mode='auto']  solve dimension
 * @returns {{lat,lon,altitude,local:{E,N,U},gdop:number,dim:2|3}|null}
 */
export function solvePositionFromRanges({ anchors, ranges, refine = true, mode = 'auto' }) {
  const n = anchors?.length || 0
  if (n < 3 || ranges?.length !== n) return null

  const origin = {
    lat: mean(anchors.map(a => a.lat)),
    lon: mean(anchors.map(a => a.lon)),
    altitude: mean(anchors.map(a => a.altitude || 0))
  }
  const A = anchors.map(a => wgs84ToEnu(origin, a.lat, a.lon, a.altitude || 0))
  // The linear solve cancels the quadratic |P|² term by subtracting one
  // "reference" anchor's equation (it uses the LAST anchor). Put the anchor
  // nearest the centroid last so a single edge/noisy anchor doesn't poison every
  // differenced equation. Reorder the ranges in lockstep (don't mutate caller's).
  const R = ranges.slice()
  reorderReferenceLast(A, R)

  // 3D needs ≥4 anchors AND enough vertical spread (else z is ill-conditioned).
  const us = A.map(a => a.U)
  const altSpread = Math.max(...us) - Math.min(...us)
  const want3D = mode === '3d' || (mode === 'auto' && n >= 4 && altSpread >= MIN_3D_ALT_SPREAD)

  let P = null, gdop = null, dim = 2
  if (want3D) {
    const lin = linearLeastSquares3D(A, R)
    if (lin) {
      P = refine ? gaussNewton3D(A, R, lin) : lin
      gdop = lin.gdop; dim = 3
    }
  }
  if (!P) {  // 2D (fallback or by choice): solve E,N, keep U at the anchor plane
    const lin = linearLeastSquares2D(A, R)
    if (!lin) return null
    const p2 = refine ? gaussNewton2D(A, R, lin) : lin
    P = { E: p2.E, N: p2.N, U: 0 }; gdop = lin.gdop; dim = 2
  }
  if (!Number.isFinite(P.E) || !Number.isFinite(P.N) || !Number.isFinite(P.U)) return null

  const w = enuToWgs84(origin, P.E, P.N, P.U)
  return { lat: w.lat, lon: w.lon, altitude: w.altitude, local: { E: P.E, N: P.N, U: P.U }, gdop, dim }
}

// Reorder A (and ranges R in lockstep) so the anchor nearest the centroid is
// last — that anchor becomes the linear solve's reference. A central reference
// conditions the differenced system better than an arbitrary edge anchor.
function reorderReferenceLast(A, R) {
  const n = A.length
  let cE = 0, cN = 0, cU = 0
  for (const a of A) { cE += a.E; cN += a.N; cU += a.U }
  cE /= n; cN /= n; cU /= n
  let best = n - 1, bestD = Infinity
  for (let i = 0; i < n; i++) {
    const dE = A[i].E - cE, dN = A[i].N - cN, dU = A[i].U - cU
    const d = dE * dE + dN * dN + dU * dU
    if (d < bestD) { bestD = d; best = i }
  }
  if (best !== n - 1) {
    const a = A[best]; A[best] = A[n - 1]; A[n - 1] = a
    const r = R[best]; R[best] = R[n - 1]; R[n - 1] = r
  }
}

// Linearized multilateration: subtract a reference anchor's equation to cancel
// the quadratic |P|² term, leaving a linear system  2(A_i − A_ref)·P = c_i.
function linearLeastSquares2D(A, ranges) {
  const n = A.length
  const ref = A[n - 1], rRef = ranges[n - 1]
  const lref = ref.E * ref.E + ref.N * ref.N
  let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0
  for (let i = 0; i < n - 1; i++) {
    const m0 = 2 * (A[i].E - ref.E)
    const m1 = 2 * (A[i].N - ref.N)
    const li = A[i].E * A[i].E + A[i].N * A[i].N
    const bi = (li - lref) - (ranges[i] * ranges[i] - rRef * rRef)
    a00 += m0 * m0; a01 += m0 * m1; a11 += m1 * m1
    b0 += m0 * bi; b1 += m1 * bi
  }
  const det = a00 * a11 - a01 * a01
  if (Math.abs(det) < 1e-9) return null   // collinear / degenerate geometry
  const E = (a11 * b0 - a01 * b1) / det
  const N = (-a01 * b0 + a00 * b1) / det
  // Geometric dilution of precision (trace of (MᵀM)⁻¹) — a quality hint.
  const gdop = Math.sqrt(Math.max(0, (a00 + a11) / det))
  return { E, N, gdop }
}

// Refine with Gauss-Newton on the nonlinear residuals r_i = |P − A_i| − range_i.
function gaussNewton2D(A, ranges, P0, iterations = 6) {
  let E = P0.E, N = P0.N
  for (let it = 0; it < iterations; it++) {
    let jtj00 = 0, jtj01 = 0, jtj11 = 0, jtr0 = 0, jtr1 = 0
    for (let i = 0; i < A.length; i++) {
      const dE = E - A[i].E, dN = N - A[i].N
      const d = Math.hypot(dE, dN)
      if (d < 1e-6) continue
      const j0 = dE / d, j1 = dN / d
      const r = d - ranges[i]
      jtj00 += j0 * j0; jtj01 += j0 * j1; jtj11 += j1 * j1
      jtr0 += j0 * r; jtr1 += j1 * r
    }
    const det = jtj00 * jtj11 - jtj01 * jtj01
    if (Math.abs(det) < 1e-12) break
    const dx = (jtj11 * jtr0 - jtj01 * jtr1) / det
    const dy = (-jtj01 * jtr0 + jtj00 * jtr1) / det
    E -= dx; N -= dy
    if (Math.hypot(dx, dy) < 1e-4) break   // converged (< 0.1 mm)
  }
  return { E, N }
}

// ── 3D variants (E,N,U): need ≥4 anchors with vertical spread ──────────

function linearLeastSquares3D(A, ranges) {
  const n = A.length
  const ref = A[n - 1], rRef = ranges[n - 1]
  const lref = ref.E * ref.E + ref.N * ref.N + ref.U * ref.U
  // Normal equations MᵀM (3×3) and Mᵀb (3).
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const b = [0, 0, 0]
  for (let i = 0; i < n - 1; i++) {
    const m = [2 * (A[i].E - ref.E), 2 * (A[i].N - ref.N), 2 * (A[i].U - ref.U)]
    const li = A[i].E * A[i].E + A[i].N * A[i].N + A[i].U * A[i].U
    const bi = (li - lref) - (ranges[i] * ranges[i] - rRef * rRef)
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) M[r][c] += m[r] * m[c]
      b[r] += m[r] * bi
    }
  }
  const x = solve3x3(M, b)
  if (!x) return null
  const inv = inv3x3(M)
  const gdop = inv ? Math.sqrt(Math.max(0, inv[0][0] + inv[1][1] + inv[2][2])) : null
  return { E: x[0], N: x[1], U: x[2], gdop }
}

function gaussNewton3D(A, ranges, P0, iterations = 8) {
  let E = P0.E, N = P0.N, U = P0.U
  for (let it = 0; it < iterations; it++) {
    const JtJ = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    const Jtr = [0, 0, 0]
    for (let i = 0; i < A.length; i++) {
      const dE = E - A[i].E, dN = N - A[i].N, dU = U - A[i].U
      const d = Math.sqrt(dE * dE + dN * dN + dU * dU)
      if (d < 1e-6) continue
      const j = [dE / d, dN / d, dU / d]
      const r = d - ranges[i]
      for (let a = 0; a < 3; a++) {
        for (let c = 0; c < 3; c++) JtJ[a][c] += j[a] * j[c]
        Jtr[a] += j[a] * r
      }
    }
    const dx = solve3x3(JtJ, Jtr)
    if (!dx) break
    E -= dx[0]; N -= dx[1]; U -= dx[2]
    if (Math.hypot(dx[0], dx[1], dx[2]) < 1e-4) break
  }
  return { E, N, U }
}

function det3x3(m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
       - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
       + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

function solve3x3(m, b) {  // Cramer's rule
  const det = det3x3(m)
  if (Math.abs(det) < 1e-9) return null
  const col = (k) => m.map((row, r) => row.map((v, c) => (c === k ? b[r] : v)))
  return [det3x3(col(0)) / det, det3x3(col(1)) / det, det3x3(col(2)) / det]
}

function inv3x3(m) {
  const det = det3x3(m)
  if (Math.abs(det) < 1e-9) return null
  const c = (r, k) => {  // cofactor
    const sub = []
    for (let i = 0; i < 3; i++) { if (i === r) continue; const row = []; for (let j = 0; j < 3; j++) { if (j === k) continue; row.push(m[i][j]) } sub.push(row) }
    const minor = sub[0][0] * sub[1][1] - sub[0][1] * sub[1][0]
    return ((r + k) % 2 ? -1 : 1) * minor
  }
  // inverse = adjugateᵀ / det
  const inv = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) inv[k][r] = c(r, k) / det
  return inv
}

// ── equirectangular WGS84 ↔ local ENU metres (matches GeoTransformer) ──

function wgs84ToEnu(origin, lat, lon, altitude) {
  const dLat = (lat - origin.lat) * Math.PI / 180
  const dLon = (lon - origin.lon) * Math.PI / 180
  const meanLat = (lat + origin.lat) / 2 * Math.PI / 180
  return { E: dLon * EARTH_R * Math.cos(meanLat), N: dLat * EARTH_R, U: (altitude || 0) - (origin.altitude || 0) }
}

function enuToWgs84(origin, E, N, U) {
  const lat = origin.lat + (N / EARTH_R) * 180 / Math.PI
  const meanLat = (lat + origin.lat) / 2 * Math.PI / 180
  const lon = origin.lon + (E / (EARTH_R * Math.cos(meanLat))) * 180 / Math.PI
  return { lat, lon, altitude: origin.altitude + U }
}

function mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length }
