// ProximityReporter — Privatsphäre-Stufe „Nähe".
//
// Meldet Agents, dass jemand bei ihrem Objekt steht, OHNE die Position zu
// senden: der Client kennt seine exakte Position, rechnet den Umkreis selbst
// aus und schickt nur Objekt-IDs — dieselbe Linie wie beim Zauberstab, der
// `interact(objectId, action)` sendet und nie Koordinaten.
//
// Gemeldet werden nur ÜBERGÄNGE (betreten/verlassen), nicht der Zustand pro
// Tick. Ein Spieler, der an einer Grenze steht, würde sonst im Sekundentakt
// enter/leave feuern — für den Agent Lärm, für den Server ein feiner
// Positionsverlauf. Dagegen die Hysterese unten.
//
// Durchgesetzt wird die Stufe NICHT hier, sondern in AjnaManager.reportProximity
// (Choke-Point). Diese Klasse rechnet nur; sie darf sich irren, ohne dass etwas
// ausläuft.
//
// GRENZE, bewusst: der Client ist die einzige Positionsquelle, kann Nähe also
// auch behaupten. Näherungs-Auslöser taugen zur Belebung, nicht als Nachweis —
// siehe POST /api/proximity in main.pb.js.

import { privacy } from './PrivacyPolicy.js'

const RADIUS_M = 50          // „bei mir" — grob Sichtweite/Ansprechweite
const LEAVE_FACTOR = 1.3     // Hysterese: raus erst bei 65 m (Flattern an der Kante)
const TICK_MS = 5_000        // Fallback-Takt; primär treibt die Positionsquelle

export class ProximityReporter {
  /**
   * @param {object} opts
   * @param {import('./AjnaManager.js').AjnaManager} opts.ajna
   * @param {() => ({lat:number, lon:number}|null)} opts.getPosition  EXAKTE Position (bleibt hier)
   * @param {number} [opts.radiusM]
   * @param {{onPosition?: (cb:(p:any)=>void)=>(()=>void)}} [opts.positionSource]
   */
  constructor({ ajna, getPosition, radiusM = RADIUS_M, positionSource = null }) {
    this.ajna = ajna
    this.getPosition = getPosition
    this.radiusM = radiusM
    this._near = new Set()      // Composite-IDs, deren „enter" schon raus ist
    this._objects = []
    this._timer = null
    this._unsubs = []
    this._positionSource = positionSource
  }

  start() {
    if (this._timer) return
    this._objects = this._geoObjects(this.ajna.getObjects?.() || [])
    this._unsubs.push(this.ajna.onObjectsChanged?.(list => { this._objects = this._geoObjects(list) }))
    if (this._positionSource?.onPosition) {
      this._unsubs.push(this._positionSource.onPosition(() => this._tick()))
    }
    // Stufenwechsel: fällt ein Server unter „Nähe", muss die letzte Anwesenheit
    // dort zurückgenommen werden — sonst bleibt der Spieler für den Agent für
    // immer anwesend. Das `leave` lässt der Manager bewusst durch.
    this._unsubs.push(privacy.onChange(() => this._retractBlocked()))
    this._timer = setInterval(() => this._tick(), TICK_MS)
    this._tick()
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    for (const un of this._unsubs) { try { un?.() } catch {} }
    this._unsubs = []
    this._retractAll()
  }

  /** Aktueller Umkreis-Stand (Debug/Anzeige). */
  getNear() { return Array.from(this._near) }

  // ── Internals ──────────────────────────────────────────────────────────

  _geoObjects(list) {
    return (list || []).filter(o => Number.isFinite(o?.lat) && Number.isFinite(o?.lon) && !o.carried_by)
  }

  async _tick() {
    const p = this.getPosition?.()
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return

    const enter = []
    const stillNear = new Set()
    for (const o of this._objects) {
      const d = distM(p.lat, p.lon, o.lat, o.lon)
      const wasNear = this._near.has(o.id)
      // Asymmetrische Schwelle: rein bei R, raus erst bei R*1.3.
      if (d <= this.radiusM || (wasNear && d <= this.radiusM * LEAVE_FACTOR)) {
        stillNear.add(o.id)
        if (!wasNear) enter.push(o.id)
      }
    }
    // Verschwundene Objekte (gelöscht/gefiltert) zählen als verlassen.
    const leave = Array.from(this._near).filter(id => !stillNear.has(id))
    if (!enter.length && !leave.length) return

    this._near = stillNear
    try { await this.ajna.reportProximity({ enter, leave }) }
    catch (err) { console.debug('[proximity] melden fehlgeschlagen:', err?.message || err) }
  }

  /** Server, die keine Nähe mehr dürfen: Anwesenheit dort zurücknehmen. */
  async _retractBlocked() {
    const blocked = Array.from(this._near).filter(id => {
      const sid = String(id).split(':')[0]
      return !privacy.allows(sid, 'proximity')
    })
    if (!blocked.length) return
    for (const id of blocked) this._near.delete(id)
    try { await this.ajna.reportProximity({ leave: blocked }) } catch {}
  }

  async _retractAll() {
    const all = Array.from(this._near)
    this._near.clear()
    if (all.length) { try { await this.ajna.reportProximity({ leave: all }) } catch {} }
  }
}

// Grobe Distanz in Metern (Äquirektangular — auf 50 m genau genug).
function distM(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * 111320
  const dLon = (bLon - aLon) * 111320 * Math.cos(aLat * Math.PI / 180)
  return Math.hypot(dLat, dLon)
}
