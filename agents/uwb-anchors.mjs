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
// ENV (geschichtet, siehe lib/env.mjs): AJNA_URL, AJNA_USER, AJNA_PASS,
//      UWB_ANCHORS_FILE (Default ./uwb-anchors.json)
//
// Start:  node agents/uwb-anchors.mjs   bzw.   npm run uwb-anchors

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { bootAgent, die, envStr } from './lib/agent-base.mjs'
import { simpleSetup } from './lib/setup-wizard.mjs'
import { ensureObject } from '../client/core/ensureObject.js'

const { ajna } = await bootAgent('uwb-anchors', {
  connect: true,
  setup: simpleSetup('uwb-anchors', { required: ['AJNA_USER', 'AJNA_PASS'], optional: ['AJNA_URL', 'UWB_ANCHORS_FILE'] }),
})
const FILE = envStr('UWB_ANCHORS_FILE', 'uwb-anchors.json') || 'uwb-anchors.json'

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

const warn = (...a) => console.warn('[uwb-anchors]', ...a)
// Sichtbar für alle eingeloggten User (ensureObject garantiert die ACE per
// Union-Merge — kollidiert nicht mit materialisierten default_permissions).
const VIEW_ACE = { subject_type: 'authenticated', rights: ['view'], interact_actions: [] }

// Networks first (idempotent over networkId), so anchors can reference them.
for (const nd of networkDefs) {
  const pan = nd.networkId ?? nd.panId
  if (pan == null) { warn('Netz ohne networkId übersprungen:', nd); continue }
  try {
    const { created } = await ensureObject(ajna, {
      match: o => o?.type === 'uwb_network' && String(o?.state?.uwb_network?.networkId ?? '') === String(pan),
      fields: {
        name: nd.name || `UWB-Netz ${pan}`,
        type: 'uwb_network',
        lat: nd.lat || 0, lon: nd.lon || 0, altitude: nd.altitude || 0,
        state: { uwb_network: { networkId: pan } }
      },
      update: true, ace: VIEW_ACE, warn,
    })
    console.log(`[uwb-anchors] Netz ${created ? 'angelegt    ' : 'aktualisiert'}  pan=${pan}`)
  } catch (e) { warn(`Netz pan=${pan} fehlgeschlagen:`, e?.message || e) }
}

for (const d of anchorDefs) {
  if (!Number.isFinite(d.nodeId) || !Number.isFinite(d.lat) || !Number.isFinite(d.lon)) {
    warn('überspringe ungültige Definition:', d); continue
  }
  const uwb = { nodeId: d.nodeId, local: d.local || { x: 0, y: 0, z: 0 } }
  if (d.network != null) uwb.network = d.network   // PANS network membership
  try {
    const { created } = await ensureObject(ajna, {
      match: o => o?.type === 'uwb_anchor' && o?.state?.uwb?.nodeId === d.nodeId,
      fields: {
        name: d.name || `UWB-Anker ${d.nodeId}`,
        type: 'uwb_anchor',
        lat: d.lat, lon: d.lon, altitude: d.altitude || 0,
        state: { uwb }
      },
      update: true, ace: VIEW_ACE, warn,
    })
    console.log(`[uwb-anchors] ${created ? 'angelegt    ' : 'aktualisiert'}  nodeId=${d.nodeId}`)
  } catch (e) {
    warn(`nodeId=${d.nodeId} fehlgeschlagen:`, e?.message || e)
  }
}

console.log('[uwb-anchors] fertig.')
process.exit(0)
