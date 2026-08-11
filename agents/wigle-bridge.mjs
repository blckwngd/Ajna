#!/usr/bin/env node
//
// agents/wigle-bridge.mjs — WLAN-Bridge für Ajna (WiGLE.net)
//
// Ruft über die WiGLE-API (https://api.wigle.net) WLAN-Netze im Umkreis eines
// Zentrums ab und legt für jedes ein Ajna-Objekt vom Typ "wifi" an:
//   • Position = WiGLE-Triangulation (trilat/trilong) → "solider Mittelpunkt"
//   • description = SSID, Verschlüsselung, Kanal, Typ, BSSID, zuletzt gesehen
//   • state.coverage_radius = je Frequenzband geschätzte Reichweite in m → Client
//     zeichnet einen Kreis um den Mittelpunkt (2,4 GHz weiter als 5/6 GHz)
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
//   WIGLE_COVERAGE_M   Reichweiten-Basis in m (Default: 50) = 2,4-GHz-Referenz
//                      und Fallback; 5 GHz ×0,6, 6 GHz ×0,45 davon
//
//   Radius je Netz — zwei Stufen:
//     • Standard: aus dem Frequenzband geschätzt (Band aus channel/frequency,
//       KEINE extra Abfrage).
//     • WIGLE_DETAIL_RADIUS=1: EMPIRISCH aus den Einzelsichtungen (network/detail,
//       robuster Perzentil-Radius). Kostet 1 Abfrage/Netz → hart budgetiert:
//         WIGLE_DETAIL_MAX          Detail-Abfragen pro Sync (Default: 10)
//         WIGLE_DETAIL_PCTL         Perzentil der Distanzen 0..1 (Default: 0.9)
//         WIGLE_DETAIL_MIN_SAMPLES  min. Sichtungen, sonst Band (Default: 4)
//         WIGLE_DETAIL_CAP_M        Radius-Deckel in m (Default: 250)
//       Der Bestand wird über mehrere Syncs schrittweise verfeinert (Backfill).
//
// Hinweis "Nähe des Nutzers": ohne Server-seitige Spielerpräsenz nutzt der
// Agent (wie ais-/poi-bridge) ein KONFIGURIERTES Zentrum. Echte Nutzer-Nähe
// käme erst mit einem Presence-Mechanismus.
//
// Start:  node agents/wigle-bridge.mjs   bzw.   npm run wigle

import { bootAgent, die, envNum, envInt, envBool, envStr, publishManifest } from './lib/agent-base.mjs'
import { encCategory, ENC_STYLE, wifiManifestLayers } from '../client/core/wifiStyle.js'
import { bboxAroundM, centerOf } from '../client/core/geoMath.js'
import { watchInterestAreas } from '../client/core/interestAreas.js'

import { simpleSetup } from './lib/setup-wizard.mjs'

// Login + geschichtete .env (Env > agents/.env.wigle > Root-.env) + System-CA.
// Erststart ohne Pflichtwerte (oder --setup): Mini-Wizard fragt sie ab. Die
// WiGLE-Keys sind hier "optional", weil auch die Legacy-Namen API_NAME/API_TOKEN
// gelten (unten geprüft) — ein need-Trigger darauf würde solche Setups brechen.
const { ajna } = await bootAgent('wigle', {
  setup: simpleSetup('wigle', {
    required: ['AJNA_USER', 'AJNA_PASS'],
    optional: ['WIGLE_API_NAME', 'WIGLE_API_TOKEN', 'AJNA_URL'],
  }),
})

// Akzeptiert beide Namenskonventionen: WIGLE_API_NAME/TOKEN (kanonisch) und
// API_NAME/API_TOKEN (wie auf wigle.net und in mancher .env).
const API_NAME   = envStr('WIGLE_API_NAME') || envStr('API_NAME')
const API_TOKEN  = envStr('WIGLE_API_TOKEN') || envStr('API_TOKEN')
const CENTER_LAT = envNum('WIGLE_CENTER_LAT', 50.3569)
const CENTER_LON = envNum('WIGLE_CENTER_LON', 7.5890)
const RADIUS_M   = envNum('WIGLE_RADIUS_M', 1000)   // Abfrage-Radius je Ziel
const MAX_NETS   = envInt('WIGLE_MAX', 300)         // Gesamt-Cap je Areal (über Seiten)
const MAX_PAGES  = envInt('WIGLE_MAX_PAGES', 3)     // Seiten je Areal (je 100, Quota-Schutz)
const INTERVAL_MS = envNum('WIGLE_INTERVAL_S', 3600) * 1000  // Re-Query bei Stillstand
const COVERAGE_M = envNum('WIGLE_COVERAGE_M', 50)
const MAX_AREAS  = envInt('WIGLE_MAX_AREAS', 8)     // Quota-Schutz
const POLL_MS      = envNum('WIGLE_POLL_S', 60) * 1000        // Bereichs-Poll (billig, lokal)
const QUERY_MIN_MS = envNum('WIGLE_QUERY_MIN_S', 300) * 1000  // min. Abstand WiGLE-Abfragen

// Ansatz B (optional): empirischer Empfangsradius aus den Einzelsichtungen
// (network/detail). EINE WiGLE-Abfrage PRO NETZ → hart budgetiert. Aus (Default)
// bleibt es bei der bandbasierten Schätzung.
const DETAIL_ON    = envBool('WIGLE_DETAIL_RADIUS')
const DETAIL_MAX   = envInt('WIGLE_DETAIL_MAX', 10)             // Detail-Abfragen pro Sync (Quota!)
const DETAIL_PCTL  = Math.min(1, Math.max(0, envNum('WIGLE_DETAIL_PCTL', 0.9)))  // Perzentil statt Max
const DETAIL_MIN   = envInt('WIGLE_DETAIL_MIN_SAMPLES', 4)      // darunter nicht vertrauenswürdig
const DETAIL_CAP_M = envNum('WIGLE_DETAIL_CAP_M', 250)          // Deckel gg. mobile/streuende APs
const DETAIL_FLOOR_M = 10

// Funk-/Sendemasten aus OpenStreetMap (über unsere Geo-API, Overpass-gecacht).
// Statisch → seltener Sync als die WLAN-Abfragen.
const MASTS_ON       = envBool('WIGLE_MASTS', true)
const MASTS_RADIUS_M = envNum('WIGLE_MASTS_RADIUS_M', 3000)
const MASTS_SYNC_MS  = envNum('WIGLE_MASTS_SYNC_S', 1800) * 1000

if (!API_NAME || !API_TOKEN) die('WIGLE_API_NAME und WIGLE_API_TOKEN fehlen (wigle.net → Account → API)')

// BoundingBox (RADIUS_M) um ein Zentrum: bboxAroundM aus client/core/geoMath.js.

const WIGLE_URL = 'https://api.wigle.net/api/v2/network/search'
const AUTH = 'Basic ' + Buffer.from(`${API_NAME}:${API_TOKEN}`).toString('base64')

console.log(`[wigle] Zentrum: ${CENTER_LAT.toFixed(4)}, ${CENTER_LON.toFixed(4)} · Radius ${RADIUS_M} m · max ${MAX_NETS}`)
console.log(`[wigle] Sync-Intervall: ${(INTERVAL_MS / 1000).toFixed(0)} s · Reichweite-Basis (2,4 GHz): ${COVERAGE_M} m, 5 GHz ${Math.round(COVERAGE_M * 0.6)} m, 6 GHz ${Math.round(COVERAGE_M * 0.45)} m`)
console.log(DETAIL_ON
  ? `[wigle] Empfangsradius: EMPIRISCH aus Sichtungen (network/detail, max ${DETAIL_MAX} Abfragen/Sync, p${Math.round(DETAIL_PCTL * 100)}, Deckel ${DETAIL_CAP_M} m), Band als Fallback`
  : `[wigle] Empfangsradius: bandbasiert geschätzt (WIGLE_DETAIL_RADIUS=1 für empirische Verfeinerung)`)

// Manifest: WLAN-Layer (je Verschlüsselung) + Funkmasten als eigener Layer.
// Beide unter derselben Quelle "wigle" — der Agent visualisiert die unsichtbare
// FUNK-Infrastruktur, WLAN und Mobilfunk/Rundfunk gehören thematisch zusammen.
const WIFI_LAYERS = wifiManifestLayers()
if (await publishManifest(ajna, {
  source: 'wigle',
  agent_name: 'Funk-Infrastruktur',
  description: `WLAN-Netze (WiGLE.net) + Funk-/Sendemasten (OpenStreetMap) im Radius ${RADIUS_M} m`,
  layers: [
    ...WIFI_LAYERS,
    ...(MASTS_ON ? [{ key: 'masts', label: 'Funkmasten', predicate: { field: 'type', equals: 'mast' } }] : []),
  ],
})) console.log('[ajna] manifest aktualisiert')

// ─── In-Memory-Map: netid (BSSID) → { objectId, name, basis, lat, lon } ──
// `basis` merkt sich, WORAUS der Radius kommt ('observations'|'band'|'fallback')
// — damit das Backfill (Ansatz B) nur noch nicht empirisch verfeinerte Netze
// anfasst. lat/lon dienen dem Detail-Aufruf als Kreismittelpunkt.
const nets = new Map()
// Netze, deren network/detail zu wenige Sichtungen (< DETAIL_MIN) hatte: prozess-
// weit gemerkt, damit das Backfill sie nicht jeden Sync erneut abfragt (sonst
// verbrennt das Budget an aussichtslosen Netzen). Bei Neustart einmal neu geprüft.
const detailInsufficient = new Set()
try {
  await ajna.refreshObjects()
  for (const obj of ajna.getObjects()) {
    if (obj.type !== 'wifi') continue
    const netid = obj.state?.netid
    if (netid) nets.set(String(netid), {
      objectId: obj.id, name: obj.name,
      basis: obj.state?.coverage_basis || null, lat: obj.lat, lon: obj.lon
    })
  }
  console.log(`[ajna] ${nets.size} vorhandene WLANs geladen`)
} catch (err) {
  console.warn(`[ajna] initiales WLAN-Listing fehlgeschlagen: ${err?.message || err}`)
}

// ─── WiGLE-Helfer ─────────────────────────────────────────────────────────

// Empfangsbereich pro WLAN schätzen (Meter). WiGLE liefert KEINEN Radius, aber
// das Frequenzband bestimmt die Reichweite am stärksten: 2,4 GHz trägt weiter als
// 5/6 GHz (längere Welle, weniger Dämpfung). Band aus `frequency` (MHz) bzw.
// `channel` ableiten — beides kommt aus der bereits getätigten Suche, kostet also
// KEINE extra WiGLE-Abfrage. Bewusst grob: eine Visualisierungs-Schätzung, keine
// Funkfeldberechnung. Für den empirischen Streuradius bräuchte es network/detail
// (eine Abfrage pro Netz → Quota), das ist hier absichtlich NICHT gemacht.
function bandOf(n) {
  const f = Number(n.frequency)
  if (Number.isFinite(f) && f > 0) {
    if (f >= 2400 && f < 2500) return '2.4'
    if (f >= 4900 && f < 5900) return '5'
    if (f >= 5900 && f <= 7200) return '6'
  }
  const ch = Number(n.channel)
  if (Number.isFinite(ch) && ch > 0) {
    if (ch <= 14) return '2.4'
    if (ch >= 32) return '5'
    // 6-GHz-Kanäle beginnen wie 2,4 GHz bei 1 → ohne `frequency` nicht sicher
    // trennbar; ch<=14 wird dem weit verbreiteteren 2,4-GHz-Band zugeordnet.
  }
  return null
}

// COVERAGE_M ist die 2,4-GHz-Referenz (und der Fallback bei unbekanntem Band).
// 5/6 GHz reichen anteilig weniger weit. Ein Skalieren von WIGLE_COVERAGE_M
// verschiebt alle Bänder proportional.
const BAND_FACTOR = { '2.4': 1.0, '5': 0.6, '6': 0.45 }
function coverageRadiusOf(n) {
  const band = bandOf(n)
  return Math.round(COVERAGE_M * (band ? BAND_FACTOR[band] : 1.0))
}

// Grobe Distanz in Metern (äquirektangular — auf dieser Skala genau genug).
function distM(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * 111320
  const dLon = (bLon - aLon) * 111320 * Math.cos(aLat * Math.PI / 180)
  return Math.hypot(dLat, dLon)
}

const WIGLE_DETAIL_URL = 'https://api.wigle.net/api/v2/network/detail'

// Ansatz B: empirischer Radius aus den EINZELsichtungen. Jede Sichtung ist ein
// Ort, an dem das AP tatsächlich empfangen wurde — die Streuung um den
// Mittelpunkt ist der ehrlichste Reichweiten-Proxy. Bewusst ein RADIUS (Kreis),
// KEIN Hüllpolygon: WiGLE-Sichtungen folgen Straßen (Wardriving), ein Polygon
// bildete den Fahrweg ab, nicht das Funkfeld. Robustes Perzentil statt Max, damit
// ein einzelner Ausreißer (mobiler Hotspot, GPS-Fehler) den Kreis nicht sprengt.
// EINE WiGLE-Abfrage pro Aufruf → nur mit Budget nutzen.
// Wirft bei 429 (Tageslimit) weiter, damit der Aufrufer das Budget stoppt.
async function fetchDetailRadius(netid, centerLat, centerLon) {
  const r = await fetch(`${WIGLE_DETAIL_URL}?${new URLSearchParams({ netid })}`, {
    headers: { Authorization: AUTH, Accept: 'application/json' }
  })
  if (r.status === 429) throw new Error('429 — WiGLE-Tageslimit')
  if (!r.ok) throw new Error(`WiGLE detail ${r.status}`)
  const data = await r.json()
  if (data && data.success === false) return null
  const net = Array.isArray(data?.results) ? data.results[0] : data
  const pts = Array.isArray(net?.locationData) ? net.locationData : []
  const dists = []
  for (const p of pts) {
    const la = Number(p.latitude ?? p.lat), lo = Number(p.longitude ?? p.lon ?? p.long)
    if (Number.isFinite(la) && Number.isFinite(lo)) dists.push(distM(centerLat, centerLon, la, lo))
  }
  if (dists.length < DETAIL_MIN) return null   // zu wenig Daten → Band-Schätzung behalten
  dists.sort((a, b) => a - b)
  const idx = Math.min(dists.length - 1, Math.floor(DETAIL_PCTL * (dists.length - 1)))
  const radius = Math.round(Math.min(DETAIL_CAP_M, Math.max(DETAIL_FLOOR_M, dists[idx])))
  return { radius, samples: dists.length }
}

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

// Aktive Ziele: Mittelpunkte der Interessensbereiche, sonst Fallback-Zentrum.
// (Abruf/Deckelung/Änderungs-Erkennung: watchInterestAreas, client/core.)
// Zuletzt aktive Zentren — vom WLAN-Tick gesetzt, vom Mast-Sync mitgenutzt.
let lastCenters = []

function centersFrom(areas) {
  if (!areas.length) return { centers: [{ lat: CENTER_LAT, lon: CENTER_LON }], fromAreas: false }
  return { centers: areas.map(centerOf), fromAreas: true }
}

// WiGLE pro Ziel abfragen (RADIUS_M um den Mittelpunkt), Union, Bestand abgleichen.
async function queryReconcile(centers, fromAreas) {
  const byNet = new Map()
  for (const c of centers) {
    try {
      for (const n of await fetchNetworks(bboxAroundM(c.lat, c.lon, RADIUS_M))) if (n.netid) byNet.set(String(n.netid), n)
    } catch (err) {
      console.warn(`[wigle] fetch fehlgeschlagen: ${err?.message || err}`)
    }
  }
  const results = Array.from(byNet.values())
  console.log(`[wigle] ${results.length} Netze aus WiGLE (${fromAreas ? `${centers.length} Bereich(e)` : 'Zentrum'})`)

  const seen = new Set()
  let created = 0, skipped = 0, failed = 0

  // Ansatz-B-Budget: höchstens DETAIL_MAX network/detail-Abfragen pro Sync, damit
  // ein Erst-Lauf mit hunderten Netzen das Tageslimit nicht sprengt. `detail429`
  // stoppt weitere Versuche, sobald WiGLE das Limit meldet; `triedDetail`
  // verhindert, dass dasselbe Netz in einem Sync doppelt abgefragt wird (Anlegen
  // + Backfill). `refined` zählt die empirisch bestimmten Radien.
  let detailBudget = DETAIL_ON ? DETAIL_MAX : 0
  let detail429 = false, refined = 0
  const triedDetail = new Set()

  // Empirischen Radius holen, solange Budget/Flag es zulassen; sonst Band-Schätzung.
  async function coverageFor(n, lat, lon) {
    const netid = String(n.netid)
    if (detailBudget > 0 && !detail429) {
      detailBudget--; triedDetail.add(netid)
      try {
        const d = await fetchDetailRadius(netid, lat, lon)
        if (d) { refined++; return { radius: d.radius, basis: 'observations', samples: d.samples } }
        detailInsufficient.add(netid)   // getestet, aber zu wenige Sichtungen → nicht erneut versuchen
      } catch (err) {
        if (String(err.message).startsWith('429')) { detail429 = true; console.warn('[wigle] detail 429 → Rest dieses Syncs Band-Schätzung') }
        else console.warn(`[wigle] detail ${netid}: ${err.message}`)
      }
    }
    return { radius: coverageRadiusOf(n), basis: bandOf(n) ? 'band' : 'fallback', samples: null }
  }

  for (const n of results) {
    const netid = n.netid
    const lat = n.trilat, lon = n.trilong
    if (!netid || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
    seen.add(String(netid))
    if (nets.has(String(netid))) { skipped++; continue }

    const name = (n.ssid || '').trim() || `WLAN ${netid}`
    const cat = encCategory(n.encryption)
    try {
      const cov = await coverageFor(n, lat, lon)   // empirisch (Ansatz B) oder Band
      const obj = await ajna.createObject({
        name,
        type: 'wifi',
        description: describeNet(n),
        lat, lon, altitude: 0,
        // Agent-definierte Darstellung: Karte zeichnet einen Canvas-Punkt in der
        // Verschlüsselungsfarbe (günstig bei Masse). Der Viewer braucht dafür
        // KEIN WLAN-Spezialwissen mehr — er interpretiert nur `appearance`.
        appearance: {
          shape: 'circle',                 // Karte: Canvas-Punkt
          color: ENC_STYLE[cat].hex,
          radius: 6,
          // AR weicht ab (2D-Kreis ≠ 3D): transparente, schwebende Kugel in
          // Verschlüsselungsfarbe, 5 m über dem Boden.
          ar: { shape: 'sphere', diameter: 0.8, opacity: 0.35, y: 5 }
        },
        state: {
          source: 'wigle',
          netid,
          ssid: n.ssid || null,
          encryption: n.encryption || null,
          enc_category: cat,                 // normalisiert → Farbe/Symbol/Filter
          channel: n.channel ?? null,
          band: bandOf(n),                   // '2.4'|'5'|'6'|null — Basis der Band-Schätzung
          wifi_type: n.type || null,
          lastupdt: n.lastupdt || null,
          coverage_radius: cov.radius,       // Client zeichnet daraus den Kreis
          coverage_basis: cov.basis,         // 'observations'|'band'|'fallback' — woher der Radius kommt
          coverage_samples: cov.samples      // Anzahl Sichtungen (nur bei 'observations')
        }
      })
      nets.set(String(netid), { objectId: obj.id, name, basis: cov.basis, lat, lon })
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

  // Backfill (Ansatz B): vorhandene Netze, die noch keinen empirischen Radius
  // haben, im verbliebenen Budget nachziehen. So wird der Bestand über mehrere
  // Syncs vollständig verfeinert — der Erst-Lauf hätte sein Budget sonst nur für
  // die zuerst angelegten Netze verbraucht, die lange laufenden alten nie.
  if (DETAIL_ON && !detail429) {
    for (const [netid, net] of nets) {
      if (detailBudget <= 0 || detail429) break
      if (net.basis === 'observations' || triedDetail.has(netid) || detailInsufficient.has(netid)) continue
      const la = Number(net.lat), lo = Number(net.lon)
      if (!Number.isFinite(la) || !Number.isFinite(lo)) continue
      detailBudget--; triedDetail.add(netid)
      try {
        const d = await fetchDetailRadius(netid, la, lo)
        if (!d) { net.basis = 'band'; detailInsufficient.add(netid); continue }   // zu wenige Sichtungen → nicht mehr versuchen
        const rec = ajna.getObjectById(net.objectId)
        if (!rec) continue
        await ajna.updateObject(net.objectId, {
          state: { ...rec.state, coverage_radius: d.radius, coverage_basis: 'observations', coverage_samples: d.samples }
        })
        net.basis = 'observations'; refined++
        console.log(`[ajna] ~ ${net.name} (${netid}) Radius ${d.radius} m aus ${d.samples} Sichtungen`)
      } catch (err) {
        if (String(err.message).startsWith('429')) { detail429 = true; console.warn('[wigle] detail 429 (Backfill) → Stop'); break }
        console.warn(`[wigle] backfill ${netid}: ${err.message}`)
      }
    }
  }

  const detailNote = DETAIL_ON ? `, ${refined} empirisch (${DETAIL_MAX - detailBudget}/${DETAIL_MAX} Detail-Abfragen)` : ''
  console.log(`[wigle] ${created} neu, ${skipped} bereits vorhanden, ${deleted} entfernt, ${failed} Fehler${detailNote} — Bestand: ${nets.size}`)
}

// Demand-getriebene Schleife: Bereiche häufig + billig pollen (watchInterestAreas),
// WiGLE nur abfragen, wenn sich die Ziele geändert haben (gedrosselt) ODER
// periodisch (Staleness) — schont das WiGLE-Tageslimit, folgt aber zügig dem Spieler.
let lastQueryAt = 0
const areaWatch = watchInterestAreas(ajna, 'wigle',
  { intervalMs: POLL_MS, maxAreas: MAX_AREAS },
  async (areas, { changed }) => {
    const { centers, fromAreas } = centersFrom(areas)
    lastCenters = centers          // auch der Mast-Sync folgt den Spielern
    const now = Date.now()
    const stale = (now - lastQueryAt) >= INTERVAL_MS
    if (stale || (changed && (now - lastQueryAt) >= QUERY_MIN_MS)) {
      if (changed && lastQueryAt) {
        console.log(`[wigle] Ziel geändert → WiGLE-Abfrage (${fromAreas ? `${centers.length} Bereich(e)` : 'Zentrum'})`)
      }
      lastQueryAt = now
      await queryReconcile(centers, fromAreas)
    }
  })
await areaWatch.first
console.log(`[wigle] bereit — Bereichs-Poll alle ${(POLL_MS / 1000) | 0} s, WiGLE-Query min. alle ${(QUERY_MIN_MS / 1000) | 0} s, Re-Query alle ${(INTERVAL_MS / 1000) | 0} s. (Strg+C)`)

// ───────────────────────────────────────────────────────────────────────
//  Funk-/Sendemasten (OpenStreetMap via Ajna-Geo-API)
//
//  Mobilfunk-, Rundfunk- und Richtfunkmasten sind die sichtbare Hälfte der
//  Funk-Infrastruktur, die dieser Agent zeigt (WLAN = die unsichtbare).
//  Quelle bewusst OSM statt OpenCelliD: kein API-Key nötig, und die Masten
//  stehen ortsfest — ein Sync alle 30 min genügt.
// ───────────────────────────────────────────────────────────────────────
const masts = new Map()   // osm_id → { objectId, name }

if (MASTS_ON) {
  const { AjnaGeo } = await import('../client/core/AjnaGeo.js')
  const geo = new AjnaGeo(ajna)

  // Bestand adoptieren (idempotent über state.osm_id).
  for (const o of ajna.getObjects()) {
    if (o?.type === 'mast' && o?.state?.source === 'wigle' && o?.state?.osm_id) {
      masts.set(String(o.state.osm_id), { objectId: o.id, name: o.name })
    }
  }
  if (masts.size) console.log(`[masts] ${masts.size} vorhandene Masten adoptiert`)

  // Mast-Typ aus den OSM-Tags lesbar machen.
  const mastLabel = (t = {}) => {
    const kind = /mobile|gsm|umts|lte|5g/i.test(`${t['communication:mobile_phone']} ${t.operator} ${t.description}`)
      ? 'Mobilfunkmast'
      : t['communication:radio'] || t['communication:television'] ? 'Sendemast (Rundfunk)'
      : t['man_made'] === 'communications_tower' ? 'Fernmeldeturm' : 'Funkmast'
    return kind
  }

  async function syncMasts() {
    const centers = lastCenters.length ? lastCenters : [{ lat: CENTER_LAT, lon: CENTER_LON }]
    const byId = new Map()
    for (const c of centers.slice(0, MAX_AREAS)) {
      try {
        const res = await geo.poisNear(c.lat, c.lon, MASTS_RADIUS_M, 'masts')
        for (const f of (res.features || [])) if (f.id) byId.set(f.id, f)
      } catch (err) { console.warn(`[masts] Abruf: ${err?.message || err}`); return }
    }
    let created = 0
    for (const f of byId.values()) {
      if (masts.has(f.id)) continue
      const coords = Array.isArray(f.coordinates) ? f.coordinates[0] : null
      if (!coords || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) continue
      const t = f.tags || {}
      const kind = mastLabel(t)
      const hoehe = Number(t.height)
      const name = (t.name || t.operator || kind).slice(0, 32)
      try {
        const obj = await ajna.createObject({
          name,
          type: 'mast',
          description: [kind, t.operator ? `Betreiber: ${t.operator}` : null,
            Number.isFinite(hoehe) ? `${hoehe} m hoch` : null, `OSM ${f.id}`]
            .filter(Boolean).join(' · '),
          lat: coords[0], lon: coords[1], altitude: 0,
          appearance: {
            emoji: '📡', color: '#b06cd6',
            // AR: schlanker Pfeiler in echter Masthöhe (sonst 30 m Default) —
            // macht die Infrastruktur im Stadtbild sichtbar.
            ar: { shape: 'cylinder', height: Number.isFinite(hoehe) ? hoehe : 30, diameter: 1.2, opacity: 0.5, y: (Number.isFinite(hoehe) ? hoehe : 30) / 2 },
          },
          state: { source: 'wigle', osm_id: f.id, osm_tags: t, mast_kind: kind },
        })
        masts.set(f.id, { objectId: obj.id, name })
        created++
      } catch (err) {
        console.warn(`[masts] create ${f.id}: ${err?.response?.data?.message || err?.message || err}`)
      }
    }
    console.log(`[masts] ${byId.size} Masten im Umkreis${created ? `, ${created} neu angelegt` : ''} — Bestand ${masts.size}`)
  }

  await syncMasts()
  setInterval(() => { syncMasts().catch(err => console.warn(`[masts] sync: ${err?.message || err}`)) }, MASTS_SYNC_MS)
}
