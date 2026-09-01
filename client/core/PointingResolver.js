// PointingResolver — "what is the wand pointing at?" computed ON-DEVICE.
//
// Casts a ray from an origin (the wand's UWB position, or a fallback position)
// along the wand's world-frame pointing direction, and picks the object with the
// smallest angular deviation within a cone + range. No raw coordinates leave the
// device — only the resolved object id is later used for interact().
//
// Pure + dependency-free (no BABYLON). Frame: local ENU metres around the origin
// (E, N, U), matching GeoTransformer/UwbManager conventions; the pointing
// direction is the world ENU unit vector produced by WandManager.

import { wgs84ToEnu, enuToWgs84 } from './geoMath.js'

/**
 * Tolerant target pick with HYSTERESIS to absorb orientation/position
 * inaccuracy and stop flicker at cone edges: a new (different) object is only
 * acquired inside the narrow `coneDeg`, while the currently-selected object is
 * held until it leaves the wider `releaseDeg`.
 *
 * @param {object} args
 * @param {{lat:number,lon:number,altitude?:number}} args.origin  ray start
 * @param {[number,number,number]} args.direction  world ENU unit vector [E,N,U]
 * @param {Array<{id:string,lat:number,lon:number,altitude?:number}>} args.objects  (caller pre-filters to visible)
 * @param {number} [args.coneDeg=12]      acquire cone (new target)
 * @param {number} [args.releaseDeg]      release cone (keep current); default coneDeg*1.6
 * @param {number} [args.maxRangeM=50]    ignore objects farther than this
 * @param {string|null} [args.currentId]  currently selected id (for hysteresis)
 * @returns {{id:string, angleDeg:number, distanceM:number}|null}
 */
export function resolvePointingTarget({ origin, direction, objects, coneDeg = 12, releaseDeg, maxRangeM = 50, currentId = null }) {
  if (!origin || !Array.isArray(direction) || !objects?.length) return null
  // 2D-Auswahl: Treffer rein HORIZONTAL bestimmen (Höhe ignorieren). Der Stab-
  // Origin liegt auf Spieler-Höhe, viele Objekte aber am Boden (alt 0) — in 3D
  // sprengt dieser Höhenversatz den Kegel, obwohl der Strahl horizontal genau
  // aufs Objekt zeigt. (Für Mehrstöckiges — viele Geräte übereinander — später
  // wieder eine 3D-/Etagen-Auflösung erwägen.)
  const dh = Math.hypot(direction[0], direction[1])
  if (dh < 1e-6) return null
  const d = [direction[0] / dh, direction[1] / dh]   // horizontale Richtung [E,N]
  const release = releaseDeg ?? coneDeg * 1.6

  let bestNarrow = null   // best within the acquire cone
  let currentEntry = null // the current target, if still within the release cone
  for (const o of objects) {
    if (!Number.isFinite(o?.lat) || !Number.isFinite(o?.lon)) continue
    const v = wgs84ToEnu(origin, o.lat, o.lon, o.altitude || 0)
    const dist = Math.hypot(v.E, v.N)   // horizontale Distanz (Höhe ignoriert)
    if (dist < 1e-3 || dist > maxRangeM) continue
    const dot = (v.E * d[0] + v.N * d[1]) / dist
    const angle = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI
    if (angle > release) continue
    const entry = { id: o.id, angleDeg: angle, distanceM: dist }
    if (o.id === currentId) currentEntry = entry
    if (angle <= coneDeg) {
      const score = angle + dist * 0.05
      if (!bestNarrow || score < (bestNarrow.angleDeg + bestNarrow.distanceM * 0.05)) bestNarrow = entry
    }
  }
  // Switch only when a DIFFERENT object enters the acquire cone; otherwise keep
  // the current target while it stays inside the wider release cone.
  if (bestNarrow && bestNarrow.id !== currentId) return bestNarrow
  if (currentEntry) return currentEntry
  return bestNarrow
}

/**
 * World position `rangeM` along the pointing direction from `origin` — the
 * endpoint of the visual ray. direction = world ENU unit vector [E,N,U].
 */
export function rayEndpointWgs84(origin, direction, rangeM = 30) {
  const dl = Math.hypot(direction[0], direction[1], direction[2]) || 1
  const E = (direction[0] / dl) * rangeM
  const N = (direction[1] / dl) * rangeM
  const U = (direction[2] / dl) * rangeM
  return enuToWgs84(origin, E, N, U)
}

/**
 * Typen, die von Natur aus KILOMETERWEIT weg sind und trotzdem angepeilt
 * werden: Flugzeuge am Himmel, Schiffe auf dem Strom. Für sie zählt fast nur
 * der Winkel — wer dorthin zeigt, meint sie auch.
 *
 * Für alles andere gilt das Gegenteil (siehe `rangiereNachPeilung`): Eine Bank
 * fünf Meter weiter schlägt einen Baum in 400 m, selbst wenn der Baum genauer
 * getroffen ist. Sonst drängt sich beim Zeigen ständig Fernes vor das, was
 * direkt vor einem steht.
 */
export const FERNZIELE = new Set(['aircraft', 'plane', 'ship', 'vessel', 'boat'])

/** Weiter als das wird beim Peilen nichts mehr angeboten (Meter). */
export const PEIL_MAX_M = 30000
/** Jenseits davon ist ein Nahziel „weit weg" und sinkt nach unten (Meter). */
export const NAH_REICHWEITE_M = 400

/**
 * Entfernungsbänder für das Peilen.
 *
 * WOFÜR: Ein Flugzeug anzupeilen ist aussichtslos, solange Laternen, Bänke
 * und Hinweise auf derselben Linie liegen — sie stehen zwangsläufig zwischen
 * einem und dem Himmel. Wer die Entfernung VORHER wählt, räumt die anderen
 * aus dem Weg, statt gegen sie anzuzielen.
 *
 * Die Bänder überschneiden sich NICHT. Ein „mittel", das die nahen Dinge
 * mitnimmt, hätte dasselbe Problem wie vorher — nur eine Stufe später.
 */
export const PEIL_BAENDER = [
  { key: 'nah',    label: 'nah',    minM: 0,   maxM: 15 },
  { key: 'mittel', label: 'mittel', minM: 15,  maxM: 100 },
  { key: 'fern',   label: 'fern',   minM: 100, maxM: PEIL_MAX_M },
]

/**
 * RANGLISTE statt Einzeltreffer: alle Objekte nach „wie sehr peile ich das an"
 * sortiert, bestes zuerst.
 *
 * WOFÜR: Der Zauberstab pickt EIN Ziel im Kegel (`resolvePointingTarget`) — für
 * eine Liste ist das zu grob. Beim Halten des Peil-Knopfes soll das anvisierte
 * Objekt oben stehen, das zweitbeste darunter, und nichts soll verschwinden,
 * nur weil es knapp neben dem Kegel liegt.
 *
 * Beide Wege teilen sich die Geometrie hier, damit sie nicht auseinanderlaufen.
 *
 * ZWEI REGIME, und das ist der Kern:
 *
 *   FERNZIELE (Flugzeug, Schiff) dürfen kilometerweit weg sein. Man zeigt in
 *   den Himmel, und dort ist nichts anderes — der WINKEL entscheidet, die
 *   Entfernung kostet über 30 km hinweg nur wenig.
 *
 *   ALLES ANDERE: NÄHE SCHLÄGT RICHTUNG. Eine Bank fünf Meter weiter gewinnt
 *   gegen einen Baum in 400 m, auch wenn der Baum genauer getroffen ist. Ohne
 *   diese Umkehr drängte sich beim Zeigen ständig Entferntes vor das, was
 *   direkt vor einem steht — genau das war der Fehler der ersten Fassung, die
 *   die Entfernungsstrafe bei 120 m deckelte und damit ein Objekt in 1000 km
 *   genauso behandelte wie eines in 121 m.
 *
 * Über PEIL_MAX_M hinaus wird gar nichts mehr angeboten.
 *
 * KEINE HYSTERESE hier — die Liste darf zappeln, solange der Knopf gehalten
 * wird; sie zeigt ja gerade die Bewegung. Festgehalten wird erst beim
 * Loslassen, und das entscheidet der Aufrufer.
 *
 * @param {object} args
 * @param {{lat:number,lon:number,altitude?:number}} args.origin
 * @param {number} args.kursGrad  Blickrichtung (0 = Nord, im Uhrzeigersinn)
 * @param {Array<object>} args.objekte  Objekte mit lat/lon (Aufrufer filtert)
 * @param {number} [args.minM=0]   untere Bandgrenze (Meter)
 * @param {number} [args.maxM=PEIL_MAX_M]  obere Bandgrenze (Meter)
 * @returns {Array<{o:object, entfernungM:number, winkelGrad:number, punkte:number}>}
 */
export function rangiereNachPeilung({ origin, kursGrad, objekte, minM = 0, maxM = PEIL_MAX_M }) {
  if (!origin || !Number.isFinite(kursGrad) || !Array.isArray(objekte)) return []
  // Kompasskurs → horizontaler ENU-Einheitsvektor. 0° = Nord = +N.
  const r = kursGrad * Math.PI / 180
  const dE = Math.sin(r)
  const dN = Math.cos(r)

  const out = []
  for (const o of objekte) {
    if (!Number.isFinite(o?.lat) || !Number.isFinite(o?.lon)) continue
    const v = wgs84ToEnu(origin, o.lat, o.lon, o.altitude || 0)
    const dist = Math.hypot(v.E, v.N)
    if (dist > maxM || dist < minM) continue
    if (dist < 1e-3) {
      // Man steht darauf — dann ist jede Peilung willkürlich, aber näher geht
      // es nicht. Ganz nach vorn.
      out.push({ o, entfernungM: dist, winkelGrad: 0, punkte: 0 })
      continue
    }
    const dot = (v.E * dE + v.N * dN) / dist
    const winkel = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI

    const fern = FERNZIELE.has(String(o.type || "").toLowerCase())
    // MIT BAND entscheidet der WINKEL. Die Entfernung hat der Mensch schon
    // gewählt, indem er den Knopf drückte — sie ein zweites Mal zu gewichten
    // hieße, seine Wahl zu überstimmen. Sie bleibt nur als leiser
    // Gleichstands-Entscheid (höchstens 10 Punkte über das ganze Band).
    //
    // OHNE BAND gelten die zwei Regime: Fernziele zielen (Winkel voll,
    // Entfernung höchstens 25 Punkte), bei allem anderen schlägt Nähe die
    // Richtung — sonst drängt sich Entferntes vor das, was vor einem steht.
    const gebaendert = minM > 0 || maxM < PEIL_MAX_M
    const spanne = Math.max(1, maxM - minM)
    const punkte = gebaendert
      ? winkel + 10 * Math.min(1, (dist - minM) / spanne)
      : fern
        ? winkel + 25 * Math.min(1, dist / maxM)
        : winkel * 0.45 + 140 * Math.min(1, dist / NAH_REICHWEITE_M)
    out.push({ o, entfernungM: dist, winkelGrad: winkel, punkte, fern })
  }
  return out.sort((a, b) => a.punkte - b.punkte)
}
