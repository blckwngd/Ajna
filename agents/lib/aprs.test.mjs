// Tests für agents/lib/aprs.mjs.
//
// HERKUNFT DER TESTDATEN — bitte lesen, bevor man sich darauf verlässt:
//
//  [SPEC]    wörtliche Beispiele aus APRS 1.01 (Kapitel „Position Reports" und
//            „Compressed Position Report Data Formats"). Dafür sind auch die
//            erwarteten Ergebnisse dokumentiert, nicht nur die Eingabe.
//  [GERECHNET] von mir aus den Kodierregeln der Spezifikation erzeugt, weil die
//            dortigen Beispiele die Bytes nicht abdruckbar enthalten (MIC-E).
//            Prüft, dass De- und Kodierung zueinander passen — NICHT, dass ein
//            echter Sender es genauso macht.
//
//  [ECHT]    aus einem Mitschnitt vom 02.10.2026 (150 km um Koblenz, erzeugt mit
//            `node tools/aprs-capture.mjs`). Das sind die aussagekräftigsten:
//            echte Sender halten sich nicht an die Beispiele der Spezifikation.
//            Sie haben prompt einen Fehler aufgedeckt — siehe micEKommentar.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseFrame, parseCoord, base91, parsePacket, parseWeather, micEKommentar,
  alsSichtung, relevant, motionOf, symbolInfo, abstandKm, SYMBOLS,
} from './aprs.mjs'

const nah = (a, b, eps = 1e-4) => Math.abs(a - b) < eps

// ─── Rahmen ───────────────────────────────────────────────────────────────

test('Absender, Ziel und Weg werden getrennt', () => {
  const f = parseFrame('DL1ABC-9>APRS,TCPIP*,qAC,T2GER:!4903.50N/07201.75W-Test')
  assert.equal(f.srccall, 'DL1ABC-9')
  assert.equal(f.dstcall, 'APRS')
  assert.deepEqual(f.path, ['TCPIP*', 'qAC', 'T2GER'])
  assert.equal(f.payload, '!4903.50N/07201.75W-Test')
})

test('ein Doppelpunkt in der Nutzlast verwirrt den Rahmen nicht', () => {
  // Nachrichten enthalten einen — nur der ERSTE beendet den Kopf.
  const f = parseFrame('DL1ABC>APRS::DL2XYZ   :Hallo:Welt')
  assert.equal(f.payload, ':DL2XYZ   :Hallo:Welt')
})

test('Server-Kommentare und Mist sind keine Pakete', () => {
  assert.equal(parseFrame('# aprsc 2.1.19'), null)
  assert.equal(parseFrame(''), null)
  assert.equal(parseFrame('ohne-doppelpunkt'), null)
  assert.equal(parseFrame('>APRS:!1234.56N/01234.56W-'), null, 'kein Absender')
})

// ─── Koordinaten ──────────────────────────────────────────────────────────

test('[SPEC] Breite und Länge werden richtig gelesen', () => {
  assert.ok(nah(parseCoord('4903.50N', false).wert, 49 + 3.5 / 60))
  assert.ok(nah(parseCoord('07201.75W', true).wert, -(72 + 1.75 / 60)))
  assert.ok(nah(parseCoord('3325.64S', false).wert, -(33 + 25.64 / 60)))
})

test('ausgeblendete Stellen gelten als Null und werden gemeldet', () => {
  // Die Spezifikation erlaubt Leerzeichen als „sage ich nicht so genau".
  const c = parseCoord('4903.  N', false)
  assert.ok(nah(c.wert, 49 + 3 / 60))
  assert.equal(c.unscharf, 2)
  assert.equal(parseCoord('4903.5 N', false).unscharf, 1)
  assert.equal(parseCoord('4903.50N', false).unscharf, 0)
})

test('unmögliche Koordinaten werden abgewiesen', () => {
  assert.equal(parseCoord('4963.50N', false), null, '63 Minuten gibt es nicht')
  assert.equal(parseCoord('4903.50X', false), null, 'keine Hemisphäre')
  assert.equal(parseCoord('490.50N', false), null, 'zu kurz')
  assert.equal(parseCoord('9903.50N', false), null, 'über 90° Breite')
})

test('base91 zählt wie die Spezifikation', () => {
  assert.equal(base91('!!'), 0)
  assert.equal(base91('!"'), 1)
  assert.equal(base91('"!'), 91)
  // Der Zeichenvorrat reicht von „!" (0) bis „{" (90) — genau 91 Ziffern.
  // Dass „{" im komprimierten Format ZUGLEICH das Kennzeichen für
  // „Funkreichweite statt Fahrt" ist, ist eine andere Ebene.
  assert.equal(base91('{'), 90)
  assert.equal(base91('|'), null, 'eins zu weit')
  assert.equal(base91(' '), null, 'unterhalb des Vorrats')
})

// ─── Unkomprimierte Position ──────────────────────────────────────────────

test('[SPEC] unkomprimierte Position ohne Zeitstempel', () => {
  const p = parsePacket('DL1ABC>APRS:!4903.50N/07201.75W-Test 001234')
  assert.ok(nah(p.lat, 49.0583333))
  assert.ok(nah(p.lon, -72.0291667))
  assert.equal(p.symbolTable, '/')
  assert.equal(p.symbol, '-')
  assert.equal(p.comment, 'Test 001234')
  assert.equal(p.course, null)
})

test('[SPEC] Kurs und Tempo hinter dem Symbol', () => {
  const p = parsePacket('DL1ABC-9>APRS:!4903.50N/07201.75W>088/036Fahrt')
  assert.equal(p.course, 88)
  assert.ok(nah(p.speed, 36 * 0.514444, 1e-3), `${p.speed} m/s`)
  assert.equal(p.comment, 'Fahrt')
})

test('Kurs 000 heisst „unbekannt", 360 heisst Nord', () => {
  assert.equal(parsePacket('A>APRS:!4903.50N/07201.75W>000/000').course, null)
  assert.equal(parsePacket('A>APRS:!4903.50N/07201.75W>360/010').course, 0)
})

test('der Zeitstempel wird übersprungen, nicht als Position gelesen', () => {
  const p = parsePacket('DL1ABC>APRS:@092345z4903.50N/07201.75W>088/036')
  assert.ok(nah(p.lat, 49.0583333), 'sonst stünde die Station im Nirgendwo')
  assert.equal(p.course, 88)
})

test('die Höhe aus /A= wird in Meter umgerechnet', () => {
  const p = parsePacket('DL1ABC>APRS:!4903.50N/07201.75W-/A=001000Turm')
  assert.ok(nah(p.altitude, 304.8, 0.1), `${p.altitude} m`)
  assert.equal(p.comment, 'Turm', 'die Angabe verschwindet aus dem Kommentar')
})

// ─── Komprimierte Position ────────────────────────────────────────────────

test('[SPEC] komprimierte Position — das Beispiel aus der Spezifikation', () => {
  // Dort steht ausdrücklich: 49°30.00'N, 72°45.00'W, Kurs 88°, Tempo 36,2 kn.
  const p = parsePacket('DL1ABC>APRS:!/5L!!<*e7>7P[')
  assert.ok(nah(p.lat, 49.5), `${p.lat}`)
  assert.ok(nah(p.lon, -72.75), `${p.lon}`)
  assert.equal(p.symbol, '>')
  assert.equal(p.course, 88)
  assert.ok(nah(p.speed, 36.23 * 0.514444, 0.01), `${p.speed} m/s`)
})

test('ein Funkreichweiten-Feld wird nicht zu Fahrtdaten', () => {
  // `{` an dieser Stelle heisst „Reichweite", nicht „Kurs 0, Tempo 0".
  const p = parsePacket('DL1ABC>APRS:!/5L!!<*e7>{?![')
  assert.equal(p.course, null)
  assert.equal(p.speed, null)
})

// ─── MIC-E ────────────────────────────────────────────────────────────────

test('[GERECHNET] MIC-E liest die Breite aus dem ZIEL-Rufzeichen', () => {
  // Das Ziel „S32U6T" ist das Beispiel der Spezifikation: 33°25.64'N, West.
  // Die Bytes der Nutzlast habe ich nach deren Kodierregeln erzeugt:
  //   Länge 112°07.08'W, Tempo 20 kn, Kurs 251°, Symbol „/>"
  const payload = '`' + String.fromCharCode(140) + '#$'
    + String.fromCharCode(30) + String.fromCharCode(30) + 'O' + '>/' + 'unterwegs'
  const p = parsePacket(`DL1ABC-9>S32U6T,WIDE1-1:${payload}`)
  assert.ok(nah(p.lat, 33 + 25.64 / 60), `${p.lat}`)
  assert.ok(nah(p.lon, -(112 + 7.08 / 60)), `${p.lon}`)
  assert.equal(p.course, 251)
  assert.ok(nah(p.speed, 20 * 0.514444, 1e-3), `${p.speed} m/s`)
  assert.equal(p.symbol, '>')
  assert.equal(p.symbolTable, '/')
  assert.equal(p.comment, 'unterwegs')
})

test('[GERECHNET] MIC-E: Süd und Ost kippen die Vorzeichen', () => {
  // Ziel mit Ziffern an Position 3/5 → Süd und Ost.
  const payload = '`' + String.fromCharCode(140) + '#$'
    + String.fromCharCode(28) + String.fromCharCode(28) + String.fromCharCode(28) + '>/'
  const p = parsePacket(`DL1ABC>S3261T,X:${payload}`.replace('S3261T', 'S32161'))
  assert.ok(p.lat < 0, `Breite sollte südlich sein: ${p.lat}`)
  assert.ok(p.lon > 0, `Länge sollte östlich sein: ${p.lon}`)
})

test('[GERECHNET] MIC-E: der +100°-Versatz der Länge', () => {
  // Position 5 des Ziels als Buchstabe → 100° werden aufgeschlagen. Ohne diese
  // Regel landete halb Europa im Atlantik.
  const bytes = '`' + String.fromCharCode(28 + 10) + '#$'
    + String.fromCharCode(28) + String.fromCharCode(28) + String.fromCharCode(28) + '>/'
  const ohne = parsePacket(`DL1ABC>S32U61,X:${bytes}`)
  const mit = parsePacket(`DL1ABC>S32UV1,X:${bytes}`)
  assert.ok(nah(Math.abs(mit.lon) - Math.abs(ohne.lon), 100), `${ohne.lon} → ${mit.lon}`)
})

test('MIC-E mit zu kurzer Nutzlast kippt nicht', () => {
  assert.equal(parsePacket('DL1ABC>S32U6T:`ab'), null)
})

// ─── Objekte, Items, Wetter ───────────────────────────────────────────────

test('ein Objekt trägt seinen eigenen Namen, nicht den des Absenders', () => {
  const p = parsePacket('DL1ABC>APRS:;Fieldday *092345z4903.50N/07201.75W-Zeltlager')
  assert.equal(p.type, 'object')
  assert.equal(p.name, 'Fieldday')
  assert.ok(nah(p.lat, 49.0583333))
  assert.equal(p.srccall, 'DL1ABC', 'der Absender bleibt erhalten')
})

test('ein gelöschtes Objekt wird als gelöscht gemeldet', () => {
  const p = parsePacket('DL1ABC>APRS:;Fieldday _092345z4903.50N/07201.75W-')
  assert.equal(p.deleted, true)
  assert.equal(relevant(p, {}), false, 'und fliegt aus dem Filter')
})

test('ein Item wird erkannt', () => {
  const p = parsePacket('DL1ABC>APRS:)Antenne!4903.50N/07201.75Wr')
  assert.equal(p.type, 'item')
  assert.equal(p.name, 'Antenne')
  assert.equal(p.symbol, 'r')
})

test('[SPEC] Wetterdaten werden umgerechnet, nicht als Fahrt gelesen', () => {
  // DER FEHLER, DEN DIESER TEST FESTHÄLT: `220/004` sind an einer
  // Wetterstation Windrichtung und Windstärke in mph. Als Kurs und Tempo
  // gelesen wären die Winddaten verschwunden — und die Station wäre „gefahren".
  const p = parsePacket('DL1ABC>APRS:!4903.50N/07201.75W_220/004g005t077r000p000P000h50b09900')
  assert.equal(p.course, null, 'eine Wetterstation hat keinen Kurs')
  assert.equal(p.speed, null)
  assert.equal(p.weather.wind_dir, 220)
  assert.ok(nah(p.weather.wind_mps, 4 * 0.44704, 1e-3))
  assert.ok(nah(p.weather.gust_mps, 5 * 0.44704, 1e-3))
  assert.equal(p.weather.temp_c, 25, '77 °F sind 25 °C')
  assert.equal(p.weather.humidity, 50)
  assert.equal(p.weather.pressure_hpa, 990)
  assert.equal(p.weather.rain_1h_mm, 0)
})

test('h00 heisst 100 % Luftfeuchte, nicht null', () => {
  // So steht es in der Spezifikation — ein Sonderfall, der sonst als
  // „knochentrocken" in der Welt landet.
  assert.equal(parseWeather('000/000t050h00b10000').humidity, 100)
})

test('Punkte statt Zahlen heissen „kein Messwert"', () => {
  const w = parseWeather('000/000t...h50b10000')
  assert.equal(w.temp_c, null)
  assert.equal(w.humidity, 50)
})

test('ohne einen einzigen Messwert gibt es kein Wetter', () => {
  assert.equal(parseWeather('nur Text'), null)
})

// ─── Filter ───────────────────────────────────────────────────────────────

const auto = parsePacket('DL1ABC-9>APRS:!5021.50N/00735.40W>088/012Unterwegs')

test('der Umkreis wird eingehalten', () => {
  const hier = { lat: 50.3583, lon: -7.59 }
  assert.equal(relevant(auto, { center: hier, radiusKm: 50 }), true)
  assert.equal(relevant(auto, { center: { lat: 0, lon: 0 }, radiusKm: 50 }), false)
  assert.equal(relevant(auto, { center: hier, radiusKm: 0 }), true, 'Radius 0 = überall')
})

test('eine Station ohne Fix landet nicht bei Null/Null', () => {
  const kein = { ...auto, lat: 0, lon: 0 }
  assert.equal(relevant(kein, {}), false)
})

test('eine zu grob angegebene Position wird nicht als Punkt behauptet', () => {
  // Zwei ausgeblendete Stellen sind bis zu 18 km Unschärfe.
  assert.equal(relevant({ ...auto, unscharf: 2 }, {}), true, 'Vorgabe lässt 2 zu')
  assert.equal(relevant({ ...auto, unscharf: 2 }, { maxUnscharf: 1 }), false)
})

// ─── Übersetzung ──────────────────────────────────────────────────────────

test('ein fahrendes Auto wird zu etwas, das man vorlesen kann', () => {
  const s = alsSichtung(auto)
  assert.match(s.description.split('\n')[0], /^Fahrzeug · 22 km\/h · Unterwegs/)
  assert.ok(s.description.split('\n')[0].length <= 100)
  assert.equal(s.appearance.emoji, '🚗')
  assert.equal(s.state.callsign, 'DL1ABC-9')
  assert.equal(s.state.course_deg, 88)
  assert.match(s.description, /Quelle: APRS über APRS-IS/)
})

test('der Bewegungsvektor entsteht aus Kurs und Tempo', () => {
  const m = motionOf(auto, 1000)
  assert.equal(m.trk, 88)
  assert.ok(nah(m.v, 12 * 0.514444, 1e-3))
  assert.equal(m.t, 1000)
  assert.equal(m.lat0, auto.lat)
})

test('eine Wetterstation bekommt keinen Bewegungsvektor', () => {
  const wx = parsePacket('DL1ABC>APRS:!4903.50N/07201.75W_220/004t077h50b09900')
  assert.equal(motionOf(wx), null)
  assert.equal(alsSichtung(wx).state.motion, undefined)
  assert.match(alsSichtung(wx).description, /25 °C/)
  assert.match(alsSichtung(wx).description, /Wetter: Wind 2 m\/s aus 220°/)
})

test('ohne Kursangabe entsteht kein Vektor — Schweigen ist kein Stillstand', () => {
  // Anders als bei C-ITS heisst ein fehlendes Kursfeld hier „nicht gesagt",
  // nicht „steht". Ein v=0 wäre eine Behauptung.
  const ohne = parsePacket('DL1ABC-9>APRS:!5021.50N/00735.40W>Unterwegs')
  assert.equal(motionOf(ohne), null)
})

test('der Weg über die Digipeater steht in der Langfassung', () => {
  const p = parsePacket('DL1ABC-9>APRS,DB0ZB*,WIDE2-1,qAR,DB0XY:!5021.50N/00735.40W>088/012')
  const d = alsSichtung(p).description
  assert.match(d, /Weg: DB0ZB\* → WIDE2-1 → DB0XY/)
  assert.ok(!d.includes('qAR'), 'die q-Konstrukte des Netzes gehören nicht dazu')
})

test('bei einem Objekt wird der Absender genannt', () => {
  const p = parsePacket('DL1ABC>APRS:;Fieldday *092345z4903.50N/07201.75W-Zeltlager')
  assert.match(alsSichtung(p).description, /Gesendet von: DL1ABC/)
})

test('der Name bleibt in den 32 Zeichen, die objects.name fasst', () => {
  const p = parsePacket('DL1ABC>APRS:;Sehr langes Objekt*092345z4903.50N/07201.75W-')
  assert.ok(alsSichtung(p).name.length <= 32)
})

test('jedes Symbol hat Beschriftung, Sinnbild und Beweglichkeit', () => {
  for (const [k, v] of Object.entries(SYMBOLS)) {
    assert.ok(v.label && v.label.length > 2, k)
    assert.ok(v.emoji, k)
    assert.equal(typeof v.moving, 'boolean', k)
  }
  // Ein unbekanntes Symbol behauptet nichts ausser „hat gesendet".
  assert.equal(symbolInfo('§').label, 'APRS-Station')
  assert.equal(symbolInfo('§').moving, false)
})

test('was wir nicht einordnen können, wird verworfen statt geraten', () => {
  assert.equal(parsePacket('DL1ABC>APRS:>Status ohne Position'), null)
  assert.equal(parsePacket('DL1ABC>APRS:T#005,199,000,255,073,123,01101001'), null)
  assert.equal(parsePacket('DL1ABC>APRS::DL2XYZ   :Nachricht'), null)
  assert.equal(parsePacket('DL1ABC>APRS:!kaputt'), null)
})

// ─── MIC-E gegen ECHTE Pakete ─────────────────────────────────────────────
//
// [ECHT] Mitschnitt vom 02.10.2026, 150 km um Koblenz, aufgenommen mit
// `node tools/aprs-capture.mjs`. Die Bytes stehen hier wörtlich, inklusive der
// nicht druckbaren (\x1c, \x1e, \x7f) — genau an denen wäre eine Verwechslung
// sichtbar geworden.
//
// WARUM DIESE SIEBEN REICHEN, um die Dekodierung zu belegen: der Server hatte
// den Mitschnitt schon auf einen Kreis gefiltert. Läge die Breite falsch — und
// sie steckt im ZIEL-Rufzeichen, der unübersichtlichsten Stelle des Formats —,
// landeten die Punkte irgendwo im Nordatlantik. Zwei Pakete derselben Station
// (DL1VED-9) liegen zudem 230 m auseinander, was zu einem fahrenden Auto passt
// und zu einem Dekodierfehler nicht.

const ECHT = [
  {
    was: 'Auto bei Darmstadt, mit Höhe hinter der Gerätekennung',
    zeile: 'DL1ASA-9>TY4VW6,qAO,DL0TRZ-10:`~BupSn>/`"5V}BDL1ASA Tom F02_4',
    lat: 49.77933, lon: 8.64817, course: 182, kmh: 83, symbol: '/>', altitude: 154,
  },
  {
    was: 'Auto bei Trier',
    zeile: 'DL1VED-9>TY5SP7,WIDE1-1,WIDE2-1,qAR,DB0DTR-10:`|R\x7fm_N>/`"5*}RALPH DL1VED ON TOUR_%',
    lat: 49.88450, lon: 6.91650, course: 350, kmh: 30, symbol: '/>',
  },
  {
    was: 'dieselbe Station 230 m weiter — ein Auto, kein Dekodierfehler',
    zeile: 'DL1VED-9>TY5SQ9,WIDE1-1,WIDE2-1,qAR,DO0NMD-10:`|S\x1en>@>/`"5"}RALPH DL1VED ON TOUR_%',
    lat: 49.88650, lon: 6.91700, course: 36, kmh: 43, symbol: '/>',
  },
  {
    was: 'feste Station im Vogelsberg, 458 m — die Höhe stimmt mit dem Gelände',
    zeile: 'DL8UU>UPSRS9,qAR,DB0KT-2:`\x7f1Dm->y/`"8u}439.100MHz FTM - 400 XDE 10 WATT ANT X50 VY 73 KARLO DL8UU_%',
    lat: 50.53983, lon: 9.35667, course: 334, kmh: 20, symbol: '/y', altitude: 458,
  },
  {
    was: 'Handfunkgerät am Niederrhein, Tempo 0',
    zeile: 'DL6LBT-15>UQPVP9,WIDE1-1,WIDE2-1,qAO,DO1EHS-10:`|Lbl"/YY`"4N}VX8E_',
    lat: 51.10150, lon: 6.81167, course: 219, kmh: 0, symbol: 'YY', altitude: 55,
  },
  {
    was: 'stehendes Auto — \\x1c mitten in der Nutzlast, nicht als Kennzeichen',
    zeile: 'DL1ASA-9>TY4VS2,WIDE1-1,WIDE2-1,qAR,DB0FDA-10:`~Bjl"\x1c>/`"5@}BDL1ASA Tom F02_4',
    lat: 49.77200, lon: 8.64633, course: 200, kmh: 0, symbol: '/>',
  },
  {
    was: 'alte MIC-E-Form mit Hochkomma, Kurs 0 heisst „nicht gesagt"',
    zeile: "DG1ID>T9QTW2,WIDE1-1,WIDE2-1,qAS,DB0ND-10:'~]gl \x1c-/>=",
    lat: 49.24533, lon: 8.09583, course: null, kmh: 0, symbol: '/-',
  },
]

for (const f of ECHT) {
  test(`[ECHT] MIC-E: ${f.was}`, () => {
    const p = parsePacket(f.zeile)
    assert.ok(p, 'nicht erkannt')
    assert.ok(nah(p.lat, f.lat, 1e-4), `Breite ${p.lat} statt ${f.lat}`)
    assert.ok(nah(p.lon, f.lon, 1e-4), `Länge ${p.lon} statt ${f.lon}`)
    assert.equal(p.course, f.course, 'Kurs')
    assert.equal(Math.round(p.speed * 3.6), f.kmh, `Tempo ${p.speed} m/s`)
    assert.equal(p.symbolTable + p.symbol, f.symbol)
    if (f.altitude !== undefined) {
      assert.ok(nah(p.altitude, f.altitude, 1), `Höhe ${p.altitude} statt ${f.altitude}`)
    }
  })
}

test('[ECHT] jede dekodierte Position liegt im Filterkreis', () => {
  // DER PRÜFSATZ, DER OHNE REFERENZDATEN AUSKOMMT: APRS-IS hatte serverseitig
  // auf 150 km um Koblenz gefiltert. Was draussen landet, ist ein Parser-Fehler.
  for (const f of ECHT) {
    const p = parsePacket(f.zeile)
    const km = abstandKm(50.4297, 7.4608, p.lat, p.lon)
    assert.ok(km <= 150, `${f.zeile.slice(0, 20)}… liegt ${km.toFixed(0)} km entfernt`)
  }
})

test('[ECHT] die Höhe steht HINTER der Gerätekennung, nicht am Anfang', () => {
  // DER FEHLER, DEN DIESER TEST FESTHÄLT: meine erste Fassung verlangte die
  // Höhe unmittelbar am Kommentaranfang. Davor steht aber ein Byte, das das
  // Funkgerät identifiziert — in vier von sechs MIC-E-Paketen des Mitschnitts.
  // Jede Höhe fiel still durch.
  assert.equal(micEKommentar('`"5V}BDL1ASA Tom F02_4').altitude, 154)
  assert.equal(micEKommentar('`"5V}BDL1ASA Tom F02_4').rest, 'BDL1ASA Tom F02')
  // Ohne Kennung muss es weiter gehen.
  assert.equal(micEKommentar('"5V}Text').altitude, 154)
  // Eine geschweifte Klammer tief im Text ist Text.
  assert.equal(micEKommentar('Lager {Treffpunkt} am Hang').altitude, null)
  assert.equal(micEKommentar('ohne alles').altitude, null)
})

test('[ECHT] Gerätekennungen verschwinden aus dem vorgelesenen Text', () => {
  const p = parsePacket('DL1VED-9>TY5SP7,qAR,X:`|R\x7fm_N>/`"5*}RALPH DL1VED ON TOUR_%')
  assert.equal(p.comment, 'RALPH DL1VED ON TOUR')
  assert.ok(!p.comment.includes('_%'), 'das Yaesu-Gerätekürzel gehört nicht in den Satz')
})

test('[ECHT] die Symbole aus dem Mitschnitt sind alle benannt', () => {
  // Diese sechzehn Pakete liefen vorher als „APRS-Station" durch. Welche
  // Symbole ein Netz wirklich benutzt, sagt kein Standard — nur ein Mitschnitt.
  for (const s of ['&', '#', '>', '[', '-', '_', '0', 'a', 'r', 'P', 'A', 'b', 'R', 'i', '.', 'I', 'y', '?', 'x', 'Y', 'F', 's', '`']) {
    assert.notEqual(symbolInfo(s).label, 'APRS-Station', `Symbol ${JSON.stringify(s)} unbenannt`)
  }
})
