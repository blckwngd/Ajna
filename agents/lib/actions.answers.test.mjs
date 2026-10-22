// Honest tool answers (22.10.2026).
//
// The persona's first days produced fifty findings; most pointed at the
// tools, not the world: `look_at` answered with the figure's own record,
// `use` let a quest TYPE through as an action and hid the 403 behind the
// SDK's generic sentence, `walk_to` said "true". These pin the corrected
// behaviour — see tests/… no: agents/data/personas/wanderer/findings.jsonl
// for where each of them came from.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  byKey, guard, describeObject, replyFor, offeredActions, typeWord, questDone, duplicateOf, failureKey,
} from './actions.mjs'

const SELF = { id: 'self1', lat: 50.4466, lon: 7.5971, rotation: { x: 0, y: 0, z: 0 } }
const BENCH = { id: 'bench1', name: 'Bank', lat: 50.4467, lon: 7.5972, state: { actions: [{ key: 'examine' }] } }

function makeCtx(over = {}) {
  const calls = []
  const ctx = {
    mode: 'debug',
    self: SELF,
    perception: { objects: [BENCH], players: [{ id: 'player1', name: 'Mara' }], inventory: [] },
    limits: { roam: { lat: 50.4466, lon: 7.5971, radius_m: 500 } },
    ajna: {
      updateObject: (...a) => { calls.push(['updateObject', ...a]); return { ok: true } },
      sendChat: (...a) => { calls.push(['sendChat', ...a]); return { ok: true } },
      interact: (...a) => { calls.push(['interact', ...a]); return { ok: true } },
    },
    walkTo: (...a) => { calls.push(['walkTo', ...a]); return { ok: true } },
    calls,
  }
  return Object.assign(ctx, over)
}

test('look_at answers with the TARGET, not with the result of turning', async () => {
  const ctx = makeCtx({ perception: { objects: [{ ...BENCH, name: 'Imbiss', type: 'poi', description: 'Fleischerei Both.' }], players: [], inventory: [] } })
  const r = await byKey('look_at').run(ctx, { object_id: 'bench1' })
  assert.match(r, /Imbiss \[bench1\]/)
  assert.match(r, /Fleischerei Both/)
  assert.match(r, /Aktionen: examine/)
  assert.ok(!/self1/.test(r), 'the own record must not leak into the answer')
  assert.equal(ctx.calls[0][0], 'updateObject', 'it still turns towards the object')
})

test('look_at works on what the figure carries: in its hand, not out of sight', async () => {
  const ctx = makeCtx({ perception: { objects: [], players: [], inventory: [{ id: 'coin1', name: 'Diamant', type: 'diamond', carried_by: 'self1' }] } })
  assert.equal(guard('debug', 'look_at', { object_id: 'coin1' }, ctx).ok, true)
  const r = await byKey('look_at').run(ctx, { object_id: 'default:coin1' })
  assert.match(r, /in deiner Hand/)
  assert.equal(ctx.calls.length, 0, 'no turning towards something in the hand')
  // walking to it stays refused: it has no place to walk to
  assert.equal(guard('debug', 'walk_to', { object_id: 'coin1' }, ctx).ok, false)
})

test('a quest type is a word, not an action, and a finished one says so', () => {
  const quest = { id: 'q1', name: 'TestQuest3', type: 'call', state: { call: { status: 'done', task: 'Geh hin.' } } }
  assert.equal(typeWord('call'), 'Auftrag')
  assert.equal(typeWord('poi'), 'Ort')
  assert.equal(typeWord('kiosk'), 'kiosk', 'unknown types keep their key')
  assert.equal(questDone(quest), true)
  assert.match(describeObject(quest), /Auftrag \(erledigt\)/)
  assert.match(describeObject(quest), /Aufgabe: Geh hin\./)
  assert.deepEqual(offeredActions(quest), ['examine'])
})

test('use refuses an action the object does not offer, and names what it does', () => {
  const quest = { id: 'q1', lat: 50.4467, lon: 7.5972, type: 'call', state: {} }
  const ctx = makeCtx({ perception: { objects: [quest], players: [], inventory: [] } })
  const g = guard('debug', 'use', { object_id: 'q1', action: 'call' }, ctx)
  assert.equal(g.ok, false)
  assert.match(g.reason, /offers: examine/)
  assert.equal(guard('debug', 'use', { object_id: 'q1', action: 'examine' }, ctx).ok, true)
})

test('use sends talking to say', () => {
  const ctx = makeCtx({ perception: { objects: [{ id: 'p9', type: 'player', lat: 50.4467, lon: 7.5972, state: { actions: [{ key: 'talk' }] } }], players: [], inventory: [] } })
  const g = guard('debug', 'use', { object_id: 'p9', action: 'talk' }, ctx)
  assert.equal(g.ok, false)
  assert.match(g.reason, /use say/)
})

test('use does not run into the same wall twice within the hour', () => {
  const ctx = makeCtx({ failed: (k) => k === failureKey('default:bench1', 'examine') ? { count: 3, error: 'not allowed (HTTP 403)' } : null })
  const g = guard('debug', 'use', { object_id: 'bench1', action: 'examine' }, ctx)
  assert.equal(g.ok, false)
  assert.match(g.reason, /failed 3×/)
  assert.match(g.reason, /HTTP 403/)
  // another action on the same object is not blocked by that memory
  assert.equal(failureKey('default:bench1', 'examine'), failureKey('bench1', 'examine'))
  assert.notEqual(failureKey('bench1', 'examine'), failureKey('bench1', 'pet'))
})

test('use on a hint answers with the text a player would read', async () => {
  const hint = { id: 'h1', lat: 50.4467, lon: 7.5972, type: 'hint', state: { hint: 'Tiere mögen Freiflächen.', actions: [{ key: 'examine' }] } }
  const ctx = makeCtx({ perception: { objects: [hint], players: [], inventory: [] } })
  ctx.ajna.interact = () => ({ ok: true, delivered: 0 })
  const r = await byKey('use').run(ctx, { object_id: 'h1', action: 'examine' })
  assert.match(r, /Tiere mögen Freiflächen/)
  assert.equal(replyFor({}, 'pet', { delivered: 0 }), 'pet ausgelöst. Niemand, der darauf reagieren könnte, ist gerade da.')
  assert.equal(replyFor({}, 'pet', { delivered: 2 }), 'pet ausgelöst. Wer das Objekt betreibt, hat es bemerkt.')
})

test('walk_to says how far and that the figure is not there yet', async () => {
  const ctx = makeCtx({ speedMps: 1.3 })
  const r = await byKey('walk_to').run(ctx, { object_id: 'bench1' })
  assert.match(r, /unterwegs zu Bank/)
  assert.match(r, /\d+ m, etwa \d+ s/)
  assert.match(r, /noch nicht dort/)
  assert.equal(ctx.calls[0][0], 'walkTo')
})

test('say tells the figure when the person is away and reads it later', async () => {
  const ctx = makeCtx()
  const noted = []
  ctx.noteSaid = (id) => noted.push(id)
  ctx.ajna.sendChat = () => ({ ok: true, delivered: 0, stored: true })
  const r = await byKey('say').run(ctx, { to: 'player1', text: 'Hallo' })
  assert.match(r, /liest es später/)
  assert.deepEqual(noted, ['player1'])
  ctx.ajna.sendChat = () => ({ ok: true, delivered: 0, stored: false })
  assert.match(await byKey('say').run(ctx, { to: 'player1', text: 'Hallo' }), /niemand hört/)
  ctx.ajna.sendChat = () => ({ ok: true, delivered: 1 })
  assert.equal(await byKey('say').run(ctx, { to: 'player1', text: 'Hallo' }), 'gesagt')
})

test('duplicateOf finds the same finding in other words, or about the same objects', () => {
  const known = [
    { type: 'bug', title: 'TestQuest4: Aktion „call" schlägt fehl', description: 'use auf default:jukd1ck00jeaiev …' },
    { type: 'bug', title: 'Getragener Gegenstand nicht ansehbar', description: 'look_at auf default:q85lm9o85990v4p verweigert' },
  ]
  assert.equal(duplicateOf(known, { type: 'bug', title: 'Aktion „call" schlägt bei TestQuest4 fehl', description: 'x' }), known[0])
  assert.equal(duplicateOf(known, { type: 'bug', title: 'Nebelbeißer nicht ansehbar', description: 'look_at auf q85lm9o85990v4p: you cannot see that object' }), known[1])
  assert.equal(duplicateOf(known, { type: 'suggestion', title: 'Getragener Gegenstand nicht ansehbar', description: 'x' }), null, 'another type is another finding')
  assert.equal(duplicateOf(known, { type: 'bug', title: 'Wegekreuz verschwindet aus der Wahrnehmung', description: 'y' }), null)
  assert.equal(duplicateOf([], { type: 'bug', title: 'irgendwas', description: '' }), null)
})
