// server/geo.js — Geo-Kontext-API für Ajna
//
// Liefert OSM-Daten (Straßen/Wege, POIs, Gebäude) als aufbereitete
// Features an Clients/Agents. Backend V1: Overpass-API live.
//
// Endpoints (alle unter /ajnaapi/geo/*, gewireted in server/index.js):
//   GET /ways      ?lat=&lon=&radius=&filter=walkable
//   GET /pois      ?lat=&lon=&radius=&filter=common
//   GET /buildings ?lat=&lon=&radius=&filter=all
//
// Konfiguration via Umgebungsvariablen:
//   AJNA_GEO_AUTH      "authenticated" (Default) oder "anonymous"
//   AJNA_GEO_TTL_MS    Cache-TTL in ms (Default 3600000 = 1 h)
//   AJNA_GEO_OVERPASS  Overpass-URL (Default: https://overpass-api.de/api/interpreter)
//
// Filter sind serverseitig **vordefiniert** (keine freie Overpass-QL-
// Durchreichung) — vermeidet Injection und hält die Cache-Key-Vielfalt
// im Griff. Neue Filter erweitern wir hier zentral im FILTER_SETS-Objekt.

import PocketBase from 'pocketbase'

const OVERPASS_URL = process.env.AJNA_GEO_OVERPASS || 'https://overpass-api.de/api/interpreter'
const CACHE_TTL_MS = parseInt(process.env.AJNA_GEO_TTL_MS || '3600000', 10)
const AUTH_MODE    = (process.env.AJNA_GEO_AUTH || 'authenticated').toLowerCase()
const PB_URL       = process.env.AJNA_PB_URL || 'http://127.0.0.1:8090'
const USER_AGENT   = 'Ajna/0.1 (https://github.com/blckwngd/Ajna)'

const MAX_RADIUS_M = 2000          // hard cap — schützt Overpass und uns
const DEFAULT_RADIUS_M = 200

// ───────────────────────────────────────────────────────────────────────
//  Filter-Sets — die einzigen Strings, die in die Overpass-QL gehen
// ───────────────────────────────────────────────────────────────────────

const FILTER_SETS = {
  ways: {
    walkable: 'way["highway"~"^(footway|path|pedestrian|residential|service|living_street|cycleway|track|unclassified|tertiary)$"]',
    all:      'way["highway"]'
  },
  pois: {
    common:   'node["amenity"~"^(bench|cafe|restaurant|bar|fast_food|fountain|drinking_water|pub|toilets)$"]',
    amenity:  'node["amenity"]',
    shops:    'node["shop"]',
    tourism:  'node["tourism"]'
  },
  buildings: {
    all:      'way["building"]'
  }
}

// ───────────────────────────────────────────────────────────────────────
//  In-Memory-Cache
// ───────────────────────────────────────────────────────────────────────

const cache = new Map()   // key → { ts, payload }

function cacheKey(endpoint, lat, lon, radius, filter) {
  // Bucket auf ~110 m: 3 Nachkommastellen Lat/Lon. Anfragen, die nah
  // beieinander liegen und denselben Filter haben, teilen damit den
  // Cache-Eintrag.
  return `${endpoint}|${lat.toFixed(3)}|${lon.toFixed(3)}|${radius}|${filter}`
}

function cacheGet(key) {
  const entry = cache.get(key)
  if (!entry) return null
  if ((Date.now() - entry.ts) > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return entry.payload
}

function cachePut(key, payload) {
  cache.set(key, { ts: Date.now(), payload })
  // simple Size-Cap, evictet ältesten Eintrag
  if (cache.size > 500) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
}

// ───────────────────────────────────────────────────────────────────────
//  Auth
// ───────────────────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  if (AUTH_MODE === 'anonymous') return next()

  const header = req.headers.authorization || ''
  const token = header.replace(/^Bearer\s+/i, '').trim()
  if (!token) return res.status(401).json({ error: 'auth token required' })

  // Token gegen PB validieren via authRefresh. Loopback-Call, sub-ms.
  try {
    const pb = new PocketBase(PB_URL)
    pb.authStore.save(token, null)
    await pb.collection('users').authRefresh()
    req.user = pb.authStore.record
    next()
  } catch (err) {
    return res.status(401).json({ error: 'invalid token' })
  }
}

// ───────────────────────────────────────────────────────────────────────
//  Overpass-Adapter
// ───────────────────────────────────────────────────────────────────────

async function overpassQuery(ql) {
  const r = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':   USER_AGENT
    },
    body: 'data=' + encodeURIComponent(ql)
  })
  if (!r.ok) {
    throw new Error(`Overpass ${r.status}: ${await r.text().catch(() => '')}`)
  }
  return r.json()
}

// OSM-Element → uniformes Feature für die Ajna-API.
// `way` mit geom → coordinates als Polyline. `node` → coordinates als
// einzelner Punkt-Array (damit Consumer einheitlich iterieren können).
function toFeature(el) {
  const tags = el.tags || {}
  const f = {
    id:   `${el.type}/${el.id}`,
    type: el.type,
    name: tags.name || null,
    tags
  }
  if (el.type === 'way' && Array.isArray(el.geometry)) {
    f.coordinates = el.geometry.map(p => [p.lat, p.lon])
  } else if (el.type === 'node') {
    f.coordinates = [[el.lat, el.lon]]
  } else {
    f.coordinates = []
  }
  return f
}

// ───────────────────────────────────────────────────────────────────────
//  Query-Parsing
// ───────────────────────────────────────────────────────────────────────

function parseQuery(req, endpoint, defaultFilter) {
  const lat = parseFloat(req.query.lat)
  const lon = parseFloat(req.query.lon)
  let radius = parseInt(req.query.radius || DEFAULT_RADIUS_M, 10)
  const filter = String(req.query.filter || defaultFilter)

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error('lat fehlt oder ungültig (-90..90)')
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new Error('lon fehlt oder ungültig (-180..180)')
  }
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new Error('radius muss positiv sein')
  }
  if (radius > MAX_RADIUS_M) radius = MAX_RADIUS_M

  const filterSet = FILTER_SETS[endpoint]
  if (!filterSet[filter]) {
    throw new Error(`filter "${filter}" unbekannt für ${endpoint}. ` +
                    `Erlaubt: ${Object.keys(filterSet).join(', ')}`)
  }
  return { lat, lon, radius, filter, filterQL: filterSet[filter] }
}

// ───────────────────────────────────────────────────────────────────────
//  Endpoint-Logik
// ───────────────────────────────────────────────────────────────────────

async function handleQuery(req, res, endpoint, defaultFilter, outDirective = 'out geom;') {
  let params
  try { params = parseQuery(req, endpoint, defaultFilter) }
  catch (err) { return res.status(400).json({ error: err.message }) }

  const key = cacheKey(endpoint, params.lat, params.lon, params.radius, params.filter)
  const hit = cacheGet(key)
  if (hit) return res.json({ ...hit, source: 'cache' })

  const ql = `[out:json][timeout:25];
(
  ${params.filterQL}(around:${params.radius},${params.lat},${params.lon});
);
${outDirective}`

  let osm
  try {
    osm = await overpassQuery(ql)
  } catch (err) {
    return res.status(502).json({ error: `overpass: ${err.message}` })
  }

  const features = (osm.elements || []).map(toFeature)
  const payload = {
    query: { lat: params.lat, lon: params.lon, radius: params.radius, filter: params.filter },
    features,
    source: 'overpass',
    cachedAt: new Date().toISOString()
  }
  cachePut(key, payload)
  res.json(payload)
}

// ───────────────────────────────────────────────────────────────────────
//  Router-Setup für Express
// ───────────────────────────────────────────────────────────────────────

export function mountGeoRoutes(app) {
  app.get('/ajnaapi/geo/ways',      requireAuth, (req, res) => handleQuery(req, res, 'ways',      'walkable'))
  app.get('/ajnaapi/geo/pois',      requireAuth, (req, res) => handleQuery(req, res, 'pois',      'common'))
  app.get('/ajnaapi/geo/buildings', requireAuth, (req, res) => handleQuery(req, res, 'buildings', 'all'))

  // Diagnose-Endpoint: erlaubte Filter pro Endpoint + Konfig anzeigen.
  app.get('/ajnaapi/geo/_info', (req, res) => {
    res.json({
      auth: AUTH_MODE,
      cacheTtlMs: CACHE_TTL_MS,
      overpass: OVERPASS_URL,
      maxRadiusM: MAX_RADIUS_M,
      filters: FILTER_SETS,
      cacheSize: cache.size
    })
  })

  console.log(`[geo] mounted /ajnaapi/geo/* (auth: ${AUTH_MODE}, ttl: ${CACHE_TTL_MS} ms, overpass: ${OVERPASS_URL})`)
}
