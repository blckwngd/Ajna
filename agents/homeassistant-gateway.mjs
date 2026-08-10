#!/usr/bin/env node
//
// agents/homeassistant-gateway.mjs — Home-Assistant-MQTT-Gateway für Ajna
//
// Übersetzt zwischen MQTT (Home-Assistant-Seite) und Ajna-Objekten (PocketBase).
// Bringt einen EINGEBETTETEN MQTT-Broker (aedes) mit — HA verbindet sich
// AUSGEHEND dorthin, kein eingehender Port zu HA. Das Gateway ist die einzige
// Vertrauensgrenze: Broker-ACL sperrt jeden HA-Client auf seinen Namespace, und
// nur das Gateway schreibt (gescopt) nach Ajna. Design: docs/homeassistant.md.
//
// Datenfluss:
//   HA → mqtt_statestream → ajna/ha/<inst>/<domain>/<entity>/state (+ /attributes)
//        → Gateway leitet die Entitätenliste ab, pflegt Controller + Geräte-Objekte.
//   Ajna-Interaktion „einschalten" → Gateway publisht ajna/ha/<inst>/<d>/<e>/set
//        {service,data} → HA-Automation ruft <domain>.<service>.
//
// Konfiguration (Env > agents/.env.ha-gateway > Root-.env — siehe lib/env.mjs):
//   AJNA_URL/USER/PASS        Ajna-Login (Gateway-User; seine Standardrechte
//                             gelten für die angelegten Objekte — s. Startwarnung)
//   HA_INSTANCE               Namespace/Instanz (Default: home)
//   MQTT_PORT                 Broker-Port des eingebetteten Brokers (Default: 1883)
//   MQTT_HA_USER/MQTT_HA_PASS Zugangsdaten des HA-Clients (Pflicht für den Broker)
//   MQTT_GATEWAY_USER/PASS    interner Gateway-Client (Default: ajna_gateway/zufällig)
//   MQTT_TLS_CERT/MQTT_TLS_KEY  optional TLS für den eingebetteten Broker (empfohlen public)
//   MQTT_EXTERNAL_URL         statt eingebettetem Broker einen externen nutzen
//                             (z. B. mqtt://host:1883) — dann kein aedes
//   HA_LAT/HA_LON             Controller-Koordinaten (Default: 50.3569/7.5890)
//   HA_ADMIN_USER             optional: User-ID mit Vollzugriff (view/edit/move/
//                             owner + alle Aktionen) auf Controller + Geräte
//
// Start:  node agents/homeassistant-gateway.mjs   bzw.   npm run ha-gateway

import { readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import net from 'node:net'
import tls from 'node:tls'
import { randomUUID, X509Certificate } from 'node:crypto'
import { bootAgent, die, envNum, envInt, envBool, envStr } from './lib/agent-base.mjs'
import { ensureAce } from '../client/core/ensureObject.js'

import { Aedes } from 'aedes'
import mqtt from 'mqtt'

// Geschichtete .env + Erststart-Wizard (--setup oder fehlende Pflichtwerte,
// nur TTY) + System-CA-Re-Exec + Login + connect — alles in bootAgent.
const { ajna } = await bootAgent('ha-gateway', {
  connect: true,
  setup: {
    need: ['AJNA_USER', 'AJNA_PASS', 'MQTT_HA_USER', 'MQTT_HA_PASS'],
    run: async () => (await import('./lib/ha-setup.mjs')).runHaSetup(),   // schreibt .env.ha-gateway + setzt process.env
  },
})

const HA_INSTANCE = envStr('HA_INSTANCE', 'home').replace(/[^a-z0-9_-]/gi, '') || 'home'
const MQTT_PORT  = envInt('MQTT_PORT', 1883)
const MQTT_HA_USER = envStr('MQTT_HA_USER')
const MQTT_HA_PASS = envStr('MQTT_HA_PASS')
const MQTT_GW_USER = envStr('MQTT_GATEWAY_USER') || 'ajna_gateway'
const MQTT_GW_PASS = envStr('MQTT_GATEWAY_PASS') || randomUUID()   // intern, nur localhost
const MQTT_EXTERNAL_URL = envStr('MQTT_EXTERNAL_URL')
const TLS_CERT = envStr('MQTT_TLS_CERT')
const TLS_KEY  = envStr('MQTT_TLS_KEY')
// Selbst signiertes TLS: wenn keine echten Zertifikate gesetzt sind, kann das
// Gateway auf Wunsch selbst eins erzeugen (einmalig, dann persistent).
const TLS_AUTO = envBool('MQTT_TLS_AUTO')
const TLS_DIR  = envStr('MQTT_TLS_DIR') || resolve(process.cwd(), '.ha-gateway-tls')
const TLS_CN   = envStr('MQTT_TLS_CN') || os.hostname()
const TLS_SAN  = envStr('MQTT_TLS_SAN').split(',').map(s => s.trim()).filter(Boolean)
const HA_LAT   = envNum('HA_LAT', 50.3569)
const HA_LON   = envNum('HA_LON', 7.5890)
// Optional: User-ID, die auf Controller + allen Geräte-Objekten eine User-ACE
// mit view/edit/move/owner + allen Aktionen bekommt (de facto Besitzer; das
// owner-FELD bleibt beim Gateway-User). Vom Wizard abgefragt (HA_ADMIN_USER).
const HA_ADMIN = envStr('HA_ADMIN_USER')
const BASE = `ajna/ha/${HA_INSTANCE}`
const CONTROLLER_NAME = 'Smart Home'

if (!MQTT_EXTERNAL_URL && (!MQTT_HA_USER || !MQTT_HA_PASS)) die('MQTT_HA_USER/MQTT_HA_PASS fehlen (Zugangsdaten des HA-Clients)')

// ─── Steuerbare Domains: Emoji + Aktionen (→ MQTT-{service,data}) ─────────
const DOMAINS = {
  light:         { emoji: '💡', actions: [
    { key: 'einschalten', label: 'Einschalten', service: 'turn_on' },
    { key: 'ausschalten', label: 'Ausschalten', service: 'turn_off' },
    { key: 'heller',      label: 'Heller (+20 %)',  dim: +20 },
    { key: 'dunkler',     label: 'Dunkler (−20 %)', dim: -20 },
  ]},
  switch:        { emoji: '🔌', actions: [
    { key: 'einschalten', label: 'Einschalten', service: 'turn_on' },
    { key: 'ausschalten', label: 'Ausschalten', service: 'turn_off' },
  ]},
  input_boolean: { emoji: '🔘', actions: [
    { key: 'einschalten', label: 'Einschalten', service: 'turn_on' },
    { key: 'ausschalten', label: 'Ausschalten', service: 'turn_off' },
  ]},
  fan:           { emoji: '🌀', actions: [
    { key: 'einschalten', label: 'Einschalten', service: 'turn_on' },
    { key: 'ausschalten', label: 'Ausschalten', service: 'turn_off' },
  ]},
  cover:         { emoji: '🪟', actions: [
    { key: 'oeffnen',   label: 'Öffnen',   service: 'open_cover' },
    { key: 'schliessen', label: 'Schließen', service: 'close_cover' },
    { key: 'stoppen',   label: 'Stoppen',  service: 'stop_cover' },
  ]},
  lock:          { emoji: '🔒', actions: [
    { key: 'abschliessen', label: 'Abschließen', service: 'lock' },
    { key: 'aufschliessen', label: 'Aufschließen', service: 'unlock' },
  ]},
  climate:       { emoji: '🌡️', actions: [
    { key: 'waermer', label: 'Wärmer (+0,5°)', temp: +0.5 },
    { key: 'kaelter', label: 'Kälter (−0,5°)', temp: -0.5 },
  ]},
  media_player:  { emoji: '📺', actions: [
    { key: 'abspielen', label: 'Abspielen', service: 'media_play' },
    { key: 'pause',     label: 'Pause',     service: 'media_pause' },
  ]},
  scene:         { emoji: '🎬', actions: [{ key: 'aktivieren', label: 'Aktivieren', service: 'turn_on' }]},
  script:        { emoji: '▶️', actions: [{ key: 'ausfuehren', label: 'Ausführen', service: 'turn_on' }]},
}

const domainOf = (entityId) => String(entityId).split('.')[0]
const humanState = (s, domain, attrs) => {
  if (s === 'on') {
    const b = Number(attrs?.brightness)
    if (domain === 'light' && Number.isFinite(b)) return `an (${Math.round(b / 255 * 100)} %)`
    return 'an'
  }
  if (s === 'off') return 'aus'
  if (s === 'open') return 'offen'; if (s === 'closed') return 'geschlossen'
  if (s === 'locked') return 'verriegelt'; if (s === 'unlocked') return 'entriegelt'
  return s || 'unbekannt'
}
const brightnessPct = (e) => {
  const b = Number(e?.attributes?.brightness)
  return e?.state === 'on' && Number.isFinite(b) ? Math.round(b / 255 * 100) : 0
}
const clampPct = (p) => Math.max(0, Math.min(100, p))
const controllerActions = (list) => list.map(e => ({ key: e.entity_id, label: `${e.friendly} · ${e.domain}` }))

// ─── Zustand ────────────────────────────────────────────────────────────
const registry = new Map()   // entity_id → { domain, state, attributes, friendly }
const subscribedObjs = new Set()
let controller = null
let createdCount = 0
let refreshTimer = null

// ═════════════════════════════════════════════════════════════════════════
//  MQTT-Broker (eingebettet, mit ACL) — oder externer Broker
// ═════════════════════════════════════════════════════════════════════════
function topicInNamespace(client, topic) {
  const inst = client?._ajnaInstance
  if (inst === '*') return topic.startsWith('ajna/ha/')          // Gateway darf alles unter ajna/ha/
  if (inst) return topic.startsWith(`ajna/ha/${inst}/`) || topic === `ajna/ha/${inst}`
  return false
}

/**
 * TLS-Material für den eingebetteten Broker beschaffen:
 *   1. Explizite Dateien (MQTT_TLS_CERT/KEY) — echte Zertifikate, z. B. von
 *      Let's Encrypt. HA vertraut ihnen automatisch. Bevorzugt.
 *   2. MQTT_TLS_AUTO=1 ohne Dateien → selbst signiertes Zertifikat, EINMALIG
 *      erzeugt und in MQTT_TLS_DIR persistiert (bei Neustart wiederverwendet —
 *      wichtig, weil HA das Zertifikat „pinnt": ein bei jedem Boot neues würde
 *      das Vertrauen brechen). HA muss es einmalig als vertrauenswürdig
 *      importieren (oder die Zertifikatsprüfung deaktivieren).
 *   3. sonst: kein TLS (Klartext).
 * @returns {{cert:Buffer|string, key:Buffer|string, selfSigned:boolean, certPath?:string}|null}
 */
function resolveTlsMaterial() {
  if (TLS_CERT && TLS_KEY) return { cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY), selfSigned: false }
  if (!TLS_AUTO) return null

  const certPath = resolve(TLS_DIR, 'cert.pem')
  const keyPath  = resolve(TLS_DIR, 'key.pem')
  if (existsSync(certPath) && existsSync(keyPath)) {
    return { cert: readFileSync(certPath), key: readFileSync(keyPath), selfSigned: true, certPath }
  }

  // Erstmalig erzeugen — über openssl (robust, keine JS-Krypto-Abhängigkeit).
  // CN = Hostname (überschreibbar via MQTT_TLS_CN); zusätzliche Namen/IPs, unter
  // denen HA den Broker erreicht, via MQTT_TLS_SAN (CSV) — sie kommen als SAN
  // ins Zertifikat, sonst schlägt HAs Hostname-Prüfung fehl.
  const names = [TLS_CN, ...TLS_SAN].filter(Boolean)
  const san = names.map(n => (net.isIP(n) ? `IP:${n}` : `DNS:${n}`)).join(',')
  mkdirSync(TLS_DIR, { recursive: true })
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-subj', `/CN=${TLS_CN}`,
      '-addext', `subjectAltName=${san}`,
    ], { stdio: 'pipe' })
  } catch (err) {
    die('Selbst signiertes TLS-Zertifikat fehlgeschlagen (openssl nicht gefunden?). '
      + 'Entweder openssl installieren, oder eigene Zertifikate über MQTT_TLS_CERT/KEY setzen. '
      + `Detail: ${err?.stderr?.toString?.() || err?.message || err}`)
  }
  try { chmodSync(keyPath, 0o600) } catch { /* Windows/ohne POSIX-Modes egal */ }
  console.log(`[ha-gateway] Selbst signiertes TLS-Zertifikat erzeugt → ${certPath}`)
  console.log(`[ha-gateway]   Namen (SAN): ${names.join(', ')} · gültig 10 Jahre`)
  return { cert: readFileSync(certPath), key: readFileSync(keyPath), selfSigned: true, certPath }
}

// aedes 1.x MUSS über die async-Factory entstehen — `new Aedes()` ist die alte
// 0.x-Schreibweise und liefert einen halb initialisierten Broker: er nimmt
// Verbindungen an und parst sogar CONNECT (authenticate läuft!), schickt aber
// nie ein CONNACK. Der Client hängt dann bis zum „connack timeout".
async function startEmbeddedBroker() {
  const broker = await Aedes.createBroker()
  broker.authenticate = (client, username, password, cb) => {
    const pass = password ? password.toString() : ''
    if (username === MQTT_GW_USER && pass === MQTT_GW_PASS) { client._ajnaInstance = '*'; return cb(null, true) }
    if (username === MQTT_HA_USER && pass === MQTT_HA_PASS) { client._ajnaInstance = HA_INSTANCE; return cb(null, true) }
    const err = new Error('Auth failed'); err.returnCode = 4; cb(err, false)
  }
  // ACL OHNE Verbindungsabbruch: Ein Error in authorizePublish/-Subscribe
  // trennt bei aedes die VERBINDUNG — HA publisht aber per Default seine
  // Birth/Will-Message auf homeassistant/status und abonniert homeassistant/#
  // (Discovery), beides außerhalb des Namespace → Reconnect-Schleife
  // (verbunden/getrennt im 10-s-Takt). Stattdessen: Subscribe sanft ablehnen
  // (SUBACK-Failure, cb(null, null)), Publish in ein totes $-Topic umleiten
  // ($-Präfix liegt außerhalb JEDES Namespace → niemand kann es abonnieren).
  broker.authorizePublish = (client, packet, cb) => {
    if (topicInNamespace(client, packet.topic)) return cb(null)
    if (packet.topic !== 'homeassistant/status') {   // HAs Birth/Will — erwartet, nicht loggen
      console.log(`[ha-gateway] ACL: Publish außerhalb des Namespace ignoriert: ${client?.id} → ${packet.topic}`)
    }
    packet.topic = '$ajna/denied'
    packet.retain = false
    cb(null)
  }
  broker.authorizeSubscribe = (client, sub, cb) => {
    if (topicInNamespace(client, sub.topic)) return cb(null, sub)
    console.log(`[ha-gateway] ACL: Subscribe außerhalb des Namespace abgelehnt: ${client?.id} → ${sub.topic}`)
    cb(null, null)
  }

  const tlsMat = resolveTlsMaterial()
  const useTls = !!tlsMat
  const handler = broker.handle
  const server = useTls
    ? tls.createServer({ cert: tlsMat.cert, key: tlsMat.key }, handler)
    : net.createServer(handler)
  server.on('error', (e) => {
    if (e?.code === 'EADDRINUSE') die(`MQTT-Port ${MQTT_PORT} ist belegt — läuft bereits eine Gateway-Instanz? `
      + `Prüfen: ss -tlnp | grep ${MQTT_PORT} bzw. pm2 status (homeassistant-gateway vs. ajna-ha-gateway — nur EINE behalten).`)
    die(`MQTT-Broker-Start fehlgeschlagen: ${e?.message || e}`)
  })
  server.listen(MQTT_PORT, () => {
    console.log(`[ha-gateway] Broker läuft auf ${useTls ? 'mqtts' : 'mqtt'}://0.0.0.0:${MQTT_PORT} (Instanz „${HA_INSTANCE}")`)
    if (!useTls) {
      console.log('[ha-gateway] Hinweis: ohne TLS — für öffentlich erreichbare Broker MQTT_TLS_CERT/KEY setzen oder MQTT_TLS_AUTO=1.')
    } else if (tlsMat.selfSigned) {
      try {
        const fp = new X509Certificate(tlsMat.cert).fingerprint256
        console.log(`[ha-gateway] TLS selbst signiert — SHA-256-Fingerprint: ${fp}`)
        console.log('[ha-gateway]   In HAs MQTT-Integration das Zertifikat importieren ODER die Prüfung deaktivieren (dann nur verschlüsselt, nicht authentifiziert).')
      } catch { /* Fingerprint nur informativ */ }
    }
  })
  broker.on('clientReady', (c) => console.log(`[ha-gateway] Client verbunden: ${c?.id}`))
  broker.on('clientDisconnect', (c) => console.log(`[ha-gateway] Client getrennt: ${c?.id}`))
  // Passendes Schema für den internen Client zurückgeben — bei TLS mqtts, sonst mqtt.
  return `${useTls ? 'mqtts' : 'mqtt'}://127.0.0.1:${MQTT_PORT}`
}

// ═════════════════════════════════════════════════════════════════════════
//  Ajna (Login + connect liefen bereits in bootAgent)
// ═════════════════════════════════════════════════════════════════════════
warnIfNoDefaults()

// ─── Broker + eigener MQTT-Client ─────────────────────────────────────────
const brokerUrl = MQTT_EXTERNAL_URL || await startEmbeddedBroker()
const mc = mqtt.connect(brokerUrl, {
  username: MQTT_EXTERNAL_URL ? (process.env.MQTT_GATEWAY_USER || MQTT_GW_USER) : MQTT_GW_USER,
  password: MQTT_EXTERNAL_URL ? (process.env.MQTT_GATEWAY_PASS || MQTT_GW_PASS) : MQTT_GW_PASS,
  reconnectPeriod: 3000,
  // Loopback zum EIGENEN TLS-Broker: dessen Zertifikat lautet auf den
  // öffentlichen Hostnamen, nicht auf 127.0.0.1 — für die interne Verbindung
  // die Prüfung aus (betrifft nur den eingebetteten Broker, nicht MQTT_EXTERNAL_URL).
  ...((!MQTT_EXTERNAL_URL && brokerUrl.startsWith('mqtts://')) ? { rejectUnauthorized: false } : {}),
})
mc.on('connect', () => {
  console.log(`[ha-gateway] mit Broker verbunden (${brokerUrl})`)
  mc.subscribe([`${BASE}/+/+/state`, `${BASE}/+/+/attributes`, `${BASE}/status`], (err) => {
    if (err) console.warn('[ha-gateway] subscribe:', err.message)
  })
})
mc.on('error', (e) => console.warn('[ha-gateway] MQTT-Fehler:', e?.message || e))
mc.on('message', (topic, payload) => { try { onMqtt(topic, payload) } catch (e) { console.warn('[ha-gateway] onMqtt:', e?.message || e) } })

// ─── Controller sicherstellen + Bestand adoptieren ───────────────────────
controller = await ensureController([])
subscribeController(controller)
adoptExisting()

console.log(`[ha-gateway] bereit. Warte auf HA-State-Topics unter ${BASE}/… (Strg+C zum Beenden)`)

// ═════════════════════════════════════════════════════════════════════════
//  MQTT → Registry → Ajna
// ═════════════════════════════════════════════════════════════════════════
function onMqtt(topic, payloadBuf) {
  const payload = payloadBuf.toString()
  const parts = topic.split('/')                 // ajna ha <inst> <domain> <entity> <kind>
  if (parts.length === 4 && parts[3] === 'status') {
    console.log(`[ha-gateway] HA-Verbindung: ${payload}`)
    return
  }
  if (parts.length !== 6) return
  const domain = parts[3], entity = parts[4], kind = parts[5]
  if (!DOMAINS[domain]) return                   // nicht steuerbare Domain ignorieren
  const entityId = `${domain}.${entity}`
  const e = registry.get(entityId) || { domain, state: 'unknown', attributes: {}, friendly: entityId }
  if (kind === 'state') {
    e.state = payload
  } else if (kind === 'attributes') {
    try { e.attributes = JSON.parse(payload) } catch { e.attributes = {} }
    if (e.attributes?.friendly_name) e.friendly = e.attributes.friendly_name
  } else return
  registry.set(entityId, e)
  scheduleControllerRefresh()
  if (kind === 'state') updateObjectsFor(entityId)
}

function usableList() {
  return [...registry.entries()]
    .map(([entity_id, e]) => ({ entity_id, domain: e.domain, friendly: e.friendly || entity_id }))
    .sort((a, b) => a.friendly.localeCompare(b.friendly, 'de'))
}

function scheduleControllerRefresh() {
  if (refreshTimer) return
  refreshTimer = setTimeout(() => { refreshTimer = null; refreshController().catch(() => {}) }, 1500)
}

// HA-Zustand → alle Ajna-Objekte dieser Entität aktualisieren.
async function updateObjectsFor(entityId) {
  const e = registry.get(entityId)
  const domain = domainOf(entityId)
  for (const o of ajna.getObjects()) {
    if (o?.state?.ha_entity !== entityId || o?.state?.ha_instance !== HA_INSTANCE) continue
    const cur = ajna.getObjectById(o.id) || o
    const s = e?.state ?? 'unknown'
    if (cur.state?.ha_state === s) continue
    try {
      await ajna.updateObject(o.id, {
        animation_state: s,
        description: `${cur.name} — ${humanState(s, domain, e?.attributes)}`,
        state: { ...(cur.state || {}), ha_state: s },
      })
    } catch (err) { console.warn('[ha-gateway] Objekt-Update:', err?.message || err) }
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  Controller-Objekt
// ═════════════════════════════════════════════════════════════════════════
// Admin-ACE (Union-Merge, idempotent) — siehe HA_ADMIN oben.
async function grantAdmin(objId) {
  if (!HA_ADMIN) return
  await ensureAce(ajna, objId, {
    subject_type: 'user', subject: HA_ADMIN,
    rights: ['view', 'edit', 'move', 'owner'], interact_actions: ['*'],
  }, { warn: (...a) => console.warn('[ha-gateway]', ...a) })
}

async function ensureController(list) {
  let ctrl = ajna.getObjects().find(o => o?.state?.ha_controller === true && o?.state?.ha_instance === HA_INSTANCE)
  const actions = controllerActions(list)
  if (!ctrl) {
    ctrl = await ajna.createObject({
      name: `${CONTROLLER_NAME} (${HA_INSTANCE})`,
      type: 'item',
      lat: HA_LAT, lon: HA_LON, altitude: 0,
      description: 'Smart-Home-Controller (MQTT). Kontextmenü öffnen und eine Entität hinzufügen.',
      appearance: { emoji: '🏠' },
      state: { ha_controller: true, ha_bridge: true, ha_instance: HA_INSTANCE, actions, realtime: true },
    })
    console.log(`[ha-gateway] Controller angelegt: ${ctrl.id} @ ${HA_LAT.toFixed(4)}, ${HA_LON.toFixed(4)}`)
  }
  await grantAdmin(ctrl.id)   // heilt auch einen bereits vorhandenen Controller
  return ctrl
}

async function refreshController() {
  const list = usableList()
  const cur = ajna.getObjectById(controller.id)
  if (!cur) return
  await ajna.updateObject(controller.id, {
    description: `Smart-Home-Controller (MQTT) — ${list.length} Entitäten.`,
    state: { ...(cur.state || {}), actions: controllerActions(list) },
  })
}

function subscribeController(ctrl) {
  ajna.subscribeInteract(ctrl.id, async (evt) => {
    const action = evt?.action
    if (!action || action === 'examine') return
    if (!registry.has(action)) { console.log(`[ha-gateway] unbekannte Entität: ${action}`); return }
    console.log(`[ha-gateway] + Entität hinzufügen: ${action} (durch ${evt.source || '?'})`)
    try { await createEntityObject(action) }
    catch (err) { console.warn('[ha-gateway] Anlegen fehlgeschlagen:', err?.message || err) }
  }).catch(err => console.warn('[ha-gateway] Controller-Abo:', err?.message || err))
}

// ═════════════════════════════════════════════════════════════════════════
//  Geräte-Objekte
// ═════════════════════════════════════════════════════════════════════════
function spreadOffset(i) {
  const ring = Math.floor(i / 8), idx = i % 8, r = 4 + ring * 4, theta = idx * (Math.PI / 4)
  return { dLat: (r * Math.cos(theta)) / 111000, dLon: (r * Math.sin(theta)) / (111000 * Math.cos(HA_LAT * Math.PI / 180)) }
}

async function createEntityObject(entityId) {
  const domain = domainOf(entityId)
  const def = DOMAINS[domain]
  if (!def) return null
  const e = registry.get(entityId)
  const name = e?.friendly || entityId
  const off = spreadOffset(createdCount++)
  const rec = await ajna.createObject({
    name,
    type: 'item',
    lat: HA_LAT + off.dLat, lon: HA_LON + off.dLon, altitude: 0,
    animation_state: e?.state || 'unknown',
    description: `${name} — ${humanState(e?.state, domain, e?.attributes)}`,
    appearance: { emoji: def.emoji },
    state: {
      ha_bridge: true, ha_instance: HA_INSTANCE, ha_entity: entityId, ha_domain: domain,
      ha_state: e?.state ?? 'unknown',
      actions: def.actions.map(a => ({ key: a.key, label: a.label })),
      realtime: true,
    },
  })
  subscribeEntity(rec.id, entityId, domain)
  await grantAdmin(rec.id)
  console.log(`[ha-gateway] Objekt angelegt: "${name}" (${entityId}) → ${rec.id}`)
  return rec
}

function adoptExisting() {
  let n = 0
  for (const o of ajna.getObjects()) {
    if (o?.state?.ha_bridge === true && o?.state?.ha_entity && o?.state?.ha_instance === HA_INSTANCE) {
      subscribeEntity(o.id, o.state.ha_entity, o.state.ha_domain || domainOf(o.state.ha_entity))
      grantAdmin(o.id)   // fire-and-forget: heilt Bestandsobjekte um die Admin-ACE
      n++
    }
  }
  createdCount = n
  if (n) console.log(`[ha-gateway] ${n} vorhandene Geräte-Objekte adoptiert`)
}

function subscribeEntity(objId, entityId, domain) {
  if (subscribedObjs.has(objId)) return
  subscribedObjs.add(objId)
  ajna.subscribeInteract(objId, async (evt) => {
    const action = evt?.action
    if (!action || action === 'examine') return
    console.log(`[ha-gateway] ${entityId}: ${action} (durch ${evt.source || '?'})`)
    try { runEntityAction(entityId, domain, action) }
    catch (err) { console.warn(`[ha-gateway] Kommando (${entityId}/${action}):`, err?.message || err) }
  }).catch(err => console.warn(`[ha-gateway] Abo ${objId}:`, err?.message || err))
}

// Aktion → {service,data} → publish auf …/<domain>/<entity>/set
function runEntityAction(entityId, domain, actionKey) {
  const def = DOMAINS[domain]
  const act = def?.actions.find(a => a.key === actionKey)
  if (!act) { console.warn(`[ha-gateway] Aktion ${actionKey} für ${domain} unbekannt`); return }
  let msg = null
  if (act.service) {
    msg = { service: act.service }
  } else if (typeof act.dim === 'number') {
    const next = clampPct(brightnessPct(registry.get(entityId)) + act.dim)
    msg = next <= 0 ? { service: 'turn_off' } : { service: 'turn_on', data: { brightness_pct: next } }
  } else if (typeof act.temp === 'number') {
    const t = Number(registry.get(entityId)?.attributes?.temperature)
    if (Number.isFinite(t)) msg = { service: 'set_temperature', data: { temperature: Math.round((t + act.temp) * 10) / 10 } }
    else { console.warn(`[ha-gateway] ${entityId}: keine Zieltemperatur bekannt`); return }
  }
  if (!msg) return
  const [d, ...rest] = entityId.split('.')
  mc.publish(`${BASE}/${d}/${rest.join('.')}/set`, JSON.stringify(msg))
}

// ─── Hilfen ────────────────────────────────────────────────────────────
function warnIfNoDefaults() {
  const dp = ajna.currentUser?.()?.default_permissions
  const empty = !dp || (Array.isArray(dp) && dp.length === 0) ||
    (typeof dp === 'object' && !Array.isArray(dp) && Object.keys(dp).length === 0)
  if (empty) {
    console.warn('[ha-gateway] ⚠ Gateway-User hat KEINE Standardrechte (default_permissions).')
    console.warn('[ha-gateway]   → Andere Nutzer sehen/steuern die Objekte nicht. Im Ajna-Profil')
    console.warn('[ha-gateway]     des Gateway-Users der Zielgruppe view + interact „*" geben.')
  }
}
