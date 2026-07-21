// agents/lib/landing-spots.mjs — Landeplatz-Suche für fliegende Wesen.
//
// Reine Geometrie, KEIN Objekt-I/O: damit ist das Verhalten testbar, ohne den
// World-Director laufen zu lassen (siehe tests/run-landing.mjs). Der Director
// bleibt der einzige Schreiber der Entity-Position — hier wird nur gerechnet.
//
// Regeln (aus dem Feature-Wunsch):
//   • Landeplatz im Ring [MIN_M, MAX_M] um den Spieler — nah genug fürs Foto,
//     aber nicht auf ihm drauf.
//   • Boden bevorzugt: ein Punkt, der in KEINEM Gebäude-Polygon liegt. Ein
//     Drache, der im Wohnzimmer landet, ist kein Feature.
//   • Dach als Kür: nur wenn am Boden nichts Freies gefunden wurde. Höhe aus
//     OSM (`height` bzw. `building:levels`), sonst konservativer Default.

const M_PER_DEG_LAT = 111320

export const DEFAULT_MIN_M = 5     // näher nicht — sonst steht er im Spieler
export const DEFAULT_MAX_M = 20
const DEFAULT_ROOF_H = 8           // m, wenn OSM nichts hergibt (~2,5 Geschosse)
const LEVEL_H = 3                  // m pro Geschoss

/** Meter-Offsets → Grad (lokal linearisiert; auf dieser Skala genau genug). */
function offsetToLatLon(lat, lon, dNorthM, dEastM) {
  const cosLat = Math.cos(lat * Math.PI / 180) || 1e-6
  return {
    lat: lat + dNorthM / M_PER_DEG_LAT,
    lon: lon + dEastM / (M_PER_DEG_LAT * cosLat)
  }
}

export function distM(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * M_PER_DEG_LAT
  const dLon = (bLon - aLon) * M_PER_DEG_LAT * Math.cos(aLat * Math.PI / 180)
  return Math.hypot(dLat, dLon)
}

/**
 * Liegt der Punkt im Polygon? Ray-Casting in Lat/Lon-Ebene — bei Gebäudegrößen
 * ist die Verzerrung durch die Kugelgestalt vernachlässigbar.
 * @param {number[][]} ring  [[lat, lon], ...]
 */
export function pointInPolygon(lat, lon, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j]
    if (!Number.isFinite(yi) || !Number.isFinite(xi)) continue
    // Kante schneidet die waagerechte Strahlenlinie durch (lat, lon)?
    const intersects = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)
    if (intersects) inside = !inside
  }
  return inside
}

/** Dachhöhe aus OSM-Tags — `height` gewinnt, sonst Geschosse, sonst Default. */
export function roofHeight(tags = {}) {
  const h = parseFloat(tags.height ?? tags['building:height'])
  if (Number.isFinite(h) && h > 0) return h
  const lv = parseFloat(tags['building:levels'] ?? tags.levels)
  if (Number.isFinite(lv) && lv > 0) return lv * LEVEL_H
  return DEFAULT_ROOF_H
}

/** Schwerpunkt eines Rings (ungewichtet — für Dachmitte gut genug). */
export function centroid(ring) {
  let sLat = 0, sLon = 0, n = 0
  for (const p of ring || []) {
    if (Number.isFinite(p?.[0]) && Number.isFinite(p?.[1])) { sLat += p[0]; sLon += p[1]; n++ }
  }
  return n ? { lat: sLat / n, lon: sLon / n } : null
}

const isInsideAny = (lat, lon, buildings) =>
  buildings.some(b => pointInPolygon(lat, lon, b.coordinates))

/**
 * Freien Landeplatz um eine Position suchen.
 *
 * @param {object} o
 * @param {number} o.lat, o.lon        Zielperson
 * @param {Array}  [o.buildings]       Features mit { coordinates: [[lat,lon]...], tags }
 * @param {number} [o.minM], [o.maxM]  Ring um die Person
 * @param {() => number} [o.rng]       injizierbar für deterministische Tests
 * @returns {{lat, lon, altitude, kind:'ground'|'roof', distance:number, building?:object}|null}
 */
export function findLandingSpot({
  lat, lon, buildings = [], minM = DEFAULT_MIN_M, maxM = DEFAULT_MAX_M,
  samples = 24, rng = Math.random
} = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const solid = (buildings || []).filter(b => Array.isArray(b?.coordinates) && b.coordinates.length >= 3)

  // ── Boden zuerst: Ring abtasten, alles in Gebäuden verwerfen ──────────
  // Startwinkel zufällig, dann gleichmäßig rundum — so ist die Richtung pro Ruf
  // anders (Abwechslung), die Abdeckung aber trotzdem systematisch.
  const start = rng() * Math.PI * 2
  for (let i = 0; i < samples; i++) {
    const ang = start + (i / samples) * Math.PI * 2
    // Radius zwischen min und max variieren, damit er nicht immer am Rand landet.
    const r = minM + ((i % 3) / 2) * (maxM - minM)
    const p = offsetToLatLon(lat, lon, Math.cos(ang) * r, Math.sin(ang) * r)
    if (!isInsideAny(p.lat, p.lon, solid)) {
      return { lat: p.lat, lon: p.lon, altitude: 0, kind: 'ground', distance: r }
    }
  }

  // ── Kür: Dach. Nur wenn am Boden alles verbaut ist. ───────────────────
  let best = null
  for (const b of solid) {
    const c = centroid(b.coordinates)
    if (!c) continue
    const d = distM(lat, lon, c.lat, c.lon)
    if (d > maxM * 2) continue                       // zu weit → kein Foto-Motiv mehr
    // Der Schwerpunkt liegt von Natur aus weg von der Kante — bei konkaven
    // Grundrissen (L-Form, Innenhof) kann er aber AUSSERHALB liegen; dann
    // taugt das Dach nicht als Landeplatz.
    if (!pointInPolygon(c.lat, c.lon, b.coordinates)) continue
    if (!best || d < best.distance) {
      best = { lat: c.lat, lon: c.lon, altitude: roofHeight(b.tags), kind: 'roof', distance: d, building: b }
    }
  }
  return best   // null → Aufrufer entscheidet (z. B. gar nicht landen)
}
