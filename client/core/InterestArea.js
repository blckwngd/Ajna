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
  get _client() { return this.ajna.defaultClient }
  _url(path) { return (this._client?.url || '').replace(/\/+$/, '') + path }
  _headers() {
    const token = this._client?.pb?.authStore?.token
    const h = { 'Content-Type': 'application/json' }
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }

  async _tick() {
    if (!InterestArea.isEnabled()) return
    if (!this.ajna.isLoggedIn?.()) return
    const p = this.getPosition?.()
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return
    try {
      await fetch(this._url('/ajnaapi/interest-areas'), {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ bbox: fuzzBbox(p.lat, p.lon), sources: this.getSources() || [] })
      })
    } catch (err) {
      console.warn('[interest-area] publish failed:', err?.message || err)
    }
  }

  async _delete() {
    if (!this.ajna.isLoggedIn?.()) return
    try {
      await fetch(this._url('/ajnaapi/interest-areas'), { method: 'DELETE', headers: this._headers() })
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
