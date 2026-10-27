// AimController — the pointing mode as a state machine, without devices.
//
// It gets two things: pointing samples from the ONE active pointing source
// (`sample({yaw, pitch, accuracy, t})`) and semantic actions from any number
// of input devices (`action('select_target')`). It answers with events:
// which object is aimed at, which one is selected, what to feel, what to
// say. Which device delivers or receives what is DeviceManager's business.
//
// THE FLOW
//   aim_toggle      start aiming (the pointing source starts streaming)
//   …               the target follows the arm, with hysteresis
//   aim_toggle /    stop aiming and SELECT what was aimed at LOOKBACK_MS ago —
//   select_target   the arm drops while the button is pressed; the sample
//                   from just before is the one the player meant
//   interact_N      act on the selected object: its N-th offered action
//   announce_target say the name (only on request — never automatically)
//   cancel          stop aiming without selecting, or drop the selection
//   next/prev       step through the candidates in the cone
//
// Raise-to-aim (optional): lifting the arm above `raiseDeg` starts aiming,
// lowering it below `lowerDeg` selects. The lookback makes the lowering safe.

import { rangiereNachPeilung } from '../PointingResolver.js'
import { coneForAccuracy, angleDiff } from './aimMath.js'

const DEFAULTS = {
  coneDeg: 12,            // acquire cone for an accurate source
  releaseFactor: 1.6,     // keep the current target until it leaves cone × this
  maxRangeM: 400,         // nothing farther is offered while pointing
  holdMs: 250,            // a new best must stay best this long before it wins
  switchMarginDeg: 3,     // … and beat the current one by this many degrees
  lookbackMs: 200,        // the selection uses the target from this long ago
  historyMs: 3000,        // how much target history to keep
  pinMs: 1500,            // next/prev pins the manual choice this long
  maxCandidates: 8,
  raiseToAim: false,
  raiseDeg: 35,           // arm above this → aiming starts (raise-to-aim)
  lowerDeg: 10,           // arm below this while raise-aiming → select
  raiseHoldMs: 300,
}

export class AimController {
  /**
   * @param {object} deps
   * @param {() => ({lat:number, lon:number}|null)} deps.getOrigin   player position, on the device
   * @param {() => Array<object>} deps.getObjects                     visible objects (lat, lon, id, name, type)
   * @param {(obj:object) => string[]} [deps.getActions]              offered action keys of an object
   * @param {(id:string, action:string) => Promise<any>} [deps.interact]
   * @param {() => number} [deps.now]
   * @param {object} [opts]  see DEFAULTS
   */
  constructor({ getOrigin, getObjects, getActions = defaultActions, interact = null, now = () => Date.now() } = {}, opts = {}) {
    this.getOrigin = getOrigin
    this.getObjects = getObjects
    this.getActions = getActions
    this.interact = interact
    this.now = now
    this.o = { ...DEFAULTS, ...opts }
    this.aiming = false
    this.aimSource = null           // 'action' | 'raise'
    this.target = null              // { id, name, type, distanceM, angleDeg }
    this.locked = null              // same shape
    this.candidates = []
    this.accuracyDeg = null
    this._pending = null            // { id, since }
    this._pinnedUntil = 0
    this._history = []              // [{ t, target }]
    this._raiseSince = null
    this._lastSample = null
    this._cbs = new Map()
  }

  // ── events ─────────────────────────────────────────────────────────────
  // 'mode' {aiming} · 'target' target|null · 'lock' target|null
  // 'feedback' {event, objectType?} · 'announce' {text} · 'notice' {text}
  // 'interact' {id, action, ok, error?} · 'calibrate' {}
  on(event, cb) {
    if (!this._cbs.has(event)) this._cbs.set(event, new Set())
    this._cbs.get(event).add(cb)
    return () => this._cbs.get(event)?.delete(cb)
  }
  _emit(event, payload) {
    for (const cb of this._cbs.get(event) || []) { try { cb(payload) } catch (err) { console.warn('[aim]', event, err?.message || err) } }
  }
  _feel(event, objectType) { this._emit('feedback', { event, objectType }) }

  setOptions(opts) { this.o = { ...this.o, ...opts } }

  // ── pointing samples ───────────────────────────────────────────────────

  /** One sample from the active pointing source. `yaw` is already calibrated. */
  sample({ yaw, pitch = 0, accuracy = null, t = this.now() } = {}) {
    if (!Number.isFinite(yaw)) return
    this._lastSample = { yaw, pitch, accuracy, t }
    if (Number.isFinite(accuracy)) this.accuracyDeg = accuracy

    if (this.o.raiseToAim) this._raise(pitch, t)
    if (!this.aiming) return
    this._retarget(yaw, t)
  }

  _raise(pitch, t) {
    if (!Number.isFinite(pitch)) return
    if (!this.aiming) {
      if (pitch >= this.o.raiseDeg) {
        if (this._raiseSince === null) this._raiseSince = t
        else if (t - this._raiseSince >= this.o.raiseHoldMs) { this._raiseSince = null; this._startAim('raise') }
      } else this._raiseSince = null
    } else if (this.aimSource === 'raise' && pitch <= this.o.lowerDeg) {
      this._select()
    }
  }

  _cone() { return coneForAccuracy(this.o.coneDeg, this.accuracyDeg) }

  _rank(yaw) {
    const origin = this.getOrigin?.()
    if (!origin || !Number.isFinite(origin.lat)) return []
    const objekte = (this.getObjects?.() || []).filter(o => o && o.id && Number.isFinite(o.lat) && Number.isFinite(o.lon))
    const cone = this._cone() * this.o.releaseFactor
    return rangiereNachPeilung({ origin, kursGrad: yaw, objekte, maxM: this.o.maxRangeM })
      .filter(r => r.winkelGrad <= cone)
      .slice(0, this.o.maxCandidates)
      .map(r => ({ id: r.o.id, name: r.o.name || null, type: r.o.type || null, distanceM: Math.round(r.entfernungM), angleDeg: r.winkelGrad, obj: r.o }))
  }

  _retarget(yaw, t) {
    this.candidates = this._rank(yaw)
    const cone = this._cone()
    const current = this.target ? this.candidates.find(c => c.id === this.target.id) : null
    const best = this.candidates.find(c => c.angleDeg <= cone) || null

    let next = this.target
    if (t < this._pinnedUntil && current) {
      next = current                                   // a manual next/prev choice holds
    } else if (!current) {
      next = best                                      // current left the release cone
      this._pending = null
    } else if (best && best.id !== current.id && best.angleDeg + this.o.switchMarginDeg < current.angleDeg) {
      // HYSTERESIS: a better one must stay better for holdMs.
      if (!this._pending || this._pending.id !== best.id) this._pending = { id: best.id, since: t }
      if (t - this._pending.since >= this.o.holdMs) { next = best; this._pending = null }
      else next = current
    } else {
      next = current
      this._pending = null
    }
    this._setTarget(next, t)
  }

  _setTarget(next, t = this.now()) {
    const changed = (next?.id || null) !== (this.target?.id || null)
    this.target = next || null
    this._history.push({ t, target: this.target })
    const cutoff = t - this.o.historyMs
    while (this._history.length && this._history[0].t < cutoff) this._history.shift()
    if (changed) {
      this._emit('target', this._public(this.target))
      this._feel(this.target ? 'target' : 'target_lost', this.target?.type)
    }
  }

  /** The target as it was `lookbackMs` ago — what the player meant before the arm moved. */
  _targetAtLookback() {
    const t0 = this.now() - this.o.lookbackMs
    let found = null
    for (const h of this._history) { if (h.t <= t0) found = h; else break }
    return found ? found.target : (this._history[0]?.target ?? this.target)
  }

  _public(tg) { return tg ? { id: tg.id, name: tg.name, type: tg.type, distanceM: tg.distanceM, angleDeg: Math.round(tg.angleDeg * 10) / 10 } : null }

  // ── actions ────────────────────────────────────────────────────────────

  /** A semantic action, already mapped and debounced. Returns a promise for interact_N. */
  action(name) {
    switch (name) {
      case 'aim_toggle':     return this.aiming ? this._select() : this._startAim('action')
      case 'select_target':  return this.aiming ? this._select() : this._startAim('action')
      case 'cancel':         return this._cancel()
      case 'announce_target': return this._announce()
      case 'next_target':    return this._step(+1)
      case 'prev_target':    return this._step(-1)
      case 'calibrate':      return this._emit('calibrate', { sample: this._lastSample })
      default: {
        const m = /^interact_(\d+)$/.exec(String(name || ''))
        if (m) return this._interact(Number(m[1]))
        return undefined
      }
    }
  }

  _startAim(source) {
    if (this.aiming) return
    this.aiming = true
    this.aimSource = source
    this.target = null
    this.candidates = []
    this._history = []
    this._pending = null
    this._pinnedUntil = 0
    this._emit('mode', { aiming: true })
    this._feel('aim_on')
    if (this._lastSample && this.now() - this._lastSample.t < 500) this._retarget(this._lastSample.yaw, this._lastSample.t)
  }

  _stopAim() {
    this.aiming = false
    this.aimSource = null
    this._raiseSince = null
    this._emit('mode', { aiming: false })
  }

  _select() {
    if (!this.aiming) return
    // FREEZE FIRST: from here on no sample moves the target.
    const chosen = this._targetAtLookback()
    this._stopAim()
    if (this.target && (!chosen || chosen.id !== this.target.id)) this._emit('target', this._public(chosen))
    this.target = null
    if (chosen) {
      this.locked = chosen
      this._emit('lock', this._public(chosen))
      this._feel('select', chosen.type)
    } else {
      this._feel('aim_off')
      this._emit('notice', { text: 'Nichts anvisiert' })
    }
  }

  _cancel() {
    if (this.aiming) {
      this._stopAim()
      if (this.target) { this.target = null; this._emit('target', null) }
      this._feel('aim_off')
      return
    }
    if (this.locked) {
      this.locked = null
      this._emit('lock', null)
      this._feel('deselect')
    }
  }

  _announce() {
    const tg = this.aiming ? this.target : this.locked
    if (!tg) { this._emit('announce', { text: this.aiming ? 'Kein Ziel' : 'Nichts gewählt' }); return }
    const name = tg.name || 'Unbenanntes Objekt'
    this._emit('announce', { text: Number.isFinite(tg.distanceM) ? `${name}, ${tg.distanceM} Meter` : name })
  }

  _step(dir) {
    if (!this.aiming || !this.candidates.length) return
    const i = this.target ? this.candidates.findIndex(c => c.id === this.target.id) : -1
    const n = this.candidates.length
    const next = this.candidates[((i < 0 ? (dir > 0 ? -1 : 0) : i) + dir + n) % n]
    this._pinnedUntil = this.now() + this.o.pinMs
    this._pending = null
    this._setTarget(next)
  }

  async _interact(n) {
    const tg = this.locked
    if (!tg) { this._feel('error'); this._emit('notice', { text: 'Nichts gewählt' }); return { ok: false, reason: 'nothing_selected' } }
    const actions = this.getActions(tg.obj || tg) || []
    const key = actions[n - 1]
    if (!key) { this._feel('error'); this._emit('notice', { text: `Keine Aktion ${n}` }); return { ok: false, reason: 'no_such_action' } }
    if (!this.interact) return { ok: false, reason: 'no_interact' }
    try {
      await this.interact(tg.id, key)
      this._feel('success', tg.type)
      this._emit('interact', { id: tg.id, action: key, ok: true })
      return { ok: true, action: key }
    } catch (err) {
      this._feel('error', tg.type)
      this._emit('interact', { id: tg.id, action: key, ok: false, error: String(err?.message || err) })
      return { ok: false, action: key, error: String(err?.message || err) }
    }
  }

  /** Snapshot for UI and devices. */
  get state() {
    return { aiming: this.aiming, target: this._public(this.target), locked: this._public(this.locked), accuracyDeg: this.accuracyDeg }
  }
}

/** An object's offered actions: its own list, `examine` when it has none. */
function defaultActions(obj) {
  const own = (obj?.state?.actions || []).map(a => (a && typeof a === 'object') ? a.key : a).filter(Boolean)
  return own.length ? own : ['examine']
}

export { angleDiff }
