// Sonnenstand (Höhe + Azimut) aus Zeitpunkt und geografischer Position.
//
// Näherung nach dem NOAA-Low-Precision-Algorithmus — für die Schattenrichtung
// mehr als genau genug (~0,1–0,5°). Rein & abhängigkeitsfrei.
//
// Rückgabe (Radiant):
//   altitude — Höhe über dem Horizont (negativ = unter dem Horizont / Nacht)
//   azimuth  — von NORD im Uhrzeigersinn (0 = N, π/2 = O, π = S, 3π/2 = W)

export function sunPosition(date, latDeg, lonDeg) {
  const rad = Math.PI / 180
  const lat = latDeg * rad

  const jd = date.getTime() / 86400000 + 2440587.5   // Julianisches Datum (UT)
  const n = jd - 2451545.0                            // Tage seit J2000.0

  const L = (((280.460 + 0.9856474 * n) % 360) + 360) % 360           // mittlere Länge (°)
  const g = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * rad   // mittlere Anomalie
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad  // ekliptikale Länge
  const eps = (23.439 - 0.0000004 * n) * rad                          // Ekliptik-Schiefe

  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda))            // Deklination
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda))  // Rektaszension

  const gmstH = ((((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24)  // Greenwich-Sternzeit (h)
  const lst = gmstH * 15 * rad + lonDeg * rad         // lokale Sternzeit (rad)
  const H = lst - ra                                  // Stundenwinkel

  let sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(H)
  sinAlt = Math.max(-1, Math.min(1, sinAlt))
  const altitude = Math.asin(sinAlt)

  let cosAz = (Math.sin(decl) - Math.sin(lat) * sinAlt) / (Math.cos(lat) * Math.cos(altitude))
  cosAz = Math.max(-1, Math.min(1, cosAz))
  let azimuth = Math.acos(cosAz)                      // [0, π], von Nord
  if (Math.sin(H) > 0) azimuth = 2 * Math.PI - azimuth  // Nachmittag → Westen

  return { altitude, azimuth }
}
