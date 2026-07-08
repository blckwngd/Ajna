#!/usr/bin/env node
//
// agents/homeassistant-bridge.mjs — Home-Assistant-Bridge für Ajna
//
// Macht Smart-Home-Geräte aus Home Assistant in Ajna sichtbar und steuerbar.
// Läuft LOKAL auf der Home-Assistant-Maschine (spricht HA über localhost an,
// der Token bleibt lokal) und verbindet sich zum Ajna-Server.
//
// Ablauf:
//   1. Login als dedizierter Bridge-User, HA-Entitäten über die REST-API holen.
//   2. Ein Controller-Objekt an HA_LAT/HA_LON anlegen/adoptieren. Sein
//      Kontextmenü (state.actions) listet alle nutzbaren Entitäten.
//   3. Klick auf eine Entität → interact → dieser Agent legt ein Geräte-Objekt
//      in der Szene an (z. B. "Deckenlicht" mit Aktionen einschalten/ausschalten/
//      heller/dunkler) mit dem aktuellen HA-Zustand. Frei verschieb-/bearbeitbar.
//   4. Interaktion auf einem Geräte-Objekt → HA-Service-Call (turn_on/off/…).
//   5. Live-Sync: HA-WebSocket (state_changed) → Geräte-Objekte spiegeln den
//      echten Zustand in Echtzeit (auch bei externen Änderungen).
//
// Rechte: KEINE hartcodierte ACE. Controller + Geräte-Objekte werden mit den
// Standardrechten des Bridge-Users angelegt (Server-Hook applyOwnerDefaults aus
// users.default_permissions) und sind danach pro Objekt frei anpassbar. Damit
// andere Nutzer schalten dürfen, muss das Bridge-User-PROFIL einer Zielgruppe
// `view` + interact `*` geben (sonst Warnung beim Start).
//
// Konfiguration (ENV oder .env im CWD):
//   AJNA_URL   PocketBase/Caddy-URL des Ajna-Servers (Default: http://127.0.0.1:8090)
//   AJNA_USER  Pflicht — Bridge-User
//   AJNA_PASS  Pflicht
//   HA_URL     Home-Assistant-URL         (Default: http://127.0.0.1:8123)
//   HA_TOKEN   Pflicht — Long-Lived Access Token (HA → Profil → Sicherheit)
//   HA_LAT     Controller-Latitude        (Default: 50.3569)
//   HA_LON     Controller-Longitude       (Default: 7.5890)
//   HA_DOMAINS optionale CSV: nur diese Domains anbieten (Default: alle steuerbaren)
//   HA_ENTITIES optionale CSV: nur diese entity_ids anbieten (Allowlist)
//   HA_REFRESH_S Controller-Entitätenliste alle N s neu einlesen (Default: 300)
//   HA_POLL_S  Zustands-Poll-Intervall als WS-Fallback in s (Default: 30)
//
// Start:  node agents/homeassistant-bridge.mjs   bzw.   npm run ha-bridge

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { maybeReexecWithSystemCa } from './lib/system-ca.mjs'
import { EventSource } from 'eventsource'
if (typeof globalThis.EventSource !== 'function') globalThis.EventSource = EventSource

import { AjnaManager } from '../client/core/AjnaManager.js'

// ─── .env laden (gleiches Schema wie die übrigen Agents) ─────────────────
function loadDotenv() {
  const path = resolve(process.cwd(), '.env')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const stripped = line.replace(/^\s*#.*$/, '').trim()
    if (!stripped) continue
    const m = stripped.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i)
    if (!m) continue
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}
loadDotenv()

const AJNA_URL   = process.env.AJNA_URL  || 'http://127.0.0.1:8090'
const AJNA_USER  = process.env.AJNA_USER
const AJNA_PASS  = process.env.AJNA_PASS
const HA_URL     = (process.env.HA_URL || 'http://127.0.0.1:8123').replace(/\/+$/, '')
const HA_TOKEN   = process.env.HA_TOKEN
const HA_LAT     = parseFloat(process.env.HA_LAT || '50.3569')
const HA_LON     = parseFloat(process.env.HA_LON || '7.5890')
const HA_DOMAINS = csv(process.env.HA_DOMAINS)
const HA_ENTITIES = csv(process.env.HA_ENTITIES)
const REFRESH_MS = parseFloat(process.env.HA_REFRESH_S || '300') * 1000
const POLL_MS    = parseFloat(process.env.HA_POLL_S || '30') * 1000
const CONTROLLER_NAME = 'Smart Home'

function csv(v) {
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean)
}

// Bei HTTPS-Ajna ggf. mit --use-system-ca neu starten (Caddys interne CA).
maybeReexecWithSystemCa(AJNA_URL)

function die(msg) { console.error(`✗ ${msg}`); process.exit(1) }
if (!AJNA_USER || !AJNA_PASS) die('AJNA_USER und AJNA_PASS fehlen (.env)')
if (!HA_TOKEN) die('HA_TOKEN fehlt — Long-Lived Access Token in HA anlegen (Profil → Sicherheit)')
if (!Number.isFinite(HA_LAT) || !Number.isFinite(HA_LON)) die('Ungültige HA_LAT/HA_LON')

// ─────────────────────────────────────────────────────────────────────────
//  Steuerbare Domains: Emoji (Karten-/AR-Icon) + Aktionen (→ HA-Service).
//  Action-Keys bewusst ASCII (interact_actions-Matching); Labels mit Umlaut.
// ─────────────────────────────────────────────────────────────────────────
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
  scene:         { emoji: '🎬', actions: [
    { key: 'aktivieren', label: 'Aktivieren', service: 'turn_on' },
  ]},
  script:        { emoji: '▶️', actions: [
    { key: 'ausfuehren', label: 'Ausführen', service: 'turn_on' },
  ]},
}
const ENABLED_DOMAINS = new Set(HA_DOMAINS.length ? HA_DOMAINS : Object.keys(DOMAINS))

// ─── Home-Assistant-REST ──────────────────────────────────────────────────
const haHeaders = { Authorization: `Bearer ${HA_TOKEN}` }

async function haFetchStates() {
  const res = await fetch(`${HA_URL}/api/states`, { headers: haHeaders })
  if (!res.ok) throw new Error(`HA /api/states → ${res.status}`)
  return res.json()
}

async function haCallService(domain, service, data) {
  const res = await fetch(`${HA_URL}/api/services/${domain}/${service}`, {
    method: 'POST',
    headers: { ...haHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`HA ${domain}.${service} → ${res.status}`)
  return res.json().catch(() => ({}))
}

const domainOf = (entityId) => String(entityId).split('.')[0]
const friendlyOf = (st, entityId) => st?.attributes?.friendly_name || entityId

// Nutzbare Entitäten: steuerbare (aktivierte) Domain + optionale Allowlist.
function usableEntities(states) {
  const allow = HA_ENTITIES.length ? new Set(HA_ENTITIES) : null
  return states
    .filter(st => DOMAINS[domainOf(st.entity_id)] && ENABLED_DOMAINS.has(domainOf(st.entity_id)))
    .filter(st => !allow || allow.has(st.entity_id))
    .map(st => ({ entity_id: st.entity_id, domain: domainOf(st.entity_id), friendly: friendlyOf(st, st.entity_id) }))
    .sort((a, b) => a.friendly.localeCompare(b.friendly, 'de'))
}

// Menschlicher Zustandstext (für Beschreibung).
function humanState(stateOrObj, domain) {
  const s = typeof stateOrObj === 'string' ? stateOrObj : stateOrObj?.state
  const attrs = (typeof stateOrObj === 'object' && stateOrObj?.attributes) || {}
  if (s === 'on') {
    const b = Number(attrs.brightness)
    if (domain === 'light' && Number.isFinite(b)) return `an (${Math.round(b / 255 * 100)} %)`
    return 'an'
  }
  if (s === 'off') return 'aus'
  if (s === 'open') return 'offen'
  if (s === 'closed') return 'geschlossen'
  if (s === 'locked') return 'verriegelt'
  if (s === 'unlocked') return 'entriegelt'
  return s || 'unbekannt'
}

// Aktuelle Helligkeit in Prozent (0, wenn aus/unbekannt).
function currentBrightnessPct(st) {
  const b = Number(st?.attributes?.brightness)
  return st?.state === 'on' && Number.isFinite(b) ? Math.round(b / 255 * 100) : 0
}
const clampPct = (p) => Math.max(0, Math.min(100, p))

// ─── Zustands-Cache (aus initialem Fetch + WS/Poll) ──────────────────────
const latestHaState = new Map()   // entity_id → HA-State-Objekt
const subscribedObjs = new Set()  // objId → interact bereits abonniert
let usableSet = new Set()         // aktuell anbietbare entity_ids
let createdCount = 0              // für versetzte Platzierung neuer Objekte

// ─── Ajna-Login ───────────────────────────────────────────────────────────
const ajna = new AjnaManager(AJNA_URL)
try { await ajna.login(AJNA_USER, AJNA_PASS) }
catch (err) { die(`Ajna-Login fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`) }
console.log(`[ha-bridge] eingeloggt als ${ajna.currentUser()?.email || AJNA_USER}`)
await ajna.connect()

warnIfNoDefaults()

// ─── Initiale HA-Zustände + Entitäten ────────────────────────────────────
let states
try { states = await haFetchStates() }
catch (err) { die(`Home Assistant nicht erreichbar unter ${HA_URL}: ${err?.message || err}`) }
for (const st of states) latestHaState.set(st.entity_id, st)

let entities = usableEntities(states)
usableSet = new Set(entities.map(e => e.entity_id))
console.log(`[ha-bridge] ${entities.length} steuerbare Entitäten aus HA (${HA_URL})`)
if (entities.length > 30) {
  console.log('[ha-bridge] Hinweis: viele Entitäten — das Controller-Kontextmenü wird lang.')
  console.log('[ha-bridge]   Mit HA_ENTITIES (Allowlist) oder HA_DOMAINS eingrenzen.')
}

// ─── Controller-Objekt sicherstellen + Bestand adoptieren ────────────────
const controller = await ensureController(entities)
subscribeController(controller)
adoptExisting()

// ─── Live-Sync + periodische Auffrischung ────────────────────────────────
startHaLiveSync()
setInterval(refreshController, REFRESH_MS)

console.log('[ha-bridge] bereit. (Strg+C zum Beenden)')
process.on('SIGINT', () => { console.log('\n[ha-bridge] beende.'); process.exit(0) })

// ═════════════════════════════════════════════════════════════════════════
//  Controller
// ═════════════════════════════════════════════════════════════════════════
function controllerActions(list) {
  // Action-Key = entity_id (eindeutig); Label = Name · Domain.
  return list.map(e => ({ key: e.entity_id, label: `${e.friendly} · ${e.domain}` }))
}

async function ensureController(list) {
  let ctrl = ajna.getObjects().find(o => o?.state?.ha_controller === true)
  const actions = controllerActions(list)
  if (!ctrl) {
    ctrl = await ajna.createObject({
      name: CONTROLLER_NAME,
      type: 'item',
      lat: HA_LAT, lon: HA_LON, altitude: 0,
      description: `Smart-Home-Controller — ${list.length} Entitäten. Kontextmenü öffnen und eine Entität hinzufügen.`,
      appearance: { emoji: '🏠' },
      state: { ha_controller: true, ha_bridge: true, actions, realtime: true },
    })
    console.log(`[ha-bridge] Controller angelegt: ${ctrl.id} @ ${HA_LAT.toFixed(4)}, ${HA_LON.toFixed(4)}`)
  } else {
    const cur = ajna.getObjectById(ctrl.id) || ctrl
    await ajna.updateObject(ctrl.id, {
      description: `Smart-Home-Controller — ${list.length} Entitäten.`,
      state: { ...(cur.state || {}), ha_controller: true, ha_bridge: true, actions },
    })
    console.log(`[ha-bridge] Controller adoptiert: ${ctrl.id} (${list.length} Entitäten)`)
  }
  return ctrl
}

function subscribeController(ctrl) {
  ajna.subscribeInteract(ctrl.id, async (evt) => {
    const action = evt?.action
    if (!action || action === 'examine') return
    if (!usableSet.has(action)) { console.log(`[ha-bridge] unbekannte Controller-Aktion: ${action}`); return }
    console.log(`[ha-bridge] + Entität hinzufügen: ${action} (durch ${evt.source || '?'})`)
    try { await createEntityObject(action) }
    catch (err) { console.warn('[ha-bridge] Anlegen fehlgeschlagen:', err?.message || err) }
  }).catch(err => console.warn('[ha-bridge] Controller-Abo fehlgeschlagen:', err?.message || err))
}

// HA-Entitätenliste periodisch neu einlesen und ins Controller-Menü übernehmen.
async function refreshController() {
  try {
    const s = await haFetchStates()
    for (const st of s) latestHaState.set(st.entity_id, st)
    entities = usableEntities(s)
    usableSet = new Set(entities.map(e => e.entity_id))
    const cur = ajna.getObjectById(controller.id)
    if (cur) {
      await ajna.updateObject(controller.id, {
        state: { ...(cur.state || {}), actions: controllerActions(entities) },
      })
    }
  } catch (err) { console.warn('[ha-bridge] Controller-Refresh:', err?.message || err) }
}

// ═════════════════════════════════════════════════════════════════════════
//  Geräte-Objekte
// ═════════════════════════════════════════════════════════════════════════
// Kleiner Ring/Gitter-Versatz um den Controller, damit neue Objekte nicht
// exakt stapeln (frei verschiebbar).
function spreadOffset(i) {
  const ring = Math.floor(i / 8)
  const idx = i % 8
  const r = 4 + ring * 4  // Meter
  const theta = idx * (Math.PI / 4)
  return {
    dLat: (r * Math.cos(theta)) / 111000,
    dLon: (r * Math.sin(theta)) / (111000 * Math.cos(HA_LAT * Math.PI / 180)),
  }
}

async function createEntityObject(entityId) {
  const domain = domainOf(entityId)
  const def = DOMAINS[domain]
  if (!def) { console.warn(`[ha-bridge] Domain ${domain} nicht steuerbar`); return null }
  const cur = latestHaState.get(entityId)
  const name = friendlyOf(cur, entityId)
  const off = spreadOffset(createdCount++)
  const rec = await ajna.createObject({
    name,
    type: 'item',
    lat: HA_LAT + off.dLat,
    lon: HA_LON + off.dLon,
    altitude: 0,
    animation_state: cur?.state || 'unknown',
    description: `${name} — ${humanState(cur, domain)}`,
    appearance: { emoji: def.emoji },
    state: {
      ha_bridge: true,
      ha_entity: entityId,
      ha_domain: domain,
      ha_state: cur?.state ?? 'unknown',
      actions: def.actions.map(a => ({ key: a.key, label: a.label })),
      realtime: true,
    },
  })
  subscribeEntity(rec.id, entityId, domain)
  console.log(`[ha-bridge] Objekt angelegt: "${name}" (${entityId}) → ${rec.id}`)
  return rec
}

// Vorhandene Geräte-Objekte beim Start adoptieren (Neustart-Idempotenz):
// interact-Abos neu aufsetzen. Es werden KEINE Duplikate angelegt.
function adoptExisting() {
  let n = 0
  for (const o of ajna.getObjects()) {
    if (o?.state?.ha_bridge === true && o?.state?.ha_entity) {
      subscribeEntity(o.id, o.state.ha_entity, o.state.ha_domain || domainOf(o.state.ha_entity))
      n++
    }
  }
  createdCount = n
  if (n) console.log(`[ha-bridge] ${n} vorhandene Geräte-Objekte adoptiert`)
}

function subscribeEntity(objId, entityId, domain) {
  if (subscribedObjs.has(objId)) return
  subscribedObjs.add(objId)
  ajna.subscribeInteract(objId, async (evt) => {
    const action = evt?.action
    if (!action || action === 'examine') return
    console.log(`[ha-bridge] ${entityId}: ${action} (durch ${evt.source || '?'})`)
    try { await runEntityAction(entityId, domain, action) }
    catch (err) { console.warn(`[ha-bridge] Service-Call (${entityId}/${action}):`, err?.message || err) }
  }).catch(err => console.warn(`[ha-bridge] Abo ${objId} fehlgeschlagen:`, err?.message || err))
}

async function runEntityAction(entityId, domain, actionKey) {
  const def = DOMAINS[domain]
  const act = def?.actions.find(a => a.key === actionKey)
  if (!act) { console.warn(`[ha-bridge] Aktion ${actionKey} für ${domain} unbekannt`); return }
  if (act.service) {
    await haCallService(domain, act.service, { entity_id: entityId })
  } else if (typeof act.dim === 'number') {
    // Relativ heller/dunkler; unter 0 % → ausschalten, über 100 % → gedeckelt.
    const next = clampPct(currentBrightnessPct(latestHaState.get(entityId)) + act.dim)
    if (next <= 0) await haCallService('light', 'turn_off', { entity_id: entityId })
    else await haCallService('light', 'turn_on', { entity_id: entityId, brightness_pct: next })
  } else if (typeof act.temp === 'number') {
    const target = Number(latestHaState.get(entityId)?.attributes?.temperature)
    if (Number.isFinite(target)) {
      await haCallService('climate', 'set_temperature', { entity_id: entityId, temperature: Math.round((target + act.temp) * 10) / 10 })
    } else {
      console.warn(`[ha-bridge] ${entityId}: keine Zieltemperatur bekannt — übersprungen`)
    }
  }
  // Der sichtbare Zustand wird über den Live-Sync (WS/Poll) nachgezogen.
}

// ═════════════════════════════════════════════════════════════════════════
//  Live-Sync HA → Ajna (WebSocket, mit Poll-Fallback)
// ═════════════════════════════════════════════════════════════════════════
function startHaLiveSync() {
  if (typeof globalThis.WebSocket !== 'function') {
    console.warn('[ha-bridge] Kein globales WebSocket (Node < 21?) → Live-Sync per Polling.')
    startPolling()
    return
  }
  const wsUrl = HA_URL.replace(/^http/, 'ws') + '/api/websocket'
  let msgId = 1
  const connect = () => {
    let ws
    try { ws = new WebSocket(wsUrl) }
    catch (err) { console.warn('[ha-bridge] WS-Init:', err?.message || err); setTimeout(connect, 5000); return }
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data) } catch { return }
      if (m.type === 'auth_required') { ws.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN })); return }
      if (m.type === 'auth_invalid') { console.error('[ha-bridge] HA-Token ungültig (WebSocket)'); return }
      if (m.type === 'auth_ok') {
        ws.send(JSON.stringify({ id: msgId++, type: 'subscribe_events', event_type: 'state_changed' }))
        console.log('[ha-bridge] HA-WebSocket verbunden — Live-Sync aktiv')
        return
      }
      if (m.type === 'event' && m.event?.event_type === 'state_changed') {
        const d = m.event.data
        if (d?.entity_id) {
          latestHaState.set(d.entity_id, d.new_state)
          onHaState(d.entity_id, d.new_state)
        }
      }
    })
    ws.addEventListener('close', () => { console.warn('[ha-bridge] HA-WebSocket getrennt → Reconnect in 5 s'); setTimeout(connect, 5000) })
    ws.addEventListener('error', () => { try { ws.close() } catch {} })
  }
  connect()
}

function startPolling() {
  setInterval(async () => {
    try {
      const s = await haFetchStates()
      for (const st of s) latestHaState.set(st.entity_id, st)
      const tracked = new Set(ajna.getObjects().filter(o => o?.state?.ha_entity).map(o => o.state.ha_entity))
      for (const ent of tracked) { const st = latestHaState.get(ent); if (st) onHaState(ent, st) }
    } catch (err) { console.warn('[ha-bridge] Poll:', err?.message || err) }
  }, POLL_MS)
}

// Ein HA-Zustandswechsel → alle Ajna-Objekte dieser Entität aktualisieren
// (Duplikate erlaubt → potenziell mehrere).
async function onHaState(entityId, newState) {
  const domain = domainOf(entityId)
  for (const o of ajna.getObjects()) {
    if (o?.state?.ha_entity !== entityId) continue
    const cur = ajna.getObjectById(o.id) || o
    const s = newState?.state ?? 'unknown'
    if (cur.state?.ha_state === s && cur.animation_state === s) continue  // nichts Neues
    try {
      await ajna.updateObject(o.id, {
        animation_state: s,
        description: `${cur.name} — ${humanState(newState, domain)}`,
        state: { ...(cur.state || {}), ha_state: s },
      })
    } catch (err) { console.warn('[ha-bridge] Objekt-Update:', err?.message || err) }
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  Hilfen
// ═════════════════════════════════════════════════════════════════════════
// Warnen, wenn der Bridge-User keine Standardrechte gesetzt hat — sonst sehen
// andere Nutzer die angelegten Objekte nicht (owner-only).
function warnIfNoDefaults() {
  const u = ajna.currentUser?.()
  const dp = u?.default_permissions
  const empty = !dp
    || (Array.isArray(dp) && dp.length === 0)
    || (typeof dp === 'object' && !Array.isArray(dp) && Object.keys(dp).length === 0)
  if (empty) {
    console.warn('[ha-bridge] ⚠ Bridge-User hat KEINE Standardrechte (default_permissions).')
    console.warn('[ha-bridge]   → Andere Nutzer sehen/steuern die Objekte nicht.')
    console.warn('[ha-bridge]   → Im Ajna-Profil des Bridge-Users unter „Standardrechte" der gewünschten')
    console.warn('[ha-bridge]     Zielgruppe view + interact „*" geben (danach pro Objekt anpassbar).')
  }
}
