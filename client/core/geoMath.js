// client/core/geoMath.js — kleine geodätische Helfer (planare Näherung).
//
// Für Bounding-Boxen, Grad-Deltas und kurze Distanzen im Agent-/Client-Alltag.
// Bewusst OHNE echte Geodäsie (WGS84 etc.) — auf den hier üblichen Skalen
// (Meter bis wenige Dutzend km) reicht die Kugel-Näherung. Präzise Distanzen
// über größere Strecken: haversine in StreetNav.js.
//
// Browserfähig (kein Node-API) — Agents nutzen dieselbe Datei per Node.

export const KM_PER_DEG_LAT = 111
export const M_PER_DEG_LAT = 111000

/** Grad-Deltas (Breite/Länge) für einen Radius in Metern um eine Breite. */
export function degDeltas(latDeg, radiusM) {
  const dLat = radiusM / M_PER_DEG_LAT
  const dLon = radiusM / (M_PER_DEG_LAT * Math.cos(latDeg * Math.PI / 180))
  return { dLat, dLon }
}

/**
 * Achsenparallele BoundingBox (Quadrat, das den Kreis-Radius enthält).
 * @returns {{latMin:number, latMax:number, lonMin:number, lonMax:number, cLat:number, cLon:number}}
 */
export function bboxAroundM(lat, lon, radiusM) {
  const { dLat, dLon } = degDeltas(lat, radiusM)
  return { latMin: lat - dLat, latMax: lat + dLat, lonMin: lon - dLon, lonMax: lon + dLon, cLat: lat, cLon: lon }
}

export const bboxAroundKm = (lat, lon, radiusKm) => bboxAroundM(lat, lon, radiusKm * 1000)

/** Mittelpunkt eines {latMin,latMax,lonMin,lonMax}-Bereichs (Interest-Area). */
export function centerOf(area) {
  return { lat: (area.latMin + area.latMax) / 2, lon: (area.lonMin + area.lonMax) / 2 }
}

/** Planare Distanz in km — für Nachbarschafts-Checks, nicht für Navigation. */
export function flatDistKm(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * KM_PER_DEG_LAT
  const dLon = (bLon - aLon) * KM_PER_DEG_LAT * Math.cos(aLat * Math.PI / 180)
  return Math.hypot(dLat, dLon)
}
