// Validation for PositionFilter (IMU/UWB fusion). Simulate a moving tag with a
// known trajectory; feed noisy IMU accel (50 Hz) + noisy UWB fixes (5 Hz) and
// check the fused track beats raw UWB and that an outlier fix is rejected.
// Run: node client/core/PositionFilter.test.mjs
import { PositionFilter } from './PositionFilter.js'

const R = 6378137, PI = Math.PI
const origin = { lat: 50.3560, lon: 7.5890, altitude: 100 }
const enuToLL = (E, N, U) => {
  const lat = origin.lat + (N / R) * 180 / PI
  const meanLat = (lat + origin.lat) / 2 * PI / 180
  const lon = origin.lon + (E / (R * Math.cos(meanLat))) * 180 / PI
  return { lat, lon, altitude: origin.altitude + U }
}
// Inverse, against the TRUE origin — the filter pins its own ENU origin to the
// first (noisy) fix, so errors must be compared in WGS84, not the filter's local.
const llToEnu = (lat, lon, alt) => {
  const dLat = (lat - origin.lat) * PI / 180, dLon = (lon - origin.lon) * PI / 180
  const meanLat = (lat + origin.lat) / 2 * PI / 180
  return { E: dLon * R * Math.cos(meanLat), N: dLat * R, U: alt - origin.altitude }
}
const fusedErr = (p, gp) => { const e = llToEnu(p.lat, p.lon, p.altitude); return Math.hypot(e.E - gp[0], e.N - gp[1], e.U - gp[2]) }

// Deterministic Gaussian noise (LCG + Box–Muller) — no Math.random for a stable test.
let seed = 1234567
const rnd = () => { seed = (1103515245 * seed + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const gauss = (sd) => { const u = rnd() || 1e-9, v = rnd(); return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * PI * v) }

// Truth: East ramps (a=0.5 for 2 s then constant v), North gentle constant accel, Up still.
function truth(t) {
  const aE = t < 2 ? 0.5 : 0
  const vE = t < 2 ? 0.5 * t : 1.0
  const pE = t < 2 ? 0.25 * t * t : (1.0 + 1.0 * (t - 2))
  return { a: [aE, 0.1, 0], p: [pE, 0.05 * t * t, 0] }
}

const f = new PositionFilter({ accelNoise: 1.5, measNoise: 0.15 })
const ACC_SD = 0.3, POS_SD = 0.15
const IMU = 0.02, UWB = 0.2, T = 8

let sumF = 0, sumR = 0, samples = 0
let outlierRejected = false, postOutlierJump = 0

for (let k = 0, t = 0; t <= T + 1e-9; k++, t = k * IMU) {
  const gt = truth(t)
  // IMU prediction every step (true accel + noise)
  f.predict([gt.a[0] + gauss(ACC_SD), gt.a[1] + gauss(ACC_SD), gt.a[2] + gauss(ACC_SD)], t * 1000)

  // UWB update every 0.2 s
  if (Math.abs((t / UWB) - Math.round(t / UWB)) < 1e-6) {
    const isOutlierStep = Math.abs(t - 5.0) < 1e-6
    const measE = gt.p[0] + (isOutlierStep ? 5.0 : gauss(POS_SD))   // 5 m spike at t=5 s
    const measN = gt.p[1] + (isOutlierStep ? 0 : gauss(POS_SD))
    const measU = gt.p[2] + (isOutlierStep ? 0 : gauss(POS_SD))
    const before = f.rejectedCount
    f.update(enuToLL(measE, measN, measU), t * 1000)
    if (isOutlierStep) {
      outlierRejected = f.rejectedCount > before
      postOutlierJump = fusedErr(f.position(), gt.p)
    } else if (t >= 1.0) {  // skip convergence transient
      const ef = fusedErr(f.position(), gt.p)
      sumF += ef * ef
      sumR += (measE - gt.p[0]) ** 2 + (measN - gt.p[1]) ** 2 + (measU - gt.p[2]) ** 2
      samples++
    }
  }
}

const rmsF = Math.sqrt(sumF / samples), rmsR = Math.sqrt(sumR / samples)
console.log(`fused RMS:   ${(rmsF * 100).toFixed(1)} cm`)
console.log(`raw UWB RMS: ${(rmsR * 100).toFixed(1)} cm`)
console.log(`outlier (5 m spike) rejected: ${outlierRejected}; state error after it: ${(postOutlierJump * 100).toFixed(1)} cm`)

let ok = true
ok = (rmsF < rmsR * 0.8) && ok          // fusion meaningfully better than raw
ok = outlierRejected && ok               // χ² gate caught the spike
ok = (postOutlierJump < 0.5) && ok       // and the state didn't jump toward it
console.log(ok ? '\nPASS ✅' : '\nFAIL ❌')
process.exit(ok ? 0 : 1)
