// fleet.mjs — mirroring moving things into Ajna objects.
//
// WHY THIS EXISTS. Three agents mirror vehicles today — aircraft, ships, and
// now road traffic — and each grew its own copy of the same hundred lines:
// a map from foreign id to object, create-or-update, a write throttle, a guard
// against overlapping writes, and a sweep for things that went away.
//
// The copies are not identical, and that is the problem. Every one of them had
// to rediscover the same three traps:
//
//   1. RESERVE THE SLOT BEFORE CREATING. Two position reports for the same
//      vehicle can arrive while the first create is still in flight. Without a
//      reserved slot both see "not known yet" and the world gets two ships.
//   2. DROP THE SLOT WHEN THE CREATE FAILS. Otherwise the id stays reserved
//      forever and that vehicle never appears, silently, until a restart.
//   3. ADOPTED OBJECTS COUNT AS JUST SEEN. A restart must not let the sweep
//      delete everything that existed before it, one second in.
//
// WHY NOT ONE BIG AGENT INSTEAD: because the three differ exactly where it
// matters operationally — one polls with an hourly budget, two hold a
// WebSocket, each has its own credentials, its own account and its own
// manifest. Merging them would mean a parser fault in one takes the other two
// down with it, and pm2 could no longer restart them apart. The repetition was
// worth removing; the isolation was not.

import { yawFuerKursGrad } from '../../client/core/yaw.js'

/**
 * @typedef {object} Sighting
 * @property {string} [name]
 * @property {number} lat
 * @property {number} lon
 * @property {number} [altitude]
 * @property {number} [headingDeg]   compass degrees, 0 = north
 * @property {string} [description]
 * @property {object} [appearance]
 * @property {object} [state]        merged over the identity fields
 * @property {Array}  [actions]
 */

export class Fleet {
  /**
   * @param {object} ajna   AjnaManager
   * @param {object} opts
   * @param {string} opts.type            Ajna object type ("ship", "aircraft", …)
   * @param {string} opts.source          content-filter source, goes into `state.source`
   * @param {string} opts.keyField        `state` field carrying the foreign id
   * @param {number} [opts.updateIntervalMs]  smallest gap between two writes per object
   * @param {number} [opts.staleMs]       unseen for this long → sweep removes it
   * @param {string} [opts.tag]           log prefix
   */
  constructor(ajna, {
    type, source, keyField,
    updateIntervalMs = 5000, staleMs = 15 * 60_000,
    tag = 'fleet', log = null, warn = null,
  }) {
    if (!type || !source || !keyField) throw new Error('Fleet: type, source and keyField are required')
    this.ajna = ajna
    this.type = type
    this.source = source
    this.keyField = keyField
    this.updateIntervalMs = updateIntervalMs
    this.staleMs = staleMs
    this.tag = tag
    // The caller's logger usually carries its own tag (bootAgent gives one).
    // Only the fallback adds one — otherwise every line reads `[cits] [cits]`.
    this.log = log || ((m) => console.log(`[${tag}] ${m}`))
    this.warn = warn || ((m) => console.warn(`[${tag}] ${m}`))
    /** @type {Map<string, {objectId: string|null, name: string, lastWriteMs: number, lastSeenMs: number, inflight: boolean}>} */
    this.slots = new Map()
  }

  get size() { return this.slots.size }
  has(key) { return this.slots.has(String(key)) }
  objectIdOf(key) { return this.slots.get(String(key))?.objectId || null }

  /**
   * Take over what is already in the world.
   *
   * Everything adopted counts as seen RIGHT NOW — see trap 3 in the header.
   * Objects of a different type or source are ignored, so two agents can share
   * one account without eating each other's objects.
   */
  adopt(objects, now = Date.now()) {
    let n = 0
    for (const o of objects || []) {
      if (o?.type !== this.type) continue
      if (o?.state?.source && o.state.source !== this.source) continue
      const key = o?.state?.[this.keyField]
      if (key === undefined || key === null || key === '') continue
      this.slots.set(String(key), {
        objectId: o.id, name: o.name || '',
        lastWriteMs: 0, lastSeenMs: now, inflight: false,
      })
      n++
    }
    return n
  }

  /** The fields every object of this fleet carries, whatever the agent adds. */
  _stateFor(key, extra) {
    return { ...(extra || {}), [this.keyField]: String(key), source: this.source }
  }

  _bodyFor(key, s) {
    const body = {
      lat: s.lat, lon: s.lon,
      state: this._stateFor(key, s.state),
    }
    if (Number.isFinite(s.altitude)) body.altitude = s.altitude
    if (Number.isFinite(s.headingDeg)) body.rotation = { x: 0, y: yawFuerKursGrad(s.headingDeg), z: 0 }
    if (s.appearance) body.appearance = s.appearance
    if (s.actions) body.state.actions = s.actions
    return body
  }

  /**
   * A new sighting: create the object, or update it if the throttle allows.
   *
   * Returns 'created' | 'updated' | 'throttled' | 'busy' | 'failed'. The caller
   * usually ignores it; it exists so tests can see what happened without
   * reading the log.
   */
  async seen(key, sighting, now = Date.now()) {
    const id = String(key)
    if (!Number.isFinite(sighting?.lat) || !Number.isFinite(sighting?.lon)) return 'failed'
    const slot = this.slots.get(id)

    if (!slot) {
      // Trap 1: reserve before creating.
      const neu = {
        objectId: null, name: sighting.name || id,
        lastWriteMs: now, lastSeenMs: now, inflight: true,
      }
      this.slots.set(id, neu)
      try {
        const body = this._bodyFor(id, sighting)
        const obj = await this.ajna.createObject({
          name: sighting.name || id,
          type: this.type,
          description: sighting.description || '',
          altitude: 0,
          ...body,
        })
        neu.objectId = obj.id
        this.log(`+ ${neu.name} (${id}) → ${obj.id}`)
        return 'created'
      } catch (err) {
        // Trap 2: free the slot so the next sighting tries again.
        this.slots.delete(id)
        this.warn(`anlegen ${id}: ${err?.response?.data?.message || err?.message || err}`)
        return 'failed'
      } finally {
        const s = this.slots.get(id)
        if (s) s.inflight = false
      }
    }

    slot.lastSeenMs = now
    if (!slot.objectId) return 'busy'                                 // create still running
    if (slot.inflight) return 'busy'                                  // write still running
    if (now - slot.lastWriteMs < this.updateIntervalMs) return 'throttled'

    const patch = this._bodyFor(id, sighting)
    // The name is only written when it really changed — otherwise every update
    // carries it and every client gets a realtime message for nothing.
    if (sighting.name && sighting.name !== slot.name) patch.name = sighting.name
    if (sighting.description) patch.description = sighting.description

    slot.inflight = true
    try {
      await this.ajna.updateObject(slot.objectId, patch)
      slot.lastWriteMs = now
      if (patch.name) slot.name = patch.name
      return 'updated'
    } catch (err) {
      this.warn(`aendern ${id}: ${err?.response?.data?.message || err?.message || err}`)
      return 'failed'
    } finally {
      slot.inflight = false
    }
  }

  /** Remove one object — for sources that say goodbye explicitly. */
  async drop(key) {
    const id = String(key)
    const slot = this.slots.get(id)
    if (!slot) return false
    this.slots.delete(id)
    if (!slot.objectId) return false
    try {
      await this.ajna.deleteObject(slot.objectId)
      return true
    } catch (err) {
      // Already gone on the server is the normal case after a manual cleanup.
      const msg = err?.response?.data?.message || err?.message || ''
      if (!/not found|404/i.test(String(msg))) this.warn(`loeschen ${id}: ${msg}`)
      return false
    }
  }

  /**
   * Remove everything not seen for `staleMs`.
   *
   * `behalte(key, slot)` can keep single objects — an agent may know that a
   * parked tram is still there even though it stopped talking.
   */
  async sweep(now = Date.now(), behalte = null) {
    const faellig = []
    for (const [key, slot] of this.slots) {
      if (slot.inflight || !slot.objectId) continue
      if (now - slot.lastSeenMs < this.staleMs) continue
      if (behalte && behalte(key, slot)) continue
      faellig.push(key)
    }
    let weg = 0
    for (const key of faellig) if (await this.drop(key)) weg++
    if (weg) this.log(`${weg} verschwundene entfernt (${this.slots.size} bleiben)`)
    return weg
  }
}
