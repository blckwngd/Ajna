// renderRange — Sichtweiten der 3D-/AR-Ansicht, gerätelokal einstellbar.
//
// Drei Regler, weil die drei Dinge technisch NICHT dasselbe kosten und nicht
// dasselbe bedeuten:
//
//   • objects — Objekte (Agenten-Daten + eigene). Rein datengetrieben; die
//     Grenze wirkt als horizontale Distanz zur Kamera. Vorgabe „unbegrenzt",
//     sonst verschwänden Flugzeuge und Schiffe, die naturgemäß weit weg sind.
//   • scenery — Kulisse aus OSM (Gebäude, Straßen, Wasser, Gleise). EIN Regler
//     für alle vier, weil sie aus derselben Kachelabfrage stammen und
//     denselben Radius teilen — sie getrennt einstellbar zu machen, wäre eine
//     Bedienoberfläche für eine Unterscheidung, die es technisch nicht gibt.
//   • terrain — Geländerelief. Getrennt, weil es je Fläche viel billiger ist
//     als Gebäudegeometrie und deshalb sinnvoll deutlich weiter reicht.
//   • anim — ab welcher Entfernung Figuren stillstehen. NICHT dasselbe wie
//     „objects": Ein fernes Objekt soll sichtbar bleiben, nur seine
//     Skelett-Animation kostet pro Frame Knochen-Matrizen. Die Grenze wird
//     zusätzlich mit der GRÖSSE der Figur gestreckt — ein Drache ist auf 300 m
//     noch bildfüllend, ein Fuchs dort ein Punkt (siehe animRadiusFuer).
//
// ABHÄNGIGKEIT: die Kulisse legt sich über den Höhen-Kachel-Cache des Reliefs
// (`GeoTransformer.terrainHeightAt`). Reicht sie weiter als das Relief, würden
// die äußeren Gebäude flach auf die Nullebene gezeichnet. Deshalb liefert
// `effectiveTerrain()` immer mindestens den Kulissen-Radius.

export const RANGE_EVENT = 'ajna:render-range'

export const RANGE_DEFS = {
  objects: { key: 'ajna.render.objects_m', min: 100, max: 5000, step: 100, def: Infinity, unbegrenzt: true },
  scenery: { key: 'ajna.render.scenery_m', min: 100, max: 2000, step: 50,  def: 300 },
  terrain: { key: 'ajna.render.terrain_m', min: 300, max: 3000, step: 100, def: 1200 },
  anim:    { key: 'ajna.render.anim_m',    min: 50,  max: 2000, step: 50,  def: 150, unbegrenzt: true },
}

/**
 * Wie weit DIESE Figur animiert bleibt.
 *
 * Die eingestellte Distanz gilt für eine Figur von Menschengröße. Große
 * Objekte bekommen mehr, weil sie am Himmel noch groß im Bild stehen, wenn ein
 * Fuchs längst ein Pixel ist — ein stillstehender Drache in 200 m Entfernung
 * fällt sofort auf, ein stillstehender Fuchs nie.
 *
 * @param {number} basis   eingestellte Distanz in Metern
 * @param {number} hoeheM  Höhe der Figur (Bounding-Box), Meter
 */
export function animRadiusFuer(basis, hoeheM) {
  if (!Number.isFinite(basis) || basis <= 0) return basis
  const h = Number(hoeheM)
  if (!Number.isFinite(h) || h <= 0) return basis
  // Bezug ist Menschengröße; die Streckung wächst linear mit der Höhe, aber
  // gedeckelt — sonst animierte ein 100-m-Objekt über den halben Horizont.
  const faktor = Math.min(8, Math.max(1, h / 1.8))
  return basis * faktor
}

const INF = 'inf'

/** Gespeicherten Wert lesen; Infinity für „unbegrenzt". */
export function readRange(name) {
  const d = RANGE_DEFS[name]
  if (!d) return NaN
  let raw = null
  try { raw = localStorage.getItem(d.key) } catch {}
  if (raw === null || raw === '') return d.def
  if (raw === INF) return d.unbegrenzt ? Infinity : d.max
  const v = parseFloat(raw)
  if (!Number.isFinite(v)) return d.def
  return Math.max(d.min, Math.min(d.max, v))
}

export function writeRange(name, value) {
  const d = RANGE_DEFS[name]
  if (!d) return
  const raw = (d.unbegrenzt && !Number.isFinite(value)) ? INF : String(value)
  try { localStorage.setItem(d.key, raw) } catch {}
}

export function readAllRanges() {
  const out = {}
  for (const name of Object.keys(RANGE_DEFS)) out[name] = readRange(name)
  return out
}

/** Reliefradius, der die Kulisse sicher unterlegt (siehe Kopfkommentar). */
export const effectiveTerrain = (ranges) => Math.max(ranges.terrain, ranges.scenery)

/** Reglerstellung → Wert: die oberste Rasterung bedeutet „unbegrenzt". */
export function valueFromSlider(name, sliderValue) {
  const d = RANGE_DEFS[name]
  const v = Number(sliderValue)
  if (!d || !Number.isFinite(v)) return NaN
  return (d.unbegrenzt && v >= d.max) ? Infinity : v
}

/** Wert → Reglerstellung (Infinity sitzt ganz rechts). */
export const sliderFromValue = (name, value) =>
  Number.isFinite(value) ? value : RANGE_DEFS[name].max

export function formatRange(value) {
  if (!Number.isFinite(value)) return '∞'
  return value >= 1000 ? `${(value / 1000).toFixed(1).replace('.0', '')} km` : `${Math.round(value)} m`
}
