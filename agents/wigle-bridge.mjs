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
const RADIUS_M   = parseFloat(process.env.WIGLE_RADIUS_M   || '1000')  // Abfrage-Radius je Ziel
const MAX_NETS   = parseInt(process.env.WIGLE_MAX || '300', 10)        // Gesamt-Cap je Areal (über Seiten)
const MAX_PAGES  = parseInt(process.env.WIGLE_MAX_PAGES || '3', 10)    // Seiten je Areal (je 100, Quota-Schutz)
const INTERVAL_MS = parseFloat(process.env.WIGLE_INTERVAL_S || '3600') * 1000  // Re-Query bei Stillstand
const COVERAGE_M = parseFloat(process.env.WIGLE_COVERAGE_M || '50')
const MAX_AREAS  = parseInt(process.env.WIGLE_MAX_AREAS || '8', 10)    // Quota-Schutz
const POLL_MS      = parseFloat(process.env.WIGLE_POLL_S || '60') * 1000        // Bereichs-Poll (billig, lokal)
const QUERY_MIN_MS = parseFloat(process.env.WIGLE_QUERY_MIN_S || '300') * 1000  // min. Abstand WiGLE-Abfragen

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

// BoundingBox (RADIUS_M) um ein beliebiges Zentrum — für den Zentrum-Fallback
// und pro aktivem Interessensbereich (dessen Mittelpunkt).
function bboxAround(lat, lon) {
  const dla = RADIUS_M / 111000
  const dlo = RADIUS_M / (111000 * Math.cos(lat * Math.PI / 180))
  return { latMin: lat - dla, latMax: lat + dla, lonMin: lon - dlo, lonMax: lon + dlo }
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
  // Paginiert über WiGLEs `searchAfter`-Token, bis MAX_NETS erreicht ist, keine
  // weitere Seite kommt, oder MAX_PAGES (Quota-Schutz) ausgeschöpft ist. Jede
  // Seite ist EINE WiGLE-Abfrage (zählt aufs Tageslimit).
  const out = []
  let searchAfter = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = {
      latrange1: String(bbox.latMin), latrange2: String(bbox.latMax),
      longrange1: String(bbox.lonMin), longrange2: String(bbox.lonMax),
      resultsPerPage: '100'
    }
    if (searchAfter) params.searchAfter = searchAfter
    const r = await fetch(`${WIGLE_URL}?${new URLSearchParams(params)}`, {
      headers: { Authorization: AUTH, Accept: 'application/json' }
    })
    if (r.status === 401) throw new Error('WiGLE 401 — API-Name/Token prüfen')
    if (r.status === 429) throw new Error('WiGLE 429 — tägliches Query-Limit erreicht')
    if (!r.ok) throw new Error(`WiGLE ${r.status}: ${await r.text().catch(() => '')}`)
    const data = await r.json()
    if (data && data.success === false) throw new Error(`WiGLE: ${data.message || 'Fehler'}`)
    const results = Array.isArray(data?.results) ? data.results : []
    out.push(...results)
    searchAfter = data?.searchAfter || data?.search_after || null
    if (!searchAfter || results.length === 0 || out.length >= MAX_NETS) break
  }
  return out.length > MAX_NETS ? out.slice(0, MAX_NETS) : out
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

// Aktive Ziele: Mittelpunkte der Interessensbereiche, sonst Fallback-Zentrum.
// `key` dient dem Änderungs-Vergleich (WiGLE nur bei Änderung neu abfragen).
async function getTargets() {
  let areas = []
  try { areas = await fetchActiveAreas() }
  catch (err) { console.warn(`[wigle] interest-areas: ${err?.message || err} → Fallback Zentrum`) }
  if (!areas.length) return { centers: [{ lat: CENTER_LAT, lon: CENTER_LON }], key: 'center', fromAreas: false }
  if (areas.length > MAX_AREAS) {
    console.warn(`[wigle] ${areas.length} Bereiche → auf ${MAX_AREAS} begrenzt (WiGLE-Quota)`)
    areas = areas.slice(0, MAX_AREAS)
  }
  const centers = areas.map(a => ({ lat: (a.latMin + a.latMax) / 2, lon: (a.lonMin + a.lonMax) / 2 }))
  const key = centers.map(c => `${c.lat.toFixed(4)},${c.lon.toFixed(4)}`).sort().join('|')
  return { centers, key, fromAreas: true }
}

// WiGLE pro Ziel abfragen (RADIUS_M um den Mittelpunkt), Union, Bestand abgleichen.
async function queryReconcile(centers, fromAreas) {
  const byNet = new Map()
  for (const c of centers) {
    try {
      for (const n of await fetchNetworks(bboxAround(c.lat, c.lon))) if (n.netid) byNet.set(String(n.netid), n)
    } catch (err) {
      console.warn(`[wigle] fetch fehlgeschlagen: ${err?.message || err}`)
    }
  }
  const results = Array.from(byNet.values())
  console.log(`[wigle] ${results.length} Netze aus WiGLE (${fromAreas ? `${centers.length} Bereich(e)` : 'Zentrum'})`)

  const seen = new Set()
  let created = 0, skipped = 0, failed = 0

  for (const n of results) {
    const netid = n.netid
    const lat = n.trilat, lon = n.trilong
    if (!netid || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
    seen.add(String(netid))
    if (nets.has(String(netid))) { skipped++; continue }

    const name = (n.ssid || '').trim() || `WLAN ${netid}`
    const cat = encCategory(n.encryption)
    try {
      const obj = await ajna.createObject({
        name,
        type: 'wifi',
        description: describeNet(n),
        lat, lon, altitude: 0,
        // Agent-definierte Darstellung: Karte zeichnet einen Canvas-Punkt in der
        // Verschlüsselungsfarbe (günstig bei Masse). Der Viewer braucht dafür
        // KEIN WLAN-Spezialwissen mehr — er interpretiert nur `appearance`.
        appearance: {
          shape: 'circle',
          color: ENC_STYLE[cat].hex,
          radius: 6
        },
        state: {
          source: 'wigle',
          netid,
          ssid: n.ssid || null,
          encryption: n.encryption || null,
          enc_category: cat,                 // normalisiert → Farbe/Symbol/Filter
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

// Demand-getriebene Schleife: Bereiche häufig + billig pollen, WiGLE nur
// abfragen, wenn sich die Ziele geändert haben (gedrosselt) ODER periodisch
// (Staleness) — schont das WiGLE-Tageslimit, folgt aber zügig dem Spieler.
let lastKey = null, lastQueryAt = 0
async function tick() {
  const { centers, key, fromAreas } = await getTargets()
  const now = Date.now()
  const changed = key !== lastKey
  const stale = (now - lastQueryAt) >= INTERVAL_MS
  if (lastKey === null || stale || (changed && (now - lastQueryAt) >= QUERY_MIN_MS)) {
    if (changed && lastKey !== null) {
      console.log(`[wigle] Ziel geändert → WiGLE-Abfrage (${fromAreas ? `${centers.length} Bereich(e)` : 'Zentrum'})`)
    }
    lastKey = key; lastQueryAt = now
    await queryReconcile(centers, fromAreas)
  }
}
await tick()
setInterval(() => { tick().catch(err => console.warn(`[wigle] tick: ${err?.message || err}`)) }, POLL_MS)
console.log(`[wigle] bereit — Bereichs-Poll alle ${(POLL_MS / 1000) | 0} s, WiGLE-Query min. alle ${(QUERY_MIN_MS / 1000) | 0} s, Re-Query alle ${(INTERVAL_MS / 1000) | 0} s. (Strg+C)`)

process.on('SIGINT',  () => { console.log('\n[wigle] SIGINT — exit'); process.exit(0) })
process.on('SIGTERM', () => { console.log('[wigle] SIGTERM — exit'); process.exit(0) })
