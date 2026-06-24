#!/usr/bin/env node
//
// agents/poi-bridge.mjs — POI-Bridge für Ajna
//
// Holt POIs (Points of Interest) aus der existierenden Ajna-Geo-API
// (`/ajnaapi/geo/pois`, intern Overpass-gestützt mit Cache) und legt
// sie als Ajna-Objekte mit `type="poi"` an. Der AR-Client rendert sie
// als grüne Stab-Marker (siehe GameObject.#createPlaceholder).
//
// POIs sind **statisch** — kein Realtime-Update. Der Agent ist demand-getrieben
// (folgt den aktiven Interessensbereichen) und pollt kontinuierlich (Default
// 120 s); POI_REFRESH_S=0 macht daraus einen einmaligen Sync. Idempotent über
// `state.osm_id` (kein doppeltes Anlegen bei Re-Run).
//
// Konfiguration via Umgebungsvariablen (oder `.env` im CWD):
//
//   POI_CENTER_LAT       Center-Latitude  (Default: 50.3569 — Koblenz)
//   POI_CENTER_LON       Center-Longitude (Default: 7.5890)
//   POI_RADIUS_KM        Radius in km     (Default: 1)
//   POI_FILTER           Filter-Set       (Default: "common";
//                        erlaubt: common | amenity | shops | tourism —
//                        siehe server/geo.js)
//   POI_REFRESH_S        Refresh-Intervall in s (Default: 120). 0 = einmaliger
//                        Sync und Ende. Niedriger Wert = mehr Overpass-Last
//                        (Server cached 1 h, also unkritisch).
//
//   AJNA_URL   PocketBase-URL  (Default: http://127.0.0.1:8090)
//   AJNA_USER  Pflicht — dedizierter PB-User für den Agent
//   AJNA_PASS  Pflicht
//
// Hinweis: für Sichtbarkeit durch andere User braucht der Agent-User
// `default_permissions` mit `subject_type=authenticated, rights=[view]`,
// damit jeder neue POI automatisch eine entsprechende ACE bekommt.
//
// Start:
//   node agents/poi-bridge.mjs
//   bzw.:
//   npm run poi

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { maybeReexecWithSystemCa } from './lib/system-ca.mjs'
import { EventSource } from 'eventsource'
// PB-SDK öffnet beim ersten refreshObjects()/connect() eine Realtime-SSE
// und greift dabei auf globalThis.EventSource zu. In Node ist das je nach
// Version nicht (zuverlässig) verfügbar → wir polyfillen aus npm.
if (typeof globalThis.EventSource !== 'function') globalThis.EventSource = EventSource

import { AjnaManager } from '../client/core/AjnaManager.js'
import { AjnaGeo } from '../client/core/AjnaGeo.js'

// ───────────────────────────────────────────────────────────────────────
//  .env laden (identisches Schema wie ais-bridge.mjs)
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
const CENTER_LAT = parseFloat(process.env.POI_CENTER_LAT || '50.3569')
const CENTER_LON = parseFloat(process.env.POI_CENTER_LON || '7.5890')
const RADIUS_KM  = parseFloat(process.env.POI_RADIUS_KM  || '1')
const FILTER     = process.env.POI_FILTER || 'common'
// Default kontinuierlich (120 s): die Bridge ist demand-getrieben und muss die
// aktiven Interessensbereiche fortlaufend pollen. Einmal-Sync via POI_REFRESH_S=0.
const REFRESH_MS = parseFloat(process.env.POI_REFRESH_S || '120') * 1000

// Bei HTTPS ggf. mit --use-system-ca neu starten (Caddys interne CA). Robust
// gegen altes Node & öffentliche Zerts — siehe agents/lib/system-ca.mjs.
maybeReexecWithSystemCa(AJNA_URL)

function die(msg) { console.error(`✗ ${msg}`); process.exit(1) }

if (!AJNA_USER || !AJNA_PASS) die('AJNA_USER und AJNA_PASS fehlen')
if (!Number.isFinite(CENTER_LAT) || !Number.isFinite(CENTER_LON)) die('Ungültige Center-Koords')
if (!Number.isFinite(RADIUS_KM) || RADIUS_KM <= 0) die('Ungültiger Radius')

console.log(`[poi] center: ${CENTER_LAT.toFixed(4)}, ${CENTER_LON.toFixed(4)}  radius: ${RADIUS_KM} km  filter: ${FILTER}`)

// ───────────────────────────────────────────────────────────────────────
//  Ajna-Login + initiales Laden vorhandener POIs (via AjnaManager —
//  Routing/Composite-IDs/Auth-Handling laufen über die Bibliothek).
// ───────────────────────────────────────────────────────────────────────

const ajna = new AjnaManager(AJNA_URL)
const geo  = new AjnaGeo(ajna)
try {
  await ajna.login(AJNA_USER, AJNA_PASS)
} catch (err) {
  die(`Ajna-Login fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`)
}
console.log(`[ajna] eingeloggt als ${ajna.currentUser()?.email || AJNA_USER}`)

// ───────────────────────────────────────────────────────────────────────
//  Agent-Manifest publishen — der Client zeigt die Layer im FilterDialog
//  als Checkboxen. Die Layer-Auswahl entspricht den Untergruppen, die
//  der serverseitige `common`-Filter in server/geo.js enthält. Für andere
//  POI_FILTER-Modes kommen Layer-Schemas später dazu.
// ───────────────────────────────────────────────────────────────────────

const POI_LAYERS_COMMON = [
  { key: 'all',         label: 'Alle POIs',  predicate: null },
  { key: 'cafe',        label: 'Cafés',          predicate: { field: 'state.osm_tags.amenity', equals: 'cafe' } },
  { key: 'restaurant',  label: 'Restaurants',    predicate: { field: 'state.osm_tags.amenity', equals: 'restaurant' } },
  { key: 'bar',         label: 'Bars',           predicate: { field: 'state.osm_tags.amenity', equals: 'bar' } },
  { key: 'pub',         label: 'Pubs',           predicate: { field: 'state.osm_tags.amenity', equals: 'pub' } },
  { key: 'fast_food',   label: 'Fast Food',      predicate: { field: 'state.osm_tags.amenity', equals: 'fast_food' } },
  { key: 'bench',       label: 'Bänke',          predicate: { field: 'state.osm_tags.amenity', equals: 'bench' } },
  { key: 'fountain',    label: 'Brunnen',        predicate: { field: 'state.osm_tags.amenity', equals: 'fountain' } },
  { key: 'toilets',     label: 'Toiletten',      predicate: { field: 'state.osm_tags.amenity', equals: 'toilets' } },
  { key: 'drinking_water', label: 'Trinkwasser', predicate: { field: 'state.osm_tags.amenity', equals: 'drinking_water' } }
]

// Für andere FILTER-Modi (amenity / shops / tourism) bieten wir vorerst
// nur den "all"-Layer an — feinere Aufschlüsselung kann pro Filter-Set
// nach Bedarf dazukommen.
const POI_LAYERS_GENERIC = [
  { key: 'all', label: 'Alle POIs', predicate: null }
]

try {
  const layers = FILTER === 'common' ? POI_LAYERS_COMMON : POI_LAYERS_GENERIC
  await ajna.upsertAgentManifest({
    source: 'overpass',
    agent_name: 'POI-Bridge',
    description: `OSM-POIs (Filter: ${FILTER}) im Radius ${RADIUS_KM} km um ${CENTER_LAT.toFixed(3)}, ${CENTER_LON.toFixed(3)}`,
    layers
  })
  console.log(`[ajna] manifest aktualisiert (${layers.length} Layer)`)
} catch (err) {
  console.warn('[ajna] manifest-upsert fehlgeschlagen:', err?.message || err)
}

/**
 * In-Memory-Map: osm_id (z. B. "node/123") → { objectId, name }.
 * Wird beim Boot aus PB gefüllt — Idempotenz garantiert beim Re-Run.
 */
const pois = new Map()

// Beim initialen Sweep filtern wir auf `state.source = "overpass"`, damit
// das Cleanup unten NUR Bridge-managte POIs anfasst und user-definierte
// type="poi"-Objekte (mit anderer `source`) unangetastet lässt.
try {
  await ajna.refreshObjects()
  for (const obj of ajna.getObjects()) {
    if (obj.type !== 'poi') continue
    if (obj.state?.source !== 'overpass') continue
    const osmId = obj.state?.osm_id
    if (!osmId) continue
    pois.set(String(osmId), { objectId: obj.id, name: obj.name })
  }
  console.log(`[ajna] ${pois.size} vorhandene Overpass-POIs geladen`)
} catch (err) {
  console.warn(`[ajna] initiales POI-Listing fehlgeschlagen: ${err?.message || err}`)
}

// ───────────────────────────────────────────────────────────────────────
//  Fetch + Sync
// ───────────────────────────────────────────────────────────────────────

// Aktive (anonymisierte) Interessensbereiche der Spieler, die diesen Agent
// eingeblendet haben. Leer → niemand da (oder alle opt-out) → Fallback Zentrum.
async function fetchActiveAreas() {
  // Über die Ajna-Library (Base-URL + Auth + /ajnaapi zentral aufgelöst).
  return ajna.fetchInterestAreas('overpass')
}

// BBOX → Center + Radius (halbe Diagonale, gedeckelt), für geo.poisNear.
function bboxToTarget(b) {
  const lat = (b.latMin + b.latMax) / 2
  const lon = (b.lonMin + b.lonMax) / 2
  const halfLatM = (b.latMax - b.latMin) / 2 * 111000
  const halfLonM = (b.lonMax - b.lonMin) / 2 * 111000 * Math.cos(lat * Math.PI / 180)
  return { lat, lon, radiusM: Math.min(2000, Math.round(Math.hypot(halfLatM, halfLonM))) }
}

async function fetchPois() {
  // Demand-getrieben: dort holen, wo Spieler sind (anonymisierte Bereiche).
  // Ohne aktive Bereiche → konfiguriertes Zentrum (Dev/Demo).
  let areas = []
  try { areas = await fetchActiveAreas() }
  catch (err) { console.warn(`[poi] interest-areas: ${err?.message || err} → Fallback Zentrum`) }

  const targets = areas.length
    ? areas.map(bboxToTarget)
    : [{ lat: CENTER_LAT, lon: CENTER_LON, radiusM: Math.round(RADIUS_KM * 1000) }]

  // AjnaGeo cached pro Areal; Union über alle Ziele, dedup nach Feature-ID.
  const byId = new Map()
  for (const t of targets) {
    try {
      const res = await geo.poisNear(t.lat, t.lon, t.radiusM, FILTER)
      for (const f of (res.features || [])) if (f.id) byId.set(f.id, f)
    } catch (err) {
      console.warn(`[poi] fetch @${t.lat.toFixed(4)},${t.lon.toFixed(4)}: ${err?.message || err}`)
    }
  }
  return {
    features: Array.from(byId.values()),
    source: areas.length ? `interest-areas (${targets.length})` : 'center'
  }
}

function derivePoiName(tags = {}) {
  // Fallback wenn `name` fehlt: kategorisch das Tag, das den POI ausmacht.
  return tags.amenity || tags.shop || tags.tourism || tags.leisure || null
}

// Informative Beschreibung aus den OSM-Tags (wird via "examine" ausgegeben).
function describePoi(tags = {}) {
  const cat = tags.amenity || tags.shop || tags.tourism || tags.leisure
  const parts = []
  if (cat) parts.push(String(cat).replace(/_/g, ' '))
  if (tags.cuisine)       parts.push(`Küche: ${String(tags.cuisine).replace(/_/g, ' ')}`)
  if (tags.opening_hours) parts.push(`Öffnungszeiten: ${tags.opening_hours}`)
  const addr = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ')
  if (addr) parts.push(addr)
  if (tags.website) parts.push(tags.website)
  return parts.length ? `POI · ${parts.join(' · ')}` : 'Point of Interest (OpenStreetMap).'
}

async function syncPois() {
  let result
  try {
    result = await fetchPois()
  } catch (err) {
    console.warn(`[poi] fetch fehlgeschlagen: ${err?.message || err}`)
    return
  }

  const features = result.features || []
  console.log(`[poi] ${features.length} POIs aus Overpass (source: ${result.source})`)

  // Cleanup: vorhandene Bridge-managte POIs, die nicht mehr im aktuellen
  // Overpass-Result auftauchen (z. B. Bbox geschrumpft, Filter geändert,
  // Tag in OSM entfernt), aus PB löschen. Berührt nur POIs, die wir in
  // unsere `pois`-Map geladen haben (= state.source==overpass).
  const currentOsmIds = new Set(features.map(f => f.id).filter(Boolean))
  let deleted = 0
  for (const [osmId, poi] of pois) {
    if (currentOsmIds.has(osmId)) continue
    try {
      await ajna.deleteObject(poi.objectId)
      pois.delete(osmId)
      deleted++
      console.log(`[ajna] − ${poi.name} (${osmId})`)
    } catch (err) {
      console.warn(`[ajna] cleanup ${osmId} fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`)
    }
  }

  let created = 0
  let skipped = 0
  let failed  = 0

  for (const f of features) {
    const osmId = f.id
    if (!osmId) continue
    if (pois.has(osmId)) { skipped++; continue }

    // POIs aus Overpass sind Nodes — `coordinates` ist Array mit einem Punkt
    const coords = Array.isArray(f.coordinates) ? f.coordinates[0] : null
    if (!coords || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) {
      console.warn(`[poi] skip ${osmId}: keine valide Position`)
      continue
    }
    const [lat, lon] = coords

    const name = f.name?.trim() || derivePoiName(f.tags) || `POI ${osmId}`

    try {
      const obj = await ajna.createObject({
        name,
        type: 'poi',
        description: describePoi(f.tags),
        lat, lon, altitude: 0,
        state: {
          osm_id:   osmId,
          osm_type: f.type,
          osm_tags: f.tags || {},
          source:   'overpass'
        }
      })
      pois.set(osmId, { objectId: obj.id, name })
      created++
      console.log(`[ajna] + ${name} (${osmId}) → ${obj.id}`)
    } catch (err) {
      failed++
      console.warn(`[ajna] create ${osmId} fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`)
    }
  }

  console.log(`[ajna] ${created} neu, ${skipped} bereits vorhanden, ${deleted} entfernt, ${failed} Fehler — Bestand: ${pois.size}`)
}

// ───────────────────────────────────────────────────────────────────────
//  Start
// ───────────────────────────────────────────────────────────────────────

await syncPois()

if (REFRESH_MS > 0) {
  console.log(`[poi] refresh: alle ${(REFRESH_MS / 1000).toFixed(0)} s`)
  setInterval(() => {
    syncPois().catch(err => console.warn(`[poi] refresh error: ${err?.message || err}`))
  }, REFRESH_MS)
  process.on('SIGINT',  () => { console.log('\n[poi] SIGINT — exit'); process.exit(0) })
  process.on('SIGTERM', () => { console.log('[poi] SIGTERM — exit');  process.exit(0) })
} else {
  console.log('[poi] initial sync abgeschlossen, beende.')
  process.exit(0)
}
