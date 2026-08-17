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

// ── ENU (East/North/Up) ──────────────────────────────────────────────────
// Lokales Meter-Koordinatensystem um einen Ursprung — die Rechengrundlage von
// UWB-Multilateration, Positionsfilter und Zeige-Auflösung. Erdradius wie im
// GeoTransformer, damit ENU-Meter und Babylon-Meter dieselbe Skala haben.
//
// Lag bis 2026-08-14 in VIER Dateien als Kopie (PointingResolver, PositionFilter,
// UwbManager, UwbMultilateration) — mit auseinandergelaufenen Fassungen: ohne die
// `?? 0`-Absicherung liefert eine fehlende Höhe (GPS ohne Altitude) still `NaN`
// statt 0, und der Fehler wandert dann durch die ganze Positionskette.
export const EARTH_R_M = 6378137

export function wgs84ToEnu(origin, lat, lon, altitude) {
  const dLat = (lat - origin.lat) * Math.PI / 180
  const dLon = (lon - origin.lon) * Math.PI / 180
  const meanLat = (lat + origin.lat) / 2 * Math.PI / 180
  return {
    E: dLon * EARTH_R_M * Math.cos(meanLat),
    N: dLat * EARTH_R_M,
    U: (altitude ?? 0) - (origin.altitude ?? 0),
  }
}

export function enuToWgs84(origin, E, N, U) {
  const lat = origin.lat + (N / EARTH_R_M) * 180 / Math.PI
  const meanLat = (lat + origin.lat) / 2 * Math.PI / 180
  const lon = origin.lon + (E / (EARTH_R_M * Math.cos(meanLat))) * 180 / Math.PI
  return { lat, lon, altitude: (origin.altitude ?? 0) + U }
}
