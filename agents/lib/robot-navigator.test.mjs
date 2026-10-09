// Tests für agents/lib/robot-navigator.mjs.
//
// Lenkung ist der eine Teil, den man nicht ansehen kann — ein Fehler zeigt
// sich erst als Fahrzeug in der Hecke. Deshalb ist er reine Rechnung ohne Uhr
// und ohne Hardware: dieselbe Lage ergibt immer denselben Befehl.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { steer, headingError, Route, DEFAULT_LIMITS } from './robot-navigator.mjs'

// Neuwied. 0,001° Breite sind rund 111 m, 0,001° Länge auf 50° rund 71 m.
const HIER = { lat: 50.4514, lon: 7.5363, heading: 0 }
const NORD = { lat: 50.4524, lon: 7.5363 }        // ~111 m nördlich
const OST  = { lat: 50.4514, lon: 7.5377 }        // ~100 m östlich
const NAH  = { lat: 50.45141, lon: 7.5363 }       // gut 1 m nördlich

// ─── Winkelfehler ─────────────────────────────────────────────────────────

test('der Winkelfehler trägt ein Vorzeichen', () => {
  // GENAU DAFÜR gibt es ihn: `kursDifferenz` aus bewegung.mjs liefert den
  // Abstand (0…180) und beantwortet „hat sich der Kurs genug geändert".
  // Ein Fahrzeug braucht zusätzlich die Richtung, sonst dreht es bei 170°
  // Abweichung die Hälfte der Zeit falsch herum und kreist für immer.
  assert.equal(headingError(90, 0), 90, 'Ziel rechts → positiv')
  assert.equal(headingError(270, 0), -90, 'Ziel links → negativ')
})

test('der Winkelfehler läuft sauber über Nord', () => {
  assert.equal(headingError(10, 350), 20)
  assert.equal(headingError(350, 10), -20)
  assert.equal(headingError(0, 0), 0)
})

// ─── Lenken ───────────────────────────────────────────────────────────────

test('am Ziel wird gehalten, nicht weitergeregelt', () => {
  const s = steer(HIER, NAH)
  assert.equal(s.arrived, true)
  assert.equal(s.v, 0)
  assert.equal(s.omega, 0)
})

test('geradeaus voraus wird gefahren, nicht gedreht', () => {
  const s = steer(HIER, NORD)
  assert.equal(s.mode, 'drive')
  assert.ok(s.v > 0, `v=${s.v}`)
  assert.ok(Math.abs(s.omega) < 0.01, `omega=${s.omega}`)
})

test('ERST DREHEN, DANN FAHREN', () => {
  // Ein Fahrzeug, das 90° daneben steht und trotzdem losfährt, beschreibt
  // einen weiten Bogen — auf einem Hof die zuverlässigste Art, in die Hecke
  // zu geraten.
  const s = steer(HIER, OST)
  assert.equal(s.mode, 'turn')
  assert.equal(s.v, 0, 'im Stand drehen heisst v = 0')
  assert.ok(s.omega > 0, `nach rechts: omega=${s.omega}`)
  assert.ok(Math.abs(s.omega) <= DEFAULT_LIMITS.maxOmega + 1e-9)
})

test('gedreht wird in die kürzere Richtung', () => {
  const westlich = { lat: 50.4514, lon: 7.5349 }
  assert.ok(steer(HIER, westlich).omega < 0, 'Ziel links → links drehen')
  assert.ok(steer(HIER, OST).omega > 0, 'Ziel rechts → rechts drehen')
})

test('kurz vor dem Ziel wird langsamer', () => {
  const weit = steer(HIER, { lat: 50.4614, lon: 7.5363 })       // ~1,1 km
  const nah = steer(HIER, { lat: 50.451427, lon: 7.5363 })      // ~3 m
  assert.ok(weit.v > nah.v, `${weit.v} sollte grösser sein als ${nah.v}`)
  assert.ok(nah.v < DEFAULT_LIMITS.maxV, 'sonst wird gar nicht gebremst')
})

test('die Bremsrampe ist länger als die Zieltoleranz', () => {
  // DIE ABSTIMMUNG, DIE EIN TEST GEFUNDEN HAT: Mit dem ersten Wert (0,5)
  // begann das Bremsen erst unterhalb von zwei Metern — bei 1,5 m Toleranz
  // also praktisch gar nicht. Volle Fahrt in den Zielpunkt und dann ein Ruck.
  //
  // Als Eigenschaft statt als Koordinate geprüft: Die Strecke, ab der gebremst
  // wird (maxV / approachGain), muss deutlich länger sein als die Toleranz —
  // sonst ist das Fahrzeug schon „angekommen", bevor es langsam geworden ist.
  const rampeM = DEFAULT_LIMITS.maxV / DEFAULT_LIMITS.approachGain
  assert.ok(rampeM >= 2 * DEFAULT_LIMITS.toleranceM,
    `Bremsrampe ${rampeM} m gegen Toleranz ${DEFAULT_LIMITS.toleranceM} m`)
})

test('langsamer heisst nicht „zu langsam zum Anfahren"', () => {
  // Unterhalb der Losbrechgrenze brummt der Antrieb nur. Lieber die letzten
  // Meter mit Mindesttempo als kurz vor dem Ziel stehenbleiben.
  const s = steer(HIER, { lat: 50.45155, lon: 7.5363 })         // ~1,7 m
  assert.ok(s.v >= DEFAULT_LIMITS.minV, `v=${s.v}`)
})

test('die Grenzen der Maschine werden nie überschritten', () => {
  const eng = { maxV: 0.3, maxOmega: 0.2 }
  for (const ziel of [NORD, OST, { lat: 50.5, lon: 7.9 }, { lat: 50.4, lon: 7.1 }]) {
    const s = steer(HIER, ziel, eng)
    assert.ok(s.v <= eng.maxV + 1e-9, `v=${s.v}`)
    assert.ok(Math.abs(s.omega) <= eng.maxOmega + 1e-9, `omega=${s.omega}`)
  }
})

test('kaputte Eingaben halten an, statt zu raten', () => {
  // Eine erfundene Fahrtrichtung ist schlimmer als Stillstand.
  for (const [pose, ziel] of [
    [null, NORD], [HIER, null], [{ lat: NaN, lon: 7, heading: 0 }, NORD],
    [{ lat: 50, lon: 7 }, NORD],                  // kein heading
    [HIER, { lat: 'x', lon: 7 }],
  ]) {
    const s = steer(pose, ziel)
    assert.equal(s.v, 0)
    assert.equal(s.omega, 0)
  }
})

// ─── Route ────────────────────────────────────────────────────────────────

test('eine Route rückt am Wegpunkt weiter — ohne Stehenbleiben', () => {
  // Hielte sie an jedem Wegpunkt einen Takt lang, ruckelte die ganze Fahrt.
  const r = new Route([NAH, NORD])
  const s = r.schritt(HIER)
  assert.equal(s.fertig, false)
  assert.equal(r.index, 1, 'der erste Punkt ist abgehakt')
  assert.ok(s.v > 0 || s.omega !== 0, 'und es geht sofort weiter')
})

test('eine abgefahrene Route meldet sich fertig und hält', () => {
  const r = new Route([NAH])
  const s = r.schritt(HIER)
  assert.equal(s.fertig, true)
  assert.equal(s.v, 0)
  assert.equal(r.rest, 0)
})

test('eine leere Route fährt nicht los', () => {
  const r = new Route([])
  assert.equal(r.fertig, true)
  assert.equal(r.schritt(HIER).v, 0)
})

test('unbrauchbare Wegpunkte fliegen beim Anlegen raus', () => {
  const r = new Route([NORD, null, { lat: 'x' }, OST, undefined])
  assert.equal(r.punkte.length, 2)
})

test('mehrere Wegpunkte werden der Reihe nach abgefahren', () => {
  const r = new Route([NAH, NORD, OST])
  assert.equal(r.rest, 3)
  r.schritt(HIER)                      // NAH erreicht → Index 1
  assert.equal(r.ziel, NORD)
  assert.equal(r.rest, 2)
})
