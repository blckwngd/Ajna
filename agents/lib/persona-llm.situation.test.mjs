// The situation text and the tool outcomes after the first findings
// (22.10.2026): types as words, always an action list, who was spoken to,
// what is already on record, and the server's own words on a refusal.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmBehaviour, describeState, systemPrompt } from './persona-llm.mjs'

test('the system prompt names the gestures once, and only when there are any', () => {
  const p = systemPrompt({ prompt: 'Du bist Jorin.', name: 'Jorin', mode: 'passive', gestures: ['wave', 'Idle_Weapon'] })
  assert.match(p, /Gesten: Bei `say` kannst du `do` mitgeben, z\. B\. \["anim:wave"\]\. Deine Gesten: wave, Idle_Weapon\./)
  assert.doesNotMatch(systemPrompt({ prompt: 'x', name: 'J', mode: 'passive' }), /Gesten:/)
  assert.doesNotMatch(systemPrompt({ prompt: 'x', name: 'J', mode: 'passive', gestures: [] }), /Gesten:/)
})

const SELF = { id: 'self1', lat: 50.3569, lon: 7.5890 }
const BENCH = { id: 'bench1', name: 'Bank', type: 'poi', lat: 50.3570, lon: 7.5891, state: { actions: [{ key: 'examine' }] } }
const COIN = { id: 'coin1', name: 'Münze', type: 'item', lat: 50.3569, lon: 7.5890, state: { portable: true } }

test('describeState: type words, action list, finished quest, spoken-to time, findings on record', () => {
  const quest = { id: 'q1', name: 'TestQuest3', type: 'call', lat: SELF.lat, lon: SELF.lon, state: { call: { status: 'done' } } }
  const t = describeState({
    self: SELF, objects: [quest, COIN],
    players: [{ id: 'p1', name: 'Andreas', near: true, saidAt: Date.parse('2026-10-22T07:41:00Z') }],
    inventory: [COIN],
    findings: [{ title: 'Imbiss sieht aus wie ein Wizard', count: 3 }],
  })
  assert.match(t, /TestQuest3 \[q1\] · 0 m · Auftrag \(erledigt\) · Aktionen: examine/)
  assert.ok(!/· call ·/.test(t), 'the bare type key must not appear')
  assert.match(t, /Münze \[coin1\] · 0 m · Gegenstand · Aktionen: examine · tragbar/)
  assert.match(t, /Andreas \[p1\] · steht bei dir · von dir angesprochen um \d\d:\d\d/)
  assert.match(t, /Du trägst: Münze \[coin1\] \(Gegenstand\)/)
  assert.match(t, /Schon festgehalten \(nicht noch einmal melden\):\n- Imbiss sieht aus wie ein Wizard \(×3\)/)
})

test('describeState without findings or spoken-to times stays as it was', () => {
  const t = describeState({ self: SELF, objects: [BENCH], players: [{ id: 'p1' }] })
  assert.match(t, /Bank \[bench1\] · \d+ m · Ort · Aktionen: examine/)
  assert.match(t, /- jemand \[p1\]$/m)
  assert.ok(!/Schon festgehalten/.test(t))
})

test("a server refusal reaches the model in the server's words, not the SDK's", async () => {
  const seen = []
  const base = { usage: { input: 1, output: 1 }, latencyMs: 1, model: 'fake-1' }
  const llm = { name: 'fake', model: 'fake-1', async complete(req) {
    const last = req.messages[req.messages.length - 1]
    if (last.role === 'tool') { seen.push(last.results[0].content); return { ...base, text: 'ok', toolCalls: [], stopReason: 'end_turn' } }
    return { ...base, text: '', toolCalls: [{ id: 't1', name: 'use', input: { object_id: 'bench1', action: 'examine' } }], stopReason: 'tool_use' }
  } }
  const failures = []
  const b = new LlmBehaviour({ llm, persona: { name: 'J', prompt: 'p' }, mode: () => 'debug', bundleMs: 1, maxRounds: 3, log() {}, warn() {} })
  const ctx = {
    mode: 'debug', self: SELF, perception: { objects: [BENCH], players: [{ id: 'p1', name: 'Mara' }], inventory: [] },
    noteFailure: (...a) => failures.push(a),
    ajna: { interact: async () => {
      const e = new Error('Something went wrong while processing your request.')
      e.status = 403
      e.response = { error: "not allowed to perform 'examine' on this object" }
      throw e
    } },
  }
  await b.turn([{ kind: 'chat', player: 'p1', text: 'was ist das' }], ctx)
  assert.equal(seen.length, 1)
  assert.match(seen[0], /not allowed to perform 'examine'/)
  assert.match(seen[0], /HTTP 403/)
  assert.ok(!/Something went wrong/.test(seen[0]))
  assert.deepEqual(failures.map(f => f.slice(0, 2)), [['bench1', 'examine']])
})
