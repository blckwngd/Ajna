#!/usr/bin/env node
// aprs-bridge.mjs — Amateurfunk-Positionsbaken (APRS) als Objekte in Ajna.
//
// WARUM NICHT DIE aprs.fi-API. Die kann nur einzelne Rufzeichen abfragen (20 je
// Anfrage, keine Platzhalter, keine Flächensuche) und verbietet in ihren
// Bedingungen ausdrücklich, Daten vorzuhalten oder zwischenzuspeichern — genau
// das tut ein Spiegel wie unser Objektbestand. Wir hängen uns stattdessen an
// APRS-IS, das Verteilnetz, in das jedes APRS-Gateway einspeist und aus dem auch
// aprs.fi seine Daten bezieht. Serverseitiger Radiusfilter, kein Schlüssel.
//
// NUR EMPFANG. Der Passcode ist fest -1; damit nimmt der Server keine Pakete
// von uns an. Senden würde eine Amateurfunk-Zulassung voraussetzen und ist für
// einen Spiegel auch nicht nötig.
//
// BESONDERHEIT GEGENÜBER C-ITS: APRS ist Schmalband-Funk. Eine feste Station
// bakt alle 20 bis 30 Minuten, ein Fahrzeug alle ein bis fünf. Die Verfallszeit
// muss hier also GROSSZÜGIG sein — bei C-ITS senden die Stationen fünfmal je
// Sekunde, da ist eine Minute Schweigen bereits ein Abschied.

import net from 'node:net'
import fs from 'node:fs'
import { bootAgent, envNum, envStr, envBool, publishManifest, ladeBestand } from './lib/agent-base.mjs'
import { Fleet } from './lib/fleet.mjs'
import { parsePacket, relevant, alsSichtung, SYMBOLS, symbolInfo } from './lib/aprs.mjs'
import { simpleSetup } from './lib/setup-wizard.mjs'

const { ajna, log, warn } = await bootAgent('aprs', {
  tag: 'aprs',
  setup: simpleSetup('aprs', {
    required: ['AJNA_USER', 'AJNA_PASS', 'APRS_CALL'],
    optional: ['AJNA_URL', 'APRS_CENTER_LAT', 'APRS_CENTER_LON', 'APRS_RADIUS_KM'],
  }),
})

// Das Rufzeichen, mit dem wir uns anmelden. APRS-IS erwartet hier das eigene
// Amateurfunk-Rufzeichen; wer keines hat, meldet sich nur lesend an und sollte
// eine erkennbare Kennung wählen statt ein fremdes Rufzeichen zu benutzen.
const CALL = envStr('APRS_CALL', '').trim().toUpperCase()
if (!CALL) {
  console.error('✗ APRS_CALL fehlt — die Anmeldung bei APRS-IS braucht eine Kennung.')
  console.error('  Mit eigenem Rufzeichen: APRS_CALL=DL1ABC')
  console.error('  Einrichten: node agents/aprs-bridge.mjs --setup')
  process.exit(1)
}

const HOST = envStr('APRS_HOST', 'rotate.aprs2.net')
const PORT = envNum('APRS_PORT', 14580)
const CENTER_LAT = envNum('APRS_CENTER_LAT', 50.4297)
const CENTER_LON = envNum('APRS_CENTER_LON', 7.4608)
const RADIUS_KM = envNum('APRS_RADIUS_KM', 50)
const STALE_MS = envNum('APRS_STALE_S', 3600) * 1000
const UPDATE_INTERVAL_MS = envNum('APRS_UPDATE_INTERVAL_S', 10) * 1000
const MAX_OBJEKTE = envNum('APRS_MAX', 300)
const MAX_UNSCHARF = envNum('APRS_MAX_VAGUE', 2)
const ARTEN = envStr('APRS_SYMBOLS', '').trim()
const WETTER_AN = envBool('APRS_WEATHER', true)
// Nur für die Entwicklung: statt zu verbinden eine mitgeschnittene Datei lesen
// (eine Zeile je Paket). So lässt sich der Weg bis in die Datenbank auch dort
// prüfen, wo Port 14580 gesperrt ist.
const REPLAY = envStr('APRS_REPLAY', '').trim()

const SYMBOL_FILTER = ARTEN ? new Set(ARTEN.split(',').map(s => s.trim()).filter(Boolean)) : null
const CENTER = { lat: CENTER_LAT, lon: CENTER_LON }

log(`Kennung ${CALL} · ${HOST}:${PORT}`)
log(`Zentrum ${CENTER_LAT.toFixed(4)}, ${CENTER_LON.toFixed(4)} · Radius ${RADIUS_KM} km`)
log(`Verfallszeit ${Math.round(STALE_MS / 60000)} min (APRS bakt selten — bewusst lang)`)
if (SYMBOL_FILTER) log(`nur diese Symbole: ${[...SYMBOL_FILTER].join(', ')}`)
if (REPLAY) log(`NACHSPIELEN aus ${REPLAY} — keine Verbindung zu APRS-IS`)

// ─── Inhaltsfilter ────────────────────────────────────────────────────────
// Nach Verhalten gruppiert, nicht nach Einzelsymbol: „alle Fahrzeuge" ist eine
// Frage, die jemand stellt, „alle Geländewagen" nicht.
const LAYERS = [
  { key: 'all', label: 'Alles', predicate: null },
  { key: 'vehicles', label: 'Fahrzeuge', predicate: { field: 'state.moving', equals: true } },
  { key: 'stations', label: 'Feste Stationen', predicate: { field: 'state.moving', equals: false } },
  { key: 'weather', label: 'Wetterstationen', predicate: { field: 'state.symbol', oneOf: ['/_', '\\_'] } },
  { key: 'objects', label: 'Objekte & Items', predicate: { field: 'state.aprs_type', oneOf: ['object', 'item'] } },
]

if (await publishManifest(ajna, {
  source: 'aprs',
  agent_name: 'APRS-Brücke',
  description: 'Amateurfunk-Positionsbaken über APRS-IS: Fahrzeuge, Wetterstationen, Digipeater',
  render_range_m: envNum('APRS_RENDER_RANGE_M', 5000),
  render_budget: envNum('APRS_RENDER_BUDGET', 80),
  layers: LAYERS,
})) log(`Manifest veröffentlicht (${LAYERS.length} Ebenen)`)

// ─── Die Flotte ───────────────────────────────────────────────────────────
const fleet = new Fleet(ajna, {
  type: 'aprs',
  source: 'aprs',
  keyField: 'callsign',
  updateIntervalMs: UPDATE_INTERVAL_MS,
  staleMs: STALE_MS,
  tag: 'aprs', log, warn,
})

fleet.adopt(await ladeBestand(ajna, { tag: 'aprs', warn }))
log(`${fleet.size} vorhandene Objekte übernommen`)

let gesehen = 0, verworfen = 0, uebernommen = 0

async function paketGesehen(zeile) {
  const p = parsePacket(zeile)
  if (!p) { verworfen++; return }
  gesehen++

  // Der Schlüssel ist das, was das Objekt IDENTIFIZIERT. Bei einem Objekt oder
  // Item ist das sein Name, nicht der Absender: dieselbe Station kann mehrere
  // ausrufen, und bei ';' wäre sonst immer nur das letzte sichtbar.
  const key = (p.type === 'object' || p.type === 'item') ? `${p.srccall}/${p.name}` : p.srccall

  // Ein ausdrücklich gelöschtes Objekt verschwindet sofort — schöner als jede
  // Schätzung über Zeitabläufe.
  if (p.deleted) { if (fleet.has(key)) await fleet.drop(key); return }

  if (!WETTER_AN && p.weather) return
  if (!relevant(p, { center: CENTER, radiusKm: RADIUS_KM, maxUnscharf: MAX_UNSCHARF, symbols: SYMBOL_FILTER })) {
    // WAS NICHT MEHR PASST, MUSS WEG — dieselbe Regel wie bei C-ITS. Sonst
    // bliebe ein Fahrzeug, das den Umkreis verlässt, am Rand hängen.
    if (fleet.has(key)) await fleet.drop(key)
    return
  }
  if (!fleet.has(key) && fleet.size >= MAX_OBJEKTE) return

  const vorher = fleet.size
  await fleet.seen(key, alsSichtung(p))
  if (fleet.size > vorher) uebernommen++
}

// ─── Verbindung ───────────────────────────────────────────────────────────
// Dieselbe Form wie bei AIS und C-ITS: wachsende Wartezeit, damit ein
// ausgefallener Server nicht beworfen wird, und eine Obergrenze, damit er nach
// einer Stunde trotzdem wieder gefunden wird.
const RECONNECT_START_MS = 2000
const RECONNECT_MAX_MS = 60_000
let wartezeit = RECONNECT_START_MS
let sock = null
let halteWach = null

function verbinde() {
  log(`verbinde mit ${HOST}:${PORT} …`)
  sock = net.createConnection({ host: HOST, port: PORT })
  sock.setKeepAlive(true, 30_000)

  let rest = ''
  sock.on('connect', () => {
    wartezeit = RECONNECT_START_MS
    // Der Filter gehört in die Anmeldezeile: dann schickt der Server gar nicht
    // erst den Weltverkehr, und wir werfen ihn nicht hier weg. `r/lat/lon/km`
    // ist ein Kreis um einen Punkt.
    const anmeldung = `user ${CALL} pass -1 vers ajna-aprs 1.0 `
      + `filter r/${CENTER_LAT.toFixed(4)}/${CENTER_LON.toFixed(4)}/${Math.round(RADIUS_KM)}`
    sock.write(anmeldung + '\r\n')
    log(`angemeldet (nur Empfang, Passcode -1), Filter r/${CENTER_LAT.toFixed(2)}/${CENTER_LON.toFixed(2)}/${Math.round(RADIUS_KM)}`)
    // Alle zehn Minuten ein Kommentar, damit NAT und Server die stille
    // Verbindung nicht für tot halten.
    clearInterval(halteWach)
    halteWach = setInterval(() => {
      if (sock?.writable) sock.write('# ajna-aprs keepalive\r\n')
    }, 600_000)
  })

  sock.on('data', async (buf) => {
    // APRS ist NICHT zwingend UTF-8 — Kommentare enthalten alles von Latin-1
    // bis zu rohen Bytes. Als UTF-8 gelesen fielen ganze Pakete als kaputt aus,
    // also byteweise lesen und nur die Kommentare behutsam behandeln.
    rest += buf.toString('latin1')
    const teile = rest.split(/\r?\n/)
    rest = teile.pop()
    for (const z of teile) {
      if (!z) continue
      if (z.startsWith('#')) continue        // Server-Geplauder
      try { await paketGesehen(z) }
      catch (err) { warn(`Verarbeiten: ${err?.message || err}`) }
    }
  })

  sock.on('error', (err) => warn(`Verbindung: ${err?.code || err?.message || err}`))
  sock.on('close', () => {
    clearInterval(halteWach)
    warn(`Verbindung getrennt — neuer Versuch in ${Math.round(wartezeit / 1000)} s`)
    setTimeout(verbinde, wartezeit)
    wartezeit = Math.min(RECONNECT_MAX_MS, wartezeit * 2)
  })
}

/** Entwicklungsweg: einen Mitschnitt zeilenweise durchschieben. */
async function nachspielen(datei) {
  const zeilen = fs.readFileSync(datei, 'latin1').split(/\r?\n/)
  log(`${zeilen.length} Zeilen gelesen`)
  for (const z of zeilen) {
    if (!z || z.startsWith('#')) continue
    try { await paketGesehen(z) } catch (err) { warn(`Verarbeiten: ${err?.message || err}`) }
  }
  log(`fertig: ${fleet.size} Objekte · ${gesehen} Pakete verstanden · ${verworfen} verworfen`)
}

if (REPLAY) await nachspielen(REPLAY)
else verbinde()

// Aufräumen: was nicht mehr bakt, verschwindet über die Verfallszeit.
setInterval(() => {
  fleet.sweep().catch(err => warn(`Aufräumen: ${err?.message || err}`))
}, 60_000)

setInterval(() => {
  log(`${fleet.size} Objekte · ${gesehen} Pakete verstanden · ${verworfen} nicht einzuordnen · ${uebernommen} angelegt`)
  gesehen = 0; verworfen = 0; uebernommen = 0
}, envNum('APRS_REPORT_S', 300) * 1000)
