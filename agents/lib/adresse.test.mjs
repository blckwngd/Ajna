// Tests für agents/lib/adresse.mjs — die Teile der Adress-Anreicherung, die
// ohne Netz prüfbar sind.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  abstandM, gewerbeAus, adressenAus, telefonbuchUrl, entschaerfe, namenAus, alsText,
  registerFelder, hatAusfall, eintraegeAus,
  radiusPruefen, RADIUS_MIN, RADIUS_MAX, RADIUS_VORGABE,
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

test('namenAus liest den Namen aus data-entry-data', () => {
  // So sieht die Seite wirklich aus (an einem echten Treffer abgelesen).
  const html =
    '<div id="entry_1" data-entry-data="id=0057550246111&at=2&na=ReThink+e.V.&bi=0057&pubNo=307">' +
    '</div><div data-entry-data="id=2&na=Zweiter+Eintrag&at=2"></div>'
  assert.deepEqual(namenAus(html), ['ReThink e.V.', 'Zweiter Eintrag'])
})

test('namenAus fällt auf itemprop zurück', () => {
  const html = '<span itemprop="name">ReThink e.V.                </span>'
  assert.deepEqual(namenAus(html), ['ReThink e.V.'])
})

test('namenAus liest NICHT den Sortierschlüssel', () => {
  // `nasort` ist grossgeschrieben und entpunktet — ein Sortierschluessel, kein
  // Anzeigename. Die erste Fassung las genau den und lieferte Unbrauchbares.
  const html = '<li class="lastelement">sectsort:C,ranksort:~,nasort:RETHINK E V,pcsort:56566</li>'
  assert.deepEqual(namenAus(html), [])
})

test('namenAus entdoppelt', () => {
  const html = '<div data-entry-data="na=Gleich"></div><div data-entry-data="na=Gleich"></div>'
  assert.deepEqual(namenAus(html), ['Gleich'])
})

test('namenAus liefert bei fremdem Markup NICHTS statt Unsinn', () => {
  // Wenn die Seite umgebaut wird, muss ein leeres Ergebnis herauskommen —
  // niemals eine Zeile, die wie eine Auskunft aussieht.
  assert.deepEqual(namenAus('<div class="treffer">Irgendwer</div>'), [])
  assert.deepEqual(namenAus(''), [])
  assert.deepEqual(namenAus(undefined), [])
})

test('registerFelder trägt den Stand an JEDEM Feld', () => {
  // Der Abzug ist Jahre alt. Ohne Datum sähe die Angabe aus wie eine Auskunft
  // über heute — das ist der ganze Grund, warum es diese Funktion gibt.
  // Keine Rechtsform: Der Abzug hat dafür keine Spalte — sie steckt im
  // Firmennamen ("… GmbH"). Erfunden wird sie nicht.
  const f = registerFelder({ firma: 'ReThink e.V.', register: 'VR 1234', anschrift: 'Hauptstr. 127' }, '21.10.2022')
  assert.equal(f.length, 3)
  for (const x of f) assert.equal(x.herkunft, 'OffeneRegister (Abzug 21.10.2022)')
})

test('registerFelder gibt OHNE Stand gar nichts aus', () => {
  // Lieber keine Angabe als eine, die sich als aktuell ausgibt.
  assert.deepEqual(registerFelder({ firma: 'X' }, ''), [])
  assert.deepEqual(registerFelder({ firma: 'X' }, undefined), [])
})

test('registerFelder nennt eine frühere Firmierung', () => {
  // Die Volltextsuche trifft auch alte Namen. Wer unter dem alten sucht und nur
  // den neuen sieht, haelt das fuer einen Fehler.
  const f = registerFelder({ firma: 'Munich Re Markets GmbH', frueher: 'Munich ReThink GmbH' }, '2022')
  assert.ok(f.some(x => x.feld === 'Früher' && x.wert === 'Munich ReThink GmbH'))
})

test('registerFelder zeigt eine Auflösung an', () => {
  // Eine aufgeloeste Firma als bestehende zu zeigen waere eine stille
  // Falschaussage.
  const f = registerFelder({ firma: 'X', aufgeloest: '2021-04-06' }, '2022')
  assert.ok(f.some(x => x.feld === 'Aufgelöst' && x.wert === '2021-04-06'))
})

test('registerFelder lässt Leeres weg statt leere Felder zu erzeugen', () => {
  const f = registerFelder({ firma: 'X', register: '', rechtsform: '   ', anschrift: null }, '2022')
  assert.equal(f.length, 1)
  assert.equal(f[0].feld, 'Firma')
})

test('registerFelder verträgt einen fehlenden Treffer', () => {
  assert.deepEqual(registerFelder(null, '2022'), [])
})

test('alsText sagt es deutlich, wenn nichts gefunden wurde', () => {
  assert.match(alsText({ adressen: [], radius: 25 }), /Keine Adresse im Umkreis von 25 m/)
})

test('alsText unterscheidet AUSFALL von Fehlanzeige', () => {
  // Der Fall trat wirklich ein: Nach einer Overpass-Drosselung meldete die Lupe
  // an einer Stelle mit Häusern „keine Adresse gefunden" — eine Sperre als
  // Tatsache über den Ort. Das ist der Unterschied, auf den es ankommt.
  const aus = alsText({ adressen: [], radius: 25, quelleAus: true })
  assert.match(aus, /antwortet gerade nicht/)
  assert.ok(!/Keine Adresse/.test(aus), aus)

  const leer = alsText({ adressen: [], radius: 25, quelleAus: false })
  assert.match(leer, /Keine Adresse im Umkreis von 25 m/)
})

test('alsText zählt ausgelassene Adressen, statt sie zu verschweigen', () => {
  // Im erweiterten Modus werden Adressen ohne Telefonbucheintrag weggelassen —
  // sonst besteht die Auskunft überwiegend aus „kein Eintrag". Stilles
  // Verschwinden wäre aber wieder eine Aussage ohne Beleg, diesmal über die
  // Vollständigkeit. Deshalb eine Zeile mit der Zahl.
  const t = alsText({
    radius: 25, verborgen: 7,
    adressen: [{ strasse: 'Hochstraße', hausnummer: '5', entfernungM: 11, felder: [] }],
  })
  assert.match(t, /7 weitere Adresse\(n\) ohne Telefonbucheintrag ausgelassen/)
})

test('alsText unterscheidet „nichts da" von „geprüft, nichts dabei"', () => {
  assert.match(alsText({ adressen: [], radius: 25, verborgen: 0 }),
    /Keine Adresse im Umkreis von 25 m/)
  assert.match(alsText({ adressen: [], radius: 25, verborgen: 8 }),
    /Keine Adresse mit Telefonbucheintrag in der Nähe \(8 geprüft\)/)
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

test('alsText nennt den Suchradius NICHT in der Kopfzeile', () => {
  // Overpass trifft ein Gebäude, sobald sein Umriss den Radius schneidet; die
  // Entfernung misst zum Mittelpunkt. „Umkreis 25 m" neben „(69 m)" liest sich
  // wie ein Fehler, obwohl beides stimmt.
  const t = alsText({ radius: 25, adressen: [{ strasse: 'X', hausnummer: '1', entfernungM: 69, felder: [] }] })
  assert.match(t, /1 Adresse\(n\) in der Nähe/)
  assert.ok(!/Umkreis von 25 m:/.test(t), t.split('\n')[0])
  assert.match(t, /\(69 m\)/)
})

test('alsText nennt den Radius sehr wohl bei Fehlanzeige', () => {
  // Dort erklärt er etwas: Wer nichts findet, will wissen, wie weit gesucht wurde.
  assert.match(alsText({ adressen: [], radius: 25 }), /Umkreis von 25 m/)
})

test('alsText weist auf die Flüchtigkeit hin', () => {
  const t = alsText({ radius: 25, adressen: [{ strasse: 'X', hausnummer: '1', entfernungM: 1, felder: [] }] })
  assert.match(t, /flüchtig/)
})


test('hatAusfall erkennt einen gescheiterten Abruf', () => {
  // Der Agent haelt das letzte Ergebnis fest, damit wiederholtes Anstupsen
  // nichts kostet. Ein FEHLSCHLAG darf dabei nicht mitkonserviert werden —
  // sonst sieht eine kurze Stoerung dauerhaft aus.
  assert.equal(hatAusfall({ adressen: [{ felder: [{ feld: 'Telefonbuch', wert: 'nicht abrufbar', ausfall: true }] }] }), true)
  assert.equal(hatAusfall({ quelleAus: true, adressen: [] }), true)
})

test('hatAusfall laesst ein sauberes Ergebnis durch', () => {
  assert.equal(hatAusfall({ adressen: [{ felder: [{ feld: 'Name', wert: 'X' }] }] }), false)
  assert.equal(hatAusfall({ adressen: [] }), false)
  assert.equal(hatAusfall(null), false)
})


test('eintraegeAus liest Name, Telefon, Anschrift und Link', () => {
  // Am echten Markup abgelesen.
  const html =
    '<div data-entry-data="id=1&at=2&na=ReThink+e.V.&bi=0057">' +
    '<a class="name" href="https://www.dastelefonbuch.de/Details/Neuwied/ReThink-e-V.html">x</a>' +
    '<span itemprop="telephone">02622 90 2<span style="display:none">&hellip;</span>7 87</span>' +
    '<span itemprop="streetAddress">Hauptstr. 127</span>' +
    '<span itemprop="postalCode">56566</span><span itemprop="addressLocality">Neuwied</span>' +
    '</div>'
  const e = eintraegeAus(html)
  assert.equal(e.length, 1)
  assert.equal(e[0].name, 'ReThink e.V.')
  assert.equal(e[0].strasse, 'Hauptstr. 127')
  assert.equal(e[0].ort, '56566 Neuwied')
  assert.match(e[0].link, /^https:\/\/www\.dastelefonbuch\.de\/Details\//)
})

test('eintraegeAus entfernt die Scraper-Bremse aus der Rufnummer', () => {
  // Ein unsichtbares Element zerschneidet die Nummer. Wer nur die Tags entfernt,
  // bekommt „02622 90 2…7 87" — eine falsche Nummer, die echt aussieht.
  const html =
    '<div data-entry-data="na=X">' +
    '<span itemprop="telephone">02622 90 2<span style="display:none">&hellip;</span>7 87</span></div>'
  assert.equal(eintraegeAus(html)[0].telefon, '02622 90 27 87')
})

test('eintraegeAus liefert bei fremdem Markup NICHTS', () => {
  assert.deepEqual(eintraegeAus('<div class="treffer">Irgendwer</div>'), [])
  assert.deepEqual(eintraegeAus(''), [])
})

// ─── Suchumkreis ──────────────────────────────────────────────────────────

test('radiusPruefen nimmt vernuenftige Werte unveraendert', () => {
  assert.equal(radiusPruefen(25), 25)
  assert.equal(radiusPruefen('60'), 60)
  assert.equal(radiusPruefen('37,5'), 38)     // Komma wie im deutschen Formular
})

test('radiusPruefen begrenzt nach oben', () => {
  // Jede Adresse laeuft einzeln durch Impressum, Register und Telefonbuch —
  // ein Umkreis von 5 km waere ein Angriff auf die Quellen, kein Suchradius.
  assert.equal(radiusPruefen(5000), RADIUS_MAX)
  assert.equal(radiusPruefen(RADIUS_MAX + 1), RADIUS_MAX)
})

test('radiusPruefen begrenzt nach unten', () => {
  assert.equal(radiusPruefen(1), RADIUS_MIN)
})

test('radiusPruefen faellt bei Unsinn auf die Vorgabe zurueck', () => {
  // Ein leeres Feld in agent_settings ist kein Wert — und 0 waere ein
  // Werkzeug, das nie etwas findet.
  for (const x of ['', null, undefined, 'viel', 0, -5, NaN]) {
    assert.equal(radiusPruefen(x), RADIUS_VORGABE, `${x}`)
  }
})
