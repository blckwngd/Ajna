// Tests für agents/lib/follow-source.mjs.
//
// ANLASS: Der Erstbestand und der Ereignisstrom sind zwei verschiedene Dinge,
// und `onObjectEvent` feuert ausdrücklich NICHT für das, was schon da ist.
// Wer nur das Abo schreibt, bekommt eine Welt, die sich erst beim nächsten
// Neustart der FREMDEN Quelle füllt — und sucht den Fehler bei sich.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { followSource, selects, distanceKm } from './follow-source.mjs'

const KOBLENZ = { lat: 50.3591, lon: 7.5932 }
const obj = (id, ue = {}) => ({
  id, name: id, lat: KOBLENZ.lat, lon: KOBLENZ.lon,
  state: { source: 'kartevonmorgen', kvm_kind: 'initiative' }, ...ue,
})

/** Ein ajna-Doppel mit Bestand und auslösbarem Ereignisstrom. */
function fakeAjna(bestand = []) {
  let hoerer = null
  return {
    getObjects: () => bestand,
    onObjectEvent: (cb) => { hoerer = cb; return () => { hoerer = null } },
    ereignis: (rec, action) => hoerer?.(rec, action),
    hatHoerer: () => !!hoerer,
  }
}

const sammle = () => {
  const dazu = [], weg = [], geaendert = []
  return {
    dazu, weg, geaendert,
    onAdd: (o) => dazu.push(o.id),
    onRemove: (o) => weg.push(o.id),
    onChange: (o) => geaendert.push(o.id),
  }
}

// ─── Der Erstbestand ──────────────────────────────────────────────────────

test('DER BESTAND WIRD ALS onAdd NACHGESPIELT', () => {
  // Der ganze Zweck dieser Datei. `onObjectEvent` allein liefert ihn nicht.
  const ajna = fakeAjna([obj('a'), obj('b')])
  const s = sammle()
  followSource(ajna, 'kartevonmorgen', s)
  assert.deepEqual(s.dazu, ['a', 'b'])
})

test('fremde Quellen bleiben unberührt', () => {
  const ajna = fakeAjna([obj('a'), obj('fremd', { state: { source: 'overpass' } })])
  const s = sammle()
  followSource(ajna, 'kartevonmorgen', s)
  assert.deepEqual(s.dazu, ['a'])
})

// ─── Der Strom ────────────────────────────────────────────────────────────

test('neue Objekte melden sich', () => {
  const ajna = fakeAjna([])
  const s = sammle()
  followSource(ajna, 'kartevonmorgen', s)
  ajna.ereignis(obj('neu'), 'create')
  assert.deepEqual(s.dazu, ['neu'])
})

test('gelöschte melden sich — aber nur, wenn sie je dazugehörten', () => {
  const ajna = fakeAjna([obj('a')])
  const s = sammle()
  followSource(ajna, 'kartevonmorgen', s)
  ajna.ereignis(obj('a'), 'delete')
  ajna.ereignis(obj('niegesehen'), 'delete')
  assert.deepEqual(s.weg, ['a'])
})

test('Änderungen sind Änderungen, keine Neuzugänge', () => {
  const ajna = fakeAjna([obj('a')])
  const s = sammle()
  followSource(ajna, 'kartevonmorgen', s)
  ajna.ereignis(obj('a', { name: 'anders' }), 'update')
  assert.deepEqual(s.dazu, ['a'], 'nur aus dem Bestand')
  assert.deepEqual(s.geaendert, ['a'])
})

// ─── Umkreis ──────────────────────────────────────────────────────────────

const weitWeg = (id) => obj(id, { lat: 51.5, lon: 7.5 })   // rund 127 km

test('der Umkreis gilt auch für den Bestand', () => {
  const ajna = fakeAjna([obj('nah'), weitWeg('fern')])
  const s = sammle()
  followSource(ajna, 'kartevonmorgen', { ...s, center: KOBLENZ, radiusKm: 10 })
  assert.deepEqual(s.dazu, ['nah'])
})

test('AUS DEM UMKREIS ZU WANDERN IST EIN ABGANG', () => {
  // Ohne diese Regel könnte ein Radius nur wachsen: Was einmal passte, bliebe
  // gemeldet, bis es an der Quelle gelöscht würde.
  const ajna = fakeAjna([obj('wanderer')])
  const s = sammle()
  followSource(ajna, 'kartevonmorgen', { ...s, center: KOBLENZ, radiusKm: 10 })
  assert.deepEqual(s.dazu, ['wanderer'])
  ajna.ereignis(weitWeg('wanderer'), 'update')
  assert.deepEqual(s.weg, ['wanderer'])
  assert.deepEqual(s.geaendert, [], 'kein „geändert" für etwas, das weg ist')
})

test('in den Umkreis zu wandern ist ein Zugang', () => {
  const ajna = fakeAjna([])
  const s = sammle()
  followSource(ajna, 'kartevonmorgen', { ...s, center: KOBLENZ, radiusKm: 10 })
  ajna.ereignis(weitWeg('x'), 'update')
  assert.deepEqual(s.dazu, [])
  ajna.ereignis(obj('x'), 'update')
  assert.deepEqual(s.dazu, ['x'])
})

test('ein eigener Filter greift zusätzlich', () => {
  const ajna = fakeAjna([obj('ini'), obj('firma', { state: { source: 'kartevonmorgen', kvm_kind: 'business' } })])
  const s = sammle()
  followSource(ajna, 'kartevonmorgen', { ...s, filter: (o) => o.state?.kvm_kind === 'initiative' })
  assert.deepEqual(s.dazu, ['ini'])
})

// ─── Robustheit ───────────────────────────────────────────────────────────

test('ein Fehler im Rückruf reisst das Abo nicht ab', () => {
  // Sonst hielte EIN kaputter Datensatz jeden späteren auf.
  const ajna = fakeAjna([])
  const gesehen = []
  followSource(ajna, 'kartevonmorgen', {
    onAdd: (o) => { if (o.id === 'böse') throw new Error('kaputt'); gesehen.push(o.id) },
    warn: () => {},
  })
  ajna.ereignis(obj('böse'), 'create')
  ajna.ereignis(obj('gut'), 'create')
  assert.deepEqual(gesehen, ['gut'])
})

test('auch ein abgelehntes Versprechen bleibt folgenlos', async () => {
  const ajna = fakeAjna([])
  const meldungen = []
  followSource(ajna, 'kartevonmorgen', {
    onAdd: async () => { throw new Error('serverfehler') },
    warn: (m) => meldungen.push(m),
  })
  ajna.ereignis(obj('a'), 'create')
  await new Promise(r => setTimeout(r, 0))
  assert.equal(meldungen.length, 1)
  assert.match(meldungen[0], /serverfehler/)
})

test('das Aufhören hört wirklich auf', () => {
  const ajna = fakeAjna([])
  const s = sammle()
  const stop = followSource(ajna, 'kartevonmorgen', s)
  stop()
  assert.equal(ajna.hatHoerer(), false)
})

test('ohne verbundenes ajna gibt es eine klare Ansage', () => {
  // Der häufigste Anfängerfehler: `connect: true` vergessen. Ohne ihn gibt es
  // weder Bestand noch Abo, und ein stilles Nichts wäre das Schlimmste.
  assert.throws(() => followSource({}, 'x'), /connect: true/)
  assert.throws(() => followSource(fakeAjna(), ''), /source fehlt/)
})

test('Objekte ohne brauchbare Koordinaten fallen aus dem Umkreis', () => {
  assert.equal(selects(obj('a', { lat: null }), { source: 'kartevonmorgen', center: KOBLENZ, radiusKm: 10 }), false)
  assert.equal(selects(null, { source: 'x' }), false)
  assert.equal(selects(obj('a'), { source: 'kartevonmorgen' }), true, 'ohne Umkreis zählt nur die Quelle')
})

test('Entfernung stimmt gegen eine bekannte Strecke', () => {
  // Koblenz → Neuwied, Luftlinie rund 10 km.
  const km = distanceKm(50.3591, 7.5932, 50.4514, 7.5363)
  assert.ok(km > 9 && km < 12, `${km.toFixed(1)} km`)
})
