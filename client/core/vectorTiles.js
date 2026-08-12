// client/core/vectorTiles.js — Kulissen-Geodaten aus OSM-Vektorkacheln.
//
// WARUM: Overpass ist für Kulissendaten die falsche Quelle. Die öffentlichen
// Instanzen drosseln hart (gemessen: 40 s pro Abfrage, zeitweise TCP-Sperre
// der IP), und Ajna fragt sie gleich mehrfach — Director-Routing, POI-Bridge,
// Kulisse. Vorgerenderte Vektorkacheln liefern DIESELBEN Daten in ~200 ms,
// ohne Key und ohne Limit: eine Kachel enthält Gebäude (inkl. fertiger
// `render_height`!), Gewässer, Flüsse, Straßen, Landnutzung und Parks.
// Overpass bleibt damit dem vorbehalten, was nur es kann: dem Wegegraph fürs
// Routing (server/geo.js).
//
// SCHEMA: OpenMapTiles (OpenFreeMap, Versatiles, MapTiler …) — Layer u. a.
//   building        Polygone · render_height, render_min_height
//   water           Polygone · class (river|lake|pond|ocean …)
//   waterway        Linien   · class (river|stream|canal|ditch|drain)
//   transportation  Linien   · class (motorway|primary|…|path), subclass
//
// GRENZEN (bewusst): Kacheln sind generalisiert (vereinfachte Geometrie) und
// werden alle paar Wochen neu gebaut — für Kulisse ideal, für „ist dieser
// Poller neu?" nicht. Gebäude gibt es erst ab Zoom 13.
//
// Browserfähig (fetch + zwei kleine Libs) — Agents können dieselbe Datei per
// Node nutzen.

// pbf 5.x exportiert benannt (PbfReader/PbfWriter) — kein Default-Export.
import { PbfReader } from 'pbf'
import { VectorTile } from '@mapbox/vector-tile'

// z14 ist die höchste Zoomstufe dieser Kachelsätze (= volle Detailtiefe) und
// deckt bei uns ~2,4 × 1,5 km ab — meist genügt EINE Kachel für die Kulisse.
export const TILE_Z = 14

const DEFAULT_ENDPOINTS = [
  'https://tiles.openfreemap.org/planet/{ver}/{z}/{x}/{y}.pbf',
  'https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}',
]
// OpenFreeMap-Kachelsätze tragen ein Build-Datum im Pfad; die aktuelle URL
// steht im TileJSON. Wird beim ersten Zugriff einmal aufgelöst und gecacht.
const TILEJSON_URL = 'https://tiles.openfreemap.org/planet'

const TTL_MS = 30 * 60 * 1000
const tileCache = new Map()     // "z/x/y" → { ts, layers }
let tileUrlTemplate = null      // aufgelöste OpenFreeMap-URL

// ─── Kachel-Mathematik (Web-Mercator) ──────────────────────────────────────

export const lon2tile = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z)
export const lat2tile = (lat, z) => Math.floor(
  (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z)

/** Alle Kacheln, die den Kreis (lat, lon, radiusM) berühren. */
export function tilesFor(lat, lon, radiusM, z = TILE_Z) {
  const dLat = radiusM / 111320
  const dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180) || 1)
  const x0 = lon2tile(lon - dLon, z), x1 = lon2tile(lon + dLon, z)
  const y0 = lat2tile(lat + dLat, z), y1 = lat2tile(lat - dLat, z)   // y wächst nach Süden
  const out = []
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ z, x, y })
  return out
}

async function resolveTemplate() {
  if (tileUrlTemplate) return tileUrlTemplate
  try {
    const r = await fetch(TILEJSON_URL)
    if (r.ok) {
      const j = await r.json()
      const t = Array.isArray(j.tiles) ? j.tiles[0] : null
      if (typeof t === 'string' && t.includes('{z}')) { tileUrlTemplate = t; return t }
    }
  } catch { /* Fallback unten */ }
  tileUrlTemplate = DEFAULT_ENDPOINTS[1]     // Versatiles braucht keine Versions-URL
  return tileUrlTemplate
}

const fill = (tpl, { z, x, y }) => tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y)

/**
 * Eine Kachel holen und dekodieren.
 * @returns {Promise<Record<string, Array>>} Layer-Name → Features
 *          (GeoJSON-artig: { type, geometry:{type,coordinates}, properties })
 */
async function fetchTile(tile) {
  const key = `${tile.z}/${tile.x}/${tile.y}`
  const hit = tileCache.get(key)
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.layers

  const urls = [fill(await resolveTemplate(), tile), fill(DEFAULT_ENDPOINTS[1], tile)]
  let buf = null, lastErr = null
  for (const url of urls) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (r.status === 204 || r.status === 404) { buf = new ArrayBuffer(0); break }   // leere Kachel (Meer/Wüste)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      buf = await r.arrayBuffer()
      break
    } catch (err) { lastErr = err }
  }
  if (buf === null) throw lastErr || new Error('Kachel nicht ladbar')

  const layers = {}
  if (buf.byteLength) {
    const vt = new VectorTile(new PbfReader(new Uint8Array(buf)))
    for (const name of Object.keys(vt.layers)) {
      const layer = vt.layers[name]
      const feats = []
      for (let i = 0; i < layer.length; i++) {
        // toGeoJSON rechnet die kachel-lokalen Koordinaten direkt in
        // lon/lat um — spart eigene Mercator-Rückrechnung.
        feats.push(layer.feature(i).toGeoJSON(tile.x, tile.y, tile.z))
      }
      layers[name] = feats
    }
  }
  tileCache.set(key, { ts: Date.now(), layers })
  return layers
}

/**
 * Kulissen-Features rund um eine Position — vereint über alle nötigen Kacheln.
 * Koordinaten kommen als [lat, lon]-Paare (Ajna-Konvention, wie die Geo-API).
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} radiusM
 * @param {string[]} [layerNames]
 * @returns {Promise<Record<string, Array<{coordinates: Array, rings?: Array, tags: object}>>>}
 */
export async function sceneryNear(lat, lon, radiusM, layerNames = ['building', 'water', 'waterway', 'transportation']) {
  const tiles = tilesFor(lat, lon, radiusM)
  const out = {}
  for (const n of layerNames) out[n] = []

  const results = await Promise.allSettled(tiles.map(fetchTile))
  for (const res of results) {
    if (res.status !== 'fulfilled') continue
    for (const name of layerNames) {
      for (const f of (res.value[name] || [])) {
        const g = f.geometry
        if (!g) continue
        const tags = f.properties || {}
        // GeoJSON [lon,lat] → Ajna [lat,lon]; Multi-Geometrien aufspalten.
        const flip = (ring) => ring.map(([x, y]) => [y, x])
        if (g.type === 'LineString') out[name].push({ coordinates: flip(g.coordinates), tags })
        else if (g.type === 'MultiLineString') for (const l of g.coordinates) out[name].push({ coordinates: flip(l), tags })
        else if (g.type === 'Polygon') out[name].push({ coordinates: flip(g.coordinates[0]), rings: g.coordinates.map(flip), tags })
        else if (g.type === 'MultiPolygon') for (const p of g.coordinates) out[name].push({ coordinates: flip(p[0]), rings: p.map(flip), tags })
      }
    }
  }
  return out
}

/** Cache leeren (z. B. nach Origin-Wechsel in einer langen Session). */
export function clearTileCache() { tileCache.clear() }
