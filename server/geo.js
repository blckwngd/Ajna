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
//   AJNA_GEO_TTL_MS    Cache-TTL in ms (Default 43200000 = 12 h)
//   AJNA_GEO_OVERPASS  Overpass-URL (Default: https://overpass-api.de/api/interpreter)
//   AJNA_GEO_CACHE_DIR Ablage des Platten-Caches (Default: .cache/geo im Projekt)
//   AJNA_GEO_CACHE_MAX Höchstzahl Dateien im Platten-Cache (Default 4000)
//
// Cache-Strategie (die öffentlichen Overpass-Instanzen sind unzuverlässig und
// zeitweise minutenlang nicht erreichbar):
//   1. Speicher-Cache   — schnellster Weg, überlebt keinen Neustart
//   2. Platten-Cache    — überlebt Neustarts; im Betrieb startet der Server
//                         sonst nach jedem Deploy wieder mit leerem Cache
//   3. Notnagel         — schlägt Overpass fehl, wird ein ABGELAUFENER Eintrag
//                         ausgeliefert statt eines 502. Gebäude und Straßen
//                         ändern sich in Stunden nicht; eine alte Kulisse ist
//                         allemal besser als gar keine.
//   4. Bündelung        — gleiche Anfrage mehrfach parallel (Client + Agents)
//                         läuft als EIN Overpass-Aufruf
//
// Filter sind serverseitig **vordefiniert** (keine freie Overpass-QL-
// Durchreichung) — vermeidet Injection und hält die Cache-Key-Vielfalt
// im Griff. Neue Filter erweitern wir hier zentral im FILTER_SETS-Objekt.

import PocketBase from 'pocketbase'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Overpass-Endpunkte in Reihenfolge: erster Treffer gewinnt, bei Ausfall/
// Rate-Limit (429/504/Netzfehler) wird der nächste probiert. Die öffentliche
// Haupt-Instanz drosselt pro IP spürbar, sobald mehrere Agents parallel
// abfragen (Director-Routing + POI-Bridge + Kulisse) — dann rettet ein
// Spiegel die Szene. Eigene Instanz via AJNA_GEO_OVERPASS setzen (überschreibt
// die Liste komplett).
const OVERPASS_URLS = (process.env.AJNA_GEO_OVERPASS
  ? [process.env.AJNA_GEO_OVERPASS]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
    ])
const OVERPASS_URL = OVERPASS_URLS[0]   // für /status + Logs
// Freie Spiegel sind unter Last LANGSAM (gemessen: 37 s für eine Gebäude-
// Abfrage im 300-m-Radius) — der Timeout muss das aushalten.
const OVERPASS_TIMEOUT_MS = parseInt(process.env.AJNA_GEO_TIMEOUT_MS || '90000', 10)
// Ausgefallene Endpunkte für eine Weile überspringen. Ohne das liefe JEDE
// Anfrage erst in den Timeout des toten Servers (real erlebt: overpass-api.de
// sperrt nach zu vielen Anfragen die IP auf TCP-Ebene — keine 429-Antwort
// mehr, nur noch Verbindungs-Timeouts).
const OVERPASS_COOLDOWN_MS = parseInt(process.env.AJNA_GEO_COOLDOWN_MS || '300000', 10)
const overpassDown = new Map()   // url → Zeitpunkt, ab dem wieder probiert wird
// 12 h statt 1 h: Gebäude, Straßen und POIs ändern sich in Monaten, nicht in
// Stunden. Die kurze Frist kostete nur Anfragen an ohnehin überlastete
// Fremdserver — und schickte den Client bei deren Ausfall auf eine leere Ebene.
const CACHE_TTL_MS = parseInt(process.env.AJNA_GEO_TTL_MS || '43200000', 10)
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
    all:      'way["highway"]',
    // Gewässer als Linien (Fluss-Mittellinie, Bäche, Kanäle) — Orientierungs-
    // anker Nr. 1 in der 3D-Ansicht. Flächen (natural=water) blieben außen vor:
    // Polygon-Triangulierung bräuchte earcut als zusätzliche Abhängigkeit.
    water:    'way["waterway"~"^(river|stream|canal|drain|ditch)$"]',
    // Schienen getrennt abrufbar (andere Darstellung als Straßen).
    rail:     'way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge)$"]'
  },
  pois: {
    common:   'node["amenity"~"^(bench|cafe|restaurant|bar|fast_food|fountain|drinking_water|pub|toilets)$"]',
    amenity:  'node["amenity"]',
    shops:    'node["shop"]',
    tourism:  'node["tourism"]',
    // Funk-/Sendemasten: Mobilfunk, Rundfunk, Richtfunk. Fasst Masten
    // (man_made=mast) UND Türme (man_made=tower) mit Kommunikations-Zweck
    // zusammen; "communication" deckt auch Rundfunktürme ab.
    masts:    'nwr["man_made"~"^(mast|tower|communications_tower)$"]["tower:type"~"communication",i]'
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

/**
 * Passt eine bereits gespeicherte, WEITERE Antwort derselben Gegend?
 *
 * Gesucht wird im Speicher-Cache: gleicher Endpunkt, gleicher Filter, gleiche
 * Raster-Zelle, Radius mindestens so groß wie der angefragte — und noch frisch.
 * Von mehreren passenden gewinnt der kleinste, damit nicht unnötig viel Geometrie
 * zurückgeht.
 */
function groessererTreffer(endpoint, params) {
  const praefix = `${endpoint}|${params.lat.toFixed(3)}|${params.lon.toFixed(3)}|`
  // Ein WEITER gefasster Filter enthält den engeren. Der Client zeichnet die
  // Kulisse mit „all", der Director plant mit „walkable" — bisher zwei
  // getrennte Overpass-Abfragen für dieselbe Straße. Jetzt reicht eine, und die
  // engere Sicht wird hier herausgeschnitten.
  const kandidaten = [params.filter, ...(BREITER[endpoint]?.[params.filter] || [])]
  let beste = null
  for (const [k, eintrag] of cache) {
    if (!k.startsWith(praefix)) continue
    if ((Date.now() - eintrag.ts) > CACHE_TTL_MS) continue
    const rest = k.slice(praefix.length)
    const i = rest.lastIndexOf('|')
    if (i < 0) continue
    const r = Number(rest.slice(0, i))
    const f = rest.slice(i + 1)
    if (!Number.isFinite(r) || r < params.radius) continue
    if (!kandidaten.includes(f)) continue
    // Gleicher Filter gewinnt vor einem weiteren; sonst der kleinste Radius.
    const rang = f === params.filter ? 0 : 1
    if (!beste || rang < beste.rang || (rang === beste.rang && r < beste.radius)) {
      beste = { radius: r, rang, filter: f, payload: eintrag.payload }
    }
  }
  if (!beste) return null
  if (beste.filter === params.filter) return beste
  const eng = ENGER[endpoint]?.[params.filter]
  if (!eng) return null
  return { ...beste, payload: { ...beste.payload, features: (beste.payload.features || []).filter(eng) } }
}

/** Welcher gespeicherte Filter enthält den angefragten? */
const BREITER = {
  ways: { walkable: ['all'] },
}

/** Wie man aus dem weiteren Satz den engeren herausschneidet. */
const ENGER = {
  ways: {
    walkable: (f) => /^(footway|path|pedestrian|residential|service|living_street|cycleway|track|unclassified|tertiary)$/
      .test(String(f?.tags?.highway || '')),
  },
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
  const eintrag = { ts: Date.now(), payload }
  cache.set(key, eintrag)
  // simple Size-Cap, evictet ältesten Eintrag
  if (cache.size > 500) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
  plattePut(key, eintrag)   // fire and forget
}

// ───────────────────────────────────────────────────────────────────────
//  Platten-Cache
// ───────────────────────────────────────────────────────────────────────
// Warum überhaupt: Der Speicher-Cache ist nach jedem Neustart leer, und im
// Entwicklungsbetrieb startet der Server oft. Danach lief jede erste Anfrage
// wieder in die Wartezeiten der öffentlichen Overpass-Instanzen — bei deren
// aktueller Verfassung minutenlang oder gar nicht. Die Antworten sind ein paar
// hundert Kilobyte und ändern sich in Monaten kaum; sie gehören auf Platte.

const HIER = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = process.env.AJNA_GEO_CACHE_DIR || join(HIER, '..', '.cache', 'geo')
const CACHE_MAX_DATEIEN = parseInt(process.env.AJNA_GEO_CACHE_MAX || '4000', 10)

const dateiFuer = (key) => join(CACHE_DIR, createHash('sha1').update(key).digest('hex') + '.json')

/**
 * Eintrag von Platte lesen — OHNE Ablauf-Prüfung. Die macht der Aufrufer:
 * frisch wird normal ausgeliefert, abgelaufen dient als Notnagel.
 * @returns {{ts:number, payload:object}|null}
 */
async function plattenGet(key) {
  try {
    const roh = await readFile(dateiFuer(key), 'utf8')
    const e = JSON.parse(roh)
    return (e && Number.isFinite(e.ts) && e.payload) ? e : null
  } catch { return null }   // nicht vorhanden oder kaputt — beides „kein Treffer"
}

let _aufraeumen = 0
async function plattePut(key, eintrag) {
  try {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(dateiFuer(key), JSON.stringify(eintrag), 'utf8')
  } catch (err) {
    console.warn(`[geo] Platten-Cache nicht schreibbar: ${err?.message || err}`)
    return
  }
  // Nicht bei jedem Schreiben aufräumen — jede 50. Ablage reicht.
  if (++_aufraeumen % 50 !== 0) return
  try {
    const dateien = await readdir(CACHE_DIR)
    if (dateien.length <= CACHE_MAX_DATEIEN) return
    const mitAlter = await Promise.all(dateien.map(async f => {
      try { return { f, t: (await stat(join(CACHE_DIR, f))).mtimeMs } } catch { return null }
    }))
    const sortiert = mitAlter.filter(Boolean).sort((a, b) => a.t - b.t)
    for (const { f } of sortiert.slice(0, sortiert.length - CACHE_MAX_DATEIEN)) {
      await unlink(join(CACHE_DIR, f)).catch(() => {})
    }
  } catch (err) {
    console.warn(`[geo] Platten-Cache aufräumen: ${err?.message || err}`)
  }
}

// ───────────────────────────────────────────────────────────────────────
//  Bündelung gleichzeitiger Anfragen
// ───────────────────────────────────────────────────────────────────────
// Kulisse, POI-Bridge und Director fragen dieselbe Gegend gern gleichzeitig ab.
// Ohne Bündelung wären das drei Overpass-Aufrufe, die sich gegenseitig ins
// Rate-Limit treiben — und drei Wartezeiten statt einer.
const laufend = new Map()   // key → Promise<osm-JSON>

function overpassGebuendelt(key, ql) {
  const da = laufend.get(key)
  if (da) return da
  const p = overpassQuery(ql).finally(() => laufend.delete(key))
  laufend.set(key, p)
  return p
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
  let lastErr = null
  const now = Date.now()
  // Erst die Endpunkte ohne aktive Sperrfrist; sind alle gesperrt, trotzdem
  // alle probieren (besser ein langsamer Versuch als gar keine Daten).
  const ready = OVERPASS_URLS.filter(u => (overpassDown.get(u) || 0) <= now)
  for (const url of (ready.length ? ready : OVERPASS_URLS)) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':   USER_AGENT
        },
        body: 'data=' + encodeURIComponent(ql),
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS)
      })
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`)
      const j = await r.json()
      overpassDown.delete(url)                 // wieder gesund
      if (url !== OVERPASS_URLS[0]) console.warn(`[geo] Ausweich-Endpunkt genutzt: ${new URL(url).host}`)
      return j
    } catch (err) {
      lastErr = err
      // Nächsten Spiegel probieren — Rate-Limit/Timeout/Netzfehler sind genau
      // die Fälle, für die die Liste existiert. Endpunkt für die Sperrfrist
      // notieren, damit nicht jede Anfrage erneut hineinläuft.
      overpassDown.set(url, Date.now() + OVERPASS_COOLDOWN_MS)
      console.warn(`[geo] Overpass ${new URL(url).host}: ${err?.message || err} — ${OVERPASS_COOLDOWN_MS / 60000} min übersprungen`)
    }
  }
  throw new Error(`Overpass nicht erreichbar (${OVERPASS_URLS.length} Endpunkte): ${lastErr?.message || lastErr}`)
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

  // Platte vor Netz: nach einem Neustart ist der Speicher-Cache leer, die
  // Antworten von gestern liegen aber noch da.
  const vonPlatte = await plattenGet(key)
  if (vonPlatte && (Date.now() - vonPlatte.ts) <= CACHE_TTL_MS) {
    cache.set(key, vonPlatte)
    return res.json({ ...vonPlatte.payload, source: 'cache-disk' })
  }

  // GRÖSSERE ANTWORT WIEDERVERWENDEN.
  //
  // Der Radius steckt im Schlüssel, also verfehlte jede Anfrage mit einem
  // anderen Radius den Zwischenspeicher — auch dann, wenn längst eine WEITERE
  // Antwort derselben Gegend danebenlag. Beobachtet: Der Client zeichnet die
  // Straßen ringsum, und trotzdem lief die Routenplanung des Directors in einen
  // Overpass-Ausfall, weil sie 600 m statt 300 m anfragte.
  //
  // Ein größerer Umkreis ENTHÄLT den kleineren. Die Extra-Elemente am Rand
  // stören niemanden: Die Kulisse zeichnet ohnehin nur, was in Sicht ist, und
  // ein Wegegraph mit ein paar Straßen mehr ist kein Fehler, sondern Auswahl.
  const groesser = groessererTreffer(endpoint, params)
  if (groesser) {
    return res.json({ ...groesser.payload, source: 'cache-weiter', radiusIst: groesser.radius })
  }

  // BBOX statt `around:` — Overpass kann die Bounding-Box direkt über seinen
  // Raum-Index bedienen, während `around:` für jedes Element eine Distanz
  // rechnet. Auf den (überlasteten) öffentlichen Servern ist das der
  // Unterschied zwischen Antwort und 504. Die Ecken der Box liegen bis zu
  // √2·r entfernt — für Kulisse/Kontext unerheblich, der Client zeichnet
  // ohnehin nur, was in Sicht ist.
  const dLat = params.radius / 111320
  const dLon = params.radius / (111320 * Math.cos(params.lat * Math.PI / 180) || 1)
  const bbox = [
    (params.lat - dLat).toFixed(6), (params.lon - dLon).toFixed(6),
    (params.lat + dLat).toFixed(6), (params.lon + dLon).toFixed(6),
  ].join(',')
  const ql = `[out:json][timeout:60];
(
  ${params.filterQL}(${bbox});
);
${outDirective}`

  let osm
  try {
    osm = await overpassGebuendelt(key, ql)
  } catch (err) {
    // Notnagel: lieber alte Daten als eine leere Ebene. Overpass fällt
    // regelmäßig für Minuten aus; Gebäude und Straßen sind derweil unverändert.
    if (vonPlatte) {
      const alterMin = Math.round((Date.now() - vonPlatte.ts) / 60000)
      console.warn(`[geo] Overpass aus — liefere ${alterMin} min alten Cache für ${endpoint}`)
      return res.json({ ...vonPlatte.payload, source: 'cache-stale', staleMinutes: alterMin })
    }
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
