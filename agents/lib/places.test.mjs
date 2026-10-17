// Tests für agents/lib/places.mjs und tools/places-import.mjs.
//
// ANLASS: OpenStreetMap ist in Städten dicht und auf dem Land löchrig. Der
// Abzug soll Lücken füllen, ohne das zu überschreiben, was Ortskundige
// eingetragen haben — und ohne so zu tun, als käme beides aus derselben Hand.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  SCHEMA, INDEX, cell, distanceM, placesNearby, asFields, mergeByName, normaliseName, openPlaces,
} from './places.mjs'
import { zuOrt, zeileLesen } from '../../tools/places-import.mjs'

// Koblenz, wie im Browser-Beispiel.
const HIER = { lat: 50.3591, lon: 7.5932 }

function db(orte = []) {
  const d = new DatabaseSync(':memory:')
  d.exec(SCHEMA); d.exec(INDEX)
  const ein = d.prepare(`INSERT INTO orte
    (id,quelle,name,kategorie,lat,lon,zlat,zlon,webseite,telefon,email,strasse,hausnummer,plz,ort,guete)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  for (const [i, o] of orte.entries()) {
    ein.run(o.id || `t${i}`, o.quelle || 'test', o.name, o.kategorie ?? null,
      o.lat, o.lon, cell(o.lat), cell(o.lon), o.webseite ?? null, o.telefon ?? null,
      o.email ?? null, null, null, null, null, o.guete ?? null)
  }
  return d
}

const versetzt = (m, ost = false) => ost
  ? { lat: HIER.lat, lon: HIER.lon + m / (111320 * Math.cos(HIER.lat * Math.PI / 180)) }
  : { lat: HIER.lat + m / 111320, lon: HIER.lon }

// ─── Umkreissuche ─────────────────────────────────────────────────────────

test('Orte kommen nach Entfernung sortiert', () => {
  const d = db([
    { name: 'Fern', ...versetzt(400) },
    { name: 'Nah', ...versetzt(50) },
    { name: 'Mittel', ...versetzt(200) },
  ])
  const r = placesNearby(d, HIER.lat, HIER.lon, 500)
  assert.deepEqual(r.map(x => x.name), ['Nah', 'Mittel', 'Fern'])
  assert.ok(r[0].distanceM < 60, `${r[0].distanceM} m`)
})

test('ein Rechteck ist kein Kreis — ausserhalb des Radius fliegt raus', () => {
  // Der Zellenindex greift grob; die genaue Grenze zieht erst die Nachmessung.
  const d = db([{ name: 'Knapp draussen', ...versetzt(600) }])
  assert.equal(placesNearby(d, HIER.lat, HIER.lon, 500).length, 0)
  assert.equal(placesNearby(d, HIER.lat, HIER.lon, 700).length, 1)
})

test('die Zellen decken auch grosse Radien ab', () => {
  // Eine Zelle ist rund 1,1 km. Bei 3 km muss die Spanne mitwachsen, sonst
  // fehlt still die Hälfte der Treffer.
  const d = db([{ name: 'Weit weg', ...versetzt(2500) }])
  assert.equal(placesNearby(d, HIER.lat, HIER.lon, 3000).length, 1)
})

test('nach Güte, Kategorie und Webseite lässt sich sieben', () => {
  const d = db([
    { name: 'Sicher', ...versetzt(10), guete: 0.9, kategorie: 'eat_and_drink', webseite: 'https://a.de' },
    { name: 'Unsicher', ...versetzt(20), guete: 0.2, kategorie: 'eat_and_drink' },
    { name: 'Andere Branche', ...versetzt(30), guete: 0.9, kategorie: 'automotive' },
  ])
  assert.deepEqual(placesNearby(d, HIER.lat, HIER.lon, 500, { minGuete: 0.5 }).map(x => x.name),
    ['Sicher', 'Andere Branche'])
  assert.deepEqual(placesNearby(d, HIER.lat, HIER.lon, 500, { kategorien: ['eat_and_drink'] }).map(x => x.name),
    ['Sicher', 'Unsicher'])
  assert.deepEqual(placesNearby(d, HIER.lat, HIER.lon, 500, { nurMitWebseite: true }).map(x => x.name),
    ['Sicher'])
})

test('fehlende Güte gilt als brauchbar, nicht als null', () => {
  // Nicht jeder Abzug führt den Wert. Ein fehlender darf keinen Ort verschlucken.
  const d = db([{ name: 'Ohne Wert', ...versetzt(10) }])
  assert.equal(placesNearby(d, HIER.lat, HIER.lon, 500, { minGuete: 0.8 }).length, 1)
})

test('eine fehlende Datenbank ist kein Fehler', () => {
  assert.deepEqual(placesNearby(null, 50, 7, 500), [])
  assert.deepEqual(placesNearby(db([]), NaN, 7, 500), [])
  const { db: d, grund } = openPlaces(['/gibt/es/nicht.db'])
  assert.equal(d, null)
  assert.match(grund, /kein Abzug gefunden/)
})

// ─── Zusammenführen ───────────────────────────────────────────────────────

test('OSM geht vor — der Abzug füllt nur Lücken', () => {
  // Dort trägt jemand ein, der da war. Ein Abzug ist breiter, aber anonym
  // zusammengetragen.
  const osm = [{ name: 'Bäckerei Schmitt GmbH' }, { name: 'Café Central' }]
  const abzug = [{ name: 'Bäckerei Schmitt' }, { name: 'Autohaus Weber' }]
  const { liste, ergaenzt } = mergeByName(osm, abzug)
  assert.equal(ergaenzt, 1, 'nur das Autohaus ist neu')
  assert.deepEqual(liste.map(x => x.name),
    ['Bäckerei Schmitt GmbH', 'Café Central', 'Autohaus Weber'])
})

test('der Namensvergleich übersieht Rechtsformen, Zeichensetzung und „und"', () => {
  assert.equal(normaliseName('Bäckerei Schmitt GmbH'), normaliseName('Bäckerei  Schmitt'))
  // DER FALL, DEN EIN SCHLAMPIGER TEST AUFGEDECKT HAT: OSM führt „Weber &
  // Sohn", der Abzug „Weber und Sohn". Ohne diese Regel stünde derselbe
  // Betrieb zweimal in der Liste — sichtbar nebeneinander.
  assert.equal(normaliseName('Weber & Sohn e.K.'), normaliseName('Weber und Sohn'))
  assert.notEqual(normaliseName('Bäckerei Schmitt'), normaliseName('Bäckerei Weber'))
})

test('leere Seiten kippen das Zusammenführen nicht', () => {
  assert.equal(mergeByName(null, [{ name: 'A' }]).liste.length, 1)
  assert.equal(mergeByName([{ name: 'A' }], null).ergaenzt, 0)
  assert.equal(mergeByName([], []).liste.length, 0)
})

// ─── Felder mit Herkunft ──────────────────────────────────────────────────

test('jedes Feld trägt seine Herkunft, und die nennt den Abzug', () => {
  // Wer „Overture" liest, weiss: Das hat kein Ortskundiger eingetragen.
  const f = asFields({ name: 'Autohaus Weber', quelle: 'overture-2026-09',
    kategorie: 'automotive', webseite: 'https://weber.de', telefon: '0261 1234' })
  assert.deepEqual(f.map(x => x.feld), ['Name', 'Branche', 'Webseite', 'Telefon'])
  for (const x of f) assert.match(x.herkunft, /overture-2026-09/)
})

test('ohne Namen gibt es keine Felder', () => {
  assert.deepEqual(asFields({ webseite: 'https://x.de' }), [])
  assert.deepEqual(asFields(null), [])
})

// ─── Einlesen ─────────────────────────────────────────────────────────────

test('die Overture-Form wird gelesen', () => {
  const o = zuOrt({
    id: '08f1fa...', names: { primary: 'Autohaus Weber' },
    categories: { primary: 'automotive' }, confidence: 0.84,
    lat: 50.36, lon: 7.59,
    websites: ['https://weber.de'], phones: ['+49 261 1234'], emails: ['info@weber.de'],
    addresses: [{ freeform: 'Hauptstr. 1', postcode: '56068', locality: 'Koblenz' }],
  }, 'overture-2026-09')
  assert.equal(o.name, 'Autohaus Weber')
  assert.equal(o.kategorie, 'automotive')
  assert.equal(o.webseite, 'https://weber.de')
  assert.equal(o.plz, '56068')
  assert.equal(o.guete, 0.84)
  assert.equal(o.quelle, 'overture-2026-09')
})

test('GeoJSON wird genauso gelesen', () => {
  // Wer den Auszug als GeoJSON zieht, soll dieselbe Datei benutzen können.
  const o = zuOrt({
    type: 'Feature', geometry: { type: 'Point', coordinates: [7.59, 50.36] },
    properties: { id: 'x', name: 'Café Central', basic_category: 'eat_and_drink' },
  }, 'q')
  assert.equal(o.name, 'Café Central')
  assert.equal(o.lat, 50.36)
  assert.equal(o.lon, 7.59)
  assert.equal(o.kategorie, 'eat_and_drink')
})

test('Datensätze ohne Namen oder Ort werden verworfen', () => {
  // Ein Ort ohne Koordinate ist kein Ort; ein Name ohne Ort auch nicht.
  assert.equal(zuOrt({ names: { primary: 'Ohne Ort' } }, 'q'), null)
  assert.equal(zuOrt({ lat: 50, lon: 7 }, 'q'), null)
  assert.equal(zuOrt({ name: 'Unmöglich', lat: 99, lon: 7 }, 'q'), null)
  assert.equal(zuOrt(null, 'q'), null)
})

test('Array- und GeoJSON-Hüllen stören nicht', () => {
  assert.equal(zeileLesen('['), null)
  assert.equal(zeileLesen(']'), null)
  assert.equal(zeileLesen(''), null)
  assert.equal(zeileLesen('kaputt{'), null)
  assert.equal(zeileLesen('{"a":1},').a, 1, 'das Komma am Zeilenende fällt weg')
})

test('ohne id entsteht eine aus Ort und Namen', () => {
  // Sonst überschreiben sich namenlose Einträge gegenseitig im Primärschlüssel.
  const a = zuOrt({ name: 'A', lat: 50.1, lon: 7.1 }, 'q')
  const b = zuOrt({ name: 'B', lat: 50.1, lon: 7.1 }, 'q')
  assert.notEqual(a.id, b.id)
})

test('Entfernung stimmt gegen eine bekannte Strecke', () => {
  // Koblenz → Neuwied, Luftlinie rund 10 km.
  const km = distanceM(50.3591, 7.5932, 50.4514, 7.5363) / 1000
  assert.ok(km > 9 && km < 12, `${km.toFixed(1)} km`)
})
