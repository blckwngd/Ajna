// Tests für nextSelection aus client/core/FilterDialog.js — die Regeln hinter
// den Häkchen im Inhaltsfilter.
//
// Die Schichten unten sind echt: so veröffentlicht die C-ITS-Brücke ihr
// Manifest (agents/cits-bridge.mjs). Wichtig daran ist, dass „Alles" KEIN
// Prädikat hat — daran, und nicht am Namen, erkennt der Filter die Summe.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextSelection } from './FilterDialog.js'

const LAYERS = [
  { key: 'all', label: 'Alles', predicate: null },
  { key: 'infrastructure', label: 'Ampeln & Stationen', predicate: { field: 'state.moving', equals: false } },
  { key: 'transit', label: 'Bus & Bahn', predicate: { field: 'state.transit_line', exists: true } },
  { key: 'car', label: 'PKW', predicate: { field: 'state.kind', equals: 'car' } },
]
const ALLE = LAYERS.map(l => l.key)
const sortiert = (a) => [...a].sort()

test('„Alles" abwählen nimmt alle Haken mit', () => {
  // Der gemeldete Fall: vorher blieb nur „Alles" leer, darunter stand weiter
  // alles angehakt.
  assert.deepEqual(nextSelection(LAYERS, undefined, 'all'), [])
  assert.deepEqual(nextSelection(LAYERS, ALLE, 'all'), [])
})

test('„Alles" anwählen setzt alle Haken', () => {
  assert.deepEqual(sortiert(nextSelection(LAYERS, [], 'all')), sortiert(ALLE))
  assert.deepEqual(sortiert(nextSelection(LAYERS, ['car'], 'all')), sortiert(ALLE))
})

test('eine einzelne Schicht abwählen lässt „Alles" mit abfallen', () => {
  // OHNE DIESE REGEL WÄRE DAS HÄKCHEN EINE LÜGE: matches() bricht bei einer
  // gewählten Schicht ohne Prädikat sofort mit „sichtbar" ab — das abgewählte
  // PKW-Häkchen hätte sichtbar umgeschaltet und nichts bewirkt.
  const next = nextSelection(LAYERS, ALLE, 'car')
  assert.ok(!next.includes('all'), next.join(','))
  assert.ok(!next.includes('car'))
  assert.deepEqual(sortiert(next), sortiert(['infrastructure', 'transit']))
})

test('das gilt auch aus dem unkonfigurierten Zustand heraus', () => {
  // `undefined` heisst „noch nie angefasst" und wird als „alles an" angezeigt.
  const next = nextSelection(LAYERS, undefined, 'transit')
  assert.deepEqual(sortiert(next), sortiert(['infrastructure', 'car']))
})

test('ist die letzte fehlende Schicht wieder an, kommt „Alles" zurück', () => {
  const next = nextSelection(LAYERS, ['infrastructure', 'transit'], 'car')
  assert.deepEqual(sortiert(next), sortiert(ALLE))
})

test('solange etwas fehlt, bleibt „Alles" aus', () => {
  const next = nextSelection(LAYERS, ['infrastructure'], 'car')
  assert.ok(!next.includes('all'), next.join(','))
  assert.deepEqual(sortiert(next), sortiert(['infrastructure', 'car']))
})

test('ein Abschnitt mit nur einer Summen-Schicht kippt sauber', () => {
  // Movebank, Adress-Lupe und die VesselFinder-Brücke melden genau eine
  // Schicht ohne Prädikat.
  const eine = [{ key: 'all', label: 'Alle Tiere', predicate: null }]
  assert.deepEqual(nextSelection(eine, undefined, 'all'), [])
  assert.deepEqual(nextSelection(eine, [], 'all'), ['all'])
})

test('die Summe wird am fehlenden Prädikat erkannt, nicht am Namen', () => {
  // Die Adress-Lupe nennt ihre Summen-Schicht „Adress-Lupe", der ADS-B-Agent
  // „Alle Flugzeuge". Ein Vergleich auf den Schlüssel „all" oder auf das Wort
  // „Alle" ginge bei beiden daneben.
  const fremd = [
    { key: 'lupe', label: 'Adress-Lupe' },                                  // kein predicate-Feld
    { key: 'haus', label: 'Häuser', predicate: { field: 'state.kind', equals: 'house' } },
  ]
  assert.deepEqual(nextSelection(fremd, ['lupe', 'haus'], 'lupe'), [])
  assert.deepEqual(sortiert(nextSelection(fremd, [], 'lupe')), sortiert(['lupe', 'haus']))
})

test('kaputte Eingaben kippen nichts um', () => {
  assert.deepEqual(nextSelection(undefined, undefined, 'all'), [])
  assert.deepEqual(nextSelection(LAYERS, null, 'car'), ['car'])
})
