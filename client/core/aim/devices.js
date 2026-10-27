// devices — the concrete pointing and input devices for DeviceManager.
//
//   phone       pointing from the phone's own sensors (always there)
//   keys        keyboard / Bluetooth remote while the app is in front (WebView keydown)
//   remote      the same remote through the native layer: captured external
//               input (touchpad as swipes, not as a mouse pointer) and media
//               keys with the screen off (MediaSession)
//   nus:<name>  a watch or the combo device over BLE (Nordic UART, JSON lines —
//               the wand's protocol family; docs/geraete-protokoll.md)
//   wand        the magic wand as a POINTING source (its own buttons keep
//               their existing path in WandManager)
//
// Each factory returns the plain device object DeviceManager expects.

import { compassHeadingDeg } from '../compassHeading.js'

/**
 * The Capacitor plugin for everything native here, or null in the browser.
 *
 * NEVER return the plugin proxy from an async function directly: resolving a
 * promise with it asks the proxy for `.then`, and a Capacitor proxy answers
 * every property with a native call — "AimDevices.then() is not implemented"
 * (measured on the phone). It travels wrapped, and is registered once.
 */
let pluginBox = null
export async function aimPlugin() {   // → { plugin } — the box, never the proxy itself
  if (!pluginBox) {
    pluginBox = (async () => {
      try {
        const { Capacitor, registerPlugin } = await import('@capacitor/core')
        return { plugin: Capacitor?.isNativePlatform?.() ? registerPlugin('AimDevices') : null }
      } catch { return { plugin: null } }
    })()
  }
  return pluginBox
}

const listeners = () => {
  const set = new Set()
  return {
    add(cb) { set.add(cb); return () => set.delete(cb) },
    emit(v) { for (const cb of set) { try { cb(v) } catch (err) { console.warn('[aim device]', err?.message || err) } } },
    get size() { return set.size },
  }
}

// ── phone ────────────────────────────────────────────────────────────────

/**
 * The phone's sensors. Yaw from the tilt-compensated compass (absolute events
 * only), pitch from the device tilt: the top edge when held flat-ish, the
 * back camera when held upright — the same two postures compassHeading blends.
 */
export function phoneDevice({ win = globalThis.window } = {}) {
  return {
    id: 'phone', label: 'Telefon', kind: 'phone', connected: true,
    caps: { pointing: 'absolute', input: false, haptics: true, display: true },
    startPointing(onSample) {
      if (!win?.addEventListener) return () => {}
      const handler = (ev) => {
        const yaw = compassHeadingDeg(ev)
        if (yaw === null) return
        const beta = Number(ev.beta) || 0
        const pitch = Math.abs(beta) < 45 ? beta : (beta > 0 ? beta - 90 : beta + 90)
        const acc = Number(ev.webkitCompassAccuracy)
        onSample({ yaw, pitch, accuracy: Number.isFinite(acc) && acc > 0 ? acc : 15, t: Date.now() })
      }
      const type = 'ondeviceorientationabsolute' in win ? 'deviceorientationabsolute' : 'deviceorientation'
      win.addEventListener(type, handler, true)
      return () => win.removeEventListener(type, handler, true)
    },
  }
}

// ── keys (WebView) ───────────────────────────────────────────────────────

const LONG_MS = 600

/**
 * Keyboard and Bluetooth remote while the app is in front. Fires on key UP
 * with the press length, so a long press is one event, not two. Typing in a
 * text field is never an action.
 */
export function keysDevice({ win = globalThis.window, kind = 'controller' } = {}) {
  const out = listeners()
  let down = new Map()
  const isTyping = (ev) => {
    const t = ev.target
    return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))
  }
  const onDown = (ev) => { if (!isTyping(ev) && !ev.repeat && !down.has(ev.key)) down.set(ev.key, Date.now()) }
  const onUp = (ev) => {
    const since = down.get(ev.key)
    down.delete(ev.key)
    if (since === undefined || isTyping(ev)) return
    out.emit({ code: ev.key, long: Date.now() - since >= LONG_MS })
  }
  return {
    id: 'keys', label: 'Tastatur / Fernbedienung (App im Vordergrund)', kind, connected: true,
    caps: { pointing: null, input: true, haptics: false, display: false },
    onInput(cb) {
      if (out.size === 0 && win?.addEventListener) { win.addEventListener('keydown', onDown); win.addEventListener('keyup', onUp) }
      const off = out.add(cb)
      return () => {
        off()
        if (out.size === 0 && win?.removeEventListener) { win.removeEventListener('keydown', onDown); win.removeEventListener('keyup', onUp); down = new Map() }
      }
    },
  }
}

// ── remote (native) ──────────────────────────────────────────────────────

/**
 * The Bluetooth remote through the native layer. While active, input from
 * EXTERNAL devices is captured before the WebView sees it — a touchpad that
 * registers as a mouse would otherwise move a pointer and click into the UI —
 * and media keys arrive through a MediaSession, also with the screen off.
 */
export async function remoteDevice() {
  const P = (await aimPlugin()).plugin
  if (!P) return null
  const out = listeners()
  let sub = null
  return {
    id: 'remote', label: 'Bluetooth-Fernbedienung (auch bei Bildschirm aus)', kind: 'controller', connected: true,
    caps: { pointing: null, input: true, haptics: false, display: false },
    onInput(cb) {
      const off = out.add(cb)
      if (!sub) {
        P.addListener('input', (e) => out.emit({ code: e.code, long: !!e.long, device: e.device })).then(h => { sub = h })
        P.setInputCapture({ enabled: true }).catch(() => {})
        P.setMediaKeys({ enabled: true }).catch(() => {})
      }
      return () => {
        off()
        if (out.size === 0) {
          P.setInputCapture({ enabled: false }).catch(() => {})
          P.setMediaKeys({ enabled: false }).catch(() => {})
          try { sub?.remove() } catch {}
          sub = null
        }
      }
    },
  }
}

// ── NUS devices: watch, combo device ─────────────────────────────────────

/**
 * A watch or the combo device over BLE. Its capabilities come from its
 * `hello`; until then it is an input device without pointing. A watch
 * without compass reports `pointing: 'relative'` (needs calibration) or
 * `null` — it stays a display and input device either way.
 *
 * @param {object} p
 * @param {string} p.name    advertised BLE name (e.g. "AjnaWatch-1A2B")
 * @param {string} [p.address]
 */
export async function nusDevice({ name, address = null }) {
  const P = (await aimPlugin()).plugin
  if (!P || !name) return null
  const id = `nus:${name}`
  const inputs = listeners()
  const status = listeners()
  let samples = null
  const handles = []
  const send = (obj) => P.sendNus({ id, json: JSON.stringify(obj) }).catch(() => {})

  const dev = {
    id, label: name, kind: 'watch', connected: false,
    caps: { pointing: null, input: true, haptics: true, display: true },
    model: null, battery: null,
    startPointing(onSample) {
      samples = onSample
      send({ cmd: 'stream', on: true, hz: 25 })
      return () => { samples = null; send({ cmd: 'stream', on: false }) }
    },
    onInput(cb) { return inputs.add(cb) },
    onStatus(cb) { return status.add(cb) },
    haptic(pattern) { send({ cmd: 'haptic', p: pattern }) },
    display(view) {
      send({
        cmd: 'view', aiming: !!view.aiming,
        target: view.target ? { name: view.target.name, type: view.target.type, dist: view.target.distanceM } : null,
        locked: view.locked ? { name: view.locked.name, type: view.locked.type, dist: view.locked.distanceM } : null,
        actions: view.actions || [], acc: view.accuracyDeg ?? null, notice: view.notice || null,
      })
    },
    async disconnect() { for (const h of handles) { try { h.remove() } catch {} } ; await P.disconnectNus({ id }).catch(() => {}) },
  }

  handles.push(await P.addListener('nusStatus', (e) => {
    if (e.id !== id) return
    dev.connected = !!e.connected
    status.emit(dev.connected)
  }))
  handles.push(await P.addListener('nus', (e) => {
    if (e.id !== id) return
    let m
    try { m = JSON.parse(e.json) } catch { return }
    switch (m.type) {
      case 'hello':
        dev.model = m.model || null
        dev.caps = {
          pointing: m.caps?.pointing === 'absolute' || m.caps?.pointing === 'relative' ? m.caps.pointing : null,
          input: true, haptics: m.caps?.haptics !== false, display: m.caps?.display !== false,
        }
        if (m.model) dev.label = `${m.model} (${name})`
        status.emit(dev.connected)       // capabilities changed — let the manager re-evaluate
        break
      case 'o':          // orientation, compact: y yaw, p pitch, a accuracy (deg), t ms
        samples?.({ yaw: Number(m.y), pitch: Number(m.p), accuracy: Number(m.a), t: Date.now() })
        break
      case 'button': inputs.emit({ code: String(m.code || ''), long: !!m.long }); break
      case 'action': inputs.emit({ action: String(m.name || '') }); break
      case 'status': if (Number.isFinite(m.battery)) dev.battery = m.battery; break
      default: break
    }
  }))
  await P.connectNus({ id, name, ...(address ? { address } : {}) })
  return dev
}

// ── wand (pointing only) ─────────────────────────────────────────────────

/**
 * The magic wand as a pointing source. Its orientation already arrives in
 * WandManager in world ENU; yaw and pitch follow from that. Its buttons keep
 * their own path (select by holding button 2, WandManager) until the wand's
 * firmware speaks semantic actions.
 */
export function wandDevice(wand) {
  if (!wand) return null
  const status = listeners()
  const dev = {
    id: 'wand', label: 'Zauberstab', kind: 'wand', connected: !!wand.connected,
    caps: { pointing: 'absolute', input: false, haptics: false, display: false },
    startPointing(onSample) {
      return wand.onOrientation((o) => {
        const w = o?.world
        if (!Array.isArray(w)) return
        const pitch = Math.atan2(w[2], Math.hypot(w[0], w[1])) * 180 / Math.PI
        const acc = Number(o.acc)
        onSample({ yaw: o.headingDeg, pitch, accuracy: Number.isFinite(acc) && acc > 0 ? acc : 8, t: o.t || Date.now() })
      })
    },
    onStatus(cb) { return status.add(cb) },
  }
  wand.onStatusChange?.((c) => { dev.connected = !!c; status.emit(dev.connected) })
  return dev
}
