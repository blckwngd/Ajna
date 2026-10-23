// blickfeld.mjs — what a figure SEES from where it stands, as text.
//
// The persona judged its surroundings from a list with distances. A list
// does not say that the chest is right in front, that the player is behind
// the house, or that the bench is at its back. This module adds the view:
// for each perceived object the direction relative to the figure's heading,
// whether it is inside the field of view, and whether something stands in
// the way — buildings (OSM footprints with a height) and large objects.
//
// PURE GEOMETRY, NO ENGINE. The scene is small (a few dozen boxes and
// footprints within 120 m), the questions are "is this segment crossing
// that polygon, and is the polygon taller than the line of sight there".
// That is a few lines of 2-D math and runs in microseconds. Babylon's
// NullEngine earns its place one step earlier — measuring the models
// (model-extents.mjs) — not here, where it would need polygon extrusion for
// the same answer.
//
// Flat ground. Altitude differences inside 120 m are ignored; a figure on a
// hill sees "over" a house in reality and not here. Known, accepted.

const toRad = (d) => (d * Math.PI) / 180
const toDeg = (r) => (r * 180) / Math.PI
const norm360 = (d) => ((d % 360) + 360) % 360
const norm180 = (d) => { const x = norm360(d); return x > 180 ? x - 360 : x }

/** Local metres east/north of a reference point (equirectangular — fine for 120 m). */
export function lokal(refLat, refLon, lat, lon) {
  const kLat = 111_320
  const kLon = 111_320 * Math.cos(toRad(refLat))
  return { x: (lon - refLon) * kLon, z: (lat - refLat) * kLat }
}

/** Compass bearing (0 = north, clockwise) from the origin to a local point. */
export const peilung = (p) => norm360(toDeg(Math.atan2(p.x, p.z)))

/** Direction words, as a figure would say them. */
export const RICHTUNGEN = ['Norden', 'Nordosten', 'Osten', 'Südosten', 'Süden', 'Südwesten', 'Westen', 'Nordwesten']
export function richtungsWort(deg) {
  return RICHTUNGEN[Math.round(norm360(deg) / 45) % 8]
}

/** Where relative to the heading — the words the situation uses. */
export function sektor(relDeg) {
  const a = Math.abs(relDeg)
  if (a <= 22.5) return 'vorn'
  const seite = relDeg > 0 ? 'rechts' : 'links'
  if (a <= 67.5) return `halb ${seite}`
  if (a <= 112.5) return seite
  if (a <= 157.5) return `schräg hinten ${seite}`
  return 'hinten'
}

/** Does segment p→q cross segment a→b (2-D)? Returns t along p→q or null. */
function schnitt(p, q, a, b) {
  const r = { x: q.x - p.x, z: q.z - p.z }, s = { x: b.x - a.x, z: b.z - a.z }
  const den = r.x * s.z - r.z * s.x
  if (Math.abs(den) < 1e-12) return null
  const qp = { x: a.x - p.x, z: a.z - p.z }
  const t = (qp.x * s.z - qp.z * s.x) / den
  const u = (qp.x * r.z - qp.z * r.x) / den
  return (t > 0 && t < 1 && u >= 0 && u <= 1) ? t : null
}

/** Is a 2-D point inside a polygon (ray casting)? */
function imPolygon(poly, p) {
  let drin = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a.z > p.z) !== (b.z > p.z) && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) drin = !drin
  }
  return drin
}

/**
 * Does an occluder block the line of sight from the eye to the target?
 * The sight line rises/falls linearly from eye height to the target's
 * centre height; an occluder blocks where it is crossed AND taller than the
 * line there.
 * @param {{x:number,z:number}} eye   figure position (2-D)
 * @param {number} eyeM
 * @param {{x:number,z:number}} ziel
 * @param {number} zielM              height of the point looked at
 * @param {{poly:Array<{x:number,z:number}>, hoehe:number}} occ
 */
function verdeckt(eye, eyeM, ziel, zielM, occ) {
  const poly = occ.poly
  if (!poly || poly.length < 3) return false
  // Inside the footprint: the target is in the building (or the figure is).
  if (imPolygon(poly, ziel) || imPolygon(poly, eye)) return false
  let tMin = null
  for (let i = 0; i < poly.length; i++) {
    const t = schnitt(eye, ziel, poly[i], poly[(i + 1) % poly.length])
    if (t !== null && (tMin === null || t < tMin)) tMin = t
  }
  if (tMin === null) return false
  const sichtHoehe = eyeM + (zielM - eyeM) * tMin
  return occ.hoehe > sichtHoehe
}

/** Axis-aligned footprint of an object as a polygon (for occlusion by big things). */
function kasten(p, breite, tiefe) {
  const hw = Math.max(0.2, breite / 2), hd = Math.max(0.2, tiefe / 2)
  return [{ x: p.x - hw, z: p.z - hd }, { x: p.x + hw, z: p.z - hd }, { x: p.x + hw, z: p.z + hd }, { x: p.x - hw, z: p.z + hd }]
}

/**
 * The view.
 *
 * @param {object} args
 * @param {{lat:number,lon:number,headingDeg?:number,eyeM?:number}} args.self
 * @param {Array<{id:string,name?:string,type?:string,lat:number,lon:number,size?:{w?:number,h?:number,d?:number}}>} args.objects
 * @param {Array<{coordinates:Array<[number,number]>, hoehe?:number, name?:string}>} [args.buildings]  OSM footprints (lat, lon pairs)
 * @param {number} [args.fovDeg=120]
 * @param {number} [args.maxM=120]
 * @param {number} [args.occluderMinM=1.5]  objects at least this tall hide what is behind them
 * @returns {{headingDeg:number, richtung:string, eintraege:Array<{id:string, name:string, distM:number, peilung:number, rel:number, sektor:string, imBlick:boolean, sichtbar:boolean, verdecktVon:string|null}>}}
 */
export function blickfeld({ self, objects = [], buildings = [], fovDeg = 120, maxM = 120, occluderMinM = 1.5 }) {
  const heading = norm360(Number(self?.headingDeg) || 0)
  const eyeM = Number(self?.eyeM) > 0 ? Number(self.eyeM) : 1.6
  const eye = { x: 0, z: 0 }
  const halb = fovDeg / 2

  const haeuser = buildings
    .filter(b => Array.isArray(b?.coordinates) && b.coordinates.length >= 3)
    .map(b => ({ name: b.name || 'Gebäude', hoehe: Number(b.hoehe) > 0 ? Number(b.hoehe) : 8,
                 poly: b.coordinates.map(([la, lo]) => lokal(self.lat, self.lon, la, lo)) }))

  const platz = objects
    .filter(o => Number.isFinite(o?.lat) && Number.isFinite(o?.lon))
    .map(o => {
      const p = lokal(self.lat, self.lon, o.lat, o.lon)
      const h = Number(o.size?.h) > 0 ? Number(o.size.h) : 1
      return { o, p, h, w: Number(o.size?.w) > 0 ? Number(o.size.w) : 0.6, d: Number(o.size?.d) > 0 ? Number(o.size.d) : 0.6,
               distM: Math.hypot(p.x, p.z) }
    })
    .filter(e => e.distM <= maxM)

  const eintraege = platz.map(e => {
    const pl = peilung(e.p)
    const rel = norm180(pl - heading)
    const imBlick = Math.abs(rel) <= halb
    let verdecktVon = null
    if (imBlick) {
      const zielM = e.h / 2
      for (const hs of haeuser) { if (verdeckt(eye, eyeM, e.p, zielM, hs)) { verdecktVon = hs.name; break } }
      if (!verdecktVon) {
        for (const other of platz) {
          if (other === e || other.h < occluderMinM || other.distM >= e.distM) continue
          if (verdeckt(eye, eyeM, e.p, zielM, { poly: kasten(other.p, other.w, other.d), hoehe: other.h })) { verdecktVon = other.o.name || other.o.id; break }
        }
      }
    }
    return {
      id: e.o.id, name: e.o.name || '(ohne Namen)', distM: Math.round(e.distM), peilung: Math.round(pl), rel: Math.round(rel),
      sektor: sektor(rel), imBlick, sichtbar: imBlick && !verdecktVon, verdecktVon,
    }
  }).sort((a, b) => a.distM - b.distM)

  return { headingDeg: Math.round(heading), richtung: richtungsWort(heading), eintraege }
}

/**
 * The view in words — for the model, and for `look_around`.
 * Nearest first within each group; what is out of view is named as such,
 * so the figure can turn instead of guessing.
 */
export function beschreibeBlickfeld(b, { max = 12 } = {}) {
  const zeilen = [`Du blickst nach ${b.richtung} (${b.headingDeg}°).`]
  const sicht = b.eintraege.filter(e => e.sichtbar).slice(0, max)
  const verdeckt = b.eintraege.filter(e => e.imBlick && !e.sichtbar).slice(0, max)
  const ausser = b.eintraege.filter(e => !e.imBlick).slice(0, max)
  if (sicht.length) zeilen.push('Im Blick: ' + sicht.map(e => `${e.name} [${e.id}] ${e.distM} m ${e.sektor}`).join(' · '))
  else zeilen.push('Im Blick: nichts Benanntes.')
  if (verdeckt.length) zeilen.push('Verdeckt: ' + verdeckt.map(e => `${e.name} [${e.id}] ${e.distM} m ${e.sektor}, hinter ${e.verdecktVon}`).join(' · '))
  if (ausser.length) zeilen.push('Außerhalb des Blicks: ' + ausser.map(e => `${e.name} [${e.id}] ${e.distM} m ${e.sektor}`).join(' · '))
  return zeilen.join('\n')
}

/**
 * Turn instructions a model may give: words or degrees.
 * @returns {number|null} new heading in degrees, or null when not understood
 */
export function neueBlickrichtung(headingDeg, anweisung) {
  const h = norm360(Number(headingDeg) || 0)
  if (anweisung === undefined || anweisung === null || anweisung === '') return h
  if (typeof anweisung === 'number' && Number.isFinite(anweisung)) return norm360(anweisung)
  const w = String(anweisung).trim().toLowerCase()
  if (/^-?\d+(\.\d+)?$/.test(w)) return norm360(Number(w))
  const worte = {
    links: h - 90, rechts: h + 90, um: h + 180, zurueck: h + 180, 'zurück': h + 180, hinten: h + 180, geradeaus: h, vorn: h,
    norden: 0, nord: 0, n: 0, nordosten: 45, osten: 90, ost: 90, o: 90, 'südosten': 135, suedosten: 135,
    'süden': 180, sueden: 180, 's': 180, 'südwesten': 225, suedwesten: 225, westen: 270, west: 270, w: 270, nordwesten: 315,
  }
  return w in worte ? norm360(worte[w]) : null
}
