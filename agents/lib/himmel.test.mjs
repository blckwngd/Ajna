// Tests für agents/lib/himmel.mjs.
//
// Die Mondphasen werden gegen BEKANNTE Termine geprüft, nicht gegen die eigene
// Formel — sonst prüft der Test nur, dass die Rechnung sich selbst gleicht.
// Termine aus dem Mondkalender 2026 (UTC).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mondphase, tageszeit, uhrzeit, himmelVars } from './himmel.mjs'

test('bekannte Vollmonde werden als Vollmond erkannt', () => {
  // 2026: 3. Januar, 2. Februar, 3. März — jeweils um die Mittagszeit UTC.
  for (const iso of ['2026-01-03T12:00Z', '2026-02-02T00:00Z', '2026-03-03T12:00Z']) {
    const m = mondphase(new Date(iso))
    assert.equal(m.name, 'Vollmond', `${iso} → ${m.name} (Anteil ${m.anteil.toFixed(3)})`)
    assert.ok(m.beleuchtet > 0.97, `${iso}: beleuchtet=${m.beleuchtet.toFixed(2)}`)
  }
})

test('bekannte Neumonde werden als Neumond erkannt', () => {
  for (const iso of ['2026-01-18T19:00Z', '2026-02-17T12:00Z']) {
    const m = mondphase(new Date(iso))
    assert.equal(m.name, 'Neumond', `${iso} → ${m.name} (Anteil ${m.anteil.toFixed(3)})`)
    assert.ok(m.beleuchtet < 0.03)
  }
})

test('„Halbmond" steht nie mehrere Tage am Stück', () => {
  // Der Zweck des engen Fensters: Eine Figur, die drei Tage lang vom Halbmond
  // spricht, wirkt nicht beobachtend, sondern kaputt. Geprüft wird deshalb die
  // längste zusammenhängende Strecke, nicht die Summe — zwei Viertel im Monat
  // ergeben zwangsläufig mehrere Treffer, nur eben an getrennten Stellen.
  const start = Date.UTC(2026, 0, 3, 12)
  let laengste = 0, lauf = 0
  for (let tag = 0; tag < 30; tag++) {
    const m = mondphase(new Date(start + tag * 86400000))
    lauf = m.name.includes('Halbmond') ? lauf + 1 : 0
    laengste = Math.max(laengste, lauf)
  }
  assert.ok(laengste <= 2, `${laengste} Tage am Stück „Halbmond" — das Fenster ist zu weit`)
})

test('der Zyklus ist vollständig und läuft in der richtigen Richtung', () => {
  const start = Date.UTC(2026, 0, 3, 12)
  const namen = new Set()
  let zunehmendeGesehen = false, abnehmendeGesehen = false
  for (let tag = 0; tag < 30; tag++) {
    const m = mondphase(new Date(start + tag * 86400000))
    namen.add(m.name)
    if (m.zunehmend) zunehmendeGesehen = true; else abnehmendeGesehen = true
  }
  assert.ok(namen.size >= 6, `nur ${namen.size} verschiedene Phasen in einem Monat`)
  assert.ok(zunehmendeGesehen && abnehmendeGesehen)
})

test('nach Vollmond nimmt der Mond ab', () => {
  const voll = new Date('2026-01-03T12:00Z')
  const danach = mondphase(new Date(voll.getTime() + 3 * 86400000))
  assert.equal(danach.zunehmend, false)
  assert.match(danach.name, /abnehmend/)
})

// ─── Tageszeit ────────────────────────────────────────────────────────────

const SONNE = { sonnenaufgang: '2026-09-23T07:17', sonnenuntergang: '2026-09-23T19:26' }

test('die Tageszeit richtet sich nach der Sonne, nicht nach der Uhr', () => {
  // 17 Uhr im Dezember ist Nacht, 17 Uhr im Juni Nachmittag. Genau dafür
  // bekommt die Funktion die Sonnenzeiten.
  const winter = { sonnenaufgang: '2026-12-21T08:24', sonnenuntergang: '2026-12-21T16:28' }
  assert.equal(tageszeit(new Date('2026-12-21T17:30'), winter), 'Nacht')
  const sommer = { sonnenaufgang: '2026-06-21T05:18', sonnenuntergang: '2026-06-21T21:44' }
  assert.equal(tageszeit(new Date('2026-06-21T17:30'), sommer), 'Nachmittag')
})

test('der Tag wird so geteilt, wie Leute sprechen', () => {
  const um = (h, m = 0) => tageszeit(new Date(2026, 8, 23, h, m), SONNE)
  assert.equal(um(8), 'Morgen')
  assert.equal(um(10), 'Vormittag')
  assert.equal(um(13), 'Mittag')
  assert.equal(um(16), 'Nachmittag')
  assert.equal(um(19), 'Abend')
  assert.equal(um(3), 'Nacht')
})

test('ohne Sonnenzeiten gilt die Uhr — ungenau, aber nie absurd', () => {
  assert.equal(tageszeit(new Date(2026, 8, 23, 3)), 'Nacht')
  assert.equal(tageszeit(new Date(2026, 8, 23, 12)), 'Mittag')
  assert.equal(tageszeit(new Date(2026, 8, 23, 23)), 'Nacht')
})

test('unbrauchbare Sonnenzeiten werfen nicht, sie fallen zurück', () => {
  assert.equal(tageszeit(new Date(2026, 8, 23, 12), { sonnenaufgang: 'Unfug' }), 'Mittag')
  assert.equal(uhrzeit('Unfug'), '')
  assert.equal(uhrzeit(null), '')
})

test('himmelVars liefert, was ein Dialog aussprechen kann', () => {
  const v = himmelVars(new Date(2026, 8, 23, 21, 0), SONNE)
  assert.equal(typeof v.mond, 'string')
  assert.ok(v.mond.length > 3)
  assert.equal(v.tageszeit, 'Nacht')
  assert.equal(v.nacht, true)
  assert.equal(v.sonnenuntergang, '19:26')
  assert.ok(Number.isInteger(v.mond_anteil) && v.mond_anteil >= 0 && v.mond_anteil <= 100)
})
