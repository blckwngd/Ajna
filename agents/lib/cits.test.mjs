// Tests für agents/lib/cits.mjs — die Übersetzung von OpenTrafficMap-Punkten.
//
// Die Beispiele sind ECHT: aus einer Live-Verbindung zu wss://opentrafficmap.org
// am 29.09.2026 entnommen und gekürzt. Erfundene Testdaten hätten genau die
// Felder, die man erwartet — und keins der Löcher, über die man stolpert.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alsSichtung, relevant, signalPhase, abstandKm, KINDS, PRIVATE_KINDS } from './cits.mjs'

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
