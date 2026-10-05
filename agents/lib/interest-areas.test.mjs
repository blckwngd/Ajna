// Tests für agents/lib/interest-areas.mjs.
//
// ANLASS, 05.10.2026: In der Entwicklungsdatenbank lagen 2549 C-ITS-Objekte
// 675 km entfernt und 143 WLAN-Netze im Median 3,8 km weg — angelegt um fest
// eingestellte Zentren, an denen nie jemand war.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InterestAreas, inBox, centreOf, radiusKmOf, distanceKm } from './interest-areas.mjs'

// Ein Bereich, wie der Server ihn liefert: auf 250 m gerastert, rund 2 km breit.
const NEUWIED = { latMin: 50.4490, latMax: 50.4535, lonMin: 7.5340, lonMax: 7.5400 }
const GRAZ = { latMin: 47.0600, latMax: 47.0700, lonMin: 15.4300, lonMax: 15.4400 }

const fakeAjna = (areas, fehler = null) => ({
  fetchInterestAreas: async () => { if (fehler) throw new Error(fehler); return areas },
})
const still = { log: () => {}, warn: () => {} }

// ─── Geometrie ────────────────────────────────────────────────────────────

test('ein Punkt im Kasten liegt drin, einer daneben nicht', () => {
  assert.equal(inBox(NEUWIED, 50.4514, 7.5363), true)
  assert.equal(inBox(NEUWIED, 50.4600, 7.5363), false)
  assert.equal(inBox(null, 50.4514, 7.5363), false)
})

test('der Puffer weitet den Kasten in Metern, nicht in Grad', () => {
  // Ein Grad Länge ist auf 50° Breite nur rund 71 km — ein Puffer in Grad wäre
  // in Nord-Süd-Richtung grosszügiger als in Ost-West. Das fällt erst auf,
  // wenn Objekte östlich zu früh verschwinden.
  const knappDrueber = 50.4535 + 0.0008          // ~89 m nördlich
  assert.equal(inBox(NEUWIED, knappDrueber, 7.5363), false)
  assert.equal(inBox(NEUWIED, knappDrueber, 7.5363, 200), true)
  const knappDaneben = 7.5400 + 0.0012           // ~85 m östlich
  assert.equal(inBox(NEUWIED, 50.4514, knappDaneben, 200), true)
  assert.equal(inBox(NEUWIED, 50.4514, knappDaneben, 20), false)
})

test('Mittelpunkt und deckender Radius', () => {
  const m = centreOf(NEUWIED)
  assert.ok(Math.abs(m.lat - 50.45125) < 1e-5)
  assert.ok(Math.abs(m.lon - 7.537) < 1e-5)
  const r = radiusKmOf(NEUWIED)
  assert.ok(r > 0.2 && r < 0.5, `${r} km`)
  assert.ok(inBox(NEUWIED, NEUWIED.latMax, NEUWIED.lonMax), 'die Ecke liegt im Kasten')
})

test('Entfernung stimmt gegen eine bekannte Strecke', () => {
  // Neuwied → Graz, Luftlinie rund 680 km — genau die Entfernung, in der die
  // 2549 Leichen lagen.
  const km = distanceKm(50.4514, 7.5363, 47.065, 15.435)
  assert.ok(km > 650 && km < 710, `${km.toFixed(0)} km`)
})

// ─── Abfrage ──────────────────────────────────────────────────────────────

test('nach einer erfolgreichen Abfrage gelten die Bereiche', async () => {
  const g = new InterestAreas(fakeAjna([NEUWIED]), still)
  assert.equal(g.known, false, 'vorher weiss der Agent nichts')
  assert.equal(await g.refresh(), true)
  assert.equal(g.known, true)
  assert.equal(g.count, 1)
  assert.equal(g.contains(50.4514, 7.5363), true)
  assert.equal(g.contains(47.065, 15.435), false, 'Graz liegt nicht in Neuwied')
})

test('EINE GESCHEITERTE ABFRAGE IST NICHT „NIEMAND DA"', async () => {
  // Die teuerste Verwechslung in dieser Datei: Wer aus einem Netzfehler auf
  // eine leere Welt schliesst, räumt beim nächsten Aufräumlauf alles ab.
  const g = new InterestAreas(fakeAjna([NEUWIED]), still)
  await g.refresh()
  g.ajna.fetchInterestAreas = async () => { throw new Error('ECONNREFUSED') }

  assert.equal(await g.refresh(), false)
  assert.equal(g.known, true, 'das Wissen von vorhin bleibt gültig')
  assert.equal(g.count, 1, 'und der letzte Stand bleibt stehen')
  assert.equal(g.contains(50.4514, 7.5363), true)
})

test('eine Fehlabfrage GANZ AM ANFANG lässt den Agenten unwissend', async () => {
  // Hier ist `known: false` die wichtige Aussage — der Aufrufer darf dann
  // weder anlegen noch löschen, sondern muss den Zustand lassen, wie er ist.
  const g = new InterestAreas(fakeAjna(null, 'ECONNREFUSED'), still)
  assert.equal(await g.refresh(), false)
  assert.equal(g.known, false)
  assert.equal(g.count, 0)
})

test('eine leere, aber erfolgreiche Antwort heisst wirklich „niemand da"', async () => {
  const g = new InterestAreas(fakeAjna([]), still)
  await g.refresh()
  assert.equal(g.known, true)
  assert.equal(g.count, 0)
  assert.equal(g.contains(50.4514, 7.5363), false)
})

test('kaputte Kästen werden aussortiert statt zu kippen', async () => {
  const g = new InterestAreas(fakeAjna([NEUWIED, null, { latMin: 1 }, 'müll']), still)
  await g.refresh()
  assert.equal(g.count, 1)
})

test('eine umhüllte Form wird auch verstanden', async () => {
  // Der Server liefert nackte Kästen; ein `{bbox: …}` wäre eine naheliegende
  // Änderung, und daran soll der Agent nicht zerbrechen.
  const g = new InterestAreas(fakeAjna([{ bbox: NEUWIED }]), still)
  await g.refresh()
  assert.equal(g.count, 1)
  assert.equal(g.contains(50.4514, 7.5363), true)
})

test('feste Bereiche des Betreibers gelten auch ohne Abfrage', async () => {
  const g = new InterestAreas(fakeAjna(null, 'offline'), { ...still, always: [GRAZ] })
  assert.equal(g.known, true, 'eine eigene Vorgabe ist Wissen')
  assert.equal(g.contains(47.065, 15.435), true)
  await g.refresh()
  assert.equal(g.count, 1, 'trotz Fehlschlag bleibt die Vorgabe')
})

test('mehrere Spieler ergeben mehrere Bereiche', async () => {
  const g = new InterestAreas(fakeAjna([NEUWIED, GRAZ]), still)
  await g.refresh()
  assert.equal(g.count, 2)
  assert.equal(g.contains(50.4514, 7.5363), true)
  assert.equal(g.contains(47.065, 15.435), true)
  assert.equal(g.contains(52.5, 13.4), false, 'Berlin nicht')
})

test('Abfrage-Punkte tragen einen Radius, der den Kasten deckt', async () => {
  const g = new InterestAreas(fakeAjna([NEUWIED]), { ...still, bufferM: 500 })
  await g.refresh()
  const [q] = g.queries()
  assert.ok(Math.abs(q.lat - 50.45125) < 1e-5)
  assert.ok(q.radiusKm > 0.7 && q.radiusKm < 1.0, `${q.radiusKm} km`)
  // Jede Ecke muss innerhalb des Radius liegen, sonst fragt der Agent zu klein ab.
  for (const [la, lo] of [[NEUWIED.latMin, NEUWIED.lonMin], [NEUWIED.latMax, NEUWIED.lonMax]]) {
    assert.ok(distanceKm(q.lat, q.lon, la, lo) <= q.radiusKm, `Ecke ${la},${lo} fällt heraus`)
  }
})

test('der Bericht wiederholt sich nicht', async () => {
  // Alle 45 Sekunden „1 Interessensgebiet" ins Protokoll wäre dieselbe Sorte
  // Lärm wie die wiederholten UWB-Meldungen.
  const zeilen = []
  const g = new InterestAreas(fakeAjna([NEUWIED]), { log: (t) => zeilen.push(t), warn: () => {} })
  await g.refresh(); await g.refresh(); await g.refresh()
  assert.equal(zeilen.length, 1, zeilen.join(' | '))
  g.ajna.fetchInterestAreas = async () => []
  await g.refresh()
  assert.equal(zeilen.length, 2, 'eine echte Änderung wird gemeldet')
})
