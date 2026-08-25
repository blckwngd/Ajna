// Yaw-Konvention — eine Umrechnung, nachgerechnet statt gestimmt.
//
// Der Audit vom 2026-08-14 fand drei Formeln für dieselbe Sache, 90 Grad
// auseinander. Diese Prüfung schließt sie: Sie rechnet die Blickrichtung
// tatsächlich aus und vergleicht sie mit der Bewegungsrichtung. Damit hängt die
// Konvention nicht mehr daran, dass jemand sich an sie erinnert.
//
// Run: node client/core/yaw.test.mjs

import {
  yawFuerKurs, yawFuerKursGrad, kursFuerYaw, normPi,
  richtungFuerKurs, blickFuerYaw, FRONT_X, FRONT_Z,
} from './yaw.js'

let failures = 0
const check = (msg, cond, info = '') => {
  if (cond) console.log(`  ✓ ${msg}${info ? ` (${info})` : ''}`)
  else { console.error(`  ✗ ${msg}${info ? ` (${info})` : ''}`); failures++ }
}
const G = (g) => g * Math.PI / 180

console.log('Yaw-Konvention:')

// ── Die Herleitung, nachgerechnet ────────────────────────────────────────
// Achsen: Ost = +X, Nord = −Z (GeoTransformer mit invertNorthSouth).
{
  const d = richtungFuerKurs(0)
  check('Nord zeigt nach −Z', Math.abs(d.z + 1) < 1e-9 && Math.abs(d.x) < 1e-9,
    `(${d.x.toFixed(2)}, ${d.z.toFixed(2)})`)
  const o = richtungFuerKurs(G(90))
  check('Ost zeigt nach +X', Math.abs(o.x - 1) < 1e-9 && Math.abs(o.z) < 1e-9)
}

// DER KERN: Blickrichtung muss der Bewegungsrichtung entsprechen — für JEDEN
// Kurs. Genau das war nie geprüft, und genau deshalb liefen drei Formeln
// nebeneinander her.
for (const front of [FRONT_Z, FRONT_X]) {
  let groessteAbweichung = 0
  for (let grad = 0; grad < 360; grad += 5) {
    const h = G(grad)
    const soll = richtungFuerKurs(h)
    const ist = blickFuerYaw(yawFuerKurs(h, front), front)
    const ab = Math.hypot(soll.x - ist.x, soll.z - ist.z)
    if (ab > groessteAbweichung) groessteAbweichung = ab
  }
  check(`Front auf +${front.toUpperCase()}: Blick = Bewegung, rundum`,
    groessteAbweichung < 1e-9, 'max. Abweichung ' + groessteAbweichung.toExponential(1))
}

// ── Die Formeln selbst ───────────────────────────────────────────────────
check('+Z-Front ergibt π − h', Math.abs(normPi(yawFuerKurs(G(30))) - normPi(Math.PI - G(30))) < 1e-9)
check('+X-Front ergibt π/2 − h', Math.abs(normPi(yawFuerKurs(G(30), FRONT_X)) - normPi(Math.PI / 2 - G(30))) < 1e-9)

// Die alte Bridge-Formel h − π/2 ist der SPIEGEL der richtigen +X-Formel —
// deshalb fuhren Fahrzeuge unter der gekippten Achsenlage verkehrt herum.
{
  const h = G(30)
  const alt = normPi(h - Math.PI / 2)
  check('die alte Fahrzeug-Formel weicht ab', Math.abs(alt - yawFuerKurs(h, FRONT_X)) > 0.5,
    `alt=${alt.toFixed(2)}, richtig=${yawFuerKurs(h, FRONT_X).toFixed(2)}`)
  // Die 90 Grad aus dem Audit sind der Abstand zwischen den beiden FRONT-
  // Konventionen — nicht zwischen alter und neuer Formel. Deren Abstand hängt
  // vom Kurs ab (2h − 3π/2), was es noch schwerer machte, den Fehler zu sehen:
  // Bei manchen Kursen stimmte es zufällig.
  check('die beiden Front-Konventionen liegen 90 Grad auseinander',
    Math.abs(Math.abs(normPi(yawFuerKurs(h, FRONT_X) - yawFuerKurs(h))) - Math.PI / 2) < 1e-9)
}

// ── Hin und zurück ───────────────────────────────────────────────────────
for (const front of [FRONT_Z, FRONT_X]) {
  let ok = true
  for (let grad = 0; grad < 360; grad += 7) {
    const h = G(grad)
    const zurueck = kursFuerYaw(yawFuerKurs(h, front), front)
    if (Math.abs(normPi(zurueck - h)) > 1e-9) ok = false
  }
  check(`Rückweg stimmt (+${front.toUpperCase()})`, ok)
}

// ── Normierung ───────────────────────────────────────────────────────────
check('π bleibt π', Math.abs(normPi(Math.PI) - Math.PI) < 1e-9)
check('−π wird zu π', Math.abs(normPi(-Math.PI) - Math.PI) < 1e-9)
check('3π wird zu π', Math.abs(normPi(3 * Math.PI) - Math.PI) < 1e-9)
check('Unsinn ergibt 0', normPi(NaN) === 0 && yawFuerKurs(undefined) !== undefined)
check('Grad-Variante deckt sich mit der Radiant-Variante',
  Math.abs(yawFuerKursGrad(137) - yawFuerKurs(G(137))) < 1e-9)

// ── Alle Agents rechnen gleich ───────────────────────────────────────────
// Die Trennlinie: Agents nutzen IMMER +Z; Modell-Eigenheiten korrigiert der
// Client je Datei (MODEL_YAW_RAD). Ein Agent kennt die GLB-Datei gar nicht.
{
  const { readFileSync } = await import('node:fs')
  const lies = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  for (const datei of ['../../agents/world-director.mjs', '../../agents/adsb-bridge.mjs',
                       '../../agents/ais-bridge.mjs', '../../agents/ais-vesselfinder.mjs']) {
    let q = ''
    try { q = lies(datei) } catch { continue }
    const name = datei.split('/').pop()
    check(`${name} nutzt die gemeinsame Umrechnung`, /yawFuerKurs/.test(q))
    check(`${name} rechnet nicht mehr selbst`,
      !/-\s*Math\.PI\s*\/\s*2\b/.test(q.replace(/^\s*\/\/.*$/gm, '')),
      'eigene π/2-Formel gefunden')
  }
}

console.log(failures === 0
  ? '\nAll yaw tests passed.'
  : `\n${failures} test(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
