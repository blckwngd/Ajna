// PositionFilter — fuse a low-rate, noisy UWB position with high-rate IMU
// (linear-acceleration) predictions into a smooth, higher-rate world position.
//
// Why: UWB gives ABSOLUTE position at a few Hz with cm-level noise; the IMU on
// the moving tag gives motion at ~50 Hz but drifts. A constant-velocity Kalman
// filter uses UWB as the position measurement and IMU accel as the prediction
// (control) input → smoother output, dead-reckoning across UWB gaps, and
// outlier rejection (a UWB fix that disagrees with the predicted state too much
// is dropped). IMU lives only on the moving tags; anchors are static.
//
// The E/N/U axes are independent under a constant-velocity model with an accel
// input, so we run three decoupled 1-D filters (state [pos, vel], 2×2 cov) —
// equivalent to a 6-D filter but far simpler and numerically robust.
//
// Frames: feed it UWB fixes as {lat,lon,altitude} and IMU accel as a world-ENU
// vector [aE,aN,aU] in m/s² (WandManager already rotates the BNO linear accel
// into the AR/UWB ENU frame). The first UWB fix pins the local ENU origin; the
// output is converted back to WGS84 against that origin.


// One axis: constant-velocity Kalman filter, state [pos, vel], accel input.
import { wgs84ToEnu, enuToWgs84 } from './geoMath.js'

class AxisKF {
  constructor(accelVar, measVar) {
    this.qa = accelVar      // process noise: accel uncertainty σ_a² (m/s²)²
    this.r = measVar        // measurement noise σ_z² (m²)
    this.p = 0; this.v = 0  // state
    this.P00 = 1; this.P01 = 0; this.P10 = 0; this.P11 = 1  // covariance
    this.init = false
  }

  // Predict dt seconds forward with world-frame accel a (m/s²).
  predict(dt, a) {
    if (!this.init || dt <= 0) return
    // state: constant-velocity + accel input
    this.p += this.v * dt + 0.5 * a * dt * dt
    this.v += a * dt
    // covariance P = F P Fᵀ + Q, F = [[1,dt],[0,1]] (computed in closed form)
    const { P00, P01, P10, P11 } = this
    const n00 = P00 + dt * (P01 + P10) + dt * dt * P11
    const n01 = P01 + dt * P11
    const n10 = P10 + dt * P11
    const n11 = P11
    // process noise from accel uncertainty (continuous white-accel model)
    const dt2 = dt * dt, dt3 = dt2 * dt, dt4 = dt3 * dt
    this.P00 = n00 + dt4 / 4 * this.qa
    this.P01 = n01 + dt3 / 2 * this.qa
    this.P10 = n10 + dt3 / 2 * this.qa
    this.P11 = n11 + dt2 * this.qa
  }

  // Normalized innovation squared for measurement z (for χ² outlier gating).
  nis(z) {
    if (!this.init) return 0
    const y = z - this.p
    const S = this.P00 + this.r
    return (y * y) / S
  }

  // Correct with position measurement z.
  update(z) {
    if (!this.init) {        // bootstrap state from the first fix
      this.p = z; this.v = 0
      this.P00 = this.r; this.P01 = 0; this.P10 = 0; this.P11 = 1
      this.init = true
      return
    }
    const y = z - this.p
    const S = this.P00 + this.r
    const K0 = this.P00 / S
    const K1 = this.P10 / S
    this.p += K0 * y
    this.v += K1 * y
    // P = (I - K H) P, H = [1, 0]
    const { P00, P01, P10, P11 } = this
    this.P00 = (1 - K0) * P00
    this.P01 = (1 - K0) * P01
    this.P10 = P10 - K1 * P00
    this.P11 = P11 - K1 * P01
  }
}

export class PositionFilter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.accelNoise=1.5]  accel std (m/s²) → process noise
   * @param {number} [opts.measNoise=0.15]  UWB position std (m) → meas noise
   * @param {number} [opts.gateChi2=11.34]  χ²(3 dof, 99%) outlier reject threshold
   * @param {number} [opts.maxPredictDt=0.5] cap a single prediction step (s)
   */
  constructor({ accelNoise = 1.5, measNoise = 0.15, gateChi2 = 11.34, maxPredictDt = 0.5 } = {}) {
    const av = accelNoise * accelNoise, mv = measNoise * measNoise
    this.kf = [new AxisKF(av, mv), new AxisKF(av, mv), new AxisKF(av, mv)]  // E,N,U
    this.gateChi2 = gateChi2
    this.maxPredictDt = maxPredictDt
    this.origin = null      // ENU origin (first UWB fix)
    this._lastT = null      // last step time (ms)
    this._last = null       // last emitted fused position
    this._cbs = new Set()
    this._rejected = 0
  }

  /** Subscribe to fused positions. Returns an unsubscribe fn. */
  onPosition(cb) { this._cbs.add(cb); return () => this._cbs.delete(cb) }

  /** Latest fused position, or null before the first UWB fix. */
  position() { return this._last }

  get rejectedCount() { return this._rejected }

  /** IMU prediction step. accel = world-ENU [aE,aN,aU] (m/s²), now = ms. */
  predict(accel, now = _now()) {
    if (!this.origin || !this.kf[0].init) return  // nothing to propagate yet
    const dt = this._dt(now)
    if (dt <= 0 || dt > this.maxPredictDt) return  // skip first / big gaps
    const a = Array.isArray(accel) ? accel : [0, 0, 0]
    this.kf[0].predict(dt, a[0] || 0)
    this.kf[1].predict(dt, a[1] || 0)
    this.kf[2].predict(dt, a[2] || 0)
    this._emit(now)
  }

  /** UWB measurement update. pos = {lat,lon,altitude}, now = ms. */
  update(pos, now = _now()) {
    if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lon)) return
    if (!this.origin) this.origin = { lat: pos.lat, lon: pos.lon, altitude: pos.altitude || 0 }
    const e = wgs84ToEnu(this.origin, pos.lat, pos.lon, pos.altitude || 0)
    const z = [e.E, e.N, e.U]
    // Run any pending prediction up to this measurement's time first.
    const dt = this._dt(now)
    if (this.kf[0].init && dt > 0 && dt <= this.maxPredictDt) {
      this.kf[0].predict(dt, 0); this.kf[1].predict(dt, 0); this.kf[2].predict(dt, 0)
    }
    // χ² outlier gate (only once initialized): reject a wildly disagreeing fix.
    if (this.kf[0].init) {
      const nis = this.kf[0].nis(z[0]) + this.kf[1].nis(z[1]) + this.kf[2].nis(z[2])
      if (nis > this.gateChi2) { this._rejected++; return }
    }
    this.kf[0].update(z[0]); this.kf[1].update(z[1]); this.kf[2].update(z[2])
    this._emit(now)
  }

  /** Drop filter state (e.g. tag disconnect) so the next fix re-bootstraps. */
  reset() {
    for (const k of this.kf) { k.init = false; k.p = 0; k.v = 0; k.P00 = 1; k.P01 = 0; k.P10 = 0; k.P11 = 1 }
    this.origin = null; this._lastT = null; this._last = null
  }

  _dt(now) {
    const prev = this._lastT
    this._lastT = now
    return prev == null ? 0 : (now - prev) / 1000
  }

  _emit(now) {
    if (!this.kf[0].init) return
    const E = this.kf[0].p, N = this.kf[1].p, U = this.kf[2].p
    const w = enuToWgs84(this.origin, E, N, U)
    this._last = {
      lat: w.lat, lon: w.lon, altitude: w.altitude,
      local: { E, N, U },
      vel: { E: this.kf[0].v, N: this.kf[1].v, U: this.kf[2].v },
      fused: true, t: now
    }
    for (const cb of this._cbs) { try { cb(this._last) } catch {} }
  }
}

function _now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
}

// equirectangular WGS84 ↔ local ENU metres (matches GeoTransformer / model B)

