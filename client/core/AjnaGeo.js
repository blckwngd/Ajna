// AjnaGeo — Client-Helper für die Geo-Kontext-API.
//
// Wrappt /ajnaapi/geo/* (Express-Backend) mit lokalem Session-Cache,
// damit wiederholte Anfragen derselben Area keinen Roundtrip kosten.
// Voraussetzung: AjnaManager ist mit der Caddy-fronted URL erzeugt
// (Default in main.js: `window.location.origin`), sonst landet die
// Anfrage am PB-Port und gibt 404.
//
// @example
//   const geo = new AjnaGeo(ajnaManager)
//   const ways = await geo.waysNear(52.5, 13.4, 200)
//   for (const w of ways.features) console.log(w.name, w.coordinates.length)
//
// Per-Server-Routing in Multi-Server-Setups kommt später (V1 nutzt den
// Default-Client). Wer einen anderen Server adressieren will, kann via
// `new AjnaGeo(ajnaManager, { serverId: '...' })` umstellen.

const LOCAL_TTL_MS = 5 * 60 * 1000   // 5 min — kürzer als der Server-Cache,
                                     // dient nur dazu, Spam zu drücken

export class AjnaGeo {
  /**
   * @param {object} ajnaManager
   * @param {{ serverId?: string }} [opts]
   */
  constructor(ajnaManager, { serverId } = {}) {
    this.ajna = ajnaManager
    this._serverId = serverId
    this._cache = new Map()    // key → { ts, payload }
  }

  /** @returns {import('./AjnaClient.js').AjnaClient} */
  get _client() {
    if (this._serverId) {
      const c = this.ajna.clients?.get(this._serverId)
      if (!c) throw new Error(`AjnaGeo: unbekannter Server "${this._serverId}"`)
      return c
    }
    return this.ajna.defaultClient
  }

  /**
   * Straßen/Wege in der Nähe als Polylines.
   * @param {number} lat
   * @param {number} lon
   * @param {number} [radius=200]
   * @param {string} [filter='walkable']  serverseitig erlaubt: walkable | all
   */
  async waysNear(lat, lon, radius = 200, filter = 'walkable') {
    return this._request('ways', { lat, lon, radius, filter })
  }

  /**
   * POIs in der Nähe als Punkte.
   * @param {string} [filter='common']  serverseitig erlaubt: common | amenity | shops | tourism
   */
  async poisNear(lat, lon, radius = 200, filter = 'common') {
    return this._request('pois', { lat, lon, radius, filter })
  }

  /**
   * Gebäude in der Nähe als Polygone (Tags enthalten ggf. building:levels, height).
   */
  async buildingsNear(lat, lon, radius = 200, filter = 'all') {
    return this._request('buildings', { lat, lon, radius, filter })
  }

  /** Diagnose-Endpoint — zeigt erlaubte Filter und Server-Konfig. */
  async info() {
    const r = await fetch(this._url('/ajnaapi/geo/_info'))
    if (!r.ok) throw new Error(`geo info ${r.status}`)
    return r.json()
  }

  /** Lokal-Cache leeren (z. B. nach manuellem Force-Refresh-Knopf). */
  clearCache() { this._cache.clear() }

  // ───────────────────────────────────────────────────────────────────
  //  Internals
  // ───────────────────────────────────────────────────────────────────

  async _request(endpoint, params) {
    const key = `${endpoint}|${JSON.stringify(params)}`
    const hit = this._cache.get(key)
    if (hit && (Date.now() - hit.ts) < LOCAL_TTL_MS) return hit.payload

    const qs  = new URLSearchParams(params).toString()
    const url = this._url(`/ajnaapi/geo/${endpoint}?${qs}`)
    const token = this._client.pb.authStore.token

    const r = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    })
    if (!r.ok) {
      const detail = await r.text().catch(() => '')
      throw new Error(`geo/${endpoint} ${r.status}: ${detail}`)
    }
    const payload = await r.json()
    this._cache.set(key, { ts: Date.now(), payload })
    return payload
  }

  _url(path) {
    const base = this._client.url || ''
    return base.replace(/\/+$/, '') + path
  }
}
