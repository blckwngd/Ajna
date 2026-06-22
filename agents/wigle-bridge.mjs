#!/usr/bin/env node
//
// agents/wigle-bridge.mjs — WLAN-Bridge für Ajna (WiGLE.net)
//
// Ruft über die WiGLE-API (https://api.wigle.net) WLAN-Netze im Umkreis eines
// Zentrums ab und legt für jedes ein Ajna-Objekt vom Typ "wifi" an:
//   • Position = WiGLE-Triangulation (trilat/trilong) → "solider Mittelpunkt"
//   • description = SSID, Verschlüsselung, Kanal, Typ, BSSID, zuletzt gesehen
//   • state.coverage_radius = geschätzte Abdeckung in m → Client zeichnet einen
//     Kreis um den Mittelpunkt
//
// Gebaut wie poi-bridge.mjs: dedizierter Agent-User, periodischer Sync,
// Cleanup verschwundener Netze. BSSID (netid) ist der stabile Identifier.
//
// Konfiguration (ENV oder .env im CWD):
//   AJNA_URL    PocketBase/Caddy-URL (Default: http://127.0.0.1:8090)
//   AJNA_USER / AJNA_PASS   Pflicht — Agent-User
//   WIGLE_API_NAME / WIGLE_API_TOKEN   Pflicht — von wigle.net (Account → API)
//   WIGLE_CENTER_LAT / WIGLE_CENTER_LON  Zentrum (Default: 50.3569, 7.5890)
//   WIGLE_RADIUS_M     Suchradius in m   (Default: 500)
//   WIGLE_MAX          max. Netze pro Sync (Default: 50; WiGLE-Quota schonen)
//   WIGLE_INTERVAL_S   Sync-Intervall in s (Default: 3600 — WiGLE hat ein
//                      tägliches Query-Limit, also sparsam abfragen)
//   WIGLE_COVERAGE_M   geschätzte Abdeckung pro WLAN in m (Default: 50)
//
// Hinweis "Nähe des Nutzers": ohne Server-seitige Spielerpräsenz nutzt der
// Agent (wie ais-/poi-bridge) ein KONFIGURIERTES Zentrum. Echte Nutzer-Nähe
// käme erst mit einem Presence-Mechanismus.
//
// Start:  node agents/wigle-bridge.mjs   bzw.   npm run wigle

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { EventSource } from 'eventsource'
if (typeof globalThis.EventSource !== 'function') globalThis.EventSource = EventSource

import { AjnaManager } from '../client/core/AjnaManager.js'
import { encCategory, ENC_STYLE, wifiManifestLayers } from '../client/core/wifiStyle.js'

// ─── .env laden (gleiches Schema wie poi-bridge.mjs) ─────────────────────
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
// Akzeptiert beide Namenskonventionen: WIGLE_API_NAME/TOKEN (kanonisch) und
// API_NAME/API_TOKEN (wie auf wigle.net und in mancher .env).
const API_NAME   = process.env.WIGLE_API_NAME  || process.env.API_NAME
const API_TOKEN  = process.env.WIGLE_API_TOKEN || process.env.API_TOKEN
const CENTER_LAT = parseFloat(process.env.WIGLE_CENTER_LAT || '50.3569')
const CENTER_LON = parseFloat(process.env.WIGLE_CENTER_LON || '7.5890')
const RADIUS_M   = parseFloat(process.env.WIGLE_RADIUS_M   || '500')
const MAX_NETS   = parseInt(process.env.WIGLE_MAX || '50', 10)
const INTERVAL_MS = parseFloat(process.env.WIGLE_INTERVAL_S || '3600') * 1000
const COVERAGE_M = parseFloat(process.env.WIGLE_COVERAGE_M || '50')
const MAX_AREAS  = parseInt(process.env.WIGLE_MAX_AREAS || '8', 10)   // Quota-Schutz

// Re-exec mit --use-system-ca bei HTTPS (Caddy-interne CA) — wie poi-bridge.
if (AJNA_URL.startsWith('https://') && !process.execArgv.includes('--use-system-ca')) {
  const r = spawnSync(process.execPath,
    ['--use-system-ca', process.argv[1], ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

function die(msg) { console.error(`✗ ${msg}`); process.exit(1) }
if (!AJNA_USER || !AJNA_PASS) die('AJNA_USER und AJNA_PASS fehlen')
if (!API_NAME || !API_TOKEN)  die('WIGLE_API_NAME und WIGLE_API_TOKEN fehlen (wigle.net → Account → API)')
if (!Number.isFinite(CENTER_LAT) || !Number.isFinite(CENTER_LON)) die('Ungültige Center-Koords')

// ─── BoundingBox um das Zentrum (Quadrat, das den Radius enthält) ────────
const KM_PER_DEG_LAT = 111000
const dLat = RADIUS_M / KM_PER_DEG_LAT
const dLon = RADIUS_M / (KM_PER_DEG_LAT * Math.cos(CENTER_LAT * Math.PI / 180))
const BBOX = {
  latMin: CENTER_LAT - dLat, latMax: CENTER_LAT + dLat,
  lonMin: CENTER_LON - dLon, lonMax: CENTER_LON + dLon
}

const WIGLE_URL = 'https://api.wigle.net/api/v2/network/search'
const AUTH = 'Basic ' + Buffer.from(`${API_NAME}:${API_TOKEN}`).toString('base64')

console.log(`[wigle] Zentrum: ${CENTER_LAT.toFixed(4)}, ${CENTER_LON.toFixed(4)} · Radius ${RADIUS_M} m · max ${MAX_NETS}`)
console.log(`[wigle] Sync-Intervall: ${(INTERVAL_MS / 1000).toFixed(0)} s · Abdeckung: ${COVERAGE_M} m`)

// ─── Ajna-Login + Manifest ───────────────────────────────────────────────
const ajna = new AjnaManager(AJNA_URL)
try { await ajna.login(AJNA_USER, AJNA_PASS) }
catch (err) { die(`Ajna-Login fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`) }
console.log(`[ajna] eingeloggt als ${ajna.currentUser()?.email || AJNA_USER}`)

try {
  await ajna.upsertAgentManifest({
    source: 'wigle',
    agent_name: 'WiGLE-Bridge',
    description: `WLAN-Netze via WiGLE.net im Radius ${RADIUS_M} m um ${CENTER_LAT.toFixed(3)}, ${CENTER_LON.toFixed(3)}`,
    layers: wifiManifestLayers()   // "Alle" + ein Filter-Layer je Verschlüsselung
  })
  console.log('[ajna] manifest aktualisiert')
} catch (err) {
  console.warn('[ajna] manifest-upsert fehlgeschlagen:', err?.message || err)
}

// ─── In-Memory-Map: netid (BSSID) → { objectId, name } ───────────────────
const nets = new Map()
try {
  await ajna.refreshObjects()
  for (const obj of ajna.getObjects()) {
    if (obj.type !== 'wifi') continue
    const netid = obj.state?.netid
    if (netid) nets.set(String(netid), { objectId: obj.id, name: obj.name })
  }
  console.log(`[ajna] ${nets.size} vorhandene WLANs geladen`)
} catch (err) {
  console.warn(`[ajna] initiales WLAN-Listing fehlgeschlagen: ${err?.message || err}`)
}

// ─── WiGLE-Helfer ─────────────────────────────────────────────────────────

function describeNet(n) {
  const ssid = (n.ssid || '').trim() || '(versteckt)'
  const parts = [`WLAN „${ssid}"`, ENC_STYLE[encCategory(n.encryption)].label]
  if (n.channel) parts.push(`Kanal ${n.channel}`)
  if (n.type)    parts.push(String(n.type))
  if (n.lastupdt) parts.push(`zuletzt gesehen ${String(n.lastupdt).slice(0, 10)}`)
  parts.push(`BSSID ${n.netid}`)
  return parts.join(' · ') + ' (Quelle: WiGLE)'
}

async function fetchNetworks(bbox) {
  const qs = new URLSearchParams({
    latrange1: String(bbox.latMin), latrange2: String(bbox.latMax),
    longrange1: String(bbox.lonMin), longrange2: String(bbox.lonMax),
    resultsPerPage: String(Math.min(MAX_NETS, 100))
  })
  const r = await fetch(`${WIGLE_URL}?${qs}`, {
    headers: { Authorization: AUTH, Accept: 'application/json' }
  })
  if (r.status === 401) throw new Error('WiGLE 401 — API-Name/Token prüfen')
  if (r.status === 429) throw new Error('WiGLE 429 — tägliches Query-Limit erreicht')
  if (!r.ok) throw new Error(`WiGLE ${r.status}: ${await r.text().catch(() => '')}`)
  const data = await r.json()
  if (data && data.success === false) throw new Error(`WiGLE: ${data.message || 'Fehler'}`)
  return Array.isArray(data?.results) ? data.results : []
}

// Aktive (anonymisierte) Interessensbereiche der Spieler, die WLANs eingeblendet
// haben. Leer → niemand da (oder Opt-out) → Fallback konfiguriertes Zentrum.
async function fetchActiveAreas() {
  const client = ajna.defaultClient
  const base = (client.url || '').replace(/\/+$/, '')
  const token = client.pb?.authStore?.token
  const r = await fetch(`${base}/ajnaapi/interest-areas?source=wigle`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  })
  if (!r.ok) throw new Error(`interest-areas ${r.status}`)
  const data = await r.json()
  return Array.isArray(data?.areas) ? data.areas : []
}

// ─── Sync ─────────────────────────────────────────────────────────────────
async function sync() {
  // Demand-getrieben: dort abfragen, wo Spieler sind (anonymisierte Bereiche);
  // ohne aktive Bereiche → konfiguriertes Zentrum.
  let areas = []
  try { areas = await fetchActiveAreas() }
  catch (err) { console.warn(`[wigle] interest-areas: ${err?.message || err} → Fallback Zentrum`) }

  let targets = areas.length ? areas : [BBOX]
  if (targets.length > MAX_AREAS) {
    console.warn(`[wigle] ${targets.length} Bereiche → auf ${MAX_AREAS} begrenzt (WiGLE-Quota)`)
    targets = targets.slice(0, MAX_AREAS)
  }

  // Union über alle Ziele, dedup nach BSSID (WiGLE-Quota: eine Abfrage/Areal).
  const byNet = new Map()
  for (const t of targets) {
    try {
      for (const n of await fetchNetworks(t)) if (n.netid) byNet.set(String(n.netid), n)
    } catch (err) {
      console.warn(`[wigle] fetch fehlgeschlagen: ${err?.message || err}`)
    }
  }
  const results = Array.from(byNet.values())
  console.log(`[wigle] ${results.length} Netze aus WiGLE (${areas.length ? `${targets.length} Bereich(e)` : 'Zentrum'})`)

  const seen = new Set()
  let created = 0, skipped = 0, failed = 0

  for (const n of results) {
    const netid = n.netid
    const lat = n.trilat, lon = n.trilong
    if (!netid || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
    seen.add(String(netid))
    if (nets.has(String(netid))) { skipped++; continue }

    const name = (n.ssid || '').trim() || `WLAN ${netid}`
    try {
      const obj = await ajna.createObject({
        name,
        type: 'wifi',
        description: describeNet(n),
        lat, lon, altitude: 0,
        state: {
          source: 'wigle',
          netid,
          ssid: n.ssid || null,
          encryption: n.encryption || null,
          enc_category: encCategory(n.encryption),   // normalisiert → Farbe/Symbol/Filter
          channel: n.channel ?? null,
          wifi_type: n.type || null,
          lastupdt: n.lastupdt || null,
          coverage_radius: COVERAGE_M     // Client zeichnet daraus den Kreis
        }
      })
      nets.set(String(netid), { objectId: obj.id, name })
      created++
      console.log(`[ajna] + ${name} (${netid}) → ${obj.id}`)
    } catch (err) {
      failed++
      console.warn(`[ajna] create ${netid} fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`)
    }
  }

  // Cleanup: WLANs, die im aktuellen Result nicht mehr auftauchen, entfernen.
  let deleted = 0
  for (const [netid, net] of nets) {
    if (seen.has(netid)) continue
    try {
      await ajna.deleteObject(net.objectId)
      nets.delete(netid)
      deleted++
      console.log(`[ajna] − ${net.name} (${netid})`)
    } catch (err) {
      console.warn(`[ajna] cleanup ${netid} fehlgeschlagen: ${err?.message || err}`)
    }
  }

  console.log(`[wigle] ${created} neu, ${skipped} bereits vorhanden, ${deleted} entfernt, ${failed} Fehler — Bestand: ${nets.size}`)
}

await sync()
setInterval(() => { sync().catch(err => console.warn(`[wigle] sync-tick: ${err?.message || err}`)) }, INTERVAL_MS)
console.log('[wigle] bereit — periodischer Sync aktiv. (Strg+C zum Beenden)')

process.on('SIGINT',  () => { console.log('\n[wigle] SIGINT — exit'); process.exit(0) })
process.on('SIGTERM', () => { console.log('[wigle] SIGTERM — exit'); process.exit(0) })
