#!/usr/bin/env node
//
// agents/cits-bridge.mjs — Straßenverkehr aus C-ITS in Ajna spiegeln.
//
// QUELLE: opentrafficmap.org. Ein Gemeinschaftsprojekt, das UNVERSCHLÜSSELTE
// C-ITS-Funksprüche (ITS-G5) mit selbstgebauten Empfängern mitliest — das
// Geplauder von Ampeln, Straßenbahnen, Bussen und neueren Autos — und als
// GeoJSON auf einem WebSocket veröffentlicht. Kein Schlüssel, keine Anmeldung:
// `wss://opentrafficmap.org/ws_ext` ist derselbe Endpunkt, den die öffentliche
// Karte für nicht angemeldete Besucher benutzt.
//
// Gemessen am 29.09.2026: 3985 Punkte, davon 1028 frisch; 1183 Ampeln mit
// Phasendaten, 856 Gefahrenmeldungen; im 50-km-Umkreis um Neuwied 22 frische.
//
// WAS DIESER AGENT NICHT TUT:
//
//   * Er spiegelt KEIN Kennzeichen. Der Dienst liefert das Feld, füllt es aber
//     nicht; käme es doch, hätte es in unserer Datenbank nichts zu suchen.
//   * Er spiegelt nicht den Rohfunkspruch. Was am Objekt steht, ist das, was
//     jemand lesen oder filtern soll — alles andere bliebe ein zweites Archiv
//     fremder Daten.
//   * Private Fahrzeuge lassen sich mit `CITS_PRIVAT=off` ganz ausnehmen.
//     Dann bleiben Infrastruktur und ÖPNV: Ampeln mit Phase, Straßenstationen,
//     Gefahrenmeldungen, Straßenbahn und Bus mit Linie und Ziel.
//
// EIGENER EMPFÄNGER: Die Gegend um Koblenz hat heute nur sporadische Abdeckung.
// Wer selbst empfängt (ESP32-C5-Bausatz, siehe wiki.opentrafficmap.org),
// speist ins Netz ein und bekommt zugleich Zugang zum vollen MQTT-Strom —
// derselbe Handel wie bei Blitzortung. Anonym mitlesen geht dort NICHT: Der
// Broker nimmt die Verbindung an und lehnt jedes `subscribe` ab (geprüft).
//
// Start:  node agents/cits-bridge.mjs   bzw.   npm run cits

import WebSocket from 'ws'
import { bootAgent, envNum, envStr, envBool, publishManifest, ladeBestand } from './lib/agent-base.mjs'
import { Fleet } from './lib/fleet.mjs'
import { InterestAreas } from './lib/interest-areas.mjs'
import { asSighting, relevant, KINDS, PRIVATE_KINDS } from './lib/cits.mjs'
import { simpleSetup } from './lib/setup-wizard.mjs'

const { ajna, log, warn } = await bootAgent('cits', {
  tag: 'cits',
  setup: simpleSetup('cits', { required: ['AJNA_USER', 'AJNA_PASS'], optional: ['AJNA_URL'] }),
})

const WS_URL = envStr('CITS_WS_URL', 'wss://opentrafficmap.org/ws_ext')
const CENTER_LAT = envNum('CITS_CENTER_LAT', 50.4297)
const CENTER_LON = envNum('CITS_CENTER_LON', 7.4608)
const RADIUS_KM = envNum('CITS_RADIUS_KM', 30)
const PRIVAT = envBool('CITS_PRIVAT', true)
const ARTEN = envStr('CITS_ARTEN', '').trim()
// Wie lange eine Meldung als „jetzt" gilt. GEMESSEN, nicht geschätzt: zwei
// Minuten am Feed, 4193 Stationen, 63790 Meldeabstände.
//
//   eine LEBENDE Station meldet sich im Median alle 0,2 s (p99 3,3 s);
//   99,9 % aller Abstände liegen unter 60 s.
//   Im Schnappschuss sind aber nur 5,9 % der Punkte jünger als 15 s —
//   und 22,6 % jünger als 15 min.
//
// Mit den früheren 900 s spiegelten wir also fast viermal so viele Objekte wie
// gerade senden: drei Viertel waren verstummte Sender. Wer 60 s schweigt, ist
// praktisch sicher weg. Zusammen mit dem 20-s-Aufräumtakt verschwindet ein
// Geist nach höchstens 80 s — BEVOR die Vorausrechnung im Client ihre 150 s
// ausschöpft (MAX_DR_MS in client/core/PositionSmoother.js). Sonst führe ein
// Fahrzeug nach dem Verlassen der Empfangsreichweite noch zwei Kilometer
// weiter und stünde dann minutenlang in der Landschaft.
const MAX_AGE_MS = envNum('CITS_MAX_AGE_S', 60) * 1000
const UPDATE_INTERVAL_MS = envNum('CITS_UPDATE_INTERVAL_S', 5) * 1000
const MAX_OBJEKTE = envNum('CITS_MAX', 300)

const KIND_FILTER = ARTEN ? new Set(ARTEN.split(',').map(s => s.trim()).filter(Boolean)) : null

// WO GESPIEGELT WIRD, BESTIMMEN DIE SPIELER — nicht die .env.
//
// Vorher stand hier ein festes Zentrum. Stand es falsch (bei mir auf Graz), legte
// der Agent munter Objekte 675 km entfernt an: am 05.10.2026 waren das 2549
// Stück und damit 79 % der ganzen Welt. Jetzt kommen die Bereiche aus
// `/ajnaapi/interest-areas` — anonymisiert, gerastert, 3 Minuten haltbar.
//
// `CITS_CENTER_LAT/LON` + `CITS_RADIUS_KM` bleiben erhalten, wirken aber nur
// noch als ZUSÄTZLICHES festes Gebiet, wenn `CITS_FIXED_AREA=on` gesetzt ist —
// für einen Betreiber, der eine Kreuzung dauerhaft bestückt haben will.
const FESTES_GEBIET = envBool('CITS_FIXED_AREA', false)
const festeGebiete = FESTES_GEBIET ? [{
  latMin: CENTER_LAT - RADIUS_KM / 111.32,
  latMax: CENTER_LAT + RADIUS_KM / 111.32,
  lonMin: CENTER_LON - RADIUS_KM / (111.32 * Math.cos(CENTER_LAT * Math.PI / 180)),
  lonMax: CENTER_LON + RADIUS_KM / (111.32 * Math.cos(CENTER_LAT * Math.PI / 180)),
}] : []

const gebiete = new InterestAreas(ajna, {
  bufferM: envNum('CITS_AREA_BUFFER_M', 800),
  always: festeGebiete,
  log, warn,
})

if (FESTES_GEBIET) log(`festes Gebiet: ${CENTER_LAT.toFixed(4)}, ${CENTER_LON.toFixed(4)} · ${RADIUS_KM} km`)
else log('folgt den Interessensgebieten der Spieler (kein festes Zentrum)')
log(`private Fahrzeuge: ${PRIVAT ? 'JA' : 'nein (nur Infrastruktur und ÖPNV)'}`)
if (KIND_FILTER) log(`nur diese Arten: ${[...KIND_FILTER].join(', ')}`)
log(`frisch heisst: jünger als ${MAX_AGE_MS < 120_000
  ? Math.round(MAX_AGE_MS / 1000) + ' s'
  : Math.round(MAX_AGE_MS / 60000) + ' min'}`)

// ─── Inhaltsfilter ────────────────────────────────────────────────────────
// Eine Ebene je Art, plus zwei nach Verhalten. Eine Kreuzung mit zwanzig
// Signalgruppen überfüllt sonst die Sicht, und wer nur den ÖPNV sehen will,
// soll nicht jede Art einzeln abwählen müssen.
const LAYERS = [
  { key: 'all', label: 'Alles', predicate: null },
  { key: 'infrastructure', label: 'Ampeln & Stationen', predicate: { field: 'state.moving', equals: false } },
  { key: 'transit', label: 'Bus & Bahn', predicate: { field: 'state.transit_line', exists: true } },
  { key: 'hazard', label: 'Gefahrenmeldungen', predicate: { field: 'state.hazard', equals: true } },
  ...Object.entries(KINDS)
    .filter(([k]) => k !== 'unknown')
    .map(([k, v]) => ({ key: k, label: v.label, predicate: { field: 'state.kind', equals: k } })),
]

if (await publishManifest(ajna, {
  source: 'cits',
  agent_name: 'C-ITS-Brücke',
  description: `Straßenverkehr (Ampeln, ÖPNV${PRIVAT ? ', Fahrzeuge' : ''}) via opentrafficmap.org`
    + ` im Radius ${RADIUS_KM} km um ${CENTER_LAT.toFixed(3)}, ${CENTER_LON.toFixed(3)}`,
  // Verkehr ist dicht und ortsfest interessant: Eine Ampel in 20 km ist
  // Rauschen, ein Flugzeug in 20 km nicht. Deshalb eine eigene Sichtweite.
  render_range_m: envNum('CITS_RENDER_RANGE_M', 1500),
  render_budget: envNum('CITS_RENDER_BUDGET', 60),
  layers: LAYERS,
})) log(`Manifest veröffentlicht (${LAYERS.length} Ebenen)`)

// ─── Die Flotte ───────────────────────────────────────────────────────────
const fleet = new Fleet(ajna, {
  type: 'cits',
  source: 'cits',
  keyField: 'mac',
  updateIntervalMs: UPDATE_INTERVAL_MS,
  staleMs: MAX_AGE_MS,
  tag: 'cits', log, warn,
})

fleet.adopt(await ladeBestand(ajna, { tag: 'cits', warn }))
log(`${fleet.size} vorhandene Objekte übernommen`)

const filter = () => ({
  kinds: KIND_FILTER, includePrivate: PRIVAT, maxAgeMs: MAX_AGE_MS,
  now: Date.now(),   // Ort wird getrennt geprüft, siehe `gebiete`
})

let gesehen = 0, uebernommen = 0

// Letzte Position je Sender, für den abgeleiteten Bewegungsvektor. Wächst mit
// der Flotte, nicht mit der Laufzeit: was die Flotte fallen lässt, fliegt hier
// mit raus (siehe punktWeg und den Aufräumlauf unten).
const letzteOrte = new Map()

async function punktGesehen(feature) {
  gesehen++
  const key = feature.properties?.mac || feature.id
  if (!key) return
  // WAS NICHT MEHR PASST, MUSS WEG — nicht bloss aufhören, gepflegt zu werden.
  // Sonst blieben nach `CITS_PRIVAT=off` alle bereits angelegten PKW stehen,
  // bis sie von selbst veralten, und ein Fahrzeug, das den Umkreis verlässt,
  // hinge am Rand fest. Der Schalter soll sofort wirken.
  // SOLANGE WIR DIE BEREICHE NICHT KENNEN, WIRD NICHTS ANGEFASST.
  //
  // Eine gescheiterte Abfrage ist nicht „niemand da". Würde sie so gelesen,
  // räumte der Agent bei der ersten Netzstörung alles ab, was er gerade pflegt.
  // Also: nichts anlegen, nichts löschen, den Zustand lassen.
  if (!gebiete.known) return

  const c = feature?.geometry?.coordinates
  const imGebiet = Array.isArray(c) && gebiete.contains(Number(c[1]), Number(c[0]))

  // WAS NICHT MEHR PASST, MUSS WEG — nicht bloss aufhören, gepflegt zu werden.
  // Sonst blieben nach `CITS_PRIVAT=off` alle bereits angelegten PKW stehen,
  // bis sie von selbst veralten, und ein Fahrzeug, das den Bereich verlässt,
  // hinge am Rand fest. Der Schalter soll sofort wirken.
  if (!imGebiet || !relevant(feature, filter())) {
    if (fleet.has(key)) await fleet.drop(key)
    letzteOrte.delete(key)
    return
  }
  // Obergrenze: Eine Autobahnkreuzung mit hundert Fahrzeugen soll die Welt
  // nicht fluten. Bekannte Objekte werden weiter gepflegt, neue abgelehnt.
  if (!fleet.has(key) && fleet.size >= MAX_OBJEKTE) return
  const vorher = fleet.size
  const sicht = asSighting(feature, letzteOrte.get(key))
  // Die vorige Position MERKEN, nicht die aktuelle Sichtung: aus zwei Punkten
  // entsteht der Bewegungsvektor für alles, was weder Tempo noch Kurs meldet
  // (die Hälfte der Sender). Nur für Bewegliches — eine Ampel, die um zwei
  // Meter „wandert", ist Ortungsrauschen und keine Fahrt.
  // Die Position JEDES Objekts merken — sie dient zwei Zwecken: dem abgeleiteten
  // Bewegungsvektor (nur für Bewegliches, `motionOf` prüft das selbst) und dem
  // Aufräumen nach Bereich weiter unten. Ohne den zweiten Zweck bliebe eine
  // Ampel stehen, nachdem der Spieler die Gegend verlassen hat.
  const t = Date.parse(feature.properties?.lastSeen || '')
  letzteOrte.set(key, { lat: sicht.lat, lon: sicht.lon, t: Number.isFinite(t) ? t : Date.now() })
  await fleet.seen(key, sicht)
  if (fleet.size > vorher) uebernommen++
}

async function punktWeg(kennung) {
  // Der Dienst sagt ausdrücklich Bescheid, wenn etwas verschwindet — schöner
  // als jede Schätzung über Zeitabläufe.
  const key = typeof kennung === 'string' ? kennung : (kennung?.id || kennung?.mac)
  if (key) { await fleet.drop(key); letzteOrte.delete(key) }
}

// ─── Verbindung ───────────────────────────────────────────────────────────
// Ein WebSocket, der wieder aufbaut. Dieselbe Form wie in der AIS-Brücke:
// wachsende Wartezeit, damit ein ausgefallener Dienst nicht mit Anfragen
// beworfen wird, und eine Obergrenze, damit er nach einer Stunde trotzdem
// wieder gefunden wird.
const RECONNECT_START_MS = 2000
const RECONNECT_MAX_MS = 60_000
let wartezeit = RECONNECT_START_MS
let ws = null

function verbinde() {
  log(`verbinde mit ${WS_URL} …`)
  ws = new WebSocket(WS_URL, { headers: { 'User-Agent': 'ajna-cits-bridge/1.0 (+https://github.com/blckwngd)' } })

  ws.on('open', () => {
    wartezeit = RECONNECT_START_MS
    log('verbunden')
  })

  ws.on('message', async (roh) => {
    let j
    try { j = JSON.parse(roh.toString()) } catch { return }
    try {
      if (j.type === 'snapshot') {
        const punkte = j.points?.features || []
        log(`Schnappschuss: ${punkte.length} Punkte, ${j.stats?.activeDevices ?? '?'} aktive Stationen`)
        for (const f of punkte) await punktGesehen(f)
        log(`davon übernommen: ${fleet.size}`)
      } else if (j.type === 'delta') {
        for (const f of j.upsertPoints || []) await punktGesehen(f)
        for (const w of j.removePoints || []) await punktWeg(w)
      }
    } catch (err) {
      warn(`Verarbeiten fehlgeschlagen: ${err?.message || err}`)
    }
  })

  ws.on('close', (code) => {
    warn(`Verbindung zu (Code ${code}) — neuer Versuch in ${Math.round(wartezeit / 1000)} s`)
    setTimeout(verbinde, wartezeit)
    wartezeit = Math.min(wartezeit * 2, RECONNECT_MAX_MS)
  })

  ws.on('error', (err) => {
    warn(`WebSocket: ${err?.message || err}`)
    try { ws.close() } catch {}
  })
}

// Bereiche holen, BEVOR das erste Paket kommt — sonst wirft der Agent den
// ganzen Schnappschuss weg, weil er noch nichts weiss.
await gebiete.refresh()
setInterval(() => { gebiete.refresh().catch(() => {}) },
  envNum('CITS_AREA_REFRESH_S', 45) * 1000)

verbinde()

// Aufräumen: Was der Dienst nicht ausdrücklich abmeldet, verschwindet über die
// Frische. Beides zusammen, weil Punkte auch einfach verstummen.
//
// Der Takt gehört zur Verfallszeit: zusammen dürfen sie die 150 s nicht
// erreichen, die der Client vorausrechnet — sonst bleibt ein Geist stehen,
// nachdem die Extrapolation ihn schon abgesetzt hat.
const AUFRAEUM_MS = envNum('CITS_SWEEP_S', 20) * 1000
setInterval(() => {
  fleet.sweep().catch(err => warn(`Aufräumen: ${err?.message || err}`))
  // Objekte, die inzwischen ausserhalb ALLER Bereiche liegen: Der Spieler ist
  // weitergegangen, sein Bereich verfallen. Ohne diesen Durchgang blieben sie
  // bis zur Verfallszeit stehen — und wenn gar niemand mehr da ist, für immer.
  if (gebiete.known) {
    for (const [key, slot] of [...fleet.slots]) {
      if (!slot.objectId || slot.inflight) continue
      const ort = letzteOrte.get(key)
      if (ort && !gebiete.contains(ort.lat, ort.lon)) {
        fleet.drop(key).catch(() => {})
        letzteOrte.delete(key)
      }
    }
  }
  // Was die Flotte nicht mehr kennt, braucht auch keine Vorgeschichte mehr.
  for (const key of letzteOrte.keys()) if (!fleet.has(key)) letzteOrte.delete(key)
}, AUFRAEUM_MS)

setInterval(() => {
  log(`${fleet.size} Objekte · ${gesehen} Punkte gesehen · ${uebernommen} angelegt`)
  gesehen = 0; uebernommen = 0
}, envNum('CITS_REPORT_S', 300) * 1000)
