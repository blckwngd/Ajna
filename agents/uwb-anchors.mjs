#!/usr/bin/env node
//
// agents/uwb-anchors.mjs — UWB-Anker in Ajna anlegen/aktualisieren
//
// UWB-Anker sind die Infrastruktur-Referenz für die zentimetergenaue
// Positionierung: jeder Anker trägt seine EXAKTE Weltposition (lat/lon/alt)
// UND seine DWM-lokale Koordinate (mm). Die App (client/core/UwbManager.js)
// liest beide und richtet damit das lokale DWM-Frame in der Welt aus (Modell A).
//
// Anker werden als normale Ajna-Objekte modelliert (kein Schema-Eingriff):
//   type           = "uwb_anchor"
//   lat/lon/altitude = Weltposition
//   state.uwb      = { nodeId: <uint16>, local: { x, y, z }, network?: <panId> }
//                    // x,y,z in mm; network = PANS-Netz-Zugehörigkeit (optional)
//
// Optional veröffentlicht das Skript auch das PANS-Netz selbst als Objekt, damit
// mehrere Personen über Ajna-Rechte (view = nutzen, edit = Knoten beitragen)
// Anker zum SELBEN Netz beisteuern können:
//   type           = "uwb_network"
//   state.uwb_network = { networkId: <panId> }   // PAN-ID aus der DRTLS-App
//
// Idempotent über state.uwb.nodeId (Anker) bzw. networkId (Netz).
//
// Zwei JSON-Formate (Default: ./uwb-anchors.json):
//   • klassisch:  [ { "nodeId":1, "lat":…, "lon":…, "local":{…} }, … ]
//   • vernetzt:   { "networks":[ { "networkId":"0x89AB", "name":"…" } ],
//                   "anchors": [ { "nodeId":1, "network":"0x89AB", … }, … ] }
//   (siehe uwb-anchors.example.json bzw. uwb-anchors-network.example.json)
//
// ENV: AJNA_URL (Default http://127.0.0.1:8090), AJNA_USER, AJNA_PASS,
//      UWB_ANCHORS_FILE (Default ./uwb-anchors.json)
//
// Start:  node agents/uwb-anchors.mjs   bzw.   npm run uwb-anchors

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { EventSource } from 'eventsource'
if (typeof globalThis.EventSource !== 'function') globalThis.EventSource = EventSource

import { AjnaManager } from '../client/core/AjnaManager.js'

function loadDotenv() {
  const path = resolve(process.cwd(), '.env')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const s = line.replace(/^\s*#.*$/, '').trim()
    const m = s && s.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = v
  }
}
loadDotenv()

const AJNA_URL  = process.env.AJNA_URL  || 'http://127.0.0.1:8090'
const AJNA_USER = process.env.AJNA_USER
const AJNA_PASS = process.env.AJNA_PASS
const FILE      = process.env.UWB_ANCHORS_FILE || 'uwb-anchors.json'

if (AJNA_URL.startsWith('https://') && !process.execArgv.includes('--use-system-ca')) {
  const r = spawnSync(process.execPath,
    ['--use-system-ca', process.argv[1], ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

function die(msg) { console.error(`✗ ${msg}`); process.exit(1) }
if (!AJNA_USER || !AJNA_PASS) die('AJNA_USER und AJNA_PASS fehlen')

const path = resolve(process.cwd(), FILE)
if (!existsSync(path)) die(`Anker-Datei nicht gefunden: ${path}`)
let defs
try { defs = JSON.parse(readFileSync(path, 'utf8')) }
catch (e) { die(`Anker-Datei ungültig: ${e.message}`) }
// Two accepted shapes:
//   • legacy:   [ {anchor}, … ]
//   • networked:{ networks: [ {networkId, name, lat?, lon?} ], anchors: [ {…, network} ] }
// A `uwb_network` object publishes a PANS network so others can contribute
// anchors to it via Ajna permissions; anchors carry `state.uwb.network` = its id.
let networkDefs = [], anchorDefs = []
if (Array.isArray(defs)) {
  anchorDefs = defs
} else if (defs && typeof defs === 'object') {
  networkDefs = Array.isArray(defs.networks) ? defs.networks : []
  anchorDefs = Array.isArray(defs.anchors) ? defs.anchors : []
} else {
  die('Anker-Datei: Array oder { networks?, anchors } erwartet')
}
if (!anchorDefs.length && !networkDefs.length) die('Anker-Datei enthält weder anchors noch networks')

const ajna = new AjnaManager(AJNA_URL)
try { await ajna.login(AJNA_USER, AJNA_PASS) } catch (e) { die(`Login fehlgeschlagen: ${e?.message || e}`) }
await ajna.connect()
console.log(`[uwb-anchors] eingeloggt als ${ajna.currentUser()?.email || AJNA_USER}`)

const existing = new Map()     // nodeId -> uwb_anchor object
const existingNets = new Map() // String(networkId) -> uwb_network object
for (const o of ajna.getObjects()) {
  if (o?.type === 'uwb_anchor' && Number.isFinite(o?.state?.uwb?.nodeId)) {
    existing.set(o.state.uwb.nodeId, o)
  } else if (o?.type === 'uwb_network' && o?.state?.uwb_network?.networkId != null) {
    existingNets.set(String(o.state.uwb_network.networkId), o)
  }
}

// Networks first (idempotent over networkId), so anchors can reference them.
for (const nd of networkDefs) {
  const pan = nd.networkId ?? nd.panId
  if (pan == null) { console.warn('[uwb-anchors] Netz ohne networkId übersprungen:', nd); continue }
  const fields = {
    name: nd.name || `UWB-Netz ${pan}`,
    type: 'uwb_network',
    lat: nd.lat || 0, lon: nd.lon || 0, altitude: nd.altitude || 0,
    state: { uwb_network: { networkId: pan } }
  }
  const found = existingNets.get(String(pan))
  try {
    if (found) {
      await ajna.updateObject(found.id, fields)
      console.log(`[uwb-anchors] Netz aktualisiert  pan=${pan}  ${fields.name}`)
    } else {
      const obj = await ajna.createObject(fields)
      try { await ajna.addPermission(obj.id, { subject_type: 'authenticated', rights: ['view'], interact_actions: [] }) }
      catch (e) { console.warn('[uwb-anchors] Netz-ACE fehlgeschlagen:', e?.message || e) }
      console.log(`[uwb-anchors] Netz angelegt      pan=${pan}  ${fields.name}`)
    }
  } catch (e) { console.warn(`[uwb-anchors] Netz pan=${pan} fehlgeschlagen:`, e?.message || e) }
}

for (const d of anchorDefs) {
  if (!Number.isFinite(d.nodeId) || !Number.isFinite(d.lat) || !Number.isFinite(d.lon)) {
    console.warn('[uwb-anchors] überspringe ungültige Definition:', d); continue
  }
  const uwb = { nodeId: d.nodeId, local: d.local || { x: 0, y: 0, z: 0 } }
  if (d.network != null) uwb.network = d.network   // PANS network membership
  const fields = {
    name: d.name || `UWB-Anker ${d.nodeId}`,
    type: 'uwb_anchor',
    lat: d.lat, lon: d.lon, altitude: d.altitude || 0,
    state: { uwb }
  }
  const found = existing.get(d.nodeId)
  try {
    if (found) {
      await ajna.updateObject(found.id, fields)
      console.log(`[uwb-anchors] aktualisiert  nodeId=${d.nodeId}  ${fields.name}`)
    } else {
      const obj = await ajna.createObject(fields)
      // Sichtbar für alle eingeloggten User.
      try {
        await ajna.addPermission(obj.id, { subject_type: 'authenticated', rights: ['view'], interact_actions: [] })
      } catch (e) { console.warn('[uwb-anchors] ACE fehlgeschlagen:', e?.message || e) }
      console.log(`[uwb-anchors] angelegt      nodeId=${d.nodeId}  ${fields.name}`)
    }
  } catch (e) {
    console.warn(`[uwb-anchors] nodeId=${d.nodeId} fehlgeschlagen:`, e?.message || e)
  }
}

console.log('[uwb-anchors] fertig.')
process.exit(0)
