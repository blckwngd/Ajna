// FusedPositionSource — presents GPS + UWB as ONE position source with the same
// interface as GPSProvider (onPosition / getWorldPosition / waitForFirstFix), so
// PlayerGPSComponent (and waitForOrigin) consume it unchanged.
//
// Priority: while a recent, sufficient-quality UWB fix exists, UWB wins and GPS
// emits are suppressed (no jitter between sources). When UWB goes stale, GPS
// resumes automatically. UWB and GPS stay fully decoupled — with no UWB node
// this behaves exactly like the raw GPSProvider.
//
// Privacy: positions are used on-device only (camera origin); nothing is
// uploaded. UWB lat/lon come from on-device anchor alignment (see UwbManager).

export class FusedPositionSource {
  /**
   * @param {object} gps  GPSProvider (or compatible)
   * @param {object} [uwb] UwbManager (optional; may connect later or never)
   * @param {{staleMs?:number, minQuality?:number}} [opts]
   */
  constructor(gps, uwb, { staleMs = 3000, minQuality = 1 } = {}) {
    this.gps = gps
    this.uwb = uwb
    this.staleMs = staleMs
    this.minQuality = minQuality
    this.listeners = new Set()
    this._last = null
    this._lastUwbAt = 0
    this._lastQuality = null
    this._firstFixResolver = null
    this._unsubs = []
    if (gps?.onPosition) this._unsubs.push(gps.onPosition(p => this._onGps(p)))
    if (uwb?.onPosition) this._unsubs.push(uwb.onPosition(p => this._onUwb(p)))
  }

  /** True while UWB has a recent, good-enough fix and should override GPS. */
  _uwbFresh(now = Date.now()) {
    return this._lastUwbAt > 0 && (now - this._lastUwbAt) < this.staleMs
  }

  _onUwb(p) {
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) return
    if ((p.quality ?? 0) < this.minQuality) return
    this._lastUwbAt = Date.now()
    this._lastQuality = p.quality ?? null
    this._emit({ lat: p.lat, lon: p.lon, altitude: p.altitude ?? 0, accuracy: 0.1, quality: p.quality, source: 'uwb' })
  }

  _onGps(p) {
    if (this._uwbFresh()) return // UWB takes precedence
    this._emit({ ...p, source: p?.source || 'gps' })
  }

  _emit(pos) {
    this._last = pos
    if (this._firstFixResolver) {
      const r = this._firstFixResolver; this._firstFixResolver = null; r(pos)
    }
    this.listeners.forEach(l => { try { l(pos) } catch (e) { console.error('FusedPositionSource listener error', e) } })
  }

  // ── GPSProvider-compatible surface ──────────────────────────────────

  onPosition(callback) {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  getWorldPosition() {
    return this._last || this.gps?.getWorldPosition?.() || null
  }

  async waitForFirstFix() {
    const existing = this.getWorldPosition()
    if (existing) return existing
    return new Promise(resolve => { this._firstFixResolver = resolve })
  }

  /** Current active source ('uwb' | 'gps' | null) — handy for debug/UI. */
  get activeSource() {
    if (this._uwbFresh()) return 'uwb'
    return this._last ? (this._last.source || 'gps') : null
  }

  /** Last UWB quality factor (0–100) while UWB is the active source, else null. */
  get quality() {
    return this._uwbFresh() ? this._lastQuality : null
  }

  dispose() {
    this._unsubs.forEach(fn => { try { fn() } catch {} })
    this._unsubs = []
    this.listeners.clear()
  }
}
