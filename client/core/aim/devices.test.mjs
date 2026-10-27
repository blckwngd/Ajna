// DeviceManager with fake devices: one pointing source, several inputs,
// fallback, feedback routing, calibration, debouncing across devices.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeviceManager, averageSamples, PHONE_ID } from './DeviceManager.js'
import { keysDevice } from './devices.js'

const HERE = { lat: 50.3569, lon: 7.5890 }
const at = (n, e) => ({ lat: HERE.lat + n / 111_320, lon: HERE.lon + e / (111_320 * Math.cos(HERE.lat * Math.PI / 180)) })

function memStore() { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) } }

function fakeDevice(id, caps, extra = {}) {
  const inputs = new Set(), status = new Set()
  const d = {
    id, label: id, kind: extra.kind || 'watch', connected: true, caps,
    started: 0, stopped: 0, sink: null, haptics: [], views: [],
    startPointing(onSample) { d.started++; d.sink = onSample; return () => { d.stopped++; d.sink = null } },
    onInput(cb) { inputs.add(cb); return () => inputs.delete(cb) },
    onStatus(cb) { status.add(cb); return () => status.delete(cb) },
    haptic(p) { d.haptics.push(p) },
    display(v) { d.views.push(v) },
    press(raw) { for (const cb of inputs) cb(raw) },
    setConnected(c) { d.connected = c; for (const cb of status) cb(c) },
    ...extra,
  }
  return d
}

function rig({ now0 = 100_000, storage = memStore() } = {}) {
  let t = now0
  const vib = [], notes = [], spoken = []
  const objs = [{ id: 'bank', name: 'Bank', type: 'poi', ...at(20, 0) }]
  const m = new DeviceManager({
    storage, now: () => t, vibrate: (p) => vib.push(p), notify: (s) => notes.push(s), speak: (s) => spoken.push(s),
    getPosition: () => HERE,
    aimDeps: { getOrigin: () => HERE, getObjects: () => objs },
  })
  return { m, vib, notes, spoken, adv: (ms) => { t += ms }, now: () => t, storage }
}

test('nothing streams until enabled and aiming; exactly one pointing source runs, the old stops first', () => {
  const r = rig()
  const phone = fakeDevice(PHONE_ID, { pointing: 'absolute' })
  const watch = fakeDevice('nus:w', { pointing: 'absolute', input: true, haptics: true, display: true })
  r.m.register(phone); r.m.register(watch)
  r.m.setPointing('nus:w'); r.m.setInput('nus:w', true)
  assert.equal(r.m.input('nus:w', { code: 'stem1' }), null, 'not enabled → input is ignored')
  assert.equal(watch.started, 0, 'not enabled → no stream')
  r.m.setEnabled(true)
  assert.equal(r.m.input('nus:w', { code: 'stem1' }), 'aim_toggle')
  assert.equal(watch.started, 1)
  assert.equal(phone.started, 0)
  r.m.setPointing(PHONE_ID)
  assert.equal(watch.stopped, 1, 'old source stopped')
  assert.equal(phone.started, 1, 'new source started')
  r.m.aim.action('cancel')
  assert.equal(phone.stopped, 1, 'stream ends with the aim mode (battery)')
})

test('a lost pointing device falls back to the phone, says so, and returns when it is back', () => {
  const r = rig()
  const phone = fakeDevice(PHONE_ID, { pointing: 'absolute' })
  const watch = fakeDevice('nus:w', { pointing: 'absolute', input: true, haptics: true })
  r.m.register(phone); r.m.register(watch)
  r.m.setEnabled(true); r.m.setInput('nus:w', true); r.m.setPointing('nus:w')
  r.m.aim.action('aim_toggle')
  watch.setConnected(false)
  assert.equal(phone.started, 1)
  assert.equal(r.m.snapshot().fallbackFrom, 'nus:w')
  assert.ok(r.notes.some(n => /nicht erreichbar/.test(n)))
  assert.ok(r.vib.length > 0, 'the phone vibrates the fallback (the watch is gone)')
  watch.setConnected(true)
  assert.equal(r.m.snapshot().activePointingId, 'nus:w')
  assert.equal(phone.stopped, 1)
})

test('a pointing source that goes silent while aiming falls back too', () => {
  const r = rig()
  const phone = fakeDevice(PHONE_ID, { pointing: 'absolute' })
  const watch = fakeDevice('nus:w', { pointing: 'absolute' })
  r.m.register(phone); r.m.register(watch)
  r.m.setEnabled(true); r.m.setPointing('nus:w'); r.m.aim.action('aim_toggle')
  r.adv(1000); r.m.tick()
  assert.equal(r.m.snapshot().activePointingId, 'nus:w')
  r.adv(3000); r.m.tick()
  assert.equal(r.m.snapshot().activePointingId, PHONE_ID)
})

test('several input devices at once, mapped per device, one action when both fire', () => {
  const r = rig()
  const watch = fakeDevice('nus:w', { input: true }, { kind: 'watch' })
  const remote = fakeDevice('remote', { input: true }, { kind: 'controller' })
  r.m.register(fakeDevice(PHONE_ID, { pointing: 'absolute' }))
  r.m.register(watch); r.m.register(remote)
  r.m.setEnabled(true); r.m.setInput('nus:w', true); r.m.setInput('remote', true)
  watch.press({ code: 'stem1' })                 // watch default: aim_toggle
  assert.equal(r.m.aim.aiming, true)
  r.adv(300)
  remote.press({ code: 'Escape' })               // remote default: cancel
  assert.equal(r.m.aim.aiming, false)
  r.adv(300)
  watch.press({ code: 'stem2' }); remote.press({ code: ' ' })   // both → announce_target, within 180 ms
  assert.equal(r.spoken.length, 1, 'debounced across devices')
  r.m.setMapping('remote', 'Escape', 'announce_target')
  r.adv(300); remote.press({ code: 'Escape' })
  assert.equal(r.spoken.length, 2, 'user mapping overrides the default')
  r.m.setInput('remote', false)
  r.adv(300); remote.press({ code: 'Escape' })
  assert.equal(r.spoken.length, 2, 'a deselected input device is not listened to')
})

test('feedback goes to haptic devices in use; display data to display devices', () => {
  const r = rig()
  const phone = fakeDevice(PHONE_ID, { pointing: 'absolute' })
  const watch = fakeDevice('nus:w', { pointing: 'absolute', input: true, haptics: true, display: true })
  r.m.register(phone); r.m.register(watch)
  r.m.setEnabled(true); r.m.setInput('nus:w', true); r.m.setPointing(PHONE_ID)
  r.m.aim.action('aim_toggle')
  phone.sink({ yaw: 0, pitch: 0, accuracy: 5, t: r.now() })
  assert.ok(watch.haptics.length >= 2, 'aim_on and target felt on the watch')
  assert.equal(r.vib.length, 0, 'the phone stays quiet when a watch takes the haptics')
  const last = watch.views.at(-1)
  assert.equal(last.aiming, true)
  assert.equal(last.target.name, 'Bank')
})

test('calibration averages a short window of samples and stores the offset per device', async () => {
  const r = rig()
  const watch = fakeDevice('nus:w', { pointing: 'relative', input: true })
  r.m.register(fakeDevice(PHONE_ID, { pointing: 'absolute' })); r.m.register(watch)
  r.m.setEnabled(true); r.m.setPointing('nus:w')
  const lm = { ...at(0, 100), name: 'Kirche' }                       // due east
  const p = r.m.calibrate('landmark', lm, { windowMs: 20 })
  assert.equal(watch.started, 1, 'calibration switches the stream on')
  watch.sink({ yaw: 350, pitch: 2, t: r.now() }); watch.sink({ yaw: 10, pitch: 4, t: r.now() })   // mean 0°
  const res = await p
  assert.equal(res.ok, true)
  assert.ok(Math.abs(res.offsetDeg - 90) < 0.5, `offset ${res.offsetDeg}`)
  assert.equal(watch.stopped, 1, 'and off again')
  assert.ok(Math.abs(r.m.config.calibration['nus:w'].offsetDeg - 90) < 0.5)
  assert.ok(r.notes.some(n => /Kalibriert \(Kirche\)/.test(n)))
  // persisted
  const again = new DeviceManager({ storage: r.storage, aimDeps: { getOrigin: () => HERE, getObjects: () => [] } })
  assert.ok(Math.abs(again.config.calibration['nus:w'].offsetDeg - 90) < 0.5)
})

test('an uncalibrated gyro-only source picks no target; calibrated, it does', async () => {
  const r = rig()
  const watch = fakeDevice('nus:w', { pointing: 'relative' })
  r.m.register(fakeDevice(PHONE_ID, { pointing: 'absolute' })); r.m.register(watch)
  r.m.setEnabled(true); r.m.setPointing('nus:w'); r.m.aim.action('aim_toggle')
  watch.sink({ yaw: 40, pitch: 0, t: r.now() })
  assert.equal(r.m.aim.target, null)
  r.m.config.calibration['nus:w'] = { offsetDeg: -40, at: r.now() }
  r.adv(50); watch.sink({ yaw: 40, pitch: 0, t: r.now() })
  assert.equal(r.m.aim.target?.id, 'bank')
})

test('averageSamples is circular around north', () => {
  const a = averageSamples([{ yaw: 355, pitch: 0 }, { yaw: 5, pitch: 10 }])
  assert.ok(a.yaw < 0.5 || a.yaw > 359.5)
  assert.equal(a.pitch, 5)
  assert.equal(averageSamples([]), null)
})

test('keys device: a press is one event on key up, long presses are marked, typing is not an action', () => {
  const handlers = {}
  const win = { addEventListener: (t, h) => { handlers[t] = h }, removeEventListener: (t) => { delete handlers[t] } }
  const d = keysDevice({ win })
  const got = []
  const off = d.onInput((e) => got.push(e))
  const realNow = Date.now
  let t = 1000; Date.now = () => t
  try {
    handlers.keydown({ key: 'Enter', target: {} }); t += 100; handlers.keyup({ key: 'Enter', target: {} })
    handlers.keydown({ key: 'Enter', target: {} }); t += 700; handlers.keyup({ key: 'Enter', target: {} })
    handlers.keydown({ key: 'a', target: { tagName: 'INPUT' } }); handlers.keyup({ key: 'a', target: { tagName: 'INPUT' } })
  } finally { Date.now = realNow }
  assert.deepEqual(got, [{ code: 'Enter', long: false }, { code: 'Enter', long: true }])
  off()
  assert.equal(handlers.keydown, undefined, 'listeners removed with the last subscriber')
})

// ── the screen-off probe ─────────────────────────────────────────────────
import { summarise, describeProbe } from './probe.js'

test('probe verdict: steady arrivals are ok; seconds-long gaps are blocked', () => {
  const mk = (n, dt, delay) => Array.from({ length: n }, (_, i) => ({ seq: i, sent: i * dt, got: i * dt + delay }))
  const timer = Array.from({ length: 200 }, (_, i) => i * 50)
  const good = summarise({ arrivals: mk(200, 50, 20), timer, expected: 200, hz: 20, seconds: 10 })
  assert.equal(good.verdict, 'ok')
  assert.equal(good.delayMedianMs, 20)
  const frozen = mk(200, 50, 20).map((a, i) => i > 50 ? { ...a, got: 50 * 50 + 9000 + i } : a)
  const bad = summarise({ arrivals: frozen, timer, expected: 200, hz: 20, seconds: 10 })
  assert.equal(bad.verdict, 'blocked', JSON.stringify(bad))
  assert.match(describeProbe(bad), /trägt NICHT/)
  const sparse = summarise({ arrivals: mk(150, 66, 400), timer, expected: 200, hz: 20, seconds: 10 })
  assert.equal(sparse.verdict, 'degraded')
})
