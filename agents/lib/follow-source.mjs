// follow-source.mjs — react to the objects another agent publishes.
//
// WHAT IT IS FOR. An agent does not have to create everything itself. It can
// attach to somebody else's source: put guide figures next to the Karte-von-
// Morgen entries the POI bridge maintains, hang a quest on every monument, let
// an NPC comment on passing ships.
//
// THE ONE TRAP THIS REMOVES. The current inventory and the stream of changes
// are two different things, and `onObjectEvent` deliberately does NOT fire for
// what is already there — that arrives through `getObjects()`. Writing only
// the subscription gives a world that fills up the next time the *other* agent
// restarts, and the author spends a day looking for the bug in their own code.
// Here both are one call: everything present is replayed as `onAdd` before the
// first live event arrives.
//
//     const stop = followSource(ajna, 'kartevonmorgen', {
//       onAdd:    (obj) => placeGuide(obj),
//       onRemove: (obj) => removeGuide(obj),
//       center, radiusKm,            // optional
//     })
//
// WHAT IT DOES NOT DO: write to those objects. They belong to the other agent,
// and the server enforces that — a write to a record whose `state.source`
// belongs to another account is refused with 403. That is not an obstacle but
// the division of labour: your figure is your own object, carrying your own
// source, pointing at the foreign id.
//
// Requires `bootAgent(..., { connect: true })` — without it there is no object
// cache and no realtime subscription to listen to.

/** Great-circle distance in km. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(a))
}

/** Does this record belong to the source we follow, and is it near enough? */
export function selects(record, { source, center = null, radiusKm = 0, filter = null } = {}) {
  if (!record || record.state?.source !== source) return false
  if (filter && !filter(record)) return false
  if (center && radiusKm > 0) {
    const lat = Number(record.lat), lon = Number(record.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
    if (distanceKm(center.lat, center.lon, lat, lon) > radiusKm) return false
  }
  return true
}

/**
 * Follow a foreign source: inventory first, then every change.
 *
 * @param {object} ajna  an AjnaManager/-Client after `connect()`
 * @param {string} source  the `state.source` to watch
 * @param {object} [opts]
 * @param {(obj: object) => any} [opts.onAdd]     appears (also for the inventory)
 * @param {(obj: object) => any} [opts.onChange]  changed while present
 * @param {(obj: object) => any} [opts.onRemove]  gone, or moved out of range
 * @param {{lat:number, lon:number}} [opts.center]
 * @param {number} [opts.radiusKm=0]  0 = everywhere
 * @param {(obj: object) => boolean} [opts.filter]  extra test, e.g. by kind
 * @param {Function} [opts.warn]
 * @returns {() => void}  stop following
 */
export function followSource(ajna, source, opts = {}) {
  const {
    onAdd = null, onChange = null, onRemove = null,
    center = null, radiusKm = 0, filter = null, warn = console.warn,
  } = opts
  if (!ajna || typeof ajna.onObjectEvent !== 'function') {
    throw new Error('followSource: braucht ein verbundenes ajna (bootAgent mit connect: true)')
  }
  if (!source) throw new Error('followSource: source fehlt')

  const wahl = { source, center, radiusKm, filter }
  /** Which ids we currently consider ours to react to. */
  const drin = new Set()

  // Errors in a caller's handler must not take the subscription down with
  // them — one bad record would otherwise stop every later one.
  const ruf = (fn, obj, was) => {
    if (!fn) return
    try {
      const r = fn(obj)
      if (r && typeof r.then === 'function') r.catch(err => warn(`followSource ${was}: ${err?.message || err}`))
    } catch (err) { warn(`followSource ${was}: ${err?.message || err}`) }
  }

  // 1. THE INVENTORY. Replayed as `onAdd`, so a caller writes the placing
  //    logic once instead of twice.
  for (const obj of (typeof ajna.getObjects === 'function' ? ajna.getObjects() : [])) {
    if (!selects(obj, wahl)) continue
    drin.add(obj.id)
    ruf(onAdd, obj, 'onAdd')
  }

  // 2. THE STREAM.
  const off = ajna.onObjectEvent((record, action) => {
    if (!record?.id) return
    const passt = selects(record, wahl)
    const kannte = drin.has(record.id)

    if (action === 'delete') {
      if (kannte) { drin.delete(record.id); ruf(onRemove, record, 'onRemove') }
      return
    }
    // MOVING OUT OF RANGE IS A REMOVAL, moving in is an addition. Without
    // this, a radius would only ever grow: whatever once matched would keep
    // being reported until it was deleted at the source.
    if (!passt) {
      if (kannte) { drin.delete(record.id); ruf(onRemove, record, 'onRemove') }
      return
    }
    if (!kannte) { drin.add(record.id); ruf(onAdd, record, 'onAdd'); return }
    ruf(onChange, record, 'onChange')
  })

  return () => { try { off?.() } catch {} drin.clear() }
}
