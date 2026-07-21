// InterestArea — veröffentlicht den Interessensbereich des Spielers an
// /ajnaapi/interest-areas, damit Agents Daten dort liefern, wo wirklich jemand ist.
//
// Datenschutz:
//   • Die Stufe bestimmt PrivacyPolicy — pro Server (Verborgen/Gegend/Nähe/Genau).
//     Standard ist „Verborgen": ohne Zutun wird NICHTS übermittelt.
//   • Diese Klasse ENTSCHEIDET NICHT, wer was bekommt. Sie liefert nur beide
//     Ausprägungen (gefuzzt + exakt); ausgewählt wird pro Server im Fan-out
//     (AjnaManager) — dort ist der Choke-Point, an dem nichts durchrutschen kann.
//   • Fuzzing CLIENT-seitig: Zentrum auf ~100-m-Raster gesnappt (Abweichung
//     ≤ ~70 m), 500-m-BBOX darum. Der Server rastert zusätzlich und anonymisiert
//     (siehe server/presence.js).
//   • Fällt ein Server auf „Verborgen", wird sein Eintrag sofort gelöscht.

import { privacy, fuzzPoint, FUZZ_GRID_M } from './PrivacyPolicy.js'

const PUBLISH_INTERVAL_MS = 60_000
const PUBLISH_MOVE_M = 60   // Positions-Delta ab dem sofort neu publiziert wird
const BBOX_HALF_M = 250    // → 500 m Kantenlänge (Raster: FUZZ_GRID_M aus PrivacyPolicy)

export class InterestArea {
  /**
   * @param {object} opts
   * @param {import('./AjnaManager.js').AjnaManager} opts.ajna
   * @param {() => ({lat:number, lon:number}|null)} opts.getPosition
   * @param {() => string[]} [opts.getSources]  eingeblendete Agent-Quellen
   * @param {{onPosition?: (cb:(p:any)=>void)=>(()=>void)}} [opts.positionSource]
   *   Optional: Positionsquelle mit onPosition-Event. Damit publisht die Area
   *   EVENT-getrieben — beim Erst-Fix, bei größerer Positionsänderung und beim
   *   Wechsel Dummy↔Live (source-Feld) — statt nur alle 60 s.
   */
  constructor({ ajna, getPosition, getSources, positionSource = null }) {
    this.ajna = ajna
    this.getPosition = getPosition
    this.getSources = getSources || (() => [])
    this._timer = null
    this._pubPos = null      // Position des letzten erfolgreichen Publishs
    this._pubSource = null   // dessen Quelle (gps/dummy/uwb) — für Toggle-Erkennung
    this._posUnsub = null
    if (positionSource?.onPosition) {
      this._posUnsub = positionSource.onPosition(p => this._onPositionEvent(p))
    }
  }

  // Positions-Event: publisht sofort bei Erst-Fix, größerer Bewegung
  // (> PUBLISH_MOVE_M) oder Quellenwechsel (Dummy↔Live). Sonst hält der
  // 60-s-Timer die Area (TTL) am Leben.
  _onPositionEvent(p) {
    if (!this._anyServerShares()) return
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return
    const src = p.source || 'gps'
    const moved = this._pubPos ? distM(this._pubPos.lat, this._pubPos.lon, p.lat, p.lon) : Infinity
    if (!this._pubPos || moved > PUBLISH_MOVE_M || src !== this._pubSource) {
      this._tick()
    }
  }

  /** IDs aller bekannten Server — Basis für die „teilt überhaupt jemand?"-Frage. */
  _serverIds() {
    try { return (this.ajna.getServers?.() || []).map(s => s.id) } catch { return [] }
  }
  _anyServerShares() { return privacy.anyEnabled(this._serverIds()) }

  start() {
    if (this._timer) return
    this._timer = setInterval(() => this._tick(), PUBLISH_INTERVAL_MS)
    // Stufenwechsel wirkt sofort: hochstufen → neu publizieren; runter auf
    // „Verborgen" → den Eintrag dort löschen. Ohne das würde die alte (evtl.
    // genauere) Area bis zum TTL-Ablauf weiterleben.
    this._privacyUnsub = privacy.onChange(() => this._onPrivacyChange())
    this._tick()
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    if (this._posUnsub) { this._posUnsub(); this._posUnsub = null }
    if (this._privacyUnsub) { this._privacyUnsub(); this._privacyUnsub = null }
  }

  // Stufenwechsel: ERST überall löschen, DANN neu publizieren.
  // Naheliegender wäre „nur bei Verborgen löschen, sonst neu publizieren" — das
  // ließe aber beim Herunterstufen (Genau → Gegend) den alten, feineren Eintrag
  // bis zum TTL (3 min) stehen, falls gerade keine Position vorliegt. Ein
  // Wechsel muss sofort wirken, auch ohne Fix; die Sekunde Lücke ist der Preis.
  async _onPrivacyChange() {
    await this._delete()
    if (this._anyServerShares()) await this._tick()
  }

  // ── Internals ──────────────────────────────────────────────────────────
  // HTTP-Aufrufe laufen über die Ajna-Library (ajna.publishInterestArea /
  // deleteInterestArea) — Base-URL + Auth-Token werden dort zentral aufgelöst.
  // Hier bleibt nur die viewer-spezifische Logik: Polling und Fuzzing.

  async _tick() {
    if (!this._anyServerShares())   return this._note({ ok: false, reason: 'sharing-off' })
    if (!this.ajna.isLoggedIn?.())  return this._note({ ok: false, reason: 'not-logged-in' })
    const p = this.getPosition?.()
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return this._note({ ok: false, reason: 'no-position' })
    const pos = { lat: p.lat, lon: p.lon }
    // Beide Ausprägungen mitgeben — welche ein Server bekommt (oder ob er leer
    // ausgeht), entscheidet der Fan-out anhand seiner Stufe.
    const variants = { fuzzed: fuzzBbox(p.lat, p.lon), exact: exactBbox(p.lat, p.lon) }
    const sources = this.getSources() || []
    try {
      await this.ajna.publishInterestArea(variants, sources)
      this._pubPos = pos
      this._pubSource = p.source || 'gps'
      return this._note({ ok: true, reason: 'published', pos, bbox: variants.fuzzed, sources })
    } catch (err) {
      return this._note({ ok: false, reason: 'publish-failed', error: err?.message || String(err), pos, bbox: variants.fuzzed, sources })
    }
  }

  // Letzten Publish-Versuch merken (für Debug-Anzeige/Konsole). Grund + Quellen +
  // BBOX helfen zu lokalisieren, warum ein Agent (z. B. world-director) nichts sieht.
  _note(info) {
    this.last = { at: Date.now(), ...info }
    if (this._debug) console.debug('[interest-area]', this.last.reason, this.last)
    return this.last
  }

  /** Letzter Publish-Status: {at, ok, reason, sources?, bbox?, pos?, error?} | null */
  getLast() { return this.last || null }
  /** Konsolen-Logging pro Tick an/aus. */
  setDebug(on) { this._debug = !!on; return this }
  /** Sofortiger Publish-Versuch (Debug/„jetzt teilen"). */
  publishNow() { return this._tick() }

  async _delete() {
    if (!this.ajna.isLoggedIn?.()) return
    try {
      await this.ajna.deleteInterestArea()
    } catch { /* egal */ }
  }
}

// Grobe Distanz in Metern (Äquirektangular — für Schwellwert genau genug).
function distM(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * 111320
  const dLon = (bLon - aLon) * 111320 * Math.cos(aLat * Math.PI / 180)
  return Math.hypot(dLat, dLon)
}

// Exakte BBOX: gleiche Kantenlänge, aber ohne Raster-Snap — das Zentrum IST die
// echte Position. Nur für Server der Stufe „Genau".
function exactBbox(lat, lon) {
  const cosLat = Math.cos(lat * Math.PI / 180) || 1e-6
  const dLat = BBOX_HALF_M / 111000
  const dLon = BBOX_HALF_M / (111000 * cosLat)
  return { latMin: lat - dLat, latMax: lat + dLat, lonMin: lon - dLon, lonMax: lon + dLon }
}

// Unscharfe BBOX: Zentrum aufs Raster snappen (fuzzPoint aus PrivacyPolicy — die
// EINE Vergröberungs-Implementierung), 500-m-Box drumherum.
function fuzzBbox(lat, lon) {
  const cosLat = Math.cos(lat * Math.PI / 180) || 1e-6
  const c = fuzzPoint(lat, lon, FUZZ_GRID_M)
  const dLat = BBOX_HALF_M / 111000
  const dLon = BBOX_HALF_M / (111000 * cosLat)
  return { latMin: c.lat - dLat, latMax: c.lat + dLat, lonMin: c.lon - dLon, lonMax: c.lon + dLon }
}
