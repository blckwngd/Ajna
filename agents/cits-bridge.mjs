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
import { alsSichtung, relevant, KINDS, PRIVATE_KINDS } from './lib/cits.mjs'
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
const MAX_AGE_MS = envNum('CITS_MAX_AGE_S', 900) * 1000
const UPDATE_INTERVAL_MS = envNum('CITS_UPDATE_INTERVAL_S', 5) * 1000
const MAX_OBJEKTE = envNum('CITS_MAX', 300)

const KIND_FILTER = ARTEN ? new Set(ARTEN.split(',').map(s => s.trim()).filter(Boolean)) : null
const CENTER = { lat: CENTER_LAT, lon: CENTER_LON }

log(`Zentrum ${CENTER_LAT.toFixed(4)}, ${CENTER_LON.toFixed(4)} · Radius ${RADIUS_KM} km`)
log(`private Fahrzeuge: ${PRIVAT ? 'JA' : 'nein (nur Infrastruktur und ÖPNV)'}`)
if (KIND_FILTER) log(`nur diese Arten: ${[...KIND_FILTER].join(', ')}`)
log(`frisch heisst: jünger als ${Math.round(MAX_AGE_MS / 60000)} min`)

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
  center: CENTER, radiusKm: RADIUS_KM, now: Date.now(),
})

let gesehen = 0, uebernommen = 0

async function punktGesehen(feature) {
  gesehen++
  const key = feature.properties?.mac || feature.id
  if (!key) return
  // WAS NICHT MEHR PASST, MUSS WEG — nicht bloss aufhören, gepflegt zu werden.
  // Sonst blieben nach `CITS_PRIVAT=off` alle bereits angelegten PKW stehen,
  // bis sie von selbst veralten, und ein Fahrzeug, das den Umkreis verlässt,
  // hinge am Rand fest. Der Schalter soll sofort wirken.
  if (!relevant(feature, filter())) {
    if (fleet.has(key)) await fleet.drop(key)
    return
  }
  // Obergrenze: Eine Autobahnkreuzung mit hundert Fahrzeugen soll die Welt
  // nicht fluten. Bekannte Objekte werden weiter gepflegt, neue abgelehnt.
  if (!fleet.has(key) && fleet.size >= MAX_OBJEKTE) return
  const vorher = fleet.size
  await fleet.seen(key, alsSichtung(feature))
  if (fleet.size > vorher) uebernommen++
}

async function punktWeg(kennung) {
  // Der Dienst sagt ausdrücklich Bescheid, wenn etwas verschwindet — schöner
  // als jede Schätzung über Zeitabläufe.
  const key = typeof kennung === 'string' ? kennung : (kennung?.id || kennung?.mac)
  if (key) await fleet.drop(key)
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

verbinde()

// Aufräumen: Was der Dienst nicht ausdrücklich abmeldet, verschwindet über die
// Frische. Beides zusammen, weil Punkte auch einfach verstummen.
setInterval(() => {
  fleet.sweep().catch(err => warn(`Aufräumen: ${err?.message || err}`))
}, 60_000)

setInterval(() => {
  log(`${fleet.size} Objekte · ${gesehen} Punkte gesehen · ${uebernommen} angelegt`)
  gesehen = 0; uebernommen = 0
}, envNum('CITS_REPORT_S', 300) * 1000)
