// Tests für agents/lib/adresse.mjs — die Teile der Adress-Anreicherung, die
// ohne Netz prüfbar sind.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  abstandM, gewerbeAus, adressenAus, telefonbuchUrl, entschaerfe, namenAus, alsText,
} from './adresse.mjs'

test('abstandM rechnet in Metern', () => {
  assert.equal(Math.round(abstandM(50.0, 7.0, 50.0, 7.0)), 0)
  // 0,001° Breite ≈ 111 m
  assert.ok(Math.abs(abstandM(50.0, 7.0, 50.001, 7.0) - 111) < 2)
})

test('gewerbeAus nimmt contact:*-Schreibweisen mit', () => {
  const f = gewerbeAus({ name: 'Bäckerei', 'contact:phone': '+49 261 1', 'contact:website': 'https://x.de' })
  const felder = Object.fromEntries(f.map(x => [x.feld, x.wert]))
  assert.equal(felder.Name, 'Bäckerei')
  assert.equal(felder.Telefon, '+49 261 1')
  assert.equal(felder.Webseite, 'https://x.de')
})

test('gewerbeAus gibt jedem Feld eine Herkunft', () => {
  // Ohne Herkunft wäre die Anzeige eine Behauptung statt einer Vorführung.
  for (const f of gewerbeAus({ name: 'X', phone: '1' })) {
    assert.equal(f.herkunft, 'OpenStreetMap')
  }
})

test('gewerbeAus lässt leere Tags weg statt leere Felder zu erzeugen', () => {
  assert.deepEqual(gewerbeAus({}), [])
  assert.deepEqual(gewerbeAus({ name: '' }), [])
})

test('adressenAus liest Flächen (way) über center — nicht nur Punkte', () => {
  // DIE FALLE: Häuser sind in OSM meistens Flächen. Wer nur el.lat liest,
  // verliert sie stillschweigend — die Liste bliebe leer, ohne Fehler.
  const antwort = {
    elements: [
      { type: 'way', center: { lat: 50.001, lon: 7.0 }, tags: { 'addr:housenumber': '5', 'addr:street': 'Fernweg' } },
      { type: 'node', lat: 50.0001, lon: 7.0, tags: { 'addr:housenumber': '1', 'addr:street': 'Nahweg' } },
    ],
  }
  const a = adressenAus(antwort, 50.0, 7.0)
  assert.equal(a.length, 2)
  assert.equal(a[0].strasse, 'Nahweg', 'nach Entfernung sortiert, das nähere zuerst')
  assert.equal(a[1].strasse, 'Fernweg')
})

test('adressenAus überspringt, was keine Hausnummer oder keinen Punkt hat', () => {
  const antwort = {
    elements: [
      { type: 'node', lat: 50, lon: 7, tags: { amenity: 'bench' } },          // keine Adresse
      { type: 'way', tags: { 'addr:housenumber': '9' } },                      // kein center
      { type: 'node', lat: 50, lon: 7, tags: { 'addr:housenumber': '7' } },    // gut
    ],
  }
  const a = adressenAus(antwort, 50, 7)
  assert.equal(a.length, 1)
  assert.equal(a[0].hausnummer, '7')
})

test('adressenAus begrenzt die Trefferzahl', () => {
  const elements = Array.from({ length: 20 }, (_, i) => ({
    type: 'node', lat: 50 + i / 100000, lon: 7, tags: { 'addr:housenumber': String(i) },
  }))
  assert.equal(adressenAus({ elements }, 50, 7, 3).length, 3)
})

test('adressenAus verträgt eine leere oder kaputte Antwort', () => {
  assert.deepEqual(adressenAus(null, 50, 7), [])
  assert.deepEqual(adressenAus({}, 50, 7), [])
  assert.deepEqual(adressenAus({ elements: [] }, 50, 7), [])
})

test('telefonbuchUrl baut das bestätigte Schema', () => {
  const u = telefonbuchUrl('56566', 'Hauptstraße', '127')
  assert.equal(u,
    'https://www.dastelefonbuch.de/R%C3%BCckw%C3%A4rts-Suche/56566----Hauptstra%C3%9Fe--127')
})

test('telefonbuchUrl kodiert Leerzeichen und Umlaute', () => {
  const u = telefonbuchUrl('12345', 'Am Alten Markt', '3a')
  assert.ok(u.includes('Am%20Alten%20Markt'), u)
  assert.ok(u.endsWith('--3a'))
})

test('entschaerfe entfernt Entities und Restmarkup', () => {
  assert.equal(entschaerfe('M&uuml;ller'), 'M&uuml;ller', 'nur die fünf Standard-Entities')
  assert.equal(entschaerfe('A &amp; B'), 'A & B')
  assert.equal(entschaerfe('<b>ReThink</b>  e.V.'), 'ReThink e.V.')
  assert.equal(entschaerfe(null), '')
})

test('namenAus liefert eindeutige Namen', () => {
  const html = '<li nasort="ReThink e.V."></li><li nasort="ReThink e.V."></li><li nasort="Zweiter"></li>'
  assert.deepEqual(namenAus(html), ['ReThink e.V.', 'Zweiter'])
})

test('namenAus liefert bei fremdem Markup NICHTS statt Unsinn', () => {
  // Wenn die Seite umgebaut wird, muss ein leeres Ergebnis herauskommen —
  // niemals eine Zeile, die wie eine Auskunft aussieht.
  assert.deepEqual(namenAus('<div class="treffer">Irgendwer</div>'), [])
  assert.deepEqual(namenAus(''), [])
  assert.deepEqual(namenAus(undefined), [])
})

test('alsText sagt es deutlich, wenn nichts gefunden wurde', () => {
  assert.match(alsText({ adressen: [], radius: 25 }), /Keine Adresse im Umkreis von 25 m/)
})

test('alsText führt jede Herkunft mit', () => {
  const t = alsText({
    radius: 25,
    adressen: [{
      strasse: 'Hauptstraße', hausnummer: '127', plz: '56566', ort: 'Neuwied', entfernungM: 8,
      felder: [
        { feld: 'Name', wert: 'ReThink e.V.', herkunft: 'OpenStreetMap' },
        { feld: 'Registereintrag', wert: 'VR 1234', herkunft: 'Impressum (§5 DDG)' },
      ],
    }],
  })
  assert.match(t, /\[OpenStreetMap\]/)
  assert.match(t, /\[Impressum \(§5 DDG\)\]/)
  assert.match(t, /Hauptstraße 127, 56566 Neuwied \(8 m\)/)
})

test('alsText kennzeichnet Ausfälle als Ausfall, nicht als Fehlanzeige', () => {
  // Eine Sperre oder ein gebrochener Parser ist KEINE Aussage über die Adresse.
  // Würde das als „kein Eintrag" erscheinen, wäre die Anzeige gelogen.
  const t = alsText({
    radius: 25,
    adressen: [{
      strasse: 'X', hausnummer: '1', entfernungM: 3,
      felder: [{ feld: 'Handelsregister', wert: 'Quelle nicht erreichbar (HTTP 502)', herkunft: 'OffeneRegister', ausfall: true }],
    }],
  })
  assert.match(t, /⚠ Handelsregister/)
})

test('alsText weist auf die Flüchtigkeit hin', () => {
  const t = alsText({ radius: 25, adressen: [{ strasse: 'X', hausnummer: '1', entfernungM: 1, felder: [] }] })
  assert.match(t, /flüchtig/)
})
