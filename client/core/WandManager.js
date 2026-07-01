// WandManager — binds the BLE "magic wand" accessory to the Ajna client.
//
// Privacy-first model (see project notes): the wand is a remote control for the
// app. The exact user position stays ON-DEVICE. The wand sends input events
// (buttons/gestures) over BLE; the app resolves locally which Ajna object is
// "meant" (nearest to the on-device position) and sends ONLY the resulting
// `interact(objectId, action)` to the server — never raw coordinates.
//
// Offline: the wand reacts locally on its own (LED/effects in firmware). The app
// additionally echoes a local effect command so feedback works without network.
//
// The native side (Capacitor `Wand` plugin → AccessoryBleService foreground
// service) keeps the BLE link alive with the screen off. This module is the
// JS-side glue and is intentionally independent of the (separate) UWB feature.

import { resolvePointingTarget } from './PointingResolver.js'
import { WandEventBus } from './WandEventBus.js'
import { spawnRandomHere } from './SpawnHere.js'

const WAND_LOG_PREFIX = '[wand]'

export class WandManager {
  /**
   * @param {object} opts
   * @param {import('./AjnaManager.js').AjnaManager} opts.ajna
   * @param {() => ({lat:number, lon:number}|null)} [opts.getPosition]  on-device position (privacy-local)
   * @param {() => ({lat:number, lon:number, altitude?:number}|null)} [opts.getOrigin]  ray origin for pointing (default: getPosition)
   * @param {(text:string)=>void} [opts.notify]  optional local feedback (toast/TTS)
   * @param {{coneDeg?:number, maxRangeM?:number}} [opts.pointing]
   */
  constructor({ ajna, getPosition, getOrigin, notify, pointing, isVisible, getName } = {}) {
    this.ajna = ajna
    this.getPosition = getPosition || (() => window.ajnaGeo?.position || null)
    this.getOrigin = getOrigin || (() => this.getPosition())
    this.notify = notify || ((t) => console.log(WAND_LOG_PREFIX, t))
    this.coneDeg = pointing?.coneDeg ?? 12
    this.releaseDeg = pointing?.releaseDeg ?? this.coneDeg * 1.6
    this.maxRangeM = pointing?.maxRangeM ?? 50
    // Only consider objects that pass the active visibility filter.
    this.isVisible = isVisible || (() => true)
    // Display name for a target id (used for audio/UI).
    this.getName = getName || ((id) => this.ajna?.getObjectById?.(id)?.name || null)
    this._targetCbs = new Set()
    this._interactionCbs = new Set()
    this._lastTargetId = null
    // Press-to-select (Button 2 held): a target is only ACQUIRED while selecting,
    // and LOCKED on release. Interactions then act on the locked object — so a
    // stray button/gesture can't fire on a random object.
    this._selecting = false
    this._lockedId = null
    this._lockCbs = new Set()
    // Push-to-talk (voice): the wand signals a button held-and-still as PTT, with
    // `btn` (1 = light effect, 3 = locked object). The wand itself swallows the
    // button release when PTT was active, so no double action here.
    this._pttCbs = new Set()
    // Diagnostic log lines (readable gesture/voice traces) for the app Debug-Log,
    // from the wand ({"type":"log"}) and injected app-side via log().
    this._logCbs = new Set()
    // Local-first event pipeline: subscribers run BEFORE an event is forwarded
    // to Ajna; a subscriber can `event.consume()` to keep it offline-local.
    this.bus = new WandEventBus()
    this.Wand = null
    this.connected = false
    this.address = null
    this._listeners = []
    this._statusCbs = new Set()
    // Orientation state (from the wand's BNO085).
    this._orientation = null        // { q:[w,x,y,z], point:[x,y,z], world:[E,N,U], headingDeg, mode, eff, acc, t }
    this._orientationCbs = new Set()
    this._pointingMode = null       // last known wand pointing mode
    this._modeCbs = new Set()
    this._wandState = null          // last known state-machine state name
    this._stateCbs = new Set()
    this._declinationRad = 0        // magnetic -> true north (app knows location)
    this._alignmentRad = 0          // residual yaw alignment to the AR/UWB frame
  }

  /** True only inside the native Capacitor app (the plugin exists there). */
  static async isAvailable() {
    try {
      const { Capacitor } = await import('@capacitor/core')
      return !!Capacitor?.isNativePlatform?.()
    } catch { return false }
  }

  async start({ name = 'WizardStaff', address = null } = {}) {
    const { registerPlugin } = await import('@capacitor/core')
    this.Wand = registerPlugin('Wand')

    this._listeners.push(await this.Wand.addListener('wandStatus', (e) => this._onStatus(e)))
    this._listeners.push(await this.Wand.addListener('wandEvent', (e) => this._onEvent(e)))
    this._listeners.push(await this.Wand.addListener('wandLog', (e) => {
      const m = e?.message
      console.debug(WAND_LOG_PREFIX, 'native:', m)
      // Surface native BLE logs (GATT connect steps, disconnect status codes) in
      // the app Debug-Log so connect/disconnect storms are diagnosable on-device.
      if (m) this._emitLog(`BLE: ${m}`)
    }))

    await this.Wand.connect(address ? { address } : { name })
    this.notify('Verbinde mit Zauberstab …')
  }

  async stop() {
    for (const l of this._listeners) { try { await l.remove() } catch {} }
    this._listeners = []
    try { await this.Wand?.disconnect() } catch {}
    this.connected = false
  }

  onStatusChange(cb) { this._statusCbs.add(cb); return () => this._statusCbs.delete(cb) }

  /**
   * Force ("run in background") or release the persistent foreground service +
   * notification — independent of a wand connection. Keeps BLE/voice/control
   * alive with the screen off. Native-only; a no-op in the browser.
   */
  async setBackgroundService(enabled) {
    try {
      const { Capacitor, registerPlugin } = await import('@capacitor/core')
      if (!Capacitor?.isNativePlatform?.()) return
      const Wand = this.Wand || registerPlugin('Wand')
      await Wand.setBackground({ enabled: !!enabled })
    } catch (e) { console.warn(WAND_LOG_PREFIX, 'setBackground failed', e?.message || e) }
  }

  /** Send a JSON command line to the wand (e.g. drive an effect). */
  async sendCommand(obj) {
    try { await this.Wand?.send({ json: JSON.stringify(obj) }) }
    catch (err) { console.warn(WAND_LOG_PREFIX, 'send failed', err) }
  }

  // ── orientation: config + accessors ─────────────────────────────────

  /** Set the wand's pointing mode (offline command, persisted intent). */
  setPointingMode(mode) {
    return this.sendCommand({ cmd: 'set', key: 'pointing_mode', value: mode })
  }

  /** Trigger a calibration on the wand (default: staff axis — hold vertical). */
  calibrate(what = 'staff') {
    return this.sendCommand({ cmd: 'calibrate', what })
  }

  /** Magnetic declination (degrees, +E) applied to map magnetic→true north. */
  setDeclinationDeg(deg) { this._declinationRad = (deg || 0) * Math.PI / 180 }

  /** Residual yaw alignment (degrees) to match the AR/UWB world frame. */
  setAlignmentDeg(deg) { this._alignmentRad = (deg || 0) * Math.PI / 180 }

  onOrientation(cb) { this._orientationCbs.add(cb); return () => this._orientationCbs.delete(cb) }
  onPointingModeChange(cb) { this._modeCbs.add(cb); return () => this._modeCbs.delete(cb) }

  /** Latest orientation snapshot (world = pointing dir in AR/UWB ENU). */
  get orientation() { return this._orientation }
  /** Last known pointing mode ('pointer'|'walkingstick'|'auto'). */
  get pointingMode() { return this._pointingMode }
  /** World-frame pointing unit vector [E,N,U], or null. */
  getPointingDirection() { return this._orientation?.world || null }

  // ── native event handlers ───────────────────────────────────────────

  _onStatus(e) {
    const next = !!e?.connected
    const addr = e?.address || null
    // Raw trace into the Debug-Log — visible even when the announcement below is
    // de-duped (e.g. the native side re-emitting "disconnected" on every failed
    // 2 s reconnect attempt while the wand reboots).
    this._emitLog(`BLE-Status: ${next ? 'verbunden' : 'getrennt'}${addr ? ' ' + addr : ''}`)
    this.address = addr
    // De-dupe: only notify/announce on a REAL change. This kills the repeated
    // "Stab getrennt. Stab getrennt. …" (and double "verbunden") spam regardless
    // of how many raw status events the native layer emits.
    if (next === this.connected) return
    this.connected = next
    this.notify(this.connected ? 'Zauberstab verbunden' : 'Zauberstab getrennt')
    this._statusCbs.forEach(cb => { try { cb(this.connected, this.address) } catch {} })
  }

  /**
   * Subscribe to wand input events ('button'|'tilt'|'gesture'|'effect'|'*')
   * BEFORE they are forwarded to Ajna. Call `event.consume()` in the handler to
   * keep the event local (offline) — e.g. a button combo that changes a setting.
   * Returns an unsubscribe function.
   */
  on(type, fn, opts) { return this.bus.on(type, fn, opts) }

  _onEvent(e) {
    let msg
    try { msg = JSON.parse(e?.json || '') } catch {
      console.warn(WAND_LOG_PREFIX, 'unparseable event', e?.json); return
    }
    switch (msg.type) {
      // Continuous state — not part of the input pipeline.
      case 'orientation': return this._handleOrientation(msg)
      case 'mode':        return this._handleMode(msg)
      case 'state':       return this._handleState(msg)
      case 'select':      return this._handleSelect(msg)
      case 'ptt':         return this._handlePtt(msg)
      case 'log':         return this._handleLog(msg)
      // Actionable inputs run through the local-first event bus.
      case 'button':
      case 'tilt':
      case 'gesture':
      case 'effect':      return this._dispatchInput(msg)
      default:
        console.debug(WAND_LOG_PREFIX, 'unhandled wand event', msg)
    }
  }

  // Run an input event through local subscribers first; forward to Ajna only if
  // none consumed it (default forward=true).
  _dispatchInput(msg) {
    const event = this.bus.dispatch(msg.type, msg)
    if (!event.forward) {
      this.notify(`„${msg.type}" lokal verarbeitet`)
      return
    }
    switch (msg.type) {
      case 'button': return this._handleButton(msg)
      case 'tilt':   return this._handleGestureLike('tilt', msg.dir, msg)
      case 'gesture':return this._handleGestureLike('gesture', msg.name, msg)
      case 'effect': return this._handleEffect(msg)
    }
  }

  // ── orientation (BNO085) ────────────────────────────────────────────

  /** Subscribe to wand state-machine changes ({name, id}). */
  onState(cb) { this._stateCbs.add(cb); return () => this._stateCbs.delete(cb) }
  /** Last known wand state name. */
  get wandState() { return this._wandState }

  _handleState(msg) {
    if (typeof msg.name !== 'string') return
    this._wandState = msg.name
    this._stateCbs.forEach(cb => { try { cb(msg.name, msg.id) } catch {} })
  }

  _handleMode(msg) {
    // Two flavours share type 'mode': the pointing mode (config) and the
    // state-machine mode ({state:N}). Only the former concerns pointing.
    if (typeof msg.pointing_mode === 'string') {
      this._pointingMode = msg.pointing_mode
      // 'disabled' => the wand stops streaming orientation (power saving); drop
      // any stale orientation so pointing falls back to nearest-by-distance.
      if (msg.pointing_mode === 'disabled') this._orientation = null
      this._modeCbs.forEach(cb => { try { cb(msg.pointing_mode) } catch {} })
    }
  }

  _handleOrientation(msg) {
    if (!Array.isArray(msg.point) || msg.point.length < 3) return
    // Rotate the wand's pointing vector (BNO world frame) into the AR/UWB ENU
    // frame: a yaw about up by declination + alignment. point = [E, N, U].
    const yaw = this._declinationRad + this._alignmentRad
    const c = Math.cos(yaw), s = Math.sin(yaw)
    const [px, py, pz] = msg.point
    const world = [px * c - py * s, px * s + py * c, pz]
    const headingDeg = (Math.atan2(world[0], world[1]) * 180 / Math.PI + 360) % 360 // bearing from North, CW
    // Linear acceleration (gravity removed), same BNO-world→ENU yaw as pointing,
    // so IMU/UWB fusion gets accel in the same frame as the UWB position. m/s².
    let accel = null
    if (Array.isArray(msg.la) && msg.la.length >= 3) {
      const [ax, ay, az] = msg.la
      accel = [ax * c - ay * s, ax * s + ay * c, az]
    }
    if (typeof msg.mode === 'string') this._pointingMode = msg.mode
    this._orientation = {
      q: msg.q, point: msg.point, world, accel,
      headingDeg, mode: msg.mode, eff: msg.eff, acc: msg.acc, t: Date.now()
    }
    this._orientationCbs.forEach(cb => { try { cb(this._orientation) } catch {} })

    // Resolve the pointed-at object ONLY while selecting (Button 2 held). Outside
    // selection the highlight stays on the locked object (we don't re-resolve).
    if (!this._selecting) return
    const target = this.resolveTarget()
    if (target) target.name = this.getName(target.id)
    const id = target?.id || null
    if (id !== this._lastTargetId) {
      this._lastTargetId = id
      // target is null on focus loss; listeners (highlight/audio) handle both.
      this._targetCbs.forEach(cb => { try { cb(target) } catch {} })
      // Rune feedback: a target is being aimed at → hover (fast/bright); lost it
      // → back to aim (slow/dim). The wand already shows "aim" locally on press.
      this.sendCommand({ cmd: 'rune', fb: id ? 2 : 1 })
    }
  }

  // Button 2 down → start aiming; up → lock the currently-aimed object. Release
  // outcomes drive the Rune feedback (the screen-off "what am I doing" cue):
  //   • aimed at an object → LOCK it           → rune fb 3 (slow/bright)
  //   • aimed at nothing, had a lock → DESELECT → rune fb 0 (off)
  //   • quick tap, nothing selected → TOGGLE the manual Rune (the "hübscher
  //     Effekt") via effect 12; the firmware clears the aim feedback itself.
  //   • long hold, missed everything → just clear the aim feedback (fb 0).
  _handleSelect(msg) {
    if (msg.pressed) {
      this._selecting = true
      this._lastTargetId = null   // fresh aim: don't re-lock the previous target
      return
    }
    this._selecting = false
    const hovered = this._lastTargetId || null
    const hadLock = !!this._lockedId

    if (hovered) {
      this._lockedId = hovered
      this.sendCommand({ cmd: 'rune', fb: 3 })
      const locked = { id: hovered, name: this.getName(hovered) }
      this.notify(`Gewählt: ${locked.name || locked.id}`)
      this._lockCbs.forEach(cb => { try { cb(locked) } catch {} })
      return
    }

    this._lockedId = null
    if (hadLock) {                                   // deselect a previous lock
      this.sendCommand({ cmd: 'rune', fb: 0 })
      this.notify('Auswahl aufgehoben')
      this._lockCbs.forEach(cb => { try { cb(null) } catch {} })
    } else if (msg.short) {                          // pure tap → toggle manual Rune
      this.sendCommand({ cmd: 'light', id: 12 })
      this.notify('Rune umgeschaltet')
    } else {                                         // long hold, no target → clear aim
      this.sendCommand({ cmd: 'rune', fb: 0 })
    }
  }

  // Push-to-talk: the wand reports a button held-and-still (mic open) and release
  // (mic close), with `btn` (1=light, 3=object). VoiceCommandManagers drive STT
  // off this and filter by button; nothing here knows about audio.
  _handlePtt(msg) {
    this._pttCbs.forEach(cb => { try { cb(!!msg.pressed, msg.btn) } catch {} })
  }
  /** Subscribe to push-to-talk: cb(pressed, btn). pressed=true→listen, false→stop. */
  onPtt(cb) { this._pttCbs.add(cb); return () => this._pttCbs.delete(cb) }

  // Readable diagnostic log lines (gestures from the wand, voice from the app).
  _handleLog(msg) { this._emitLog(typeof msg.msg === 'string' ? msg.msg : '') }
  _emitLog(line) { if (line) this._logCbs.forEach(cb => { try { cb(line) } catch {} }) }
  /** Inject an app-side log line (e.g. STT result) into the same Debug-Log feed. */
  log(line) { this._emitLog(line) }
  /** Subscribe to diagnostic log lines (wand + app). */
  onLog(cb) { this._logCbs.add(cb); return () => this._logCbs.delete(cb) }

  /** Fire a voice-resolved action on the locked object (same path as a gesture). */
  voiceInteract(action, payload) {
    return this._interactTarget(action, payload || {})
  }

  onTarget(cb) { this._targetCbs.add(cb); return () => this._targetCbs.delete(cb) }
  onInteraction(cb) { this._interactionCbs.add(cb); return () => this._interactionCbs.delete(cb) }
  /** Subscribe to lock changes: cb({id,name}) on lock, cb(null) on deselect. */
  onLock(cb) { this._lockCbs.add(cb); return () => this._lockCbs.delete(cb) }
  /** Currently locked object, or null. */
  getLockedTarget() { return this._lockedId ? { id: this._lockedId, name: this.getName(this._lockedId) } : null }
  /** Clear the lock (e.g. from an app "deselect" button). */
  clearLock() {
    if (!this._lockedId) return
    this._lockedId = null
    this._lastTargetId = null
    this.sendCommand({ cmd: 'rune', fb: 0 })                       // turn the lock-rune off
    this._targetCbs.forEach(cb => { try { cb(null) } catch {} })   // drop the highlight
    this._lockCbs.forEach(cb => { try { cb(null) } catch {} })
  }

  /**
   * Resolve the object the wand currently points at (ray = origin + direction),
   * or null. Origin defaults to the wand's UWB position (via getOrigin).
   */
  resolveTarget() {
    const direction = this.getPointingDirection()
    const origin = this.getOrigin?.()
    if (!direction || !origin || !Number.isFinite(origin.lat)) return null
    const objects = this.ajna?.objectMap
      ? [...this.ajna.objectMap.entries()]
          .filter(([, o]) => this.isVisible(o))   // only filter-visible objects
          .map(([id, o]) => ({ id, lat: o.lat, lon: o.lon, altitude: o.altitude }))
      : []
    return resolvePointingTarget({
      origin, direction, objects,
      coneDeg: this.coneDeg, releaseDeg: this.releaseDeg, maxRangeM: this.maxRangeM,
      currentId: this._lastTargetId    // hysteresis: keep current within release cone
    })
  }

  // ── mapping wand input → Ajna interaction (privacy-local resolution) ─

  _handleButton(msg) {
    // Button 3 short carries a `dir` (wand tilt at press) → a directional action.
    if (msg.id === 3 && msg.dir) return this._handleDirAction(msg.dir)
    // (No LED command: the wand's on-board LED is unused — it shares the NINA's
    // SPI with BLE, so driving it would break BLE. Visible feedback is an
    // external light, handled wand-side. PTT-hold releases are swallowed wand-side.)
    const action = msg.long ? 'wand_long' : 'wand_press'
    this._interactTarget(action, { buttonId: msg.id, long: !!msg.long })
  }

  // Button 3 "tilt + press": the wand tilt selects the action on the locked object
  // (or, for "down", spawns a new object here — no lock needed). The physical
  // direction→name mapping depends on the wand mounting/grip; remap here if a tilt
  // comes out as the wrong direction (the wand logs the detected direction).
  async _handleDirAction(dir) {
    switch (dir) {
      case 'down': {                                  // create a random object here (no lock needed)
        const position = this.getPosition?.() || this.getOrigin?.()   // GPS, else fused origin
        try {
          const obj = await spawnRandomHere({ ajna: this.ajna, position })
          this.notify(`Erzeugt: ${obj?.name || 'Objekt'}`)
        } catch (e) { this.notify('Spawn fehlgeschlagen: ' + (e?.message || e)) }
        return
      }
      case 'back':                                    // attack + take (fire both)
        await this._interactTarget('attack', { via: 'tilt' })
        await this._interactTarget('collect', { via: 'tilt' })
        return
      case 'left':  return this._interactTarget('examine', { via: 'tilt' })  // untersuchen
      case 'right': return this._interactTarget('talk', { via: 'tilt' })     // ansprechen
      default:      return this._interactTarget('wand_press', { via: 'tilt' }) // forward/up → primary
    }
  }

  _handleGestureLike(kind, name, msg) {
    this._interactTarget('wand_gesture', { kind, name })
  }

  _handleEffect(msg) {
    // Wand-side "effect intent" (e.g. light/sound). Forward as an interaction;
    // the Ajna agent decides the networked effect.
    this._interactTarget('wand_effect', { domain: msg.domain, id: msg.id })
  }

  /**
   * Send one interaction to the LOCKED object (selected by holding Button 2 and
   * pointing, then releasing). No lock → no interaction, so a stray button or
   * gesture can't fire on a random object. No coordinates leave the device.
   */
  async _interactTarget(action, payload) {
    const target = this._lockedId
    if (!target) { this.notify('Kein Objekt gewählt — Knopf 2 halten und anvisieren'); return }
    const name = this.getName(target)
    // Map the generic short press onto the target's PRIMARY action (first in
    // state.actions) so "point + click" performs the object's main interaction
    // — and the server permits it (its interact_actions list those keys, not
    // the raw 'wand_press'). Long-press/gestures stay generic for agents.
    let effective = action
    if (action === 'wand_press') {
      const rec = this.ajna?.getObjectById?.(target)
      const first = Array.isArray(rec?.state?.actions) && rec.state.actions[0]?.key
      effective = first || 'examine'
    }
    // Notify listeners (e.g. audio) that an action was triggered on the locked target.
    this._interactionCbs.forEach(cb => { try { cb({ action: effective, id: target, name, locked: true }) } catch {} })
    try {
      await this.ajna.interact(target, effective, payload || {})
      this.notify(`Aktion „${effective}" → ${name || 'gewähltes Objekt'}`)
    } catch (err) {
      // Offline / not logged in: the local wand reaction already happened.
      console.warn(WAND_LOG_PREFIX, 'interact failed (offline?)', err?.message || err)
      this.notify('Offline – lokale Reaktion ausgeführt')
    }
  }

  _nearestObjectId() {
    const pos = this.getPosition?.()
    const entries = this.ajna?.objectMap ? [...this.ajna.objectMap.entries()] : []
    if (!entries.length) return null
    // No position AND no pointing → we cannot tell which object is meant. Return
    // null (caller reports "no target") rather than guessing an arbitrary object.
    if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lon)) {
      return null
    }
    let bestId = null, bestD = Infinity
    for (const [id, o] of entries) {
      if (!Number.isFinite(o?.lat) || !Number.isFinite(o?.lon)) continue
      const d = haversineMeters(pos.lat, pos.lon, o.lat, o.lon)
      if (d < bestD) { bestD = d; bestId = id }
    }
    return bestId
  }
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6378137
  const toRad = d => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}
