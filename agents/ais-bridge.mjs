#!/usr/bin/env node
//
// agents/ais-bridge.mjs — AIS-Realtime-Bridge für Ajna
//
// Verbindet sich gegen aisstream.io (WebSocket-API für AIS-Schiffspositionen),
// filtert per BoundingBox auf einen Radius um eine Center-Position, und
// legt für jedes gesichtete Schiff ein Ajna-Objekt an bzw. aktualisiert es.
// MMSI ist der stabile Identifier — Lookup geschieht via `state.mmsi` auf
// dem Ajna-Record, type-Tag "ship" hilft beim initialen Sweep nach Boot.
//
// Konfiguration via Umgebungsvariablen (oder `.env` im CWD):
//
//   AISSTREAM_API_KEY      Pflicht — Key von https://aisstream.io
//   AIS_CENTER_LAT         Center-Latitude  (Default: 53.5511 — Hamburg)
//   AIS_CENTER_LON         Center-Longitude (Default: 9.9937)
//   AIS_RADIUS_KM          Radius in km     (Default: 10)
//   AIS_UPDATE_INTERVAL_S  Min. Sekunden zwischen PB-Updates pro Schiff
//                          (Default: 5)
//   AIS_STALE_TIMEOUT_S    Schiffe, die so lange keine Message mehr
//                          gesendet haben, werden aus PB entfernt
//                          (Default: 600 = 10 Minuten). Greift typischerweise
//                          dann, wenn ein Schiff die BoundingBox verlassen
//                          hat — aisstream hört dann auf, Reports dafür
//                          durchzureichen.
//
//   AJNA_URL   PocketBase-URL  (Default: http://127.0.0.1:8090)
//   AJNA_USER  Pflicht — dedizierter PB-User für den Agent
//   AJNA_PASS  Pflicht
//
// Hinweis zur Sichtbarkeit: die Schiffs-Objekte gehören initial nur dem
// Agent-User. Damit andere Spieler sie sehen, im PB-Profil dieses Users
// `default_permissions` setzen (z. B. `subject_type=authenticated, rights=[view]`),
// dann werden neue Schiffs-Records automatisch mit dieser ACE materialisiert.
//
// Start:
//   node agents/ais-bridge.mjs
//   bzw. via npm-Script:
//   npm run ais
//
// Beenden: Ctrl+C.

import WebSocket from 'ws'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { EventSource } from 'eventsource'
// PB-SDK öffnet beim ersten refreshObjects()/connect() eine Realtime-SSE
// und greift dabei auf globalThis.EventSource zu. In Node ist das je nach
// Version nicht (zuverlässig) verfügbar → wir polyfillen aus npm.
if (typeof globalThis.EventSource !== 'function') globalThis.EventSource = EventSource

import { AjnaManager } from '../client/core/AjnaManager.js'

// ───────────────────────────────────────────────────────────────────────
//  .env laden (identisches Schema wie tools/ajna.mjs)
// ───────────────────────────────────────────────────────────────────────

function loadDotenv() {
  const path = resolve(process.cwd(), '.env')
  if (!existsSync(path)) return
  const raw = readFileSync(path, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const stripped = line.replace(/^\s*#.*$/, '').trim()
    if (!stripped) continue
    const m = stripped.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i)
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadDotenv()

const AJNA_URL  = process.env.AJNA_URL  || 'http://127.0.0.1:8090'
const AJNA_USER = process.env.AJNA_USER
const AJNA_PASS = process.env.AJNA_PASS
const AIS_KEY   = process.env.AISSTREAM_API_KEY
const CENTER_LAT = parseFloat(process.env.AIS_CENTER_LAT || '53.5511')
const CENTER_LON = parseFloat(process.env.AIS_CENTER_LON || '9.9937')
const RADIUS_KM  = parseFloat(process.env.AIS_RADIUS_KM  || '10')
const UPDATE_INTERVAL_MS = parseFloat(process.env.AIS_UPDATE_INTERVAL_S || '5') * 1000
const STALE_TIMEOUT_MS   = parseFloat(process.env.AIS_STALE_TIMEOUT_S   || '600') * 1000
const CLEANUP_INTERVAL_MS = 30 * 1000

// Re-exec mit --use-system-ca, falls AJNA_URL HTTPS ist (Caddy-Interne-CA).
// Identisches Pattern wie tools/ajna.mjs.
if (AJNA_URL.startsWith('https://') && !process.execArgv.includes('--use-system-ca')) {
  const r = spawnSync(
    process.execPath,
    ['--use-system-ca', process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit' }
  )
  process.exit(r.status ?? 1)
}

function die(msg) { console.error(`✗ ${msg}`); process.exit(1) }

if (!AIS_KEY)  die('AISSTREAM_API_KEY fehlt (.env oder env var)')
if (!AJNA_USER || !AJNA_PASS) die('AJNA_USER und AJNA_PASS fehlen')
if (!Number.isFinite(CENTER_LAT) || !Number.isFinite(CENTER_LON)) die('Ungültige Center-Koords')
if (!Number.isFinite(RADIUS_KM) || RADIUS_KM <= 0) die('Ungültiger Radius')

// ───────────────────────────────────────────────────────────────────────
//  BoundingBox berechnen (Quadrat um Center, das den Kreis-Radius enthält)
// ───────────────────────────────────────────────────────────────────────

const KM_PER_DEG_LAT = 111
const dLat = RADIUS_KM / KM_PER_DEG_LAT
const dLon = RADIUS_KM / (KM_PER_DEG_LAT * Math.cos(CENTER_LAT * Math.PI / 180))
const BBOX = [
  [CENTER_LAT - dLat, CENTER_LON - dLon],
  [CENTER_LAT + dLat, CENTER_LON + dLon]
]

console.log(`[ais] center: ${CENTER_LAT.toFixed(4)}, ${CENTER_LON.toFixed(4)}  radius: ${RADIUS_KM} km`)
console.log(`[ais] bbox SW: ${BBOX[0][0].toFixed(4)}, ${BBOX[0][1].toFixed(4)}`)
console.log(`[ais] bbox NE: ${BBOX[1][0].toFixed(4)}, ${BBOX[1][1].toFixed(4)}`)
console.log(`[ais] throttle: ${(UPDATE_INTERVAL_MS / 1000).toFixed(1)} s pro Schiff`)
console.log(`[ais] stale timeout: ${(STALE_TIMEOUT_MS / 1000).toFixed(0)} s`)

// ───────────────────────────────────────────────────────────────────────
//  Ajna-Login + initiales Laden bekannter Schiffe (via AjnaManager —
//  keine direkten PB-Aufrufe, damit Federation-Routing + Composite-IDs
//  transparent greifen).
// ───────────────────────────────────────────────────────────────────────

const ajna = new AjnaManager(AJNA_URL)
try {
  await ajna.login(AJNA_USER, AJNA_PASS)
} catch (err) {
  die(`Ajna-Login fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`)
}
console.log(`[ajna] eingeloggt als ${ajna.currentUser()?.email || AJNA_USER}`)

// ───────────────────────────────────────────────────────────────────────
//  Agent-Manifest publishen — damit der Client im FilterDialog weiß,
//  was dieser Agent anbietet. AIS hat (V1) nur einen "all"-Layer; eine
//  feinere Aufschlüsselung nach Schiffstyp könnte später aus
//  ShipStaticData.Type abgeleitet werden.
// ───────────────────────────────────────────────────────────────────────
try {
  await ajna.upsertAgentManifest({
    source: 'aisstream',
    agent_name: 'AIS-Bridge',
    description: `Schiffe via aisstream.io im Radius ${RADIUS_KM} km um ${CENTER_LAT.toFixed(3)}, ${CENTER_LON.toFixed(3)}`,
    layers: [
      { key: 'all', label: 'Alle Schiffe', predicate: null }
    ]
  })
  console.log('[ajna] manifest aktualisiert')
} catch (err) {
  console.warn('[ajna] manifest-upsert fehlgeschlagen:', err?.message || err)
}

/**
 * In-Memory-Map: MMSI → Schiffs-State
 *  - objectId:     Ajna-Record-ID
 *  - lastUpdateMs: Timestamp des letzten PB-Updates (für Throttle)
 *  - lastSeenMs:   Timestamp der letzten AIS-Message überhaupt (für Cleanup)
 *  - name:         Anzeigename
 *  - lat/lon:      letzte gespeicherte Position
 *  - inflight:     true während eines laufenden PB-Calls (verhindert Race)
 */
const ships = new Map()

// Beim Boot zählt jedes vorhandene Schiff als "frisch gesehen", damit
// das Cleanup nicht direkt nach Start alles wegräumt, was schon vor dem
// Restart drin war. AIS-Reports innerhalb der ersten STALE_TIMEOUT_S
// halten die Records dann am Leben.
const bootMs = Date.now()
try {
  await ajna.refreshObjects()
  for (const obj of ajna.getObjects()) {
    if (obj.type !== 'ship') continue
    const mmsi = obj.state?.mmsi
    if (!mmsi) continue
    ships.set(String(mmsi), {
      objectId: obj.id,                // composite ID, vom Manager geroutet
      lastUpdateMs: 0,
      lastSeenMs: bootMs,
      name: obj.name || `MMSI ${mmsi}`,
      lat: obj.lat,
      lon: obj.lon,
      inflight: false
    })
  }
  console.log(`[ajna] ${ships.size} vorhandene Schiffe geladen`)
} catch (err) {
  console.warn(`[ajna] initiales Schiffs-Listing fehlgeschlagen: ${err?.message || err}`)
}

// ───────────────────────────────────────────────────────────────────────
//  WebSocket-Verbindung mit Reconnect
// ───────────────────────────────────────────────────────────────────────

const AIS_WS_URL = 'wss://stream.aisstream.io/v0/stream'
const MAX_AREAS = parseInt(process.env.AIS_MAX_AREAS || '12', 10)
const AREA_REFRESH_MS = parseFloat(process.env.AIS_AREA_REFRESH_S || '60') * 1000
let ws = null
let reconnectMs = 1000
let lastBoxesKey = null
const MAX_RECONNECT_MS = 60000

// Aktive (anonymisierte) Interessensbereiche der Spieler, die AIS eingeblendet
// haben. Leer → Fallback konfiguriertes Zentrum.
async function fetchActiveAreas() {
  const client = ajna.defaultClient
  const base = (client.url || '').replace(/\/+$/, '')
  const token = client.pb?.authStore?.token
  const r = await fetch(`${base}/ajnaapi/interest-areas?source=aisstream`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  })
  if (!r.ok) throw new Error(`interest-areas ${r.status}`)
  const data = await r.json()
  return Array.isArray(data?.areas) ? data.areas : []
}

// aisstream-BBOX-Format: [[swLat,swLon],[neLat,neLon]]. Demand-getrieben aus den
// aktiven Bereichen; ohne Bereiche → konfiguriertes Zentrum.
async function currentBoundingBoxes() {
  let areas = []
  try { areas = await fetchActiveAreas() }
  catch (err) { console.warn(`[ais] interest-areas: ${err?.message || err} → Fallback Zentrum`) }
  if (!areas.length) return [BBOX]
  if (areas.length > MAX_AREAS) {
    console.warn(`[ais] ${areas.length} Bereiche → auf ${MAX_AREAS} begrenzt`)
    areas = areas.slice(0, MAX_AREAS)
  }
  return areas.map(a => [[a.latMin, a.lonMin], [a.latMax, a.lonMax]])
}

function sendSubscription(boxes) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  ws.send(JSON.stringify({
    APIKey: AIS_KEY, BoundingBoxes: boxes,
    FilterMessageTypes: ['PositionReport', 'ShipStaticData']
  }))
  lastBoxesKey = JSON.stringify(boxes)
  return true
}

function connect() {
  ws = new WebSocket(AIS_WS_URL)

  ws.addEventListener('open', async () => {
    console.log('[ws] verbunden, sende Subscription')
    reconnectMs = 1000
    const boxes = await currentBoundingBoxes()
    sendSubscription(boxes)
    console.log(`[ais] abonniert: ${boxes.length} Box(en) (${lastBoxesKey === JSON.stringify([BBOX]) ? 'Zentrum' : 'interest-areas'})`)
  })

  ws.addEventListener('message', ev => {
    let msg
    try { msg = JSON.parse(ev.data) }
    catch { return }
    handleMessage(msg).catch(err =>
      console.warn(`[handle] ${err?.message || err}`)
    )
  })

  ws.addEventListener('close', ev => {
    console.warn(`[ws] geschlossen (code=${ev.code}), reconnect in ${reconnectMs} ms`)
    setTimeout(() => {
      reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS)
      connect()
    }, reconnectMs)
  })

  ws.addEventListener('error', err => {
    console.error('[ws] error:', err?.message || err?.type || err)
  })
}

// ───────────────────────────────────────────────────────────────────────
//  Message-Handling
// ───────────────────────────────────────────────────────────────────────

async function handleMessage(msg) {
  // Manche Fehlermeldungen kommen als reine String-Felder (Auth-Issues etc.)
  if (msg.error) {
    console.error('[ais] Server-Fehler:', msg.error)
    return
  }
  // Doku-Inkonsistenz: die Seite schreibt "Metadata", die offiziellen
  // Sample-Clients + der Wire-Stream nutzen "MetaData". Robust gegen beides.
  const meta = msg.MetaData || msg.Metadata || {}
  const mmsi = String(meta.MMSI || msg.Message?.PositionReport?.UserID || msg.Message?.ShipStaticData?.UserID || '')

  // Egal welche Message-Art: solange wir eine MMSI haben, sehen wir
  // das Schiff aktiv → lastSeenMs auffrischen, damit das Cleanup
  // jegliche Lebenszeichen berücksichtigt (auch ShipStaticData etc.).
  if (mmsi) {
    const existing = ships.get(mmsi)
    if (existing) existing.lastSeenMs = Date.now()
  }

  if (msg.MessageType === 'PositionReport')   return handlePosition(msg, meta, mmsi)
  if (msg.MessageType === 'ShipStaticData')   return handleStatic(msg, meta, mmsi)
}

async function handlePosition(msg, meta, mmsi) {
  if (!mmsi) return

  const lat = meta.latitude  ?? msg.Message?.PositionReport?.Latitude
  const lon = meta.longitude ?? msg.Message?.PositionReport?.Longitude
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return

  // Heading: TrueHeading (511 = unbekannt) bevorzugt, sonst Cog (Course
  // over Ground). Beides in Grad, 0 = Nord, im Uhrzeigersinn.
  const trueHeading = msg.Message?.PositionReport?.TrueHeading
  const cog         = msg.Message?.PositionReport?.Cog
  const heading = (Number.isFinite(trueHeading) && trueHeading !== 511)
    ? trueHeading
    : (Number.isFinite(cog) ? cog : 0)

  const shipName = (meta.ShipName || '').trim()
  const name = shipName || `MMSI ${mmsi}`
  const ship = ships.get(mmsi)
  const now = Date.now()

  if (!ship) {
    // Neu — Slot reservieren, damit parallele Reports nicht doppelt anlegen.
    // lastSeenMs sofort gesetzt, damit Cleanup einen frischen Eintrag
    // garantiert nicht direkt wegräumt.
    const slot = {
      objectId: null, lastUpdateMs: 0, lastSeenMs: now,
      name, lat, lon, inflight: true
    }
    ships.set(mmsi, slot)
    try {
      const obj = await ajna.createObject({
        name,
        type: 'ship',
        description: `Schiff · MMSI ${mmsi} · Live-Position via aisstream.io (AIS).`,
        lat, lon, altitude: 0,
        rotation: { x: 0, y: degToYaw(heading), z: 0 },
        state: { mmsi, course: heading, source: 'aisstream' }
      })
      slot.objectId = obj.id
      slot.lastUpdateMs = now
      console.log(`[ajna] + ${name} (MMSI ${mmsi}) → ${obj.id}`)
    } catch (err) {
      ships.delete(mmsi)  // damit der nächste Report einen Retry triggert
      console.warn(`[ajna] create MMSI ${mmsi} fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`)
    } finally {
      if (ships.has(mmsi)) ships.get(mmsi).inflight = false
    }
    return
  }

  if (!ship.objectId) return                              // create läuft noch
  if (ship.inflight) return                               // letzter update läuft
  if (now - ship.lastUpdateMs < UPDATE_INTERVAL_MS) return // throttle

  // Name nachpflegen, wenn aisstream einen neuen Wert liefert (z. B. erst
  // nach mehreren PositionReports oder nach einem ShipStaticData-Update).
  const patch = {
    lat, lon,
    rotation: { x: 0, y: degToYaw(heading), z: 0 },
    state: { mmsi, course: heading, source: 'aisstream' }
  }
  if (shipName && shipName !== ship.name) {
    patch.name = shipName
  }

  ship.inflight = true
  try {
    await ajna.updateObject(ship.objectId, patch)
    ship.lastUpdateMs = now
    ship.lat = lat
    ship.lon = lon
    if (patch.name) {
      console.log(`[ajna] ~ MMSI ${mmsi}: ${ship.name} → ${patch.name}`)
      ship.name = patch.name
    }
  } catch (err) {
    console.warn(`[ajna] update MMSI ${mmsi} fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`)
  } finally {
    ship.inflight = false
  }
}

async function handleStatic(msg, meta, mmsi) {
  const ship = ships.get(mmsi)
  if (!ship?.objectId) return

  // Schiffsname: ShipStaticData.Name ist die kanonische Quelle (siehe Doku);
  // MetaData.ShipName als Fallback.
  const newName = (msg.Message?.ShipStaticData?.Name || meta.ShipName || '').trim()
  if (!newName || newName === ship.name) return

  try {
    await ajna.updateObject(ship.objectId, { name: newName })
    console.log(`[ajna] ~ MMSI ${mmsi}: ${ship.name} → ${newName}`)
    ship.name = newName
  } catch (err) {
    console.warn(`[ajna] rename MMSI ${mmsi} fehlgeschlagen: ${err?.message || err}`)
  }
}

// ───────────────────────────────────────────────────────────────────────
//  Cleanup — Schiffe, die aus der BoundingBox raus oder offline sind,
//  hören einfach auf zu senden. Nach STALE_TIMEOUT_MS räumen wir den
//  Ajna-Record + den Map-Eintrag ab.
// ───────────────────────────────────────────────────────────────────────

async function cleanupStaleShips() {
  const now = Date.now()
  const cutoff = now - STALE_TIMEOUT_MS
  for (const [mmsi, ship] of ships) {
    if (!ship.objectId) continue       // create läuft / fehlgeschlagen
    if (ship.inflight) continue        // gerade ein Update unterwegs → nicht stale
    if (ship.lastSeenMs > cutoff) continue

    ship.inflight = true
    try {
      await ajna.deleteObject(ship.objectId)
      ships.delete(mmsi)
      const ageS = Math.round((now - ship.lastSeenMs) / 1000)
      console.log(`[ajna] − ${ship.name} (MMSI ${mmsi}) stale ${ageS}s — entfernt`)
    } catch (err) {
      // Map-Eintrag stehen lassen; nächster Cleanup-Tick retried.
      ship.inflight = false
      console.warn(`[ajna] cleanup MMSI ${mmsi} fehlgeschlagen: ${err?.message || err}`)
    }
  }
}

setInterval(() => {
  cleanupStaleShips().catch(err =>
    console.warn(`[cleanup] tick error: ${err?.message || err}`)
  )
}, CLEANUP_INTERVAL_MS)

// AIS-Heading in Grad (Kompass, CW von Nord) → Babylon-Yaw in Radianten.
// Empirischer Offset matched die ungekippte GeoTransformer-Convention
// (Z=Nord, X=Ost) — siehe Fox-Agent für die analoge Diskussion.
function degToYaw(deg) {
  return (deg * Math.PI / 180) - Math.PI / 2
}

// Subscription periodisch an die aktiven Bereiche anpassen (Spieler bewegen
// sich / kommen + gehen). Nur neu senden, wenn sich die BBOX-Menge ändert.
setInterval(async () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const boxes = await currentBoundingBoxes()
  if (JSON.stringify(boxes) !== lastBoxesKey && sendSubscription(boxes)) {
    console.log(`[ais] Subscription aktualisiert: ${boxes.length} Box(en)`)
  }
}, AREA_REFRESH_MS)

// ───────────────────────────────────────────────────────────────────────
//  Start
// ───────────────────────────────────────────────────────────────────────

connect()

process.on('SIGINT',  () => { console.log('\n[ais] SIGINT — exit'); process.exit(0) })
process.on('SIGTERM', () => { console.log('[ais] SIGTERM — exit'); process.exit(0) })
