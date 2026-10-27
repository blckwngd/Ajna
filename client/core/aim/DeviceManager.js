// DeviceManager — which device points, which devices give input, who gets
// feedback. Sits between the devices and the AimController.
//
// ROLES
//   pointing  exactly ONE active source. Falls back to the phone when the
//             chosen one is gone, and says so (haptic + notice).
//   input     any number of devices at once; their raw events are mapped to
//             actions per device and debounced across all of them.
//   feedback  haptic patterns and display data go to every connected device
//             that can show or feel them; with none, the phone vibrates.
//
// A DEVICE is a plain object (see devices.js):
//   { id, label, kind, caps: { pointing: 'absolute'|'relative'|null,
//     input: bool, haptics: bool, display: bool },
//     connected: bool,
//     startPointing(onSample) → stop fn   // only if caps.pointing
//     onInput(cb) → unsubscribe           // only if caps.input; cb({code,long}|{action})
//     onStatus(cb) → unsubscribe          // cb(connected)
//     haptic(pattern), display(view) }    // only if the cap says so
//
// The config is persisted per device (localStorage), and a device that is
// not there right now keeps its place in the config.

import { AimController } from './AimController.js'
import { defaultMapping, mapRawEvent, ActionDebouncer } from './inputMapping.js'
import { hapticPattern } from './haptics.js'
import { calibrationTarget, computeCalibration, effectiveAccuracy } from './aimMath.js'

const STORE = 'ajna.aim.v1'
export const PHONE_ID = 'phone'
const SILENCE_MS = 2500        // no samples this long while aiming → fallback

function load(storage) {
  try { const raw = storage?.getItem(STORE); return raw ? JSON.parse(raw) : null } catch { return null }
}

export class DeviceManager {
  /**
   * @param {object} deps
   * @param {AimController} [deps.aim]          created here when omitted (with the aim deps below)
   * @param {object} [deps.aimDeps]             getOrigin, getObjects, getActions, interact
   * @param {Storage} [deps.storage]
   * @param {(text:string) => void} [deps.speak]
   * @param {(pattern:number[]) => void} [deps.vibrate]   the phone's own vibration
   * @param {(text:string) => void} [deps.notify]
   * @param {() => ({lat:number, lon:number}|null)} [deps.getPosition]
   * @param {() => number} [deps.now]
   */
  constructor({ aim = null, aimDeps = {}, storage = globalThis.localStorage, speak = () => {}, vibrate = () => {}, notify = () => {}, getPosition = () => null, now = () => Date.now() } = {}) {
    this.storage = storage
    this.speak = speak
    this.vibrate = vibrate
    this.notify = notify
    this.getPosition = getPosition
    this.now = now
    const saved = load(storage) || {}
    this.config = {
      pointingId: saved.pointingId || PHONE_ID,
      inputIds: Array.isArray(saved.inputIds) ? saved.inputIds : [],
      mappings: saved.mappings || {},          // deviceId → { code: action }
      calibration: saved.calibration || {},    // deviceId → { offsetDeg, at, driftDegPerMin }
      raiseToAim: saved.raiseToAim === true,
      enabled: saved.enabled === true,         // nothing runs until the player switches it on
    }
    this.aim = aim || new AimController({ ...aimDeps, now })
    this.aim.setOptions({ raiseToAim: this.config.raiseToAim })
    this.devices = new Map()
    this.debouncer = new ActionDebouncer({ now })
    this._activePointing = null      // { id, stop }
    this._inputSubs = new Map()      // id → unsubscribe
    this._statusSubs = new Map()
    this._lastRaw = null             // last raw sample of the active source (for calibration)
    this._lastSampleAt = 0
    this._fallbackFrom = null        // device id we fell back from
    this._cbs = new Set()
    this._wireAim()
  }

  // ── config ─────────────────────────────────────────────────────────────

  _save() {
    try { this.storage?.setItem(STORE, JSON.stringify(this.config)) } catch { /* private mode */ }
    this._changed()
  }
  onChange(cb) { this._cbs.add(cb); return () => this._cbs.delete(cb) }
  _changed() { for (const cb of this._cbs) { try { cb(this.snapshot()) } catch {} } }

  snapshot() {
    return {
      ...this.config,
      activePointingId: this._activePointing?.id || null,
      fallbackFrom: this._fallbackFrom,
      devices: [...this.devices.values()].map(d => ({ id: d.id, label: d.label, kind: d.kind, caps: d.caps, connected: !!d.connected })),
      aim: this.aim.state,
    }
  }

  mappingFor(id) {
    const d = this.devices.get(id)
    return { ...defaultMapping(d?.kind), ...(this.config.mappings[id] || {}) }
  }
  setMapping(id, code, action) {
    const m = { ...(this.config.mappings[id] || {}) }
    if (action) m[code] = action; else delete m[code]
    this.config.mappings[id] = m
    this._save()
  }
  resetMapping(id) { delete this.config.mappings[id]; this._save() }

  setEnabled(on) { this.config.enabled = !!on; this._save(); this._apply() }
  setRaiseToAim(on) {
    this.config.raiseToAim = !!on
    this.aim.setOptions({ raiseToAim: this.config.raiseToAim })
    this._save()
    this._applyPointing()
  }

  /** Exactly one pointing device. The old source stops before the new one starts. */
  setPointing(id) {
    this.config.pointingId = id || PHONE_ID
    this._fallbackFrom = null
    this._save()
    this._applyPointing()
  }

  setInput(id, on) {
    const set = new Set(this.config.inputIds)
    if (on) set.add(id); else set.delete(id)
    this.config.inputIds = [...set]
    this._save()
    this._applyInputs()
  }

  // ── devices ────────────────────────────────────────────────────────────

  register(device) {
    if (!device?.id) return () => {}
    this.unregister(device.id)
    this.devices.set(device.id, device)
    if (typeof device.onStatus === 'function') {
      this._statusSubs.set(device.id, device.onStatus((connected) => this._onDeviceStatus(device.id, connected)))
    }
    this._apply()
    this._changed()
    return () => this.unregister(device.id)
  }

  unregister(id) {
    if (!this.devices.has(id)) return
    if (this._activePointing?.id === id) this._stopPointing()
    try { this._inputSubs.get(id)?.() } catch {}
    this._inputSubs.delete(id)
    try { this._statusSubs.get(id)?.() } catch {}
    this._statusSubs.delete(id)
    this.devices.delete(id)
    this._apply()
    this._changed()
  }

  _onDeviceStatus(id, connected) {
    if (!connected && this._activePointing?.id === id) this._fallback(id)
    else if (connected && this._fallbackFrom === id) {
      this._fallbackFrom = null
      this._applyPointing()
      this.notify(`${this.devices.get(id)?.label || id} ist wieder da`)
    }
    this._applyInputs()
    this._changed()
  }

  _apply() { this._applyPointing(); this._applyInputs() }

  // ── pointing ───────────────────────────────────────────────────────────

  /** Stream only while aiming (or always with raise-to-aim) — battery. */
  _wantsStream() { return this.config.enabled && (this.aim.aiming || this.config.raiseToAim || !!this._calibrating) }

  _pointingDevice() {
    const want = this._fallbackFrom ? PHONE_ID : this.config.pointingId
    const d = this.devices.get(want)
    if (d && d.connected !== false && d.caps?.pointing) return d
    return null
  }

  _applyPointing() {
    const d = this._wantsStream() ? this._pointingDevice() : null
    if (this._activePointing?.id === (d?.id || null)) return
    this._stopPointing()                                   // OLD stops first …
    if (!d) {
      if (this._wantsStream() && this.config.pointingId !== PHONE_ID && !this._fallbackFrom) this._fallback(this.config.pointingId)
      return
    }
    const stop = d.startPointing((raw) => this._onRaw(d, raw))  // … then the new starts
    this._activePointing = { id: d.id, stop }
    this._lastSampleAt = this.now()
    this._changed()
  }

  _stopPointing() {
    const a = this._activePointing
    this._activePointing = null
    if (a) { try { a.stop?.() } catch {} }
  }

  _fallback(fromId) {
    if (fromId === PHONE_ID) return
    this._fallbackFrom = fromId
    this._stopPointing()
    this._feedback({ event: 'fallback' })
    this.notify(`${this.devices.get(fromId)?.label || 'Zeigegerät'} nicht erreichbar — Telefon zeigt`)
    this._applyPointing()
    this._changed()
  }

  /** A raw sample: apply this device's calibration, compute its accuracy, hand it on. */
  _onRaw(device, raw) {
    if (!raw || !Number.isFinite(raw.yaw)) return
    this._lastRaw = { ...raw, deviceId: device.id }
    this._lastSampleAt = this.now()
    if (this._calibrating) { this._calibrating(this._lastRaw); return }
    const cal = this.config.calibration[device.id]
    const kind = device.caps?.pointing === 'relative' ? 'relative' : 'absolute'
    const accuracy = effectiveAccuracy({
      kind, reportedDeg: raw.accuracy, calibratedAt: cal?.at ?? null, now: this.now(), driftDegPerMin: cal?.driftDegPerMin ?? 1.5,
    })
    // A relative source without calibration has no north: it can still say
    // "the arm went up" (raise-to-aim), but it cannot pick a target.
    const yaw = kind === 'relative' && !cal ? null : raw.yaw + (cal?.offsetDeg || 0)
    this.aim.sample({ yaw: yaw ?? NaN, pitch: raw.pitch, accuracy, t: raw.t ?? this.now() })
    if (yaw === null && Number.isFinite(raw.pitch) && this.config.raiseToAim) this.aim._raise?.(raw.pitch, raw.t ?? this.now())
  }

  /** Called periodically by the owner: detects a pointing source that went silent. */
  tick() {
    if (!this._activePointing || !this.aim.aiming) return
    if (this.now() - this._lastSampleAt > SILENCE_MS && this._activePointing.id !== PHONE_ID) this._fallback(this._activePointing.id)
  }

  // ── calibration ────────────────────────────────────────────────────────

  /**
   * Calibrate the active pointing device on a known direction.
   *
   * The device may not be streaming (it only does while aiming), so this
   * switches the stream on, collects samples for `windowMs` while the player
   * holds still, and averages them — steadier than one sample.
   *
   * @param {'shadow'|'sun'|'landmark'} kind
   * @param {{lat:number, lon:number, name?:string}} [landmark]
   * @param {{windowMs?:number}} [opts]
   */
  async calibrate(kind = 'shadow', landmark = null, { windowMs = 600 } = {}) {
    const samples = []
    this._calibrating = (raw) => samples.push(raw)
    this._applyPointing()
    await new Promise(r => setTimeout(r, windowMs))
    this._calibrating = null
    this._applyPointing()
    const id = samples[0]?.deviceId
    const raw = averageSamples(samples)
    if (!raw || !id) {
      this._feedback({ event: 'error' }); this.notify('Kalibrieren: kein Zeigegerät liefert gerade Werte'); return { ok: false, reason: 'no_reading' }
    }
    const target = calibrationTarget({ kind, at: this.getPosition(), time: new Date(this.now()), landmark })
    const r = computeCalibration(raw, target)
    if (!r.ok) {
      this._feedback({ event: 'error' })
      this.notify(CAL_REASONS[r.reason] ? CAL_REASONS[r.reason](r.detail) : `Kalibrieren fehlgeschlagen (${r.reason})`)
      return r
    }
    const prev = this.config.calibration[id]
    this.config.calibration[id] = { offsetDeg: r.offsetDeg, at: this.now(), driftDegPerMin: prev?.driftDegPerMin ?? 1.5, kind }
    this._save()
    this._feedback({ event: 'calibrated' })
    this.notify(`Kalibriert (${kind === 'landmark' ? (landmark?.name || 'Ort') : kind === 'sun' ? 'Sonne' : 'Schatten'}): ${r.offsetDeg >= 0 ? '+' : ''}${Math.round(r.offsetDeg)}°`)
    return r
  }

  clearCalibration(id) { delete this.config.calibration[id]; this._save() }

  // ── input ──────────────────────────────────────────────────────────────

  _applyInputs() {
    const want = new Set(this.config.enabled ? this.config.inputIds : [])
    for (const [id, unsub] of this._inputSubs) {
      if (!want.has(id) || !this.devices.get(id)) { try { unsub() } catch {}; this._inputSubs.delete(id) }
    }
    for (const id of want) {
      const d = this.devices.get(id)
      if (!d || this._inputSubs.has(id) || typeof d.onInput !== 'function' || !d.caps?.input) continue
      this._inputSubs.set(id, d.onInput((raw) => this.input(id, raw)))
    }
  }

  /** One raw event from an input device. Returns the action that fired, or null. */
  input(deviceId, raw) {
    if (!this.config.enabled) return null
    const action = mapRawEvent(raw, this.mappingFor(deviceId))
    if (!action || !this.debouncer.accept(action)) return null
    this.aim.action(action)
    return action
  }

  /** Learn mode for the settings UI: the next raw event of this device is returned instead of acted on. */
  learn(deviceId) {
    const d = this.devices.get(deviceId)
    if (!d?.onInput) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => { unsub(); resolve(null) }, 10_000)
      const unsub = d.onInput((raw) => { clearTimeout(timer); unsub(); resolve(raw) })
    })
  }

  // ── feedback ───────────────────────────────────────────────────────────

  _wireAim() {
    this.aim.on('feedback', (f) => this._feedback(f))
    this.aim.on('announce', ({ text }) => this.speak(text))
    this.aim.on('notice', ({ text }) => { this.notify(text); this._display({ notice: text }) })
    this.aim.on('mode', () => { this._applyPointing(); this._display() })
    this.aim.on('target', () => this._display())
    this.aim.on('lock', (tg) => { this._display(); if (tg) this.notify(`Gewählt: ${tg.name || tg.id}`) })
    this.aim.on('interact', (r) => this._display({ notice: r.ok ? `${r.action}: ok` : `${r.action}: ${r.error || 'Fehler'}` }))
    this.aim.on('calibrate', () => this.calibrate(this._defaultCalibrationKind()))
  }

  _defaultCalibrationKind() {
    const t = calibrationTarget({ kind: 'shadow', at: this.getPosition(), time: new Date(this.now()) })
    return t.ok ? 'shadow' : 'none'
  }

  _feedbackDevices(cap) {
    return [...this.devices.values()].filter(d => d.caps?.[cap] && d.connected !== false && d.id !== PHONE_ID
      && (this.config.inputIds.includes(d.id) || this._activePointing?.id === d.id))
  }

  _feedback({ event, objectType }) {
    const pattern = hapticPattern(event, objectType)
    const targets = this._feedbackDevices('haptics')
    if (!targets.length) { try { this.vibrate(pattern) } catch {} ; return }
    for (const d of targets) { try { d.haptic(pattern) } catch {} }
  }

  _display(extra = {}) {
    const s = this.aim.state
    const lockedObj = this.aim.locked?.obj
    const actions = lockedObj ? (this.aim.getActions(lockedObj) || []).slice(0, 4) : []
    const view = { aiming: s.aiming, target: s.target, locked: s.locked, actions, accuracyDeg: Number.isFinite(s.accuracyDeg) ? Math.round(s.accuracyDeg) : null, ...extra }
    for (const d of this._feedbackDevices('display')) { try { d.display(view) } catch {} }
    this._changed()
  }
}

/** Circular mean of yaw, plain mean of pitch. */
export function averageSamples(samples) {
  const ok = (samples || []).filter(s => Number.isFinite(s?.yaw))
  if (!ok.length) return null
  let sx = 0, sy = 0, sp = 0, np = 0
  for (const s of ok) {
    sx += Math.sin(s.yaw * Math.PI / 180); sy += Math.cos(s.yaw * Math.PI / 180)
    if (Number.isFinite(s.pitch)) { sp += s.pitch; np++ }
  }
  const yaw = ((Math.atan2(sx, sy) * 180 / Math.PI) % 360 + 360) % 360
  return { yaw, pitch: np ? sp / np : null, deviceId: ok[0].deviceId, t: ok[ok.length - 1].t }
}

const CAL_REASONS = {
  sun_too_low: () => 'Die Sonne steht zu tief — mit einem bekannten Ort kalibrieren',
  pitch_mismatch: (d) => `Das passt nicht zur Sonnenhöhe (${d}° daneben) — noch einmal`,
  not_pointing_down: () => 'Beim Schatten nach unten zeigen, den Schatten entlang',
  not_pointing_up: () => 'Zur Sonne nach oben zeigen',
  no_position: () => 'Kalibrieren braucht die eigene Position',
  no_landmark: () => 'Kein Ort zum Kalibrieren gewählt',
  none: () => 'Kalibrieren: Sonne zu tief — mit einem bekannten Ort kalibrieren',
  unknown_kind: () => 'Kalibrieren: Sonne zu tief — mit einem bekannten Ort kalibrieren',
}
