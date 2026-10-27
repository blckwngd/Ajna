// Tests for the pointing core: math, calibration, mapping, debouncing, the
// aim state machine (hysteresis, freeze with lookback, interact, raise-to-aim).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  directionFromYawPitch, yawPitchFromDirection, angleDiff, calibrationTarget, computeCalibration,
  effectiveAccuracy, coneForAccuracy,
} from './aimMath.js'
import { hapticPattern } from './haptics.js'
import { defaultMapping, mapRawEvent, ActionDebouncer, ACTIONS } from './inputMapping.js'
import { AimController } from './AimController.js'

const HERE = { lat: 50.3569, lon: 7.5890 }
const at = (n, e) => ({ lat: HERE.lat + n / 111_320, lon: HERE.lon + e / (111_320 * Math.cos(HERE.lat * Math.PI / 180)) })

// ── math ─────────────────────────────────────────────────────────────────

test('yaw/pitch ↔ ENU round trip, north is +N, east is +E', () => {
  const n = directionFromYawPitch(0, 0)
  assert.ok(Math.abs(n[1] - 1) < 1e-9 && Math.abs(n[0]) < 1e-9)
  const e = directionFromYawPitch(90, 0)
  assert.ok(Math.abs(e[0] - 1) < 1e-9)
  const back = yawPitchFromDirection(directionFromYawPitch(237, -20))
  assert.ok(Math.abs(back.yaw - 237) < 1e-9 && Math.abs(back.pitch + 20) < 1e-9)
  assert.equal(angleDiff(10, 350), 20)
  assert.equal(angleDiff(350, 10), -20)
})

test('calibration on the sun: offset from the true azimuth, pitch must match the sun height', () => {
  const noon = new Date('2026-06-21T11:20:00Z')
  const t = calibrationTarget({ kind: 'sun', at: HERE, time: noon })
  assert.equal(t.ok, true)
  assert.ok(t.pitch > 50 && t.pitch < 70, `sun height ${t.pitch}`)
  assert.ok(Math.abs(angleDiff(t.yaw, 180)) < 15, `sun azimuth ${t.yaw}`)
  const r = computeCalibration({ yaw: t.yaw - 23, pitch: t.pitch + 2 }, t)
  assert.equal(r.ok, true)
  assert.ok(Math.abs(r.offsetDeg - 23) < 1e-9)
  const wrong = computeCalibration({ yaw: t.yaw, pitch: 10 }, t)
  assert.equal(wrong.ok, false)
  assert.equal(wrong.reason, 'pitch_mismatch')
})

test('calibration on the shadow: opposite the sun, pointing down', () => {
  const noon = new Date('2026-06-21T11:20:00Z')
  const sun = calibrationTarget({ kind: 'sun', at: HERE, time: noon })
  const sh = calibrationTarget({ kind: 'shadow', at: HERE, time: noon })
  assert.ok(Math.abs(Math.abs(angleDiff(sh.yaw, sun.yaw)) - 180) < 1e-9)
  assert.equal(computeCalibration({ yaw: sh.yaw + 10, pitch: -40 }, sh).ok, true)
  assert.equal(computeCalibration({ yaw: sh.yaw, pitch: 20 }, sh).reason, 'not_pointing_down')
})

test('no sun at night; a landmark works any time', () => {
  const night = new Date('2026-06-21T23:00:00Z')
  assert.equal(calibrationTarget({ kind: 'sun', at: HERE, time: night }).reason, 'sun_too_low')
  const lm = calibrationTarget({ kind: 'landmark', at: HERE, landmark: at(0, 100) })
  assert.ok(Math.abs(lm.yaw - 90) < 0.5)
  assert.equal(computeCalibration({ yaw: 80, pitch: 5 }, lm).offsetDeg, lm.yaw - 80)
  assert.equal(calibrationTarget({ kind: 'landmark', at: HERE }).reason, 'no_landmark')
})

test('drift: a gyro-only source grows uncertain over time, and the cone grows with it', () => {
  assert.equal(effectiveAccuracy({ kind: 'relative', calibratedAt: null }), Infinity)
  const t0 = 1_000_000
  assert.equal(effectiveAccuracy({ kind: 'relative', reportedDeg: 3, calibratedAt: t0, now: t0, driftDegPerMin: 2 }), 3)
  assert.equal(effectiveAccuracy({ kind: 'relative', reportedDeg: 3, calibratedAt: t0, now: t0 + 5 * 60_000, driftDegPerMin: 2 }), 13)
  assert.equal(effectiveAccuracy({ kind: 'absolute', reportedDeg: 8 }), 8)
  assert.equal(coneForAccuracy(12, 5), 12)
  assert.equal(coneForAccuracy(12, 20), 20)
  assert.equal(coneForAccuracy(12, Infinity), 35)
})

// ── haptics, mapping, debounce ───────────────────────────────────────────

test('haptic patterns: by type for target changes, by event otherwise, always off/on timings', () => {
  assert.deepEqual(hapticPattern('target', 'npc'), [0, 25, 60, 25])
  assert.notDeepEqual(hapticPattern('target', 'npc'), hapticPattern('target', 'item'))
  assert.deepEqual(hapticPattern('target', 'unknown'), [0, 30])
  for (const p of [hapticPattern('select'), hapticPattern('error'), hapticPattern('fallback')]) assert.equal(p[0], 0)
})

test('mapping: raw codes and long presses to actions; a device may send actions directly', () => {
  const m = defaultMapping('controller')
  assert.equal(mapRawEvent({ code: 'MediaPlayPause' }, m), 'aim_toggle')
  assert.equal(mapRawEvent({ code: 'MediaPlayPause', long: true }, m), 'cancel')
  assert.equal(mapRawEvent({ code: 'swipe_left' }, m), 'prev_target')
  assert.equal(mapRawEvent({ code: 'q' }, m), null)
  assert.equal(mapRawEvent({ action: 'interact_2' }, m), 'interact_2')
  assert.equal(mapRawEvent({ action: 'format_disk' }, m), null)
  const w = defaultMapping('watch')
  assert.equal(mapRawEvent({ code: 'stem2', long: true }, w), 'calibrate')
  m.MediaPlayPause = 'announce_target'
  assert.equal(defaultMapping('controller').MediaPlayPause, 'aim_toggle', 'defaults are copies')
  for (const v of Object.values(defaultMapping('keyboard'))) assert.ok(ACTIONS.includes(v), v)
})

test('debouncer: two devices on the same action within the window fire once', () => {
  let t = 1000
  const d = new ActionDebouncer({ windowMs: 180, now: () => t })
  assert.equal(d.accept('select_target'), true)
  t += 50; assert.equal(d.accept('select_target'), false)
  assert.equal(d.accept('announce_target'), true, 'another action is independent')
  t += 200; assert.equal(d.accept('select_target'), true)
})

// ── the state machine ────────────────────────────────────────────────────

function rig(opts = {}, objects = null) {
  let t = 10_000
  const objs = objects || [
    { id: 'bank', name: 'Bank', type: 'poi', ...at(20, 0) },                         // north
    { id: 'baum', name: 'Baum', type: 'poi', ...at(20 * Math.cos(Math.PI / 6), 20 * Math.sin(Math.PI / 6)) }, // 30° east
    { id: 'figur', name: 'Mara', type: 'npc', ...at(0, 25), state: { actions: [{ key: 'talk' }, { key: 'examine' }] } }, // east
  ]
  const log = []
  const calls = []
  const c = new AimController({
    getOrigin: () => HERE, getObjects: () => objs, now: () => t,
    interact: async (id, a) => { calls.push([id, a]); if (a === 'boom') throw new Error('nope') },
  }, opts)
  for (const ev of ['mode', 'target', 'lock', 'feedback', 'announce', 'notice', 'interact', 'calibrate']) c.on(ev, (p) => log.push([ev, p]))
  const sample = (yaw, pitch = 0, dt = 50) => { t += dt; c.sample({ yaw, pitch, accuracy: 5, t }) }
  return { c, log, calls, sample, adv: (ms) => { t += ms }, now: () => t }
}

test('aiming picks the object in the cone, and does nothing outside the aim mode', () => {
  const r = rig()
  r.sample(0)
  assert.equal(r.c.target, null, 'no aiming, no target')
  r.c.action('aim_toggle')
  r.sample(0)
  assert.equal(r.c.target.id, 'bank')
  assert.ok(r.log.some(([e, p]) => e === 'feedback' && p.event === 'target' && p.objectType === 'poi'))
  r.sample(90)
  assert.equal(r.c.target.id, 'figur')
})

test('hysteresis: a slightly better neighbour does not steal the target; a clearly better one only after holdMs', () => {
  const r = rig({ coneDeg: 20, holdMs: 250, switchMarginDeg: 3 })
  r.c.action('aim_toggle')
  r.sample(0)
  assert.equal(r.c.target.id, 'bank')
  r.sample(16)          // bank 16°, baum 14°: within the margin → stay
  assert.equal(r.c.target.id, 'bank')
  r.sample(25)          // baum 5°, bank 25° → clearly better, but must hold
  assert.equal(r.c.target.id, 'bank')
  r.sample(25, 0, 100)
  assert.equal(r.c.target.id, 'bank')
  r.sample(25, 0, 200)  // 300 ms since it became best
  assert.equal(r.c.target.id, 'baum')
})

test('select freezes the target from LOOKBACK before — the arm dropping away does not change it', () => {
  const r = rig({ lookbackMs: 200, holdMs: 0 })
  r.c.action('aim_toggle')
  r.sample(0, 0, 50)
  r.sample(0, 0, 300)   // pointing at the bank for a while
  r.sample(90, 0, 100)  // the arm swings to the figure in the last 100 ms …
  assert.equal(r.c.target.id, 'figur')
  r.adv(20)
  r.c.action('select_target')          // … but the selection is what was aimed 200 ms ago
  assert.equal(r.c.locked.id, 'bank')
  assert.equal(r.c.aiming, false)
  r.sample(180)                        // samples after the freeze change nothing
  assert.equal(r.c.locked.id, 'bank')
  assert.ok(r.log.some(([e, p]) => e === 'lock' && p?.id === 'bank'))
})

test('interact_N acts on the selected object; without selection or action it says so and vibrates an error', async () => {
  const r = rig({ holdMs: 0, lookbackMs: 0 })
  assert.equal((await r.c.action('interact_1')).reason, 'nothing_selected')
  r.c.action('aim_toggle'); r.sample(90); r.adv(10); r.c.action('select_target')
  assert.equal(r.c.locked.id, 'figur')
  assert.equal((await r.c.action('interact_1')).action, 'talk')
  assert.equal((await r.c.action('interact_2')).action, 'examine')
  assert.equal((await r.c.action('interact_3')).reason, 'no_such_action')
  assert.deepEqual(r.calls, [['figur', 'talk'], ['figur', 'examine']])
  assert.ok(r.log.some(([e, p]) => e === 'feedback' && p.event === 'success'))
  assert.ok(r.log.some(([e, p]) => e === 'feedback' && p.event === 'error'))
})

test('announce only on request: the target while aiming, the selection afterwards', () => {
  const r = rig({ holdMs: 0, lookbackMs: 0 })
  r.c.action('aim_toggle'); r.sample(0)
  assert.ok(!r.log.some(([e]) => e === 'announce'), 'nothing is said automatically')
  r.c.action('announce_target')
  assert.deepEqual(r.log.filter(([e]) => e === 'announce').at(-1)[1], { text: 'Bank, 20 Meter' })
  r.adv(10); r.c.action('select_target'); r.c.action('announce_target')
  assert.deepEqual(r.log.filter(([e]) => e === 'announce').at(-1)[1], { text: 'Bank, 20 Meter' })
  r.c.action('cancel'); r.c.action('announce_target')
  assert.deepEqual(r.log.filter(([e]) => e === 'announce').at(-1)[1], { text: 'Nichts gewählt' })
})

test('cancel stops aiming without selecting; next/prev step through the candidates and pin the choice', () => {
  const r = rig({ coneDeg: 20, holdMs: 0 })
  r.c.action('aim_toggle'); r.sample(10)
  assert.equal(r.c.target.id, 'bank')
  r.c.action('next_target')
  assert.equal(r.c.target.id, 'baum')
  r.sample(10)                          // pinned: the arm still favours the bank
  assert.equal(r.c.target.id, 'baum')
  r.c.action('prev_target')
  assert.equal(r.c.target.id, 'bank')
  r.c.action('cancel')
  assert.equal(r.c.aiming, false)
  assert.equal(r.c.locked, null)
})

test('raise-to-aim: lifting the arm starts aiming, lowering it selects — with the lookback', () => {
  const r = rig({ raiseToAim: true, raiseDeg: 35, lowerDeg: 10, raiseHoldMs: 300, holdMs: 0, lookbackMs: 200 })
  r.sample(0, 50, 50)
  assert.equal(r.c.aiming, false)
  r.sample(0, 50, 350)
  assert.equal(r.c.aiming, true)
  r.sample(0, 45, 300)
  assert.equal(r.c.target.id, 'bank')
  r.sample(90, 5, 100)                  // the arm drops and swings while lowering
  assert.equal(r.c.aiming, false)
  assert.equal(r.c.locked.id, 'bank')
})

test('a poor source widens the cone: an object 18° off is found with accuracy 20°, not with 5°', () => {
  const objs = [{ id: 'x', name: 'X', type: 'poi', ...at(20 * Math.cos(18 * Math.PI / 180), 20 * Math.sin(18 * Math.PI / 180)) }]
  const r = rig({ coneDeg: 12, releaseFactor: 1 }, objs)
  r.c.action('aim_toggle')
  r.c.sample({ yaw: 0, accuracy: 5, t: r.now() + 50 })
  assert.equal(r.c.target, null)
  r.c.sample({ yaw: 0, accuracy: 20, t: r.now() + 100 })
  assert.equal(r.c.target?.id, 'x')
})

test('calibrate hands the last raw sample to whoever owns the source', () => {
  const r = rig()
  r.sample(42, 7)
  r.c.action('calibrate')
  const ev = r.log.find(([e]) => e === 'calibrate')
  assert.equal(ev[1].sample.yaw, 42)
})
