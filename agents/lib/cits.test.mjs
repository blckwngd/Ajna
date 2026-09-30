// Tests für agents/lib/cits.mjs — die Übersetzung von OpenTrafficMap-Punkten.
//
// Die Beispiele sind ECHT: aus einer Live-Verbindung zu wss://opentrafficmap.org
// am 29.09.2026 entnommen und gekürzt. Erfundene Testdaten hätten genau die
// Felder, die man erwartet — und keins der Löcher, über die man stolpert.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alsSichtung, relevant, signalPhase, phaseEndsInS, motionOf, kursGrad,
         abstandKm, KINDS, PRIVATE_KINDS, STATION_TYPES, LIGHT_LABELS } from './cits.mjs'

const JETZT = Date.parse('2026-09-29T10:41:00Z')
const FRISCH = '2026-09-29T10:40:30Z'

const tram = {
  type: 'Feature', id: '00:30:e7:00:01:d8',
  geometry: { type: 'Point', coordinates: [15.44, 47.07] },
  properties: {
    mac: '00:30:e7:00:01:d8', shortMac: '00:01:d8', kind: 'tram', emoji: '🚋',
    typeLabel: 'Tram', lastSeen: FRISCH, stationId: 11943923,
    transitLineDisplay: '4', transitTargetName: 'Liebenau Murpark',
    speedKmh: 27.5, headingDeg: 133,
  },
}

const ampel = {
  type: 'Feature', id: '00:0d:41:ff:bf:37',
  geometry: { type: 'Point', coordinates: [15.4131583, 47.0332809] },
  properties: {
    mac: '00:0d:41:ff:bf:37', shortMac: 'ff:bf:37', kind: 'traffic_light', emoji: '🚦',
    typeLabel: 'Ampel', lastSeen: FRISCH,
    trafficLightSpat: { moy: 390881, groups: [
      { signalGroup: '1', eventState: 6 }, { signalGroup: '2', eventState: 6 },
      { signalGroup: '3', eventState: 3 }, { signalGroup: '5', eventState: 6 },
    ] },
  },
}

const pkw = {
  type: 'Feature', id: 'aa:bb:cc:dd:ee:ff',
  geometry: { type: 'Point', coordinates: [7.56, 50.36] },
  properties: { mac: 'aa:bb:cc:dd:ee:ff', shortMac: 'dd:ee:ff', kind: 'car',
                emoji: '🚗', typeLabel: 'PKW', lastSeen: FRISCH, speedKmh: 48 },
}

// ─── Übersetzung ──────────────────────────────────────────────────────────

test('eine Straßenbahn wird zu etwas, das man vorlesen kann', () => {
  const s = alsSichtung(tram)
  assert.equal(s.name, 'Straßenbahn 4 00:01:d8')
  assert.match(s.description, /Linie 4 → Liebenau Murpark/)
  assert.match(s.description, /28 km\/h/)
  assert.match(s.description, /opentrafficmap\.org/, 'die Quelle steht am Objekt')
  assert.equal(s.lat, 47.07)
  assert.equal(s.lon, 15.44)
  assert.equal(s.headingDeg, 133)
  assert.equal(s.appearance.emoji, '🚋')
  assert.equal(s.state.transit_line, '4')
})

test('der Name bleibt in den 32 Zeichen, die objects.name fasst', () => {
  const lang = { ...tram, properties: { ...tram.properties, transitLineDisplay: 'S-Bahn-Ersatzverkehr 47' } }
  assert.ok(alsSichtung(lang).name.length <= 32)
})

test('ein eigener Name wird nicht mitten in der Adresse abgeschnitten', () => {
  // Echt erlebt: „20001_E_Reuter_Hardenberg 12:39:" — die Kurz-MAC hatte den
  // Namen über die Grenze geschoben und wurde selbst zerhackt.
  const benannt = { ...ampel, properties: { ...ampel.properties, trafficLightName: '20001_E_Reuter_Hardenberg' } }
  const name = alsSichtung(benannt).name
  assert.equal(name, '20001_E_Reuter_Hardenberg')
  assert.ok(!name.endsWith(':'), 'kein angeschnittenes Anhängsel')
})

test('die Platzhalter-Linie „0" gilt als keine Linie', () => {
  // Das Quellsystem setzt sie, wenn nichts bekannt ist. Vorgelesen wäre sie
  // eine Behauptung über einen Fahrplan.
  const ohne = { ...tram, properties: { ...tram.properties, transitLineDisplay: '0' } }
  const s = alsSichtung(ohne)
  assert.equal(s.state.transit_line, null)
  assert.ok(!s.name.includes(' 0 '), s.name)
  assert.ok(!s.description.includes('Linie 0'), s.description)
})

test('eine Ampel sagt ihre Phase in Worten', () => {
  const s = alsSichtung(ampel)
  assert.equal(s.state.signal_phase, 'grün · 3 von 4 Gruppen grün')
  assert.equal(s.state.signal_green, 3)
  assert.equal(s.state.signal_groups, 4)
  assert.match(s.description, /Signal: grün/)
})

test('eine einzelne Signalgruppe wird nicht aufgezählt', () => {
  const eins = signalPhase({ groups: [{ signalGroup: '1', eventState: 3 }] })
  assert.equal(eins.text, 'rot')
})

test('ohne Phasendaten wird keine erfunden', () => {
  assert.equal(signalPhase(null), null)
  assert.equal(signalPhase({ groups: [] }), null)
  assert.equal(alsSichtung(pkw).state.signal_phase, null)
})

test('ein unbekannter Stationstyp bricht nichts', () => {
  const fremd = { ...pkw, properties: { ...pkw.properties, kind: 'zeppelin', typeLabel: 'Zeppelin', emoji: '🛸' } }
  const s = alsSichtung(fremd)
  assert.equal(s.state.kind, 'zeppelin')
  assert.match(s.name, /Zeppelin/)
  assert.equal(s.appearance.emoji, '🛸')
})

test('das Kennzeichen wird NICHT übernommen', () => {
  // Der Dienst liefert es zwar als Feld, füllt es aber nicht (0 von 3985 im
  // Test). Käme es doch einmal, hätte es in unserer Datenbank nichts zu suchen.
  const mitSchild = { ...pkw, properties: { ...pkw.properties, licensePlate: 'KO-AB 123' } }
  const s = alsSichtung(mitSchild)
  assert.ok(!JSON.stringify(s).includes('KO-AB'), 'kein Kennzeichen im Objekt')
})

// ─── Filter ───────────────────────────────────────────────────────────────

test('Altes gilt als nicht vorhanden', () => {
  // Drei von vier Punkten im Schnappschuss sind Karteileichen; einer war 110
  // Tage alt. Ohne diesen Filter füllt sich die Welt mit Geistern.
  const alt = { ...tram, properties: { ...tram.properties, lastSeen: '2026-06-01T00:00:00Z' } }
  assert.equal(relevant(alt, { now: JETZT }), false)
  assert.equal(relevant(tram, { now: JETZT }), true)
})

test('ohne Zeitstempel wird nichts übernommen', () => {
  const ohne = { ...tram, properties: { ...tram.properties, lastSeen: null } }
  assert.equal(relevant(ohne, { now: JETZT }), false)
})

test('der Umkreis wird eingehalten', () => {
  const nahe = { lat: 50.36, lon: 7.56 }
  assert.equal(relevant(pkw, { now: JETZT, center: nahe, radiusKm: 5 }), true)
  assert.equal(relevant(tram, { now: JETZT, center: nahe, radiusKm: 5 }), false, 'Graz ist nicht Koblenz')
  assert.equal(relevant(tram, { now: JETZT, center: nahe, radiusKm: 0 }), true, 'Radius 0 = überall')
})

test('private Fahrzeuge lassen sich ausnehmen', () => {
  // Der Schalter, um den der Betreiber gebeten hat: Infrastruktur und ÖPNV
  // bleiben, PKW verschwinden.
  assert.equal(relevant(pkw, { now: JETZT, includePrivate: true }), true)
  assert.equal(relevant(pkw, { now: JETZT, includePrivate: false }), false)
  assert.equal(relevant(tram, { now: JETZT, includePrivate: false }), true, 'Straßenbahn ist öffentlich')
  assert.equal(relevant(ampel, { now: JETZT, includePrivate: false }), true)
})

test('die Auswahl einzelner Arten geht auch', () => {
  const nurAmpeln = new Set(['traffic_light'])
  assert.equal(relevant(ampel, { now: JETZT, kinds: nurAmpeln }), true)
  assert.equal(relevant(tram, { now: JETZT, kinds: nurAmpeln }), false)
})

test('kaputte Punkte fliegen raus, statt zu werfen', () => {
  assert.equal(relevant(null, { now: JETZT }), false)
  assert.equal(relevant({}, { now: JETZT }), false)
  assert.equal(relevant({ properties: { kind: 'car', lastSeen: FRISCH } }, { now: JETZT }), false)
  assert.equal(relevant({ ...pkw, geometry: { coordinates: ['x', 'y'] } }, { now: JETZT }), false)
})

test('jede bekannte Art hat Etikett und Sinnbild', () => {
  for (const [k, v] of Object.entries(KINDS)) {
    assert.ok(v.label && v.label.length > 2, k)
    assert.ok(v.emoji, k)
    assert.equal(typeof v.moving, 'boolean', k)
  }
  // Was privat ist, muss auch als Art bekannt sein — sonst greift der Schalter ins Leere.
  for (const k of PRIVATE_KINDS) assert.ok(KINDS[k], `${k} fehlt in KINDS`)
})

test('Entfernung stimmt gegen eine bekannte Strecke', () => {
  // Neuwied → Koblenz, Luftlinie rund 10 km.
  const km = abstandKm(50.4297, 7.4608, 50.3569, 7.5890)
  assert.ok(km > 9 && km < 13, `${km.toFixed(1)} km`)
})

// ─── Signalphase: wann wird es grün? ──────────────────────────────────────

test('die Restzeit der Ampelphase kommt aus der Nachricht selbst', () => {
  // ECHTE Werte aus dem Mitschnitt vom 29.09.2026. Nachgerechnet:
  //   moy 387841 → Minute 1 der Stunde; timeStamp 25040 ms
  //   → 1·60 + 25,04 = 85,04 s in der Stunde
  //   likelyTime 1190 (Zehntelsekunden) → 119,0 s in der Stunde
  //   → Rest 33,96 s
  // Die Rechnung braucht KEINE eigene Uhr: die Zeitbasis steckt in `moy` und
  // `timeStamp`, ein Empfänger mit falscher Uhr kippt sie also nicht.
  const spat = { moy: 387841, timeStamp: 25040 }
  assert.equal(phaseEndsInS(spat, { likelyTime: 1190 }), 34)
  assert.equal(phaseEndsInS(spat, { minEndTime: 1020 }), 17)
  assert.equal(phaseEndsInS(spat, { maxEndTime: 1300 }), 45)
})

test('die Restzeit wickelt sich über den Stundenwechsel', () => {
  // 59. Minute, Marke liegt in der NÄCHSTEN Stunde — so steht es im Standard.
  assert.equal(phaseEndsInS({ moy: 59, timeStamp: 50000 }, { likelyTime: 100 }), 20)
})

test('"unbekannt" wird nicht zu einer Zahl', () => {
  // 36001 ist im Standard ausdrücklich "unbekannt". Als Sekundenwert gelesen
  // stünde an der Ampel "wechselt in ~3590 s".
  assert.equal(phaseEndsInS({ moy: 1, timeStamp: 0 }, { likelyTime: 36001 }), null)
  assert.equal(phaseEndsInS({ moy: 1, timeStamp: 0 }, {}), null)
  assert.equal(phaseEndsInS(null, { likelyTime: 100 }), null, 'ohne Zeitbasis keine Rechnung')
})

test('eine unplausibel weit entfernte Marke gilt als veraltet', () => {
  // Keine Ampel hält eine Phase eine Viertelstunde. So ein Wert ist eine alte
  // Nachricht, keine lange Rotphase.
  assert.equal(phaseEndsInS({ moy: 0, timeStamp: 0 }, { likelyTime: 20000 }), null)
})

test('die Phase trägt die Restzeit mit', () => {
  const p = signalPhase({ moy: 387841, timeStamp: 25040, groups: [{ signalGroup: '1', eventState: 3, likelyTime: 1190 }] })
  assert.equal(p.text, 'rot')
  assert.equal(p.endetInS, 34)
})

// ─── Bewegung ─────────────────────────────────────────────────────────────

test('Tempo und Kurs aus der Meldung werden zum Bewegungsvektor', () => {
  const m = motionOf(tram)
  assert.ok(Math.abs(m.v - 27.5 / 3.6) < 1e-9, `v=${m.v}`)
  assert.equal(m.trk, 133)
  assert.equal(m.lat0, 47.07)
  assert.equal(m.lon0, 15.44)
  assert.equal(m.vrate, 0, 'Straßenbahnen steigen nicht')
  // Der Zeitstempel der MESSUNG, nicht der Verarbeitung — sonst rechnet der
  // Client die Latenz der Quelle nicht heraus und das Objekt hinkt hinterher.
  assert.equal(m.t, Date.parse(FRISCH))
})

test('ein stehendes Fahrzeug bekommt v = 0 statt gar keinen Vektor', () => {
  // Die Quelle meldet für Haltende Werte wie 0,036 km/h. Ohne Schwelle kröche
  // ein Auto an der roten Ampel über die Kreuzung; ohne Vektor extrapolierte
  // der Client stattdessen den ALTEN weiter.
  const steht = { ...pkw, properties: { ...pkw.properties, speedKmh: 0.036, headingDeg: 12 } }
  assert.equal(motionOf(steht).v, 0)
})

test('Ampeln und Straßenstationen fahren nicht', () => {
  assert.equal(motionOf(ampel), null)
})

test('ohne Tempo-Angabe entsteht der Vektor aus zwei Sichtungen', () => {
  // Die Hälfte der Sender meldet weder Tempo noch Kurs.
  const ohne = { ...pkw, properties: { mac: pkw.properties.mac, kind: 'car', lastSeen: FRISCH } }
  const vorher = { lat: 50.36, lon: 7.56, t: Date.parse(FRISCH) - 10000 }
  // Ziel liegt 0,001° nördlich ≈ 111 m in 10 s ≈ 11,1 m/s
  const m = motionOf({ ...ohne, geometry: { type: 'Point', coordinates: [7.56, 50.361] } }, vorher)
  assert.ok(m.v > 10 && m.v < 12, `v=${m.v}`)
  assert.ok(m.trk < 1 || m.trk > 359, `Kurs Nord erwartet, war ${m.trk}`)
})

test('zu dicht beieinander liegende Sichtungen ergeben keine Geisterfahrt', () => {
  const ohne = { ...pkw, properties: { mac: 'x', kind: 'car', lastSeen: FRISCH } }
  const gerade = { lat: 50.36, lon: 7.56, t: Date.parse(FRISCH) - 500 }
  assert.equal(motionOf(ohne, gerade), null, 'unter 2 s ist der Weg reines Rauschen')
  const uralt = { lat: 50.36, lon: 7.56, t: Date.parse(FRISCH) - 600000 }
  assert.equal(motionOf(ohne, uralt), null, 'dazwischen war es woanders')
})

test('ein Datensprung wird nicht zur Überschallfahrt', () => {
  const schnell = { ...pkw, properties: { ...pkw.properties, speedKmh: 4000, headingDeg: 90 } }
  assert.equal(motionOf(schnell), null)
})

test('der Kurs stimmt gegen bekannte Richtungen', () => {
  assert.ok(Math.abs(kursGrad(50, 7, 51, 7) - 0) < 0.5, 'Nord')
  assert.ok(Math.abs(kursGrad(50, 7, 50, 8) - 90) < 0.5, 'Ost')
  assert.ok(Math.abs(kursGrad(50, 7, 49, 7) - 180) < 0.5, 'Süd')
})

// ─── Untersuchen: die Langfassung ─────────────────────────────────────────

const reich = {
  type: 'Feature', id: '00:30:e7:00:01:d8',
  geometry: { type: 'Point', coordinates: [15.44, 47.07] },
  properties: {
    ...tram.properties,
    stationType: 11, vehicleLengthM: 7, vehicleWidthM: 2, vehicleNumber: '501',
    transitCity: 'Graz', intersectionId: 703,
    exteriorLights: { lowBeamHeadlightsOn: true, rightTurnSignalOn: true, fogLightOn: false },
    brakePedalEngaged: true, gasPedalEngaged: false, cruiseControlEngaged: false,
    isSigned: true, remainingHops: 9, maxHops: 10, packetCount: 41,
    certificateVerification: { signature_valid: true, chain_valid: false, status: 'valid' },
    denmData: { messageKind: 'roadworks', messageLabel: 'Roadworks' },
  },
}

test('die erste Zeile bleibt kurz genug zum Vorlesen', () => {
  // Der Announcer kürzt auf 100 Zeichen. Was dort abgeschnitten wird, hat
  // der Spieler nie gehört.
  const erste = alsSichtung(reich).description.split('\n')[0]
  assert.ok(erste.length <= 100, `${erste.length} Zeichen: ${erste}`)
})

test('untersuchen verrät Maße, Licht und Fahrzustand', () => {
  const d = alsSichtung(reich).description
  assert.match(d, /Fahrzeug: 7\.0 × 2\.0 m · Wagen 501/)
  assert.match(d, /Licht: Abblendlicht, Blinker rechts/)
  assert.ok(!/Nebelscheinwerfer/.test(d), 'ausgeschaltete Lampen werden nicht aufgezählt')
  assert.match(d, /Fahrzustand: bremst/)
  assert.ok(!/gibt Gas/.test(d))
})

test('untersuchen nennt Gefahr, Betrieb und Stationstyp', () => {
  const d = alsSichtung(reich).description
  assert.match(d, /Gefahrenmeldung: Baustelle/, 'messageKind wird übersetzt')
  assert.match(d, /Verkehrsbetrieb: Graz/)
  assert.match(d, /Stationstyp laut Sender: Straßenbahn \(11\)/)
})

test('untersuchen sagt, wie belastbar der Funkspruch ist', () => {
  // Für dieses Projekt ist Herkunft Inhalt, nicht Beiwerk: ob die Signatur
  // aufgeht und über wie viele fremde Empfänger die Meldung lief, entscheidet,
  // wie ernst man sie nehmen darf.
  const d = alsSichtung(reich).description
  assert.match(d, /Funk: signiert · Signatur gültig · Kette nicht prüfbar · über 1 Zwischenstation · 41 Pakete/)
})

test('ein karger Punkt bekommt keine Langfassung mit leeren Zeilen', () => {
  const d = alsSichtung(pkw).description
  assert.ok(!d.includes('\n\n\n'), d)
  assert.ok(!/: *$/m.test(d), 'keine Zeile endet mit einem leeren Doppelpunkt')
})

test('Stationsfotos werden NICHT gespiegelt', () => {
  // Sie zeigen echte Orte, tragen den Handle des Hochladenden und eine
  // Privatsphäre-Prüfung; manche sind an der Quelle geschwärzt. Hierher
  // kopiert wären sie von genau dieser Prüfung abgeschnitten.
  const mitFotos = { ...reich, properties: { ...reich.properties,
    stationPhotos: [{ url: '/api/station-photo-proxy/abc', uploadedBy: 'jo-ei', reviewedForPrivacy: false }] } }
  const s = JSON.stringify(alsSichtung(mitFotos))
  assert.ok(!s.includes('station-photo-proxy'), 'keine Foto-Adresse im Objekt')
  assert.ok(!s.includes('jo-ei'), 'kein Handle im Objekt')
})

test('jeder Stationstyp und jede Lampe hat eine Beschriftung', () => {
  for (const [k, v] of Object.entries(STATION_TYPES)) assert.ok(v.length > 2, k)
  for (const [k, v] of Object.entries(LIGHT_LABELS)) assert.ok(v.length > 2, k)
})

test('ein PKW bekommt keinen Verkehrsbetrieb angedichtet', () => {
  // ECHT PASSIERT: `transitCity` steht auch an privaten Fahrzeugen — es ist die
  // Stadt, gegen deren Fahrplan der Dienst abgleicht. "Verkehrsbetrieb: Graz"
  // an einem PKW ist schlicht falsch.
  const auto = { ...pkw, properties: { ...pkw.properties, transitCity: 'Graz' } }
  assert.ok(!alsSichtung(auto).description.includes('Verkehrsbetrieb'), alsSichtung(auto).description)
  assert.match(alsSichtung(reich).description, /Verkehrsbetrieb: Graz/, 'bei einer Linie schon')
})

test('die Ampelphase steht nicht zweimal wortgleich da', () => {
  // Ohne Restzeit und ohne Kreuzungsangabe sagt die Detailzeile nichts Neues.
  const nackt = { ...ampel, properties: { ...ampel.properties, trafficLightName: '' } }
  const d = alsSichtung(nackt).description
  assert.equal(d.split('grün · 3 von 4 Gruppen grün').length - 1, 1, d)
})
