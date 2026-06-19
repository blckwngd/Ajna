// WorldMagneticModel — computes magnetic declination from the World Magnetic
// Model (default: WMM2025). Pure, offline, dependency-free.
//
// Used for auto-declination: the wand reports orientation relative to MAGNETIC
// north; this maps it to TRUE north for the AR/UWB world frame. Validated
// against NOAA's official WMM2025 test values (see geomag/wmm.test.mjs).
//
// Spherical-harmonic synthesis per the NOAA WMM technical report (Schmidt
// semi-normalized Legendre recursion, geodetic↔geocentric rotation).

import { WMM2025 } from './wmm2025.js'

const DEG = Math.PI / 180
// WGS84 ellipsoid (km) + geomagnetic reference radius (km).
const A_WGS = 6378.137
const F_WGS = 1 / 298.257223563
const E2 = F_WGS * (2 - F_WGS)
const RE = 6371.2

export class WorldMagneticModel {
  constructor(model = WMM2025) {
    this.model = model
    const N = model.maxDegree
    this.N = N
    // g[n][m], h[n][m] base + secular-variation arrays.
    this.g = make2D(N); this.h = make2D(N)
    this.dg = make2D(N); this.dh = make2D(N)
    for (const [n, m, gnm, hnm, dgnm, dhnm] of model.coeffs) {
      this.g[n][m] = gnm; this.h[n][m] = hnm
      this.dg[n][m] = dgnm; this.dh[n][m] = dhnm
    }
    // Schmidt semi-normalization factors S[n][m] (applied to Gauss-normalized
    // Legendre functions). Standard IGRF/WMM recursion.
    this.S = make2D(N)
    this.S[0][0] = 1
    for (let n = 1; n <= N; n++) {
      this.S[n][0] = this.S[n - 1][0] * (2 * n - 1) / n
      for (let m = 1; m <= n; m++) {
        const f = (m === 1) ? 2 : 1
        this.S[n][m] = this.S[n][m - 1] * Math.sqrt((n - m + 1) * f / (n + m))
      }
    }
  }

  /** Decimal year from a Date (UTC), e.g. 2026.46. */
  static decimalYear(date = new Date()) {
    const y = date.getUTCFullYear()
    const start = Date.UTC(y, 0, 1)
    const end = Date.UTC(y + 1, 0, 1)
    return y + (date.getTime() - start) / (end - start)
  }

  /**
   * Full geomagnetic field at a location/time.
   * @returns {{X,Y,Z,H,F,D,I}} components in nT and degrees.
   */
  field(latDeg, lonDeg, altKm = 0, decimalYear = WorldMagneticModel.decimalYear()) {
    const N = this.N
    const dt = decimalYear - this.model.epoch
    let lat = latDeg
    if (lat > 89.999) lat = 89.999
    else if (lat < -89.999) lat = -89.999

    const phi = lat * DEG
    const lambda = lonDeg * DEG
    const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi)

    // Geodetic → geocentric (spherical) coordinates.
    const Nrad = A_WGS / Math.sqrt(1 - E2 * sinPhi * sinPhi)
    const rho = (Nrad + altKm) * cosPhi
    const zc = (Nrad * (1 - E2) + altKm) * sinPhi
    const r = Math.sqrt(rho * rho + zc * zc)
    const sinPhiP = zc / r       // sin(geocentric lat)
    const cosPhiP = rho / r      // cos(geocentric lat)
    // Geocentric colatitude θ': ct = cosθ' = sin(geocentric lat), st = sinθ'.
    const ct = sinPhiP, st = cosPhiP

    // Gauss-normalized associated Legendre Pg[n][m] and dPg/dθ', then scale by
    // the Schmidt factors S[n][m] to get Schmidt semi-normalized P/dP.
    const Pg = make2D(N), dPg = make2D(N)
    Pg[0][0] = 1; dPg[0][0] = 0
    for (let m = 0; m <= N; m++) {
      if (m > 0) {  // Gauss diagonal: P^m_m = sinθ' · P^{m-1}_{m-1}
        Pg[m][m] = st * Pg[m - 1][m - 1]
        dPg[m][m] = st * dPg[m - 1][m - 1] + ct * Pg[m - 1][m - 1]
      }
      for (let n = m + 1; n <= N; n++) {
        const Knm = (n === m + 1) ? 0
          : ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3))
        const P2 = (n >= 2) ? Pg[n - 2][m] : 0
        const dP2 = (n >= 2) ? dPg[n - 2][m] : 0
        Pg[n][m] = ct * Pg[n - 1][m] - Knm * P2
        dPg[n][m] = ct * dPg[n - 1][m] - st * Pg[n - 1][m] - Knm * dP2
      }
    }
    const P = make2D(N), dP = make2D(N)
    for (let n = 0; n <= N; n++) for (let m = 0; m <= n; m++) {
      P[n][m] = this.S[n][m] * Pg[n][m]
      dP[n][m] = this.S[n][m] * dPg[n][m]
    }

    // Precompute cos/sin(mλ).
    const cml = new Array(N + 1), sml = new Array(N + 1)
    for (let m = 0; m <= N; m++) { cml[m] = Math.cos(m * lambda); sml[m] = Math.sin(m * lambda) }

    // Sum the field in geocentric spherical components.
    let Br = 0, Bt = 0, Bp = 0
    const arBase = RE / r
    for (let n = 1; n <= N; n++) {
      const arPow = Math.pow(arBase, n + 2)
      for (let m = 0; m <= n; m++) {
        const g = this.g[n][m] + dt * this.dg[n][m]
        const h = this.h[n][m] + dt * this.dh[n][m]
        const gc = g * cml[m] + h * sml[m]
        Br += (n + 1) * arPow * gc * P[n][m]
        Bt += arPow * gc * dP[n][m]
        Bp += arPow * m * (g * sml[m] - h * cml[m]) * P[n][m]
      }
    }
    // Geocentric elements (X'=north, Y'=east, Z'=down).
    //   X' = -B_θ = +Σ (a/r)^{n+2}(g cos+h sin) dP/dθ' = Bt
    const Xp = Bt
    const Yp = (Math.abs(st) < 1e-9) ? 0 : Bp / st
    const Zp = -Br

    // Rotate geocentric → geodetic by Δ = geocentric lat − geodetic lat.
    const delta = Math.atan2(sinPhiP, cosPhiP) - phi
    const cosD = Math.cos(delta), sinD = Math.sin(delta)
    const X = Xp * cosD - Zp * sinD
    const Z = Xp * sinD + Zp * cosD
    const Y = Yp

    const H = Math.hypot(X, Y)
    const F = Math.hypot(H, Z)
    const D = Math.atan2(Y, X) / DEG
    const I = Math.atan2(Z, H) / DEG
    return { X, Y, Z, H, F, D, I }
  }

  /** Magnetic declination in degrees (+E). */
  declination(latDeg, lonDeg, altKm = 0, decimalYear = WorldMagneticModel.decimalYear()) {
    return this.field(latDeg, lonDeg, altKm, decimalYear).D
  }
}

function make2D(N) {
  const a = new Array(N + 1)
  for (let i = 0; i <= N; i++) a[i] = new Array(N + 1).fill(0)
  return a
}

// Singleton for the bundled model.
export const wmm = new WorldMagneticModel(WMM2025)
