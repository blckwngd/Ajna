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
//   POI_NATURDENKMAL     Naturdenkmale als eigene Quelle (Default: an; 0/off = aus).
//                        Quelle: die Wikipedia-Gemeindelisten. Die Gemeinde wird
//                        aus den aktiven Arealen rueckwaerts-geokodiert.
//   POI_ND_CACHE_H       Haltbarkeit der Denkmallisten in Stunden (Default: 168)
//   POI_CACHE_H          Haltbarkeit der Overpass-Antworten in Stunden (Default: 6)
//   POI_WIKI_CACHE_H     Haltbarkeit von Artikeln und Fotos (Default: 24)
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

import { bootAgent, die, envNum, envInt, envBool, envStr, publishManifest, ladeBestand } from './lib/agent-base.mjs'
import { AjnaGeo } from '../client/core/AjnaGeo.js'

import { simpleSetup } from './lib/setup-wizard.mjs'
import { Quellcache } from './lib/quellcache.mjs'
import * as nd from './lib/denkmale.mjs'

// Login + geschichtete .env (Env > agents/.env.poi > Root-.env) + System-CA.
// Erststart ohne Pflichtwerte (oder --setup): Mini-Wizard fragt sie ab.
const { ajna, url: ajnaUrl } = await bootAgent('poi', {
  setup: simpleSetup('poi', { required: ['AJNA_USER', 'AJNA_PASS'], optional: ['AJNA_URL'] }),
})
const geo = new AjnaGeo(ajna)

const CENTER_LAT = envNum('POI_CENTER_LAT', 50.3569)
const CENTER_LON = envNum('POI_CENTER_LON', 7.5890)
const RADIUS_KM  = envNum('POI_RADIUS_KM', 1)
// MEHRERE FILTERSAETZE, kommagetrennt. Frueher genau einer — damit waren
// Wegekreuze, Ruinen und Quellen unerreichbar, obwohl sie in OSM stehen.
const FILTER     = envStr('POI_FILTER') || 'common,historic,natur'
const FILTER_LISTE = FILTER.split(',').map(x => x.trim()).filter(Boolean)

// ── Zwischenspeicher ────────────────────────────────────────────────────
// Diese Brücke fragte BISHER alle 120 s alles neu ab — auch Wikipedia und
// Commons. Artikel und Fotos ändern sich nicht im Zwei-Minuten-Takt; das waren
// je Areal rund 700 Anfragen am Tag gegen fremde Dienste, ohne Gegenwert.
//
// Overpass läuft ohnehin über den Ajna-Server, der selbst zwischenspeichert.
// Zwei Dinge kann aber nur der Agent: die Antwort über einen NEUSTART hinweg
// behalten und beim Ausfall des Servers den letzten guten Stand ausliefern —
// sonst verschwinden die POIs bei jedem Schluckauf aus der Welt.
const cache = new Quellcache('poi', {
  ttlMs: envNum('POI_CACHE_H', 6) * 3600_000,
})
const WIKI_CACHE_MS = envNum('POI_WIKI_CACHE_H', 24) * 3600_000

// Schlüssel und Abfrage müssen auf DASSELBE Raster: Interessensbereiche wandern
// mit dem Spieler, und ein Schlüssel, der sich bei jedem Schritt ändert, trifft
// nie. 3 Nachkommastellen ≈ 110 m — bei Suchradien von 1–2 km belanglos.
const raster = (v) => Math.round(v * 1000) / 1000
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

// Naturdenkmale als DRITTE Quelle. Warum nicht über die GeoSearch nebenan:
// Die findet nur Artikel mit eigenen Koordinaten, und Naturdenkmale sind
// Zeilen in Gemeindelisten. Begründung und Messwerte in lib/denkmale.mjs.
const ND_ON        = envBool('POI_NATURDENKMAL', true)
// Diese Listen ändern sich im Jahresrhythmus, nicht im Stundentakt — eine
// Woche Haltbarkeit ist grosszuegig und trotzdem sparsam.
const ND_CACHE_MS  = envNum('POI_ND_CACHE_H', 168) * 3600_000
// Getrennter Vorrat je Quelle: Ein Zeitablauf bei Wikipedia darf die
// Geokodierung nicht mitsperren — dieselbe Lehre wie beim Adress-Agenten.
const ndCache      = new Quellcache('denkmal', { ttlMs: ND_CACHE_MS })
// Nominatim verlangt höflichen Abstand; eine Sekunde ist die Hausnummer.
const ortCache     = new Quellcache('denkmal-orte', { ttlMs: 30 * 24 * 3600_000, minAbstandMs: 1100 })

if (RADIUS_KM <= 0) die('Ungültiger Radius')

console.log(`[poi] center: ${CENTER_LAT.toFixed(4)}, ${CENTER_LON.toFixed(4)}  radius: ${RADIUS_KM} km  filter: ${FILTER}`)

// ───────────────────────────────────────────────────────────────────────
//  Agent-Manifest publishen — der Client zeigt die Layer im FilterDialog
//  als Checkboxen. Die Layer-Auswahl entspricht den Untergruppen, die
//  der serverseitige `common`-Filter in server/geo.js enthält. Für andere
//  POI_FILTER-Modes kommen Layer-Schemas später dazu.
// ───────────────────────────────────────────────────────────────────────

// GRUPPIERT STATT EINZELN. Fünf Schalter für Café, Restaurant, Bar, Pub und
// Imbiss beantworten eine Frage, die niemand stellt — wer Gastronomie ausblendet,
// meint alle fünf. Der Dialog wird dadurch lesbar, und die Untergruppen stehen
// weiterhin in `state.osm_tags`, falls sie je wieder gebraucht werden.
const POI_LAYERS_COMMON = [
  { key: 'all',    label: 'Alle POIs', predicate: null },
  { key: 'food', label: 'Gastronomie',
    predicate: { field: 'state.osm_tags.amenity', oneOf: ['cafe', 'restaurant', 'bar', 'pub', 'fast_food'] } },
  { key: 'rest',   label: 'Rasten & Wasser',
    predicate: { field: 'state.osm_tags.amenity', oneOf: ['bench', 'fountain', 'drinking_water'] } },
  { key: 'toilets', label: 'Toiletten',
    predicate: { field: 'state.osm_tags.amenity', equals: 'toilets' } },
  // Historisches und Landschaft kommen aus eigenen Filtersaetzen (server/geo.js)
  // und tragen andere Etiketten als `amenity` — deshalb `exists` statt `equals`.
  { key: 'historic', label: 'Historisches',
    predicate: { field: 'state.osm_tags.historic', exists: true } },
  { key: 'nature', label: 'Quellen & Aussicht',
    predicate: { field: 'state.osm_group', equals: 'nature' } },
]

// Für andere FILTER-Modi (amenity / shops / tourism) bieten wir vorerst
// nur den "all"-Layer an — feinere Aufschlüsselung kann pro Filter-Set
// nach Bedarf dazukommen.
const POI_LAYERS_GENERIC = [
  { key: 'all', label: 'Alle POIs', predicate: null }
]

// Nicht `FILTER === 'common'`: Seit mehrere Saetze erlaubt sind, heisst die
// Einstellung „common,historic,natur" — der Gleichheitsvergleich traf nicht
// mehr, und das Manifest fiel auf die eine Sammelschicht zurueck.
const layers = FILTER_LISTE.includes('common') ? POI_LAYERS_COMMON : POI_LAYERS_GENERIC
if (await publishManifest(ajna, {
  source: 'overpass',
  agent_name: 'POI-Bridge',
  // POIs sind dicht und ortsfest — jenseits von ein paar hundert Metern sind
  // sie Rauschen, nicht Information.
  render_range_m: envNum('POI_RANGE_M', 400),
  description: `OSM-POIs (Filter: ${FILTER}) im Radius ${RADIUS_KM} km um ${CENTER_LAT.toFixed(3)}, ${CENTER_LON.toFixed(3)}`,
  layers
})) console.log(`[ajna] manifest aktualisiert (${layers.length} Layer)`)

// Zweites Manifest: Wikipedia als eigene Quelle → eigener Schalter + eigene
// Interest-Areas (Spieler können OSM-POIs und Wikipedia getrennt einblenden).
if (WIKI_ON && await publishManifest(ajna, {
  source: 'wikipedia',
  agent_name: 'Wikipedia',
  render_range_m: envNum('POI_WIKI_RANGE_M', 800),
  description: `Wikipedia-Artikel (${WIKI_LANG}) und Commons-Fotos mit Geo-Koordinaten in deiner Umgebung`,
  layers: [
    { key: 'all',      label: 'Alles',    predicate: null },
    { key: 'articles', label: 'Artikel',  predicate: { field: 'state.wiki_kind', equals: 'article' } },
    { key: 'images',   label: 'Bilder',   predicate: { field: 'state.wiki_kind', equals: 'image' } },
  ]
})) console.log('[ajna] wikipedia-manifest aktualisiert')

// Drittes Manifest: DENKMAELER als eigene Quelle — Natur- und Kulturdenkmale
// unter einem Schalter, getrennt in Schichten. Eigene Quelle, weil Auftraege
// und Figuren gezielt darauf zugreifen sollen, ohne POIs mitzuziehen.
//
// ERLOSCHENE ALS EIGENE SCHICHT: Wer „geschuetzt" waehlt, soll nur bekommen, was
// es auch ist. Aufgehobene Denkmale bleiben verfuegbar (oft noch beeindruckende
// Baeume), aber niemand bekommt sie ungefragt als geschuetzt angezeigt.
//
// SICHTWEITE: Kulturdenkmaeler sind DICHT — 179 allein in Neuwied. Ohne eigene
// Grenze muesste man den globalen Regler so weit zudrehen, dass Flugzeuge und
// Schiffe mit verschwinden. 500 m sind fussgaengig und halten das Bild frei.
if (ND_ON && await publishManifest(ajna, {
  source: 'denkmal',
  agent_name: 'Denkmäler',
  description: 'Natur- und Kulturdenkmäler aus den Wikipedia-Gemeindelisten',
  render_range_m: envNum('POI_DM_RANGE_M', 500),
  layers: [
    { key: 'all',        label: 'Alle',              predicate: null },
    { key: 'nature',     label: 'Naturdenkmale',     predicate: { field: 'state.monument_kind', equals: 'nature' } },
    { key: 'cultural',   label: 'Kulturdenkmäler',   predicate: { field: 'state.monument_kind', equals: 'cultural' } },
    // „Stolperstein" bleibt ein Eigenname — auch im Englischen.
    { key: 'stolperstein', label: 'Stolpersteine',   predicate: { field: 'state.monument_kind', equals: 'stolperstein' } },
    { key: 'protected',  label: 'Nur geschützte',    predicate: { field: 'state.monument_revoked', equals: false } },
    { key: 'revoked',    label: 'Schutz aufgehoben', predicate: { field: 'state.monument_revoked', equals: true } },
  ]
})) console.log('[ajna] denkmal-manifest aktualisiert')

/**
 * In-Memory-Map: osm_id (z. B. "node/123") → { objectId, name }.
 * Wird beim Boot aus PB gefüllt — Idempotenz garantiert beim Re-Run.
 */
const pois = new Map()
/** pageid (String) → { objectId, name } — Wikipedia-Artikel-Objekte. */
const wikis = new Map()
/** Commons-pageid (String) → { objectId, name } — Commons-Foto-Objekte. */
const photos = new Map()
/** Denkmal-Schlüssel → { objectId, name }. */
const denkmale = new Map()
/** Objekte der Vorgaenger-Quelle `naturdenkmal` — einmalig wegzuraeumen. */
const altlasten = []

// Beim initialen Sweep filtern wir auf `state.source`, damit das Cleanup
// unten NUR Bridge-managte Objekte anfasst und user-definierte type="poi"-
// Objekte (mit anderer `source`) unangetastet lässt.
for (const obj of await ladeBestand(ajna, { tag: 'poi', warn: console.warn })) {
  if (obj.type !== 'poi') continue
  if (obj.state?.source === 'overpass' && obj.state?.osm_id) {
    pois.set(String(obj.state.osm_id), { objectId: obj.id, name: obj.name })
  } else if (obj.state?.source === 'wikipedia' && obj.state?.commons_id != null) {
    photos.set(String(obj.state.commons_id), { objectId: obj.id, name: obj.name })
  } else if (obj.state?.source === 'wikipedia' && obj.state?.wiki_id != null) {
    wikis.set(String(obj.state.wiki_id), { objectId: obj.id, name: obj.name })
  } else if (obj.state?.source === 'denkmal' && (obj.state?.monument_key || obj.state?.dm_key)) {
    // `dm_*` ist die alte Schreibweise (docs/key-rename.md).
    denkmale.set(String(obj.state.monument_key ?? obj.state.dm_key), { objectId: obj.id, name: obj.name })
  } else if (obj.state?.source === 'naturdenkmal') {
    // Vorgaenger-Quelle. Wird unten einmalig weggeraeumt und unter `denkmal`
    // neu angelegt — die Daten stammen ohnehin aus der Liste, es geht nichts
    // verloren.
    altlasten.push(obj.id)
  }
}
console.log(`[ajna] Bestand geladen: ${pois.size} Overpass-POIs, ${wikis.size} Wikipedia-Artikel, `
  + `${photos.size} Commons-Fotos, ${denkmale.size} Denkmäler`)
for (const id of altlasten) {
  try { await ajna.deleteObject(id) }
  catch (err) { console.warn(`[nd] Altlast ${id}: ${err?.message || err}`) }
}
if (altlasten.length) console.log(`[nd] ${altlasten.length} Objekte der alten Quelle „naturdenkmal" abgeraeumt`)

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
  // Auf das Raster legen (siehe `raster`), sonst geht jede Abfrage an eine neue
  // Stelle und der Zwischenspeicher bleibt wirkungslos.
  return {
    lat: raster(lat), lon: raster(lon),
    radiusM: Math.min(2000, Math.round(Math.hypot(halfLatM, halfLonM) / 100) * 100) || 100,
  }
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
    for (const satz of FILTER_LISTE) {
      try {
        const { daten: res } = await cache.hole(
          `pois:${t.lat}:${t.lon}:${t.radiusM}:${satz}`,
          () => geo.poisNear(t.lat, t.lon, t.radiusM, satz))
        // Die GRUPPE mitschreiben: Aus den Etiketten allein liesse sich
        // „Quelle" und „Aussichtspunkt" nicht zu einer Schicht zusammenfassen —
        // die eine traegt `natural`, die andere `tourism`.
        for (const f of (res?.features || [])) if (f.id) byId.set(f.id, { ...f, _gruppe: satz })
      } catch (err) {
        errors++
        console.warn(`[poi] fetch ${satz} @${t.lat.toFixed(4)},${t.lon.toFixed(4)}: ${err?.message || err}`)
      }
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
  // JEDER Fehlschlag verbietet das Aufräumen — nicht nur der vollständige.
  //
  // Bis eben stand hier `if (!features.length && result.errors)`, also: nur
  // wenn GAR NICHTS zurückkam. Das reichte, solange es einen Filtersatz gab.
  // Seit es mehrere sind, ist der häufige Fall ein anderer: `historic` liefert,
  // `common` läuft in einen Zeitablauf — und die Aufräumlogik hält alle
  // gastronomischen POIs für verschwunden. Genau so sind bei einem Testlauf 70
  // Objekte gelöscht worden, die es in OSM unverändert gibt.
  //
  // Eine unvollständige Antwort ist keine Aussage darüber, was es NICHT gibt.
  if (result.errors) {
    console.log(`[poi] ${result.errors} Abfrage(n) fehlgeschlagen — Bestand bleibt unangetastet`)
    return
  }

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
          osm_group: f._gruppe || FILTER_LISTE[0],
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
      const { daten: data } = await cache.hole(
        `wiki:${WIKI_LANG}:${t.lat}:${t.lon}:${radius}:${WIKI_MAX}`,
        async () => {
          const r = await fetch(`https://${WIKI_LANG}.wikipedia.org/w/api.php?${params}`, {
            headers: { 'User-Agent': WIKI_UA } })
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        }, { ttlMs: WIKI_CACHE_MS })
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
  // Auch hier gilt: Eine unvollständige Antwort ist keine Aussage darüber, was
  // es NICHT gibt. Ein Areal, dessen Abfrage in den Zeitablauf lief, darf nicht
  // dazu führen, dass seine Artikel als verschwunden gelten.
  if (result.errors) {
    console.log(`[wiki] ${result.errors} Abfrage(n) fehlgeschlagen — Bestand bleibt unangetastet`)
    return
  }

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

// Fotos für EIN Areal holen — drei Schritte gegen Commons. Als eigene Funktion,
// damit der Zwischenspeicher das komplette Ergebnis je Areal ablegen kann und
// nicht drei Teilantworten einzeln.
async function commonsFuerZiel(t, radius) {
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
  if (!picked.length) return []
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
  return picked.map(f => {
    const l = labels[`M${f.pageid}`]?.labels || {}
    return {
      ...f,
      info: d2?.query?.pages?.[f.pageid]?.imageinfo?.[0],
      caption: l[WIKI_LANG]?.value || l.en?.value || null,
    }
  })
}

async function fetchCommons() {
  const { targets, source } = await wikiTargets()
  const radius = Math.max(100, Math.min(10000, WIKI_RADIUS_M))
  const byId = new Map()
  let errors = 0
  for (const t of targets) {
    try {
      const { daten: eintraege } = await cache.hole(
        `commons:${WIKI_LANG}:${t.lat}:${t.lon}:${radius}:${COMMONS_MAX}`,
        () => commonsFuerZiel(t, radius), { ttlMs: WIKI_CACHE_MS })
      for (const e of (eintraege || [])) byId.set(String(e.pageid), e)
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
//  Naturdenkmale: geschützte Einzelobjekte aus den Wikipedia-Gemeindelisten.
//  Von der Interessens-Koordinate über eine Rückwärts-Geokodierung zum
//  Gemeindenamen, von dort zur Liste. Siehe lib/denkmale.mjs.
// ───────────────────────────────────────────────────────────────────────

/**
 * Gemeinden, deren Listen für die aktiven Areale in Frage kommen.
 *
 * Gerastert auf 0,01° (≈ 1 km): Eine Gemeinde ändert sich nicht, wenn der
 * Spieler zweihundert Meter weitergeht, und Nominatim soll nicht bei jedem
 * Durchlauf neu gefragt werden. Der Vorrat hält einen Monat.
 *
 * NICHT GRÖBER: Bei 0,05° (≈ 5 km) entscheidet die erste Abfrage für einen
 * Fünf-Kilometer-Kasten — und Gemeindegrenzen liegen viel enger. Ein Areal am
 * Rand bekäme dann die Denkmalliste des Nachbarorts. Eine Abfrage je
 * Quadratkilometer, einmal im Monat, ist der Preis dafür.
 */
async function ndGemeinden(targets) {
  const namen = new Set()
  for (const t of targets) {
    const zelle = `${Math.round(t.lat * 100) / 100},${Math.round(t.lon * 100) / 100}`
    const { daten, grund } = await ortCache.hole(`ort:${zelle}`,
      () => nd.holeGemeinden(t.lat, t.lon, { userAgent: WIKI_UA }),
      { ttlMs: 30 * 24 * 3600_000 })
    // KEIN NAME IST KEINE FEHLANZEIGE, wenn wir gar nicht fragen durften.
    if (!daten) { if (grund) console.log(`[nd] Ortsbestimmung ${zelle} übersprungen: ${grund}`); continue }
    for (const n of daten) namen.add(n)
  }
  return [...namen]
}

/**
 * Ein Denkmal eindeutig machen — amtliche Kennung, sonst Liste + Lage.
 *
 * Die ART gehört in den Schlüssel: Natur- und Kulturdenkmale werden getrennt
 * numeriert, und dieselbe Nummer kann in beiden Listen vorkommen.
 */
const ndKey = (d) => d.nummer
  ? `${d.art}:nr:${d.nummer}`
  : `${d.art}:pos:${d.lat.toFixed(5)},${d.lon.toFixed(5)}`

async function fetchNaturdenkmale() {
  let areas = []
  try { areas = await ajna.fetchInterestAreas('denkmal') }
  catch (err) { console.warn(`[nd] interest-areas: ${err?.message || err} → Fallback Zentrum`) }
  const targets = areas.length
    ? areas.map(bboxToTarget)
    : [{ lat: CENTER_LAT, lon: CENTER_LON, radiusM: Math.round(RADIUS_KM * 1000) }]

  const gemeinden = await ndGemeinden(targets)
  if (!gemeinden.length) return { denkmale: [], gemeinden, ausfall: true }

  const gefunden = new Map()
  let ausfall = false
  for (const g of gemeinden) {
    const { daten, grund } = await ndCache.hole(`liste:${g}`,
      () => nd.holeListe(g, { userAgent: WIKI_UA }), { ttlMs: ND_CACHE_MS })
    if (!daten) { ausfall = true; console.log(`[nd] Liste „${g}" übersprungen: ${grund}`); continue }
    for (const d of daten.denkmale) gefunden.set(ndKey(d), d)
  }
  return { denkmale: [...gefunden.values()], gemeinden, ausfall }
}

async function syncNaturdenkmale() {
  if (!ND_ON) return
  let erg
  try { erg = await fetchNaturdenkmale() }
  catch (err) { console.warn(`[nd] fetch fehlgeschlagen: ${err?.message || err}`); return }

  const liste = erg.denkmale
  console.log(`[nd] ${liste.length} Denkmäler aus ${erg.gemeinden.length} Gemeinde(n): `
    + `${erg.gemeinden.join(', ') || '—'}`)

  // KONNTEN WIR NICHT FRAGEN, WIRD NICHT AUFGERÄUMT — auch dann nicht, wenn
  // ein Teil geantwortet hat. Faellt die Liste einer von zwei Gemeinden aus,
  // gelten deren Denkmale sonst als verschwunden und werden gelöscht.
  if (erg.ausfall) {
    console.log('[nd] mindestens eine Liste nicht abrufbar — Bestand bleibt unangetastet')
    return
  }

  const aktuell = new Set(liste.map(ndKey))
  let entfernt = 0
  for (const [k, w] of denkmale) {
    if (aktuell.has(k)) continue
    try {
      await ajna.deleteObject(w.objectId)
      denkmale.delete(k)
      entfernt++
      console.log(`[nd] − ${w.name}`)
    } catch (err) {
      console.warn(`[nd] cleanup ${k}: ${err?.response?.data?.message || err?.message || err}`)
    }
  }

  let neu = 0, bekannt = 0, fehler = 0
  for (const d of liste) {
    const k = ndKey(d)
    if (denkmale.has(k)) { bekannt++; continue }

    // `objects.name` fasst 32 Zeichen — „Kastanie am Engelstor der Abtei
    // Rommersdorf" passt nicht. Der volle Name steht in der Beschreibung.
    // `objects.name` fasst 32 Zeichen. Bei Stolpersteinen trägt der Listen-Name
    // „Stolpersteine <Strasse> <Nr>, <Ort>" — der Ort steht ohnehin in der
    // Beschreibung, also fällt er zuerst weg statt mitten im Wort abzubrechen.
    const roh = d.art === 'stolperstein' ? d.bezeichnung.split(',')[0].trim() : d.bezeichnung
    const kurz = roh.length > 32 ? `${roh.slice(0, 31)}…` : roh

    // Die Beschreibung trägt, was vor Ort zählt — und die Quelle, denn
    // Wikipedia steht unter CC BY-SA: Wer den Text übernimmt, nennt sie.
    const url = `https://de.wikipedia.org/wiki/${encodeURIComponent((d.liste || '').replace(/ /g, '_'))}`
    const zeilen = [
      d.bezeichnung,
      d.beschreibung,
      [d.ortsteil, d.adresse].filter(Boolean).join(', '),
      d.baujahr ? `Baujahr ${d.baujahr}` : '',
      d.nummer ? `Kennung ${d.nummer}` : '',
      // EIN STOLPERSTEIN IST KEIN GESCHÜTZTES OBJEKT, sondern ein Gedenkzeichen.
      // Ihm „Denkmalschutz" zuzuschreiben wäre schlicht falsch — und an dieser
      // Stelle die Sorte Fehler, die man nicht macht.
      d.art === 'stolperstein' ? 'Gedenkzeichen im Gehweg — verlegt im Rahmen des Projekts von Gunter Demnig.'
        : d.erloschen ? 'Schutz aufgehoben — steht nicht mehr unter Denkmalschutz.'
        : (d.art === 'cultural' ? 'Geschütztes Kulturdenkmal.' : 'Geschütztes Naturdenkmal.'),
      `Quelle: ${nd.HERKUNFT} — ${url}`,
    ].filter(Boolean)

    try {
      const obj = await ajna.createObject({
        name: kurz,
        type: 'poi',
        description: zeilen.join('\n').slice(0, 900),
        lat: d.lat, lon: d.lon, altitude: 0,
        appearance: {
          emoji: d.art === 'stolperstein' ? '🪨'
            : d.erloschen ? '🌾'
            : (d.art === 'cultural' ? '🏛️' : '🌳'),
          color: d.art === 'stolperstein' ? '#b08d57'      // Messing
            : d.erloschen ? '#9aa0a6'
            : (d.art === 'cultural' ? '#c9a227' : '#6fae7a'),
        },
        state: {
          source: 'denkmal',
          monument_key: k,
          monument_kind: d.art,
          monument_ref: d.nummer || '',
          monument_revoked: !!d.erloschen,
          monument_place: d.ortsteil || '',
          monument_list: d.liste || '',
          url,
        },
      })
      denkmale.set(k, { objectId: obj.id, name: kurz })
      neu++
      console.log(`[nd] + ${kurz}${d.erloschen ? ' (aufgehoben)' : ''} → ${obj.id}`)
    } catch (err) {
      fehler++
      console.warn(`[nd] create ${k}: ${err?.response?.data?.message || err?.message || err}`)
    }
  }
  console.log(`[nd] ${neu} neu, ${bekannt} bereits vorhanden, ${entfernt} entfernt, ${fehler} Fehler `
    + `— Bestand: ${denkmale.size}`)
}


// ───────────────────────────────────────────────────────────────────────
//  Start
// ───────────────────────────────────────────────────────────────────────

await syncPois()
await syncWikipedia()
await syncCommons()
await syncNaturdenkmale()

if (REFRESH_MS > 0) {
  console.log(`[poi] refresh: alle ${(REFRESH_MS / 1000).toFixed(0)} s`)
  setInterval(() => {
    syncPois().catch(err => console.warn(`[poi] refresh error: ${err?.message || err}`))
    syncWikipedia().catch(err => console.warn(`[wiki] refresh error: ${err?.message || err}`))
    syncCommons().catch(err => console.warn(`[fotos] refresh error: ${err?.message || err}`))
    syncNaturdenkmale().catch(err => console.warn(`[nd] refresh error: ${err?.message || err}`))
  }, REFRESH_MS)
  // SIGINT/SIGTERM übernimmt bootAgent.
} else {
  console.log('[poi] initial sync abgeschlossen, beende.')
  process.exit(0)
}
