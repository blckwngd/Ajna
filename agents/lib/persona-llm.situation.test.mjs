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

test('describeState names the location: coordinates, street, place', () => {
  const t = describeState({
    self: SELF, objects: [], location: { lat: 50.35691, lon: 7.58904, street: 'Löhrstraße', streetDistM: 12 },
    world: { ort: { stadt: 'Koblenz', land: 'Rheinland-Pfalz', text: 'Koblenz, Rheinland-Pfalz' } },
    view: { richtung: 'Westen', headingDeg: 270 },
  })
  assert.match(t, /Standort: 50\.35691, 7\.58904 · an der Löhrstraße \(12 m\) · Koblenz, Rheinland-Pfalz\./)
  assert.match(t, /Du blickst nach Westen\./)
  const ohne = describeState({ self: SELF, objects: [], location: { lat: 50.1, lon: 7.1 } })
  assert.match(ohne, /Standort: 50\.10000, 7\.10000\./, 'without street and place: the coordinates alone')
})

test('every turn hands a trace to onTrace: events, situation, rounds with calls and results, outcome', async () => {
  const traces = []
  const base = { usage: { input: 1, output: 1 }, latencyMs: 1, model: 'fake-1' }
  const llm = { name: 'fake', model: 'fake-1', async complete(req) {
    const last = req.messages[req.messages.length - 1]
    if (last.role === 'tool') return { ...base, text: 'Fertig.', toolCalls: [], stopReason: 'end_turn' }
    return { ...base, text: 'Ich sehe nach.', toolCalls: [{ id: 't1', name: 'look_at', input: { object_id: 'bench1' } }], stopReason: 'tool_use' }
  } }
  const b = new LlmBehaviour({ llm, persona: { name: 'J', prompt: 'p' }, mode: () => 'debug', bundleMs: 1, maxRounds: 3, log() {}, warn() {}, onTrace: (t) => traces.push(t) })
  const ctx = { mode: 'debug', self: SELF, perception: { objects: [BENCH], players: [{ id: 'p1', name: 'Mara' }], inventory: [] }, ajna: { updateObject: async () => ({}) } }
  await b.turn([{ kind: 'chat', player: 'p1', text: 'was ist das' }], ctx)
  assert.equal(traces.length, 1)
  const t = traces[0]
  assert.equal(t.kind_of, 'chat')
  assert.deepEqual(t.events, ['p1 sagt zu dir: „was ist das"'])
  assert.match(t.situation, /LAGE:/)
  assert.match(t.system, /REGELN/)
  assert.equal(t.rounds.length, 2)
  assert.equal(t.rounds[0].calls[0].name, 'look_at')
  assert.match(t.rounds[0].calls[0].result, /Bank \[bench1\]/)
  assert.equal(t.rounds[1].text, 'Fertig.')
  assert.equal(t.outcome.source, 'model')
  // a binding Parley answer is a turn too — without rounds
  await b.turn([{ kind: 'chat', player: 'p1', text: 'hallo', parley: { text: 'Hallo!', binding: true } }], ctx)
  assert.equal(traces[1].outcome.source, 'parley-binding')
  assert.equal(traces[1].rounds.length, 0)
})

test('narrate hands location, view and findings to the model — not only the first eight fields', () => {
  const b = new LlmBehaviour({ llm: { async complete() { throw new Error('unused') } }, persona: { name: 'J', prompt: 'p' }, mode: () => 'debug', log() {}, warn() {} })
  const ctx = {
    self: SELF, perception: { objects: [BENCH], players: [], inventory: [] },
    location: { lat: 50.35691, lon: 7.58904, street: 'Löhrstraße', streetDistM: 12 },
    world: { ort: { text: 'Koblenz, Rheinland-Pfalz' } },
    view: { richtung: 'Westen', headingDeg: 270 },
    findings: [{ title: 'Imbiss sieht aus wie ein Wizard', count: 2 }],
  }
  const text = b.narrate([{ kind: 'chat', player: 'p1', text: 'wo bist du' }], [], ctx)
  assert.match(text, /Standort: 50\.35691, 7\.58904 · an der Löhrstraße \(12 m\) · Koblenz, Rheinland-Pfalz\./)
  assert.match(text, /Du blickst nach Westen\./)
  assert.match(text, /Schon festgehalten[\s\S]*Imbiss sieht aus wie ein Wizard \(×2\)/)
})

test('describeState: date and clock, the building next door, and the area beyond reach', () => {
  const t = describeState({
    self: SELF, objects: [], now: Date.parse('2026-10-23T13:12:00+02:00'),
    location: { lat: 50.1, lon: 7.1, building: 'Kirche St. Kastor' },
    gegend: [{ id: 'w1', name: 'Schloss Sayn', distM: 450, richtung: 'Nordosten', typ: 'Wikipedia' }, { id: 'q1', name: 'Botengang', distM: 300, richtung: 'Süden', typ: 'Auftrag' }],
  })
  assert.match(t, /Heute ist Freitag, der 23\. Oktober 2026, \d\d:12 Uhr\./)
  assert.match(t, /Standort: 50\.10000, 7\.10000 · bei Kirche St\. Kastor\./)
  assert.match(t, /In der Gegend \(weiter weg\): Schloss Sayn \[w1\] 450 m Nordosten \(Wikipedia\) · Botengang \[q1\] 300 m Süden \(Auftrag\)/)
  assert.ok(!/Heute ist/.test(describeState({ self: SELF, objects: [] })), 'no clock line without a time')
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
