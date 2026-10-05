// interest-areas.mjs — only populate the world where somebody actually is.
//
// WHY. A mirror agent with a fixed configured centre creates objects whether or
// not anyone will ever see them. Measured in the development database on
// 05.10.2026: 2549 C-ITS objects 675 km away (a centre still pointed at Graz),
// 143 WiFi networks at a median of 3.8 km, every one of them out of the
// player's reach. The world director has followed the interest areas since it
// was written; this makes the same path available to the fleet agents.
//
// WHAT AN AREA IS. `GET /ajnaapi/interest-areas` returns an ANONYMISED, merged
// and grid-snapped set of bounding boxes (server/presence.js): no identities,
// no history, three minutes of shelf life, snapped to 250 m so nearby players
// collapse into the same cell. Reading it tells you "somebody is here", never
// "who".
//
// THE TRAP THIS IS MOSTLY ABOUT:
//
//     A FAILED REQUEST IS NOT "NOBODY THERE".
//
// Confuse the two and the next sweep clears half the world over a hiccup in the
// network. Hence `known`: only after one successful request may a caller draw
// any conclusion from `contains()`.
//
// ON THE SOURCE FILTER. The endpoint can narrow areas to those whose publisher
// asked for a particular source. That is too narrow for a mirror: a player
// standing somewhere is a reason to show traffic there whether or not their
// client listed `cits` among its wishes. So the default asks for everything.

const EARTH_KM = 6371

/** Great-circle distance in km. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2
  return EARTH_KM * 2 * Math.asin(Math.sqrt(a))
}

/** Is a point inside a bbox, widened by `bufferM` metres? */
export function inBox(bbox, lat, lon, bufferM = 0) {
  if (!bbox) return false
  const dLat = bufferM / 111320
  const dLon = bufferM / (111320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)))
  return lat >= bbox.latMin - dLat && lat <= bbox.latMax + dLat
      && lon >= bbox.lonMin - dLon && lon <= bbox.lonMax + dLon
}

/** The centre of a bbox. */
export const centreOf = (b) => ({ lat: (b.latMin + b.latMax) / 2, lon: (b.lonMin + b.lonMax) / 2 })

/**
 * Half the diagonal of a bbox in km — the radius that covers it.
 *
 * For agents that cannot ask "is this point inside?" but have to hand a centre
 * and a radius to somebody else's API (WiGLE, Overpass).
 */
export function radiusKmOf(b) {
  const m = centreOf(b)
  return distanceKm(m.lat, m.lon, b.latMax, b.lonMax)
}

const validBox = (b) => !!b && ['latMin', 'latMax', 'lonMin', 'lonMax'].every(k => Number.isFinite(b[k]))

export class InterestAreas {
  /**
   * @param {object} ajna  an AjnaManager/-Client with fetchInterestAreas()
   * @param {object} [opts]
   * @param {string}   [opts.source]   only areas whose publisher asked for this
   *   source. Left out on purpose by default — see the note above.
   * @param {number}   [opts.bufferM=500]  margin around every box. The boxes are
   *   snapped to 250 m and at most ~2 km across; without a margin an object
   *   would vanish the moment the player takes two steps.
   * @param {object[]} [opts.always]  extra fixed boxes (an operator's own say-so)
   * @param {Function} [opts.log]
   * @param {Function} [opts.warn]
   */
  constructor(ajna, { source = null, bufferM = 500, always = [], log = console.log, warn = console.warn } = {}) {
    this.ajna = ajna
    this.source = source
    this.bufferM = bufferM
    this.always = (Array.isArray(always) ? always : []).filter(validBox)
    this.log = log
    this.warn = warn
    this._fetched = []
    /** Has there ever been a successful request? Before that, nothing here means anything. */
    this.known = this.always.length > 0
    this._reported = null
  }

  /** The boxes in force: the operator's fixed ones plus whatever was fetched. */
  get areas() { return [...this.always, ...this._fetched] }
  get count() { return this.areas.length }

  /**
   * Fetch the areas again.
   *
   * If the request fails the LAST state stands and `known` is left alone — one
   * hiccup must not empty the world.
   */
  async refresh() {
    try {
      const raw = await this.ajna.fetchInterestAreas(this.source || undefined)
      // The endpoint returns bare boxes; tolerate a wrapped shape too.
      this._fetched = (Array.isArray(raw) ? raw : []).map(a => a?.bbox || a).filter(validBox)
      this.known = true
      // Only report a change — otherwise the log fills with "4 areas" and that
      // is the same kind of noise as a repeated status message.
      const mark = String(this.count)
      if (mark !== this._reported) {
        this._reported = mark
        this.log(this.count
          ? `${this.count} Interessensgebiet(e) — es wird nur dort gepflegt`
          : 'kein Interessensgebiet gemeldet — es wird nichts Neues angelegt')
      }
      return true
    } catch (err) {
      this.warn(`Interessensgebiete nicht abrufbar: ${err?.message || err}`
        + ` (letzter Stand bleibt: ${this.count} Bereich(e))`)
      return false
    }
  }

  /**
   * Is the point inside one of the areas?
   *
   * Only meaningful while `known` is true. A caller that skips that check reads
   * a failed request as an empty world.
   */
  contains(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
    for (const b of this.areas) if (inBox(b, lat, lon, this.bufferM)) return true
    return false
  }

  /** Centres of all areas — for APIs that insist on a point. */
  centres() { return this.areas.map(centreOf) }

  /** Centres with a radius that covers the box plus the margin, in km. */
  queries() {
    return this.areas.map(b => ({ ...centreOf(b), radiusKm: radiusKmOf(b) + this.bufferM / 1000 }))
  }
}
