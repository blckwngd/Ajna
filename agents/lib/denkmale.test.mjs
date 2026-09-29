// Tests für agents/lib/denkmale.mjs — gegen echten Wikitext, ohne Netz.
//
// Die Ausschnitte unten stammen wörtlich aus „Liste der Naturdenkmale in
// Neuwied" (21.09.2026). Erfundener Wikitext würde genau die Eigenheiten
// verfehlen, an denen ein Parser scheitert.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zeilenAus, parameterAus, klartext, listenTitel, gemeindeKandidaten,
         stolpersteineAus, HERKUNFT } from './denkmale.mjs'

const SEITE = `== Naturdenkmale ==
{{Naturdenkmalliste Rheinland-Pfalz Tabellenkopf|Ortsteil=|Ortsgemeinde=|Verbandsgemeinde=}}
{{Naturdenkmalliste Rheinland-Pfalz Tabellenzeile
 | Nummer = ND-7138-401
 | Bezeichnung = Ginkgo biloba
 | Artikel =
 | Beschreibung = ''[[Ginkgo|Ginkgo biloba]]''
 | Ortsteil = [[Engers]]
 | Adresse = Johannisstraße, bei Nr. 23
 | NS = 50.423028
 | EW = 7.542743
 | Bild =
 | Commonscat =
 }}
{{Naturdenkmalliste Rheinland-Pfalz Tabellenzeile
 | Nummer = ND-7138-406
 | Bezeichnung = Gerichtslinde
 | Artikel =
 | Beschreibung = ''[[Linden (Botanik)|Tilia sp.]]''; alte [[Gerichtslinde]] auf dem historischen [[Gerichtsbaum|Gerichtsplatz]] bei der [[Feldkirche (Neuwied)|Feldkirche]]
 | Ortsteil = [[Wollendorf]]
 | Adresse = Feldkircher Straße, bei Nr. 89
 | NS = 50.452227
 | EW = 7.432314
 | Bild = Gerichtslinde2.JPG
 | Commonscat =
 }}
== Ehemalige Naturdenkmale ==
{{Naturdenkmalliste Rheinland-Pfalz Tabellenzeile
 | Nummer = ND-7138-410
 | Bezeichnung = Linden am Südtor der Abtei Rommersdorf
 | Beschreibung = ''[[Linden (Botanik)|Tilia sp.]]'', drei Bäume; Rechtsverordnung vor 2013 aufgehoben
 | Ortsteil = [[Heimbach-Weis|Heimbach]]
 | NS = 50.455702
 | EW = 7.534785
 }}
`

test('liest alle Zeilen der Liste', () => {
  assert.equal(zeilenAus(SEITE).length, 3)
})

test('Koordinaten kommen als Zahlen an', () => {
  const [erste] = zeilenAus(SEITE)
  assert.equal(erste.lat, 50.423028)
  assert.equal(erste.lon, 7.542743)
})

test('Felder landen dort, wo sie hingehören', () => {
  const linde = zeilenAus(SEITE).find(d => d.bezeichnung === 'Gerichtslinde')
  assert.equal(linde.nummer, 'ND-7138-406')
  assert.equal(linde.ortsteil, 'Wollendorf')
  assert.equal(linde.adresse, 'Feldkircher Straße, bei Nr. 89')
  assert.equal(linde.bild, 'Gerichtslinde2.JPG')
  assert.equal(linde.herkunft, HERKUNFT)
})

test('DIE FALLE: ein senkrechter Strich INNERHALB eines Wikilinks', () => {
  // `[[Linden (Botanik)|Tilia sp.]]` — ein naives split('|') macht daraus zwei
  // halbe Parameter, und die Beschreibung wäre zerrissen.
  const linde = zeilenAus(SEITE).find(d => d.bezeichnung === 'Gerichtslinde')
  assert.match(linde.beschreibung, /^Tilia sp\.; alte Gerichtslinde/)
  assert.match(linde.beschreibung, /bei der Feldkirche$/)
})

test('erloschene Denkmale sind als solche gekennzeichnet', () => {
  // Sonst behauptete die Anzeige Schutz, den es nicht mehr gibt — bei einem
  // Werkzeug, das für Schutz sensibilisieren soll, die schlimmste Sorte Fehler.
  const alle = zeilenAus(SEITE)
  assert.equal(alle.filter(d => d.erloschen).length, 1)
  assert.equal(alle.find(d => d.erloschen).nummer, 'ND-7138-410')
  assert.ok(alle.filter(d => !d.erloschen).every(d => d.erloschen === false))
})

test('ohne Abschnitt „Ehemalige" gilt keines als erloschen', () => {
  const nurAktive = SEITE.slice(0, SEITE.indexOf('== Ehemalige'))
  assert.ok(zeilenAus(nurAktive).every(d => d.erloschen === false))
})

test('Zeilen ohne Koordinaten werden übergangen, nicht geraten', () => {
  const ohne = `{{Naturdenkmalliste Rheinland-Pfalz Tabellenzeile
 | Nummer = ND-1
 | Bezeichnung = Irgendwas
 }}`
  assert.equal(zeilenAus(ohne).length, 0)
})

test('Zeilen ohne Bezeichnung ebenso', () => {
  const ohne = `{{Naturdenkmalliste Rheinland-Pfalz Tabellenzeile
 | Nummer = ND-1
 | NS = 50.1
 | EW = 7.1
 }}`
  assert.equal(zeilenAus(ohne).length, 0)
})

test('Schrott ergibt eine leere Liste statt eines Absturzes', () => {
  assert.deepEqual(zeilenAus(''), [])
  assert.deepEqual(zeilenAus(null), [])
  assert.deepEqual(zeilenAus('{{Naturdenkmalliste Rheinland-Pfalz Tabellenzeile | Nummer = X'), [])
})

test('parameterAus trennt nur auf äusserer Ebene', () => {
  const p = parameterAus(" | A = [[x|y]] | B = {{t|1|2}} | C = 3 ")
  assert.equal(p.A, '[[x|y]]')
  assert.equal(p.B, '{{t|1|2}}')
  assert.equal(p.C, '3')
})

test('klartext räumt Auszeichnung weg', () => {
  assert.equal(klartext("''[[Ginkgo|Ginkgo biloba]]''"), 'Ginkgo biloba')
  assert.equal(klartext('[[Wollendorf]]'), 'Wollendorf')
  assert.equal(klartext('Text<ref name="a">Quelle</ref> weiter'), 'Text weiter')
  assert.equal(klartext('<!-- versteckt -->sichtbar'), 'sichtbar')
  assert.equal(klartext(null), '')
})

test('listenTitel baut den Seitennamen', () => {
  assert.equal(listenTitel('Neuwied'), 'Liste der Naturdenkmale in Neuwied')
  assert.equal(listenTitel(' Mainz '), 'Liste der Naturdenkmale in Mainz')
})

// ─── Von der Koordinate zur Gemeinde ──────────────────────────────────────

test('gemeindeKandidaten sortiert vom Kleinsten zum Grössten', () => {
  // Gemessen an Hochspeyer: Der Ort hat eine eigene Liste, die
  // Verbandsgemeinde wäre der Rückfall.
  const k = gemeindeKandidaten({
    village: 'Hochspeyer', municipality: 'Enkenbach-Alsenborn',
    county: 'Landkreis Kaiserslautern', state: 'Rheinland-Pfalz',
  })
  assert.deepEqual(k, ['Hochspeyer', 'Enkenbach-Alsenborn'])
})

test('der Landkreis ist KEIN Kandidat', () => {
  // „Liste der Naturdenkmale in Landkreis Neuwied" gibt es nicht — Kreislisten
  // heißen „… im Landkreis …". Ein Kandidat, der nie trifft, kostet nur.
  assert.deepEqual(gemeindeKandidaten({ county: 'Landkreis Neuwied' }), [])
})

test('Amtsbezeichnungen fallen weg', () => {
  assert.deepEqual(gemeindeKandidaten({ municipality: 'Verbandsgemeinde Asbach' }), ['Asbach'])
  assert.deepEqual(gemeindeKandidaten({ city: 'Stadt Neuwied' }), ['Neuwied'])
})

test('doppelte Namen erscheinen einmal', () => {
  assert.deepEqual(gemeindeKandidaten({ town: 'Neuwied', city: 'Neuwied' }), ['Neuwied'])
})

test('eine leere Adresse ergibt keine Kandidaten', () => {
  assert.deepEqual(gemeindeKandidaten({}), [])
  assert.deepEqual(gemeindeKandidaten(null), [])
})

// ─── Stolpersteine ────────────────────────────────────────────────────────

const STOLPER = `{| class="wikitable"
|-
| rowspan="4"|Alleestraße 41<br /> {{Coordinate|simple=y|text=ICON2|NS=50.424606|EW=7.544513|type=landmark|region=DE-RP|name=Stolpersteine Alleestraße 41, Neuwied-Engers}}<br />
| {{PersonZelle|Günter|Mendel|nl=1}}
| style="text-align:center" | Hier wohnte<br />'''Günter Mendel'''<br />Jg. 1930
|-
| {{PersonZelle|Hedwig|Mendel|nl=1}}
|-
| Am Carmen-Sylva-Garten 4<br /> {{Coordinate|simple=y|NS=50.425281|EW=7.464391|name=Stolperstein Am Carmen-Sylva-Garten 4, Neuwied}}
| {{PersonZelle|Erich|Salomon|nl=1}}
|}`

test('Stolpersteine: ein Objekt JE ORT, nicht je Person', () => {
  // Vier Steine einer Familie an einer Adresse wären sonst vier Objekte auf
  // demselben Punkt — in der Welt ein einziger, dreifach verdeckter Marker.
  const r = stolpersteineAus(STOLPER, 'Liste der Stolpersteine in Neuwied')
  assert.equal(r.length, 2)
})

test('Stolpersteine: die Namen stehen am Ort', () => {
  const [erster] = stolpersteineAus(STOLPER)
  assert.equal(erster.bezeichnung, 'Stolpersteine Alleestraße 41, Neuwied-Engers')
  assert.deepEqual(erster.personen, ['Günter Mendel', 'Hedwig Mendel'])
  assert.match(erster.beschreibung, /Verlegt für Günter Mendel, Hedwig Mendel\./)
})

test('Stolpersteine: Koordinaten und Art', () => {
  const [erster, zweiter] = stolpersteineAus(STOLPER)
  assert.equal(erster.lat, 50.424606)
  assert.equal(erster.lon, 7.544513)
  assert.equal(erster.art, 'stolperstein')
  assert.equal(zweiter.lat, 50.425281)
  // Ein Gedenkzeichen ist nie „erloschen" — die Kennzeichnung gehört zum
  // Denkmalschutz, nicht hierher.
  assert.equal(zweiter.erloschen, false)
})

test('Stolpersteine: ohne Koordinate kein Eintrag', () => {
  assert.equal(stolpersteineAus('{{Coordinate|simple=y|name=Ohne Lage}}').length, 0)
  assert.equal(stolpersteineAus('').length, 0)
})

// ─── Listenarten ──────────────────────────────────────────────────────────

test('Kulturdenkmäler nutzen dieselbe Zeilenform', () => {
  // Gemessen: „Liste der Kulturdenkmäler in Neuwied" führt 179 Einträge mit
  // derselben Vorlagenform — ein Eintrag in LISTENARTEN, kein neuer Parser.
  const kultur = `{{Denkmalliste Rheinland-Pfalz Tabellenzeile
 | Bezeichnung = Denkmalzone Augustastraße
 | Baujahr = um 1900
 | Beschreibung = geschlossene Zeile aus [[Wohnhaus|Wohnhäusern]]
 | Adresse = Augustastraße
 | NS = 50.431950
 | EW = 7.466210
 }}`
  const [d] = zeilenAus(kultur, 'Liste der Kulturdenkmäler in Neuwied')
  assert.equal(d.art, 'cultural')
  assert.equal(d.bezeichnung, 'Denkmalzone Augustastraße')
  assert.equal(d.baujahr, 'um 1900')
  assert.equal(d.beschreibung, 'geschlossene Zeile aus Wohnhäusern')
})

test('Naturdenkmale behalten ihre Art', () => {
  assert.ok(zeilenAus(SEITE).every(d => d.art === 'nature'))
})
