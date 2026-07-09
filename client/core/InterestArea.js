// InterestArea — veröffentlicht (nur bei Opt-in) den UNSCHARFEN
// Interessensbereich des Spielers an /ajnaapi/interest-areas, damit Agents
// Daten dort liefern, wo wirklich jemand ist.
//
// Datenschutz:
//   • Opt-in: standardmäßig AUS (localStorage `ajna.share_location`). Solange
//     aus, wird NICHTS übermittelt.
//   • Fuzzing CLIENT-seitig: das Zentrum wird auf ein ~100-m-Raster gesnappt
//     (Abweichung ≤ ~70 m) und eine 500-m-BBOX darum gebildet. Der Server
//     bekommt also nie die genaue Position; er rastert zusätzlich gröber und
//     anonymisiert (siehe server/presence.js).
//   • Beim Ausschalten/Logout wird der eigene Eintrag per DELETE entfernt.

const STORAGE_KEY = 'ajna.share_location'
const PUBLISH_INTERVAL_MS = 60_000
const BBOX_HALF_M = 250    // → 500 m Kantenlänge
const FUZZ_GRID_M = 100    // Zentrum auf dieses Raster snappen

export class InterestArea {
  /**
   * @param {object} opts
   * @param {import('./AjnaManager.js').AjnaManager} opts.ajna
   * @param {() => ({lat:number, lon:number}|null)} opts.getPosition
   * @param {() => string[]} [opts.getSources]  eingeblendete Agent-Quellen
   */
  constructor({ ajna, getPosition, getSources }) {
    this.ajna = ajna
    this.getPosition = getPosition
    this.getSources = getSources || (() => [])
    this._timer = null
  }

  static isEnabled() { try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false } }
  static setEnabled(on) { try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0') } catch {} }

  start() {
    if (this._timer) return
    this._timer = setInterval(() => this._tick(), PUBLISH_INTERVAL_MS)
    this._tick()
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
  }

  /** Vom Einstellungen-Schalter aufgerufen. */
  async onToggle(on) {
    InterestArea.setEnabled(on)
    if (on) await this._tick()
    else await this._delete()   // Opt-out: eigenen Eintrag sofort entfernen
  }

  // ── Internals ──────────────────────────────────────────────────────────
  // HTTP-Aufrufe laufen über die Ajna-Library (ajna.publishInterestArea /
  // deleteInterestArea) — Base-URL + Auth-Token werden dort zentral aufgelöst.
  // Hier bleibt nur die viewer-spezifische Logik: Opt-in-Flag, Polling, Fuzzing.

  async _tick() {
    if (!InterestArea.isEnabled())  return this._note({ ok: false, reason: 'sharing-off' })
    if (!this.ajna.isLoggedIn?.())  return this._note({ ok: false, reason: 'not-logged-in' })
    const p = this.getPosition?.()
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return this._note({ ok: false, reason: 'no-position' })
    const pos = { lat: p.lat, lon: p.lon }
    const bbox = fuzzBbox(p.lat, p.lon)
    const sources = this.getSources() || []
    try {
      await this.ajna.publishInterestArea(bbox, sources)
      return this._note({ ok: true, reason: 'published', pos, bbox, sources })
    } catch (err) {
      return this._note({ ok: false, reason: 'publish-failed', error: err?.message || String(err), pos, bbox, sources })
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

// Unscharfe BBOX: Zentrum aufs Raster snappen, 500-m-Box drumherum.
function fuzzBbox(lat, lon) {
  const cosLat = Math.cos(lat * Math.PI / 180) || 1e-6
  const gLat = FUZZ_GRID_M / 111000
  const gLon = FUZZ_GRID_M / (111000 * cosLat)
  const cLat = Math.round(lat / gLat) * gLat
  const cLon = Math.round(lon / gLon) * gLon
  const dLat = BBOX_HALF_M / 111000
  const dLon = BBOX_HALF_M / (111000 * cosLat)
  return { latMin: cLat - dLat, latMax: cLat + dLat, lonMin: cLon - dLon, lonMax: cLon + dLon }
}
