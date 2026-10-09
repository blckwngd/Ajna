// Tests für agents/lib/robot-driver.mjs — Vertrag und Simulationstreiber.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SimDriver, checkDriver, clamp, CAPABILITY_SHAPE } from './robot-driver.mjs'

/** Eine steuerbare Uhr — sonst hinge die Simulation am Taktgeber des Rechners. */
function uhr(start = 0) {
  let t = start
  return { jetzt: () => t, vor: (ms) => { t += ms } }
}

// ─── Der Vertrag ──────────────────────────────────────────────────────────

test('ein vollständiger Treiber besteht die Prüfung', () => {
  assert.deepEqual(checkDriver(new SimDriver()), [])
})

test('die Prüfung benennt, was fehlt', () => {
  // Für den, der den zweiten Treiber schreibt: einmal im Test laufen lassen
  // und man weiss, was fehlt — statt es an einer rollenden Maschine zu merken.
  const fehlt = checkDriver({ start() {}, drive() {} })
  assert.ok(fehlt.some(f => f.includes('halt()')), fehlt.join(' | '))
  assert.ok(fehlt.some(f => f.includes('capabilities()')))
  assert.equal(checkDriver(null).length, 6, 'gar nichts → alle sechs')
})

test('unbrauchbare Fähigkeiten fallen auf', () => {
  const stumpf = {
    start() {}, drive() {}, halt() {}, stop() {}, state: () => ({}),
    capabilities: () => ({ maxV: 0, maxOmega: -1, extraActions: 'nein' }),
  }
  const fehlt = checkDriver(stumpf)
  assert.ok(fehlt.some(f => f.includes('maxV')), fehlt.join(' | '))
  assert.ok(fehlt.some(f => f.includes('maxOmega')))
  assert.ok(fehlt.some(f => f.includes('extraActions')))
})

test('die Form der Fähigkeiten ist dokumentiert', () => {
  for (const k of ['maxV', 'maxOmega', 'turnsInPlace', 'holonomic', 'extraActions']) {
    assert.ok(k in CAPABILITY_SHAPE, k)
  }
})

test('clamp hält beidseitig', () => {
  assert.equal(clamp(5, 2), 2)
  assert.equal(clamp(-5, 2), -2)
  assert.equal(clamp(1, 2), 1)
  assert.equal(clamp(NaN, 2), 0, 'kein NaN an die Motoren')
  assert.equal(clamp(undefined, 2), 0)
})

// ─── Simulation ───────────────────────────────────────────────────────────

test('vorwärts fahren bewegt nach Norden, wenn der Kurs Nord ist', () => {
  const u = uhr()
  const d = new SimDriver({ start: { lat: 50, lon: 7, heading: 0 }, now: u.jetzt })
  d.start()
  d.drive({ v: 1, omega: 0 })
  u.vor(10_000)                               // 10 s bei 1 m/s = 10 m
  const p = d.state().pose
  const nordM = (p.lat - 50) * 111320
  assert.ok(Math.abs(nordM - 10) < 0.1, `${nordM.toFixed(2)} m statt 10`)
  assert.ok(Math.abs(p.lon - 7) < 1e-9, 'und keinen Meter zur Seite')
})

test('nach Osten fahren bewegt nach Osten', () => {
  const u = uhr()
  // Grenzen grosszügig: geprüft wird die Kinematik, nicht die Begrenzung
  // (die hat ihren eigenen Test — und sie hat diesen hier zuerst gerissen).
  const d = new SimDriver({ start: { lat: 50, lon: 7, heading: 90 }, maxV: 5, now: u.jetzt })
  d.start()
  d.drive({ v: 2, omega: 0 })
  u.vor(5_000)                                // 10 m
  const p = d.state().pose
  const ostM = (p.lon - 7) * 111320 * Math.cos(50 * Math.PI / 180)
  assert.ok(Math.abs(ostM - 10) < 0.2, `${ostM.toFixed(2)} m statt 10`)
})

test('Drehen ändert den Kurs und sonst nichts', () => {
  const u = uhr()
  const d = new SimDriver({ start: { lat: 50, lon: 7, heading: 0 }, maxOmega: 3, now: u.jetzt })
  d.start()
  d.drive({ v: 0, omega: Math.PI / 2 })       // 90°/s
  u.vor(1_000)
  const p = d.state().pose
  assert.ok(Math.abs(p.heading - 90) < 0.5, `heading=${p.heading}`)
  assert.ok(Math.abs(p.lat - 50) < 1e-9 && Math.abs(p.lon - 7) < 1e-9, 'kein Versatz')
})

test('der Kurs läuft sauber über 360°', () => {
  const u = uhr()
  const d = new SimDriver({ start: { lat: 50, lon: 7, heading: 350 }, maxOmega: 3, now: u.jetzt })
  d.start()
  d.drive({ v: 0, omega: Math.PI / 2 })
  u.vor(1_000)                                // +90° → 440° → 80°
  assert.ok(Math.abs(d.state().pose.heading - 80) < 0.5, d.state().pose.heading)
})

test('die Maschine fährt nie schneller, als sie kann', () => {
  const u = uhr()
  const d = new SimDriver({ maxV: 0.5, maxOmega: 0.4, now: u.jetzt })
  d.start()
  d.drive({ v: 99, omega: -99 })
  const s = d.state()
  assert.equal(s.v, 0.5)
  assert.equal(s.omega, -0.4)
})

test('halt stoppt sofort', () => {
  const u = uhr()
  const d = new SimDriver({ start: { lat: 50, lon: 7, heading: 0 }, now: u.jetzt })
  d.start()
  d.drive({ v: 1, omega: 1 })
  u.vor(1_000)
  d.halt()
  const vorher = { ...d.state().pose }
  u.vor(10_000)
  const nachher = d.state().pose
  assert.deepEqual(nachher, vorher, 'nach halt bewegt sich nichts mehr')
})

test('vor dem Start bewegt sich nichts', () => {
  // Ein Treiber, der ohne `start()` schon fährt, würde beim ersten Takt
  // überraschen — und zwar mit einer Maschine, die sich in Bewegung setzt.
  const u = uhr()
  const d = new SimDriver({ start: { lat: 50, lon: 7, heading: 0 }, now: u.jetzt })
  d.drive({ v: 1, omega: 0 })
  u.vor(10_000)
  assert.ok(Math.abs(d.state().pose.lat - 50) < 1e-12)
})

test('der Kilometerzähler zählt auch rückwärts gefahrene Meter', () => {
  const u = uhr()
  const d = new SimDriver({ now: u.jetzt })
  d.start()
  d.drive({ v: 1, omega: 0 }); u.vor(5_000)
  d.drive({ v: -1, omega: 0 }); u.vor(5_000)
  assert.ok(Math.abs(d.state().odometerM - 10) < 0.1, d.state().odometerM)
})

test('Schlupf macht die Maschine langsamer, nicht schneller', () => {
  const u = uhr()
  const d = new SimDriver({ slipp: 0.5, maxV: 1, now: u.jetzt })
  d.start()
  d.drive({ v: 1, omega: 0 })
  assert.ok(Math.abs(d.state().v - 0.5) < 1e-9, d.state().v)
})

test('die Simulation sagt, dass sie eine ist', () => {
  // Damit in keinem Protokoll der Eindruck entsteht, da sei etwas gefahren.
  assert.equal(new SimDriver().state().simuliert, true)
})
