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
//   POI_WIKIPEDIA        Wikipedia-Artikel als eigene Schicht (Default: an;
//                        0/off = aus). Quelle: MediaWiki-GeoSearch, kein Key.
//   POI_WIKI_LANG        Wikipedia-Sprache (Default: de)
//   POI_WIKI_RADIUS_M    Suchradius je Areal in m (Default: 2000, max 10000)
//   POI_WIKI_MAX         Artikel je Areal (Default: 20 — API-Extract-Limit)
//   POI_COMMONS          Commons-Fotos als "Bilder"-Layer (Default: an)
//   POI_COMMONS_MAX      Fotos je Areal nach Clustering (Default: 15, max 50)
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

import { bootAgent, die, envNum, envInt, envBool, envStr, publishManifest } from './lib/agent-base.mjs'
import { AjnaGeo } from '../client/core/AjnaGeo.js'

import { simpleSetup } from './lib/setup-wizard.mjs'

// Login + geschichtete .env (Env > agents/.env.poi > Root-.env) + System-CA.
// Erststart ohne Pflichtwerte (oder --setup): Mini-Wizard fragt sie ab.
const { ajna, url: ajnaUrl } = await bootAgent('poi', {
  setup: simpleSetup('poi', { required: ['AJNA_USER', 'AJNA_PASS'], optional: ['AJNA_URL'] }),
})
const geo = new AjnaGeo(ajna)

const CENTER_LAT = envNum('POI_CENTER_LAT', 50.3569)
const CENTER_LON = envNum('POI_CENTER_LON', 7.5890)
const RADIUS_KM  = envNum('POI_RADIUS_KM', 1)
const FILTER     = envStr('POI_FILTER') || 'common'
// Default kontinuierlich (120 s): die Bridge ist demand-getrieben und muss die
// aktiven Interessensbereiche fortlaufend pollen. Einmal-Sync via POI_REFRESH_S=0.
const REFRESH_MS = envNum('POI_REFRESH_S', 120) * 1000

// Wikipedia-GeoSearch als zweite Quelle: georeferenzierte Artikel als eigene,
// im FilterDialog separat schaltbare Schicht (state.source = "wikipedia").
const WIKI_ON       = envBool('POI_WIKIPEDIA', true)
const WIKI_LANG     = (envStr('POI_WIKI_LANG') || 'de').replace(/[^a-z-]/gi, '')
const WIKI_RADIUS_M = Math.min(10000, envNum('POI_WIKI_RADIUS_M', 2000))  // API-Maximum: 10 km
const WIKI_MAX      = Math.min(20, envInt('POI_WIKI_MAX', 20))            // exlimit (Extracts) deckelt bei 20
// Wikimedia Commons: geo-getaggte Fotos als "Bilder"-Layer derselben Quelle.
const COMMONS_ON    = envBool('POI_COMMONS', true)
const COMMONS_MAX   = Math.min(50, envInt('POI_COMMONS_MAX', 15))   // je Areal; imageinfo-Batch ≤ 50
// Wikimedia-Etikette: aussagekräftiger User-Agent mit Kontakt-Hinweis.
const WIKI_UA       = `ajna-poi-bridge/1.0 (+${ajnaUrl})`

if (RADIUS_KM <= 0) die('Ungültiger Radius')

console.log(`[poi] center: ${CENTER_LAT.toFixed(4)}, ${CENTER_LON.toFixed(4)}  radius: ${RADIUS_KM} km  filter: ${FILTER}`)

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

const layers = FILTER === 'common' ? POI_LAYERS_COMMON : POI_LAYERS_GENERIC
if (await publishManifest(ajna, {
  source: 'overpass',
  agent_name: 'POI-Bridge',
  description: `OSM-POIs (Filter: ${FILTER}) im Radius ${RADIUS_KM} km um ${CENTER_LAT.toFixed(3)}, ${CENTER_LON.toFixed(3)}`,
  layers
})) console.log(`[ajna] manifest aktualisiert (${layers.length} Layer)`)

// Zweites Manifest: Wikipedia als eigene Quelle → eigener Schalter + eigene
// Interest-Areas (Spieler können OSM-POIs und Wikipedia getrennt einblenden).
if (WIKI_ON && await publishManifest(ajna, {
  source: 'wikipedia',
  agent_name: 'Wikipedia',
  description: `Wikipedia-Artikel (${WIKI_LANG}) und Commons-Fotos mit Geo-Koordinaten in deiner Umgebung`,
  layers: [
    { key: 'all',      label: 'Alles',    predicate: null },
    { key: 'articles', label: 'Artikel',  predicate: { field: 'state.wiki_kind', equals: 'article' } },
    { key: 'images',   label: 'Bilder',   predicate: { field: 'state.wiki_kind', equals: 'image' } },
  ]
})) console.log('[ajna] wikipedia-manifest aktualisiert')

/**
 * In-Memory-Map: osm_id (z. B. "node/123") → { objectId, name }.
 * Wird beim Boot aus PB gefüllt — Idempotenz garantiert beim Re-Run.
 */
const pois = new Map()
/** pageid (String) → { objectId, name } — Wikipedia-Artikel-Objekte. */
const wikis = new Map()
/** Commons-pageid (String) → { objectId, name } — Commons-Foto-Objekte. */
const photos = new Map()

// Beim initialen Sweep filtern wir auf `state.source`, damit das Cleanup
// unten NUR Bridge-managte Objekte anfasst und user-definierte type="poi"-
// Objekte (mit anderer `source`) unangetastet lässt.
try {
  await ajna.refreshObjects()
  for (const obj of ajna.getObjects()) {
    if (obj.type !== 'poi') continue
    if (obj.state?.source === 'overpass' && obj.state?.osm_id) {
      pois.set(String(obj.state.osm_id), { objectId: obj.id, name: obj.name })
    } else if (obj.state?.source === 'wikipedia' && obj.state?.commons_id != null) {
      photos.set(String(obj.state.commons_id), { objectId: obj.id, name: obj.name })
    } else if (obj.state?.source === 'wikipedia' && obj.state?.wiki_id != null) {
      wikis.set(String(obj.state.wiki_id), { objectId: obj.id, name: obj.name })
    }
  }
  console.log(`[ajna] Bestand geladen: ${pois.size} Overpass-POIs, ${wikis.size} Wikipedia-Artikel, ${photos.size} Commons-Fotos`)
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
  let errors = 0
  for (const t of targets) {
    try {
      const res = await geo.poisNear(t.lat, t.lon, t.radiusM, FILTER)
      for (const f of (res.features || [])) if (f.id) byId.set(f.id, f)
    } catch (err) {
      errors++
      console.warn(`[poi] fetch @${t.lat.toFixed(4)},${t.lon.toFixed(4)}: ${err?.message || err}`)
    }
  }
  return {
    features: Array.from(byId.values()), errors,
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
  // Kompletter Fehlschlag (z. B. Geo-API down) → Bestand NICHT abräumen,
  // sonst löscht ein API-Schluckauf alle POIs, die danach neu angelegt würden.
  if (!features.length && result.errors) return

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
//  Wikipedia (GeoSearch): Artikel mit Koordinaten rund um die aktiven
//  Interessensbereiche. Ein Request pro Areal liefert Seiten inkl. Intro-
//  Extract (3 Sätze) und URL — kein API-Key nötig.
// ───────────────────────────────────────────────────────────────────────

// Gemeinsame Ziel-Ermittlung für Artikel UND Fotos (eine Quelle "wikipedia").
async function wikiTargets() {
  let areas = []
  try { areas = await ajna.fetchInterestAreas('wikipedia') }
  catch (err) { console.warn(`[wiki] interest-areas: ${err?.message || err} → Fallback Zentrum`) }
  return {
    targets: areas.length
      ? areas.map(bboxToTarget)
      : [{ lat: CENTER_LAT, lon: CENTER_LON, radiusM: Math.round(RADIUS_KM * 1000) }],
    source: areas.length ? `interest-areas (${areas.length})` : 'center',
  }
}

async function fetchWikipedia() {
  const { targets, source } = await wikiTargets()
  const byId = new Map()
  let errors = 0
  for (const t of targets) {
    // Fester Suchradius (WIKI_RADIUS_M) um das Areal-Zentrum — Artikel sind
    // dünn gesät, der kleine Interessens-Areal-Radius wäre meist leer.
    const radius = Math.max(100, Math.min(10000, WIKI_RADIUS_M))
    const params = new URLSearchParams({
      action: 'query', format: 'json',
      generator: 'geosearch',
      ggscoord: `${t.lat}|${t.lon}`, ggsradius: String(radius), ggslimit: String(WIKI_MAX),
      prop: 'extracts|coordinates|info',
      exintro: '1', explaintext: '1', exsentences: '3', exlimit: 'max',
      colimit: 'max', inprop: 'url',
    })
    try {
      const r = await fetch(`https://${WIKI_LANG}.wikipedia.org/w/api.php?${params}`, {
        headers: { 'User-Agent': WIKI_UA } })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      for (const p of Object.values(data?.query?.pages || {})) {
        const co = Array.isArray(p.coordinates) ? p.coordinates[0] : null
        if (!co || !Number.isFinite(co.lat) || !Number.isFinite(co.lon)) continue
        byId.set(String(p.pageid), p)
      }
    } catch (err) {
      errors++
      console.warn(`[wiki] fetch @${t.lat.toFixed(4)},${t.lon.toFixed(4)}: ${err?.message || err}`)
    }
  }
  return { pages: Array.from(byId.values()), errors, source }
}

async function syncWikipedia() {
  if (!WIKI_ON) return
  let result
  try { result = await fetchWikipedia() }
  catch (err) { console.warn(`[wiki] fetch fehlgeschlagen: ${err?.message || err}`); return }

  const pages = result.pages
  console.log(`[wiki] ${pages.length} Artikel aus Wikipedia (source: ${result.source})`)
  // Kompletter Fehlschlag → Bestand NICHT abräumen (sonst löscht ein API-
  // Schluckauf alle Artikel, die im nächsten Zyklus neu angelegt würden).
  if (!pages.length && result.errors) return

  // Cleanup wie bei Overpass: verwaltete Artikel, die nicht mehr im aktuellen
  // Ergebnis auftauchen (Areal gewandert, Artikel umgezogen), entfernen.
  const current = new Set(pages.map(p => String(p.pageid)))
  let deleted = 0
  for (const [pid, w] of wikis) {
    if (current.has(pid)) continue
    try {
      await ajna.deleteObject(w.objectId)
      wikis.delete(pid)
      deleted++
      console.log(`[wiki] − ${w.name} (${pid})`)
    } catch (err) {
      console.warn(`[wiki] cleanup ${pid} fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`)
    }
  }

  let created = 0, skipped = 0, failed = 0
  for (const p of pages) {
    const pid = String(p.pageid)
    if (wikis.has(pid)) { skipped++; continue }
    const co = p.coordinates[0]
    // objects.name ist auf 32 Zeichen begrenzt — lange Artikel-Titel kürzen
    // (der volle Titel steht ohnehin am Anfang des Extracts/der URL).
    const title = (p.title || `Wikipedia ${pid}`).trim()
    const name = title.length > 32 ? `${title.slice(0, 31)}…` : title
    const extract = (p.extract || '').trim().replace(/\s+/g, ' ')
    const short = extract.length > 400 ? `${extract.slice(0, 397)}…` : extract
    const url = p.fullurl || `https://${WIKI_LANG}.wikipedia.org/?curid=${pid}`
    try {
      const obj = await ajna.createObject({
        name,
        type: 'poi',
        description: short ? `${short}\n${url}` : url,
        lat: co.lat, lon: co.lon, altitude: 0,
        appearance: { emoji: '📖' },
        state: { source: 'wikipedia', wiki_kind: 'article', wiki_id: p.pageid, wiki_lang: WIKI_LANG, url }
      })
      wikis.set(pid, { objectId: obj.id, name })
      created++
      console.log(`[wiki] + ${name} → ${obj.id}`)
    } catch (err) {
      failed++
      console.warn(`[wiki] create ${pid} fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`)
    }
  }
  console.log(`[wiki] ${created} neu, ${skipped} bereits vorhanden, ${deleted} entfernt, ${failed} Fehler — Bestand: ${wikis.size}`)
}

// ───────────────────────────────────────────────────────────────────────
//  Wikimedia Commons: geo-getaggte Fotos als "Bilder"-Layer. Zweistufig:
//  billige geosearch-Liste (Titel+Koordinaten) → JPEG-Filter + Standort-
//  Clustering → imageinfo (Thumb-URL + Beschreibung) NUR für die Auswahl.
// ───────────────────────────────────────────────────────────────────────

const stripHtml = (h) => String(h || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim()

async function fetchCommons() {
  const { targets, source } = await wikiTargets()
  const radius = Math.max(100, Math.min(10000, WIKI_RADIUS_M))
  const byId = new Map()
  let errors = 0
  for (const t of targets) {
    try {
      // Schritt 1: Titel+Koordinaten. WICHTIG gsprimary=all — viele Fotos
      // tragen ihre Koordinate als Typ "object", nicht als primary (so fand
      // die Default-Suche z. B. das Hexen-Mahnmal Heimbach-Weis NICHT).
      const p1 = new URLSearchParams({
        action: 'query', format: 'json', list: 'geosearch',
        gscoord: `${t.lat}|${t.lon}`, gsradius: String(radius), gslimit: '500',
        gsnamespace: '6', gsprimary: 'all',
      })
      const r1 = await fetch(`https://commons.wikimedia.org/w/api.php?${p1}`, { headers: { 'User-Agent': WIKI_UA } })
      if (!r1.ok) throw new Error(`HTTP ${r1.status}`)
      const d1 = await r1.json()
      // Nur echte Fotos (JPEG) — Orthophoto-/Karten-Kacheln sind PNGs und
      // würden die Welt fluten. Foto-Serien am selben Standort (~11 m Raster)
      // auf EIN Objekt clustern.
      const jpgs = (d1?.query?.geosearch || []).filter(f => /\.jpe?g$/i.test(f.title))
      const clusters = new Map()
      for (const f of jpgs) {
        const key = `${f.lat.toFixed(4)},${f.lon.toFixed(4)}`
        if (!clusters.has(key)) clusters.set(key, f)
      }
      const picked = Array.from(clusters.values()).slice(0, COMMONS_MAX)
      if (!picked.length) continue
      // Schritt 2: Bild-URL + Beschreibung nur für die Auswahl.
      const p2 = new URLSearchParams({
        action: 'query', format: 'json', pageids: picked.map(f => f.pageid).join('|'),
        prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '640',
        iiextmetadatalanguage: WIKI_LANG,
      })
      const r2 = await fetch(`https://commons.wikimedia.org/w/api.php?${p2}`, { headers: { 'User-Agent': WIKI_UA } })
      if (!r2.ok) throw new Error(`HTTP ${r2.status}`)
      const d2 = await r2.json()
      // Schritt 3: Structured-Data-Captions (MediaInfo-Labels) — DAS sind die
      // menschenlesbaren Namen ("Wegekreuz (Lindenstraße, …)"); der extmetadata-
      // ObjectName ist meist nur der Dateiname.
      let labels = {}
      try {
        const p3 = new URLSearchParams({
          action: 'wbgetentities', format: 'json',
          ids: picked.map(f => `M${f.pageid}`).join('|'), props: 'labels',
        })
        const r3 = await fetch(`https://commons.wikimedia.org/w/api.php?${p3}`, { headers: { 'User-Agent': WIKI_UA } })
        if (r3.ok) labels = (await r3.json())?.entities || {}
      } catch { /* Captions sind nice-to-have — Dateiname bleibt Fallback */ }
      for (const f of picked) {
        const l = labels[`M${f.pageid}`]?.labels || {}
        byId.set(String(f.pageid), {
          ...f,
          info: d2?.query?.pages?.[f.pageid]?.imageinfo?.[0],
          caption: l[WIKI_LANG]?.value || l.en?.value || null,
        })
      }
    } catch (err) {
      errors++
      console.warn(`[fotos] fetch @${t.lat.toFixed(4)},${t.lon.toFixed(4)}: ${err?.message || err}`)
    }
  }
  return { files: Array.from(byId.values()), errors, source }
}

async function syncCommons() {
  if (!COMMONS_ON) return
  let result
  try { result = await fetchCommons() }
  catch (err) { console.warn(`[fotos] fetch fehlgeschlagen: ${err?.message || err}`); return }

  const files = result.files
  console.log(`[fotos] ${files.length} Commons-Fotos (source: ${result.source})`)
  // Kompletter Fehlschlag → Bestand nicht abräumen (wie bei Overpass/Artikeln).
  if (!files.length && result.errors) return

  const current = new Set(files.map(f => String(f.pageid)))
  let deleted = 0
  for (const [pid, ph] of photos) {
    if (current.has(pid)) continue
    try {
      await ajna.deleteObject(ph.objectId)
      photos.delete(pid)
      deleted++
      console.log(`[fotos] − ${ph.name} (${pid})`)
    } catch (err) {
      console.warn(`[fotos] cleanup ${pid} fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`)
    }
  }

  let created = 0, skipped = 0, failed = 0
  for (const f of files) {
    const pid = String(f.pageid)
    if (photos.has(pid)) { skipped++; continue }
    const fileTitle = String(f.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').trim()
    // Name: Structured-Data-Caption zuerst — der Dateiname ist nur Fallback.
    const title = (f.caption || fileTitle || `Foto ${pid}`).trim()
    const name = title.length > 32 ? `${title.slice(0, 31)}…` : title
    const info = f.info
    const desc = stripHtml(info?.extmetadata?.ImageDescription?.value)
    const artist = stripHtml(info?.extmetadata?.Artist?.value)
    const pageUrl = info?.descriptionurl || `https://commons.wikimedia.org/?curid=${pid}`
    const short = desc.length > 300 ? `${desc.slice(0, 297)}…` : desc
    const lines = []
    if (f.caption) lines.push(f.caption)              // volle Caption (Name ist ggf. gekürzt)
    if (short && short !== f.caption) lines.push(short)
    if (!lines.length) lines.push(title)
    if (artist) lines.push(`Foto: ${artist.slice(0, 80)}`)
    lines.push(pageUrl)
    // Bildtafel-Appearance: Maße aus dem Thumb-Seitenverhältnis, längste
    // Kante 1,2 m; auf der Karte Popup-Thumbnail, in AR Foto-Plane.
    const thumb = info?.thumburl || null
    const tw = Number(info?.thumbwidth), th = Number(info?.thumbheight)
    const ratio = tw > 0 && th > 0 ? th / tw : 0.75
    const wM = ratio <= 1 ? 1.2 : Math.round(120 / ratio) / 100
    const hM = ratio <= 1 ? Math.round(120 * ratio) / 100 : 1.2
    try {
      const obj = await ajna.createObject({
        name,
        type: 'poi',
        description: lines.filter(Boolean).join('\n'),
        lat: f.lat, lon: f.lon, altitude: 0,
        appearance: thumb
          ? { emoji: '📷', shape: 'image', texture: thumb, width: wM, height: hM, y: 1.4 }
          : { emoji: '📷' },
        state: {
          source: 'wikipedia', wiki_kind: 'image', commons_id: f.pageid,
          url: pageUrl, image: thumb || info?.url || null,
        }
      })
      photos.set(pid, { objectId: obj.id, name })
      created++
      console.log(`[fotos] + ${name} → ${obj.id}`)
    } catch (err) {
      failed++
      console.warn(`[fotos] create ${pid} fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`)
    }
  }
  console.log(`[fotos] ${created} neu, ${skipped} bereits vorhanden, ${deleted} entfernt, ${failed} Fehler — Bestand: ${photos.size}`)
}

// ───────────────────────────────────────────────────────────────────────
//  Start
// ───────────────────────────────────────────────────────────────────────

await syncPois()
await syncWikipedia()
await syncCommons()

if (REFRESH_MS > 0) {
  console.log(`[poi] refresh: alle ${(REFRESH_MS / 1000).toFixed(0)} s`)
  setInterval(() => {
    syncPois().catch(err => console.warn(`[poi] refresh error: ${err?.message || err}`))
    syncWikipedia().catch(err => console.warn(`[wiki] refresh error: ${err?.message || err}`))
    syncCommons().catch(err => console.warn(`[fotos] refresh error: ${err?.message || err}`))
  }, REFRESH_MS)
  // SIGINT/SIGTERM übernimmt bootAgent.
} else {
  console.log('[poi] initial sync abgeschlossen, beende.')
  process.exit(0)
}
