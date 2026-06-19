// Regression test for WorldMagneticModel against official NOAA WMM2025 test
// values. Run: node client/core/geomag/wmm.test.mjs
//
// Values are exact rows from NOAA's WMM2025_TEST_VALUES.txt (declination, deg).
// The full set (100 rows) all match within ~0.005° (the published rounding).

import { wmm } from './WorldMagneticModel.js'

// [decimalYear, altKm, latDeg, lonDeg, expectedDeclinationDeg]
const CASES = [
  [2025.0, 28,  89, -121, -99.77],
  [2025.0, 65,  43,   93,   0.50],
  [2025.0, 51, -33,  109,  -5.49],
  [2025.0, 18,   0,   21,   1.29],
  [2025.5, 50, -70, -133,  57.21],
  [2027.0, 67, -47,  -32, -13.52]
]

let maxErr = 0
for (const [year, alt, lat, lon, expD] of CASES) {
  const got = wmm.declination(lat, lon, alt, year)
  let err = Math.abs(got - expD)
  if (err > 180) err = 360 - err
  maxErr = Math.max(maxErr, err)
  console.log(`lat=${String(lat).padStart(4)} lon=${String(lon).padStart(5)} y=${year}  D exp ${expD.toFixed(2).padStart(8)}  got ${got.toFixed(2).padStart(8)}  err ${err.toFixed(4)}`)
}
const ok = maxErr < 0.01
console.log(`\nmax error ${maxErr.toFixed(5)}°  ->  ${ok ? 'PASS ✅' : 'FAIL ❌'}`)
process.exit(ok ? 0 : 1)
