// Tests for the action register.
//
// The point of most of these is the guard. A persona takes instructions
// from whatever a player types into the chat, and hands them to a model
// that can call tools. Everything that keeps that from turning into
// "a stranger drives the character" is in `check()` and `validateArgs()`,
// so that is what gets hammered here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIONS, MODES, byKey, actionsFor, toolDefinitions, guard, validateArgs, distanceM,
} from './actions.mjs'

// ── A world the tests can hold in their head ─────────────────────────────
const SELF = { id: 'self1', lat: 50.4466, lon: 7.5971, rotation: { x: 0, y: 0, z: 0 } }
const BENCH = { id: 'bench1', lat: 50.4467, lon: 7.5972, state: { actions: [{ key: 'examine' }] } }
const FAR = { id: 'far1', lat: 50.9, lon: 7.5, state: {} }
const COIN = { id: 'coin1', lat: 50.4466, lon: 7.5971, state: { portable: true } }

function makeCtx(over = {}) {
  const calls = []
  const ctx = {
    mode: 'debug',
    self: SELF,
    perception: {
      objects: [BENCH, FAR, COIN],
      players: [{ id: 'player1', name: 'Mara' }],
      inventory: [],
    },
    limits: { roam: { lat: 50.4466, lon: 7.5971, radius_m: 500 } },
    ajna: {
      updateObject: (...a) => { calls.push(['updateObject', ...a]); return { ok: true } },
      sendChat: (...a) => { calls.push(['sendChat', ...a]); return { ok: true } },
      interact: (...a) => { calls.push(['interact', ...a]); return { ok: true } },
      pickup: (...a) => { calls.push(['pickup', ...a]); return { ok: true } },
      place: (...a) => { calls.push(['place', ...a]); return { ok: true } },
    },
    walkTo: (...a) => { calls.push(['walkTo', ...a]); return { ok: true } },
    stop: () => { calls.push(['stop']); return { ok: true } },
    wait: (...a) => { calls.push(['wait', ...a]); return { ok: true } },
    recordFinding: (...a) => { calls.push(['recordFinding', ...a]); return { ok: true } },
    calls,
  }
  return Object.assign(ctx, over)
}

// ── Shape ────────────────────────────────────────────────────────────────

test('every action carries the four parts and a usable schema', () => {
  for (const a of ACTIONS) {
    assert.equal(typeof a.key, 'string', `${a.key}: key`)
    assert.ok(a.description.length > 5, `${a.key}: description`)
    assert.equal(typeof a.check, 'function', `${a.key}: check`)
    assert.equal(typeof a.expect, 'function', `${a.key}: expect`)
    assert.equal(typeof a.run, 'function', `${a.key}: run`)
    assert.equal(a.parameters.type, 'object', `${a.key}: schema type`)
    for (const req of a.parameters.required || []) {
      assert.ok(a.parameters.properties[req], `${a.key}: required "${req}" is not a property`)
    }
    for (const m of a.modes) assert.ok(MODES.includes(m), `${a.key}: unknown mode ${m}`)
  }
})

test('action keys are unique', () => {
  const keys = ACTIONS.map(a => a.key)
  assert.equal(new Set(keys).size, keys.length)
})

test('basic mode gets no tools at all — that is what basic means', () => {
  assert.deepEqual(actionsFor('basic'), [])
  assert.deepEqual(toolDefinitions('basic'), [])
})

test('an unknown mode gets nothing rather than everything', () => {
  assert.deepEqual(actionsFor('wirklich-alles'), [])
})

test('tool definitions are derived from the register, so they cannot drift', () => {
  const tools = toolDefinitions('debug')
  const keys = actionsFor('debug').map(a => a.key)
  assert.deepEqual(tools.map(t => t.name), keys)
  for (const t of tools) {
    assert.ok(t.description)
    assert.equal(t.input_schema.type, 'object')
  }
})

test('report_finding exists only in debug', () => {
  assert.ok(!actionsFor('passive').some(a => a.key === 'report_finding'))
  assert.ok(!actionsFor('active').some(a => a.key === 'report_finding'))
  assert.ok(actionsFor('debug').some(a => a.key === 'report_finding'))
})

// ── Argument validation ──────────────────────────────────────────────────

test('validateArgs catches what a model actually gets wrong', () => {
  const schema = {
    type: 'object',
    properties: {
      a: { type: 'string' },
      n: { type: 'number', minimum: 1, maximum: 10 },
      e: { type: 'string', enum: ['x', 'y'] },
    },
    required: ['a'],
  }
  assert.equal(validateArgs(schema, { a: 'hallo' }), null)
  assert.match(validateArgs(schema, {}), /missing required/)
  assert.match(validateArgs(schema, { a: '' }), /missing required/)   // leer zählt als fehlend
  assert.match(validateArgs(schema, { a: 1 }), /must be a string/)
  assert.match(validateArgs(schema, { a: 'x', n: '5' }), /must be a number/)
  assert.match(validateArgs(schema, { a: 'x', n: 99 }), /at most/)
  assert.match(validateArgs(schema, { a: 'x', n: 0 }), /at least/)
  assert.match(validateArgs(schema, { a: 'x', e: 'z' }), /must be one of/)
  assert.match(validateArgs(schema, { a: 'x', nope: 1 }), /unknown argument/)
  assert.match(validateArgs(schema, 'nicht mal ein Objekt'), /must be an object/)
  assert.match(validateArgs(schema, ['auch nicht']), /must be an object/)
})

test('NaN is not a number', () => {
  const schema = { type: 'object', properties: { n: { type: 'number' } }, required: [] }
  assert.match(validateArgs(schema, { n: NaN }), /must be a number/)
})

// ── The guard ────────────────────────────────────────────────────────────

test('an unknown action is refused, not thrown', () => {
  const r = guard('debug', 'fliegen', {}, makeCtx())
  assert.equal(r.ok, false)
  assert.match(r.reason, /unknown action/)
})

test('an action outside the mode is refused', () => {
  const r = guard('passive', 'report_finding',
    { type: 'bug', title: 't', description: 'd' }, makeCtx({ mode: 'passive' }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /not available in mode/)
})

test('THE important one: an object that is not perceived cannot be named', () => {
  // This is the line against prompt injection — a player types an id into
  // the chat and the model repeats it.
  const r = guard('debug', 'use', { object_id: 'irgendwas999', action: 'examine' }, makeCtx())
  assert.equal(r.ok, false)
  assert.match(r.reason, /cannot see/)
})

test('and a person who is not present cannot be spoken to', () => {
  const r = guard('debug', 'say', { to: 'fremder9', text: 'hallo' }, makeCtx())
  assert.equal(r.ok, false)
  assert.match(r.reason, /not talking to/)
})

test('the leash holds: a target outside the roaming area is refused', () => {
  const r = guard('debug', 'walk_to', { object_id: 'far1' }, makeCtx())
  assert.equal(r.ok, false)
  assert.match(r.reason, /outside the area/)
})

test('without a leash everything perceived is reachable', () => {
  const ctx = makeCtx({ limits: {} })
  assert.equal(guard('debug', 'walk_to', { object_id: 'far1' }, ctx).ok, true)
})

test('use is refused when the object contradicts it, allowed when it says nothing', () => {
  const ctx = makeCtx()
  const nein = guard('debug', 'use', { object_id: 'bench1', action: 'anzuenden' }, ctx)
  assert.equal(nein.ok, false)
  assert.match(nein.reason, /offers: examine/)
  assert.equal(guard('debug', 'use', { object_id: 'bench1', action: 'examine' }, ctx).ok, true)
  // coin1 lists no actions — then the agent simply does not know better.
  assert.equal(guard('debug', 'use', { object_id: 'coin1', action: 'examine' }, ctx).ok, true)
})

test('drop needs the thing to be in hand, not merely in sight', () => {
  const ctx = makeCtx()
  assert.equal(guard('debug', 'drop', { object_id: 'coin1' }, ctx).ok, false)
  ctx.perception.inventory = [COIN]
  assert.equal(guard('debug', 'drop', { object_id: 'coin1' }, ctx).ok, true)
})

test('an overlong line is refused before it is sent', () => {
  const r = guard('debug', 'say', { to: 'player1', text: 'a'.repeat(801) }, makeCtx())
  assert.equal(r.ok, false)
  assert.match(r.reason, /too long/)
})

test('report_finding is gated by mode, never by content', () => {
  const ctx = makeCtx()
  // Deliberately vague and not a crash: it must still pass. What counts as
  // a finding is the model's judgement, not a predicate's.
  const r = guard('debug', 'report_finding', {
    type: 'suggestion', title: 'Der Hinweis widerspricht sich',
    description: 'Er schickt nach Norden, der Turm steht aber im Süden.',
  }, ctx)
  assert.equal(r.ok, true)
})

// ── Running ──────────────────────────────────────────────────────────────

test('each action reaches exactly one call', async () => {
  const ctx = makeCtx()
  await byKey('say').run(ctx, { to: 'player1', text: 'Guten Tag.' })
  await byKey('use').run(ctx, { object_id: 'bench1', action: 'examine' })
  await byKey('pick_up').run(ctx, { object_id: 'coin1' })
  await byKey('walk_to').run(ctx, { object_id: 'bench1' })
  await byKey('stop').run(ctx, {})
  await byKey('wait').run(ctx, { seconds: 5 })

  assert.deepEqual(ctx.calls.map(c => c[0]),
    ['sendChat', 'interact', 'pickup', 'walkTo', 'stop', 'wait'])
  const [, to, payload] = ctx.calls[0]
  assert.equal(to, 'player1')
  assert.equal(payload.text, 'Guten Tag.')
  assert.equal(payload.object, 'self1', 'die Figur muss mitgeschickt werden, sonst weiss der Client nicht, wer spricht')
})

test('walk_to hands over coordinates, not an id — routing is the caller\'s job', async () => {
  const ctx = makeCtx()
  await byKey('walk_to').run(ctx, { object_id: 'bench1' })
  assert.deepEqual(ctx.calls[0], ['walkTo', BENCH.lat, BENCH.lon])
})

test('drop places the object where the figure stands', async () => {
  const ctx = makeCtx()
  ctx.perception.inventory = [COIN]
  await byKey('drop').run(ctx, { object_id: 'coin1' })
  assert.deepEqual(ctx.calls[0], ['place', 'coin1', { lat: SELF.lat, lon: SELF.lon }])
})

test('end_turn does nothing but say so', async () => {
  const ctx = makeCtx()
  const r = await byKey('end_turn').run(ctx, {})
  assert.deepEqual(r, { ended: true })
  assert.equal(ctx.calls.length, 0)
})

// ── Expectations are evidence, not a filter ──────────────────────────────

test('expect() describes what should follow, and nothing more', () => {
  const ctx = makeCtx()
  assert.deepEqual(byKey('pick_up').expect(ctx, { object_id: 'coin1' }),
    { kind: 'carried_by_me', object_id: 'coin1' })
  assert.deepEqual(byKey('stop').expect(ctx, {}), { kind: 'standing_still' })
  // No expectation is a legitimate answer — saying something changes no state.
  assert.equal(byKey('say').expect(ctx, { to: 'player1', text: 'hm' }), null)
})

test('expect() never decides anything — it only returns a description', () => {
  const ctx = makeCtx()
  for (const a of ACTIONS) {
    const v = a.expect(ctx, { object_id: 'bench1', action: 'examine', to: 'player1', text: 'x', seconds: 1 })
    assert.ok(v === null || (typeof v === 'object' && typeof v.kind === 'string'),
      `${a.key}: expect must return null or {kind}`)
  }
})

// ── Geometry ─────────────────────────────────────────────────────────────

test('distanceM matches known distances closely enough', () => {
  assert.equal(Math.round(distanceM(50.4466, 7.5971, 50.4466, 7.5971)), 0)
  const d = distanceM(50.4466, 7.5971, 50.4476, 7.5971)   // 0.001° Breite
  assert.ok(d > 110 && d < 112, `${d} m`)
})
