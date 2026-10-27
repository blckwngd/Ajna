// aimMath — the arithmetic behind pointing: directions, calibration, drift.
//
// Pure and dependency-light (only the sun position), so it runs in the
// browser, in the app and in tests alike.
//
// CONVENTIONS, used everywhere in client/core/aim/:
//   yaw    compass bearing in degrees, 0 = true north, clockwise
//   pitch  degrees above the horizon (+90 = straight up, −90 = straight down)
//   ENU    local east/north/up, the frame of PointingResolver and the scene

import { sunPosition } from '../solarPosition.js'

const RAD = Math.PI / 180

/** Degrees into [0, 360). */
export const normDeg = (d) => ((Number(d) % 360) + 360) % 360

/** Signed smallest difference a − b in degrees, in (−180, 180]. */
export function angleDiff(a, b) {
  const d = normDeg(a - b)
  return d > 180 ? d - 360 : d
}

/** Yaw/pitch → ENU unit vector [E, N, U]. */
export function directionFromYawPitch(yawDeg, pitchDeg = 0) {
  const y = normDeg(yawDeg) * RAD
  const p = Math.max(-90, Math.min(90, Number(pitchDeg) || 0)) * RAD
  return [Math.sin(y) * Math.cos(p), Math.cos(y) * Math.cos(p), Math.sin(p)]
}

/** ENU vector → { yaw, pitch } in degrees. */
export function yawPitchFromDirection([e, n, u]) {
  const h = Math.hypot(e, n)
  return { yaw: normDeg(Math.atan2(e, n) / RAD), pitch: Math.atan2(u, h) / RAD }
}

// ── Calibration on a known direction ─────────────────────────────────────
//
// The user points at something whose direction is known and presses
// "calibrate". The difference between what the device reports and what is
// true becomes the source's yaw offset. Works for devices WITH a compass
// (local magnetic disturbance, device bias) and is the only way for devices
// WITHOUT one (gyro only: yaw is relative, pitch is absolute from gravity).

/** Below this the sun is too low to be a usable target (degrees). */
export const SUN_MIN_ALTITUDE_DEG = 3
/** Pitch check tolerance for sun and shadow (degrees). */
export const PITCH_TOLERANCE_DEG = 15

/**
 * Where should the device point for this calibration target?
 *
 * @param {object} t
 * @param {'shadow'|'sun'|'landmark'} t.kind
 * @param {{lat:number, lon:number}} t.at          where the user stands
 * @param {Date} [t.time]
 * @param {{lat:number, lon:number}} [t.landmark]  for kind 'landmark'
 * @returns {{ok:true, yaw:number, pitch:number|null, check:'above'|'below'|'none'} | {ok:false, reason:string}}
 *   `pitch` is the expected elevation where it is known (sun); `check` says
 *   what the pitch plausibility test is for the others.
 */
export function calibrationTarget({ kind, at, time = new Date(), landmark = null }) {
  if (!at || !Number.isFinite(at.lat) || !Number.isFinite(at.lon)) return { ok: false, reason: 'no_position' }
  if (kind === 'sun' || kind === 'shadow') {
    const s = sunPosition(time, at.lat, at.lon)
    const alt = s.altitude / RAD
    if (alt < SUN_MIN_ALTITUDE_DEG) return { ok: false, reason: 'sun_too_low' }
    const az = normDeg(s.azimuth / RAD)
    // The shadow runs away from the sun on the ground: you point DOWN along it.
    // The exact angle depends on how far along the shadow one points — only
    // "below the horizon" is checkable.
    return kind === 'sun'
      ? { ok: true, yaw: az, pitch: alt, check: 'above' }
      : { ok: true, yaw: normDeg(az + 180), pitch: null, check: 'below' }
  }
  if (kind === 'landmark') {
    if (!landmark || !Number.isFinite(landmark.lat) || !Number.isFinite(landmark.lon)) return { ok: false, reason: 'no_landmark' }
    const kLon = Math.cos(at.lat * RAD)
    const e = (landmark.lon - at.lon) * kLon, n = landmark.lat - at.lat
    if (Math.hypot(e, n) < 1e-6) return { ok: false, reason: 'landmark_here' }
    return { ok: true, yaw: normDeg(Math.atan2(e, n) / RAD), pitch: null, check: 'none' }
  }
  return { ok: false, reason: 'unknown_kind' }
}

/**
 * The calibration itself: offset = true − measured yaw, after a plausibility
 * test on pitch where one is possible.
 *
 * @param {{yaw:number, pitch:number}} measured   raw device reading (offset NOT applied)
 * @param {ReturnType<typeof calibrationTarget>} target
 * @returns {{ok:true, offsetDeg:number} | {ok:false, reason:string, detail?:number}}
 */
export function computeCalibration(measured, target) {
  if (!target?.ok) return { ok: false, reason: target?.reason || 'no_target' }
  if (!measured || !Number.isFinite(measured.yaw)) return { ok: false, reason: 'no_reading' }
  const p = Number(measured.pitch)
  if (Number.isFinite(target.pitch) && Number.isFinite(p)) {
    const d = Math.abs(p - target.pitch)
    if (d > PITCH_TOLERANCE_DEG) return { ok: false, reason: 'pitch_mismatch', detail: Math.round(d) }
  } else if (target.check === 'below' && Number.isFinite(p) && p > -5) {
    return { ok: false, reason: 'not_pointing_down', detail: Math.round(p) }
  } else if (target.check === 'above' && Number.isFinite(p) && p < 0) {
    return { ok: false, reason: 'not_pointing_up', detail: Math.round(p) }
  }
  return { ok: true, offsetDeg: angleDiff(target.yaw, measured.yaw) }
}

/**
 * How uncertain is a source's yaw right now?
 *
 * Absolute sources (compass) report their own accuracy. Relative sources
 * (gyro only) drift: their uncertainty grows with the time since the last
 * calibration, and without one they have no absolute yaw at all.
 *
 * @param {object} s
 * @param {'absolute'|'relative'} s.kind
 * @param {number} [s.reportedDeg]     accuracy the device reports
 * @param {number|null} [s.calibratedAt]  ms timestamp of the last calibration
 * @param {number} [s.now]
 * @param {number} [s.driftDegPerMin]  measured drift rate of the source
 * @returns {number} degrees; Infinity for an uncalibrated relative source
 */
export function effectiveAccuracy({ kind, reportedDeg = 10, calibratedAt = null, now = Date.now(), driftDegPerMin = 1.5 }) {
  const base = Number.isFinite(reportedDeg) && reportedDeg > 0 ? reportedDeg : 10
  if (kind !== 'relative') return base
  if (!Number.isFinite(calibratedAt)) return Infinity
  const minutes = Math.max(0, (now - calibratedAt) / 60_000)
  return base + driftDegPerMin * minutes
}

/** The acquire cone for a given yaw uncertainty — never narrower than the base, capped. */
export function coneForAccuracy(baseConeDeg, accuracyDeg, maxConeDeg = 35) {
  if (!Number.isFinite(accuracyDeg)) return maxConeDeg
  return Math.min(maxConeDeg, Math.max(baseConeDeg, accuracyDeg))
}
