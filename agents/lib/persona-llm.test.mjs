import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmBehaviour, Memory, describeState, systemPrompt } from './persona-llm.mjs'
import { LlmError } from './llm.mjs'

// ── Fixtures ─────────────────────────────────────────────────────────────

const SELF = { id: 'self1', lat: 50.3569, lon: 7.5890 }
const BENCH = { id: 'bench1', name: 'Bank', type: 'poi', lat: 50.3570, lon: 7.5891, state: { actions: [{ key: 'examine' }] } }
const COIN = { id: 'coin1', name: 'Münze', type: 'item', lat: 50.3569, lon: 7.5890, state: { portable: true } }

function makeCtx(over = {}) {
  const calls = []
  const ctx = {
    mode: 'debug',
    self: SELF,
    perception: { objects: [BENCH, COIN], players: [{ id: 'p1', name: 'Mara', near: true }], inventory: [] },
    limits: { roam: { lat: SELF.lat, lon: SELF.lon, radius_m: 150 } },
    activity: 'steht herum',
    ajna: {
      sendChat: (...a) => { calls.push(['sendChat', ...a]); return { ok: true } },
      interact: (...a) => { calls.push(['interact', ...a]); return { ok: true } },
      pickup: (...a) => { calls.push(['pickup', ...a]); return { ok: true } },
      place: (...a) => { calls.push(['place', ...a]); return { ok: true } },
      updateObject: (...a) => { calls.push(['updateObject', ...a]); return { ok: true } },
    },
    walkTo: (...a) => { calls.push(['walkTo', ...a]); return true },
    stop: () => { calls.push(['stop']); return true },
    wait: (...a) => { calls.push(['wait', ...a]); return true },
    recordFinding: (...a) => { calls.push(['recordFinding', ...a]); return { ok: true } },
    calls,
  }
  return Object.assign(ctx, over)
}

/** A scripted model: each call pops the next response. */
function scriptedLlm(responses) {
  const requests = []
  return {
    name: 'fake', model: 'fake-1', requests,
    async complete(req) {
      // Snapshot: the runner keeps appending to the same messages array.
      requests.push({ ...req, messages: req.messages.map(m => ({ ...m })) })
      const next = responses.shift()
      if (!next) return { text: '', toolCalls: [], stopReason: 'end_turn', usage: { input: 1, output: 1 }, latencyMs: 1, model: 'fake-1' }
      if (next instanceof Error) throw next
      return { text: '', toolCalls: [], stopReason: next.toolCalls?.length ? 'tool_use' : 'end_turn', usage: { input: 10, output: 5 }, latencyMs: 3, model: 'fake-1', ...next }
    },
  }
}

const PERSONA = { name: 'Jorin', prompt: 'Du bist Jorin.' }
const mk = (llm, mode = 'debug', extra = {}) => new LlmBehaviour({ llm, persona: PERSONA, mode: () => mode, log: () => {}, bundleMs: 1, ...extra })

// ── Mode gate ────────────────────────────────────────────────────────────

test('in basic the model is never asked', async () => {
  const llm = scriptedLlm([])
  const b = mk(llm, 'basic')
  const r = await b.handle({ kind: 'chat', player: 'p1', text: 'hallo' }, makeCtx)
  assert.equal(r.handled, false)
  assert.equal(llm.requests.length, 0)
})

// ── Parley first ─────────────────────────────────────────────────────────

test('a binding Parley answer short-circuits: verbatim, model not consulted', async () => {
  const llm = scriptedLlm([])
  const b = mk(llm)
  const r = await b.turn([{ kind: 'chat', player: 'p1', text: 'wo ist der turm', parley: { text: 'Im Norden.', binding: true, do: [] } }], makeCtx())
  assert.equal(r.source, 'parley-binding')
  assert.deepEqual(r.say, [{ to: 'p1', text: 'Im Norden.', do: [] }])
  assert.equal(llm.requests.length, 0)
})

test('a non-binding Parley answer is handed to the model as material', async () => {
  const llm = scriptedLlm([{ text: '', toolCalls: [{ id: 'c1', name: 'say', input: { to: 'p1', text: 'Tag, Mara.' } }] }])
  const b = mk(llm)
  await b.turn([{ kind: 'chat', player: 'p1', text: 'hallo', parley: { text: 'Tag auch.', binding: false } }], makeCtx())
  const user = llm.requests[0].messages.at(-1)
  assert.match(user.text, /p1 sagt zu dir: „hallo"/)
  assert.match(user.text, /vorbereiteten Antworten würden p1 sagen: „Tag auch\."/)
  assert.match(user.text, /LAGE:/)
})

// ── Tool loop ────────────────────────────────────────────────────────────

test('tool calls run through the guard; results go back; say is collected', async () => {
  const llm = scriptedLlm([
    { toolCalls: [
      { id: 'c1', name: 'use', input: { object_id: 'bench1', action: 'examine' } },
      { id: 'c2', name: 'use', input: { object_id: 'nicht-da', action: 'examine' } },   // not perceived → refused
    ] },
    { toolCalls: [{ id: 'c3', name: 'say', input: { to: 'p1', text: 'Eine Bank.' } }] },
    { toolCalls: [{ id: 'c4', name: 'end_turn', input: {} }] },
  ])
  const b = mk(llm)
  const ctx = makeCtx()
  const r = await b.turn([{ kind: 'chat', player: 'p1', text: 'was ist das' }], ctx)
  assert.equal(r.source, 'model')
  assert.deepEqual(r.say, [{ to: 'p1', text: 'Eine Bank.' }])
  assert.equal(ctx.calls.filter(c => c[0] === 'interact').length, 1)
  assert.equal(ctx.calls.some(c => c[0] === 'sendChat'), true)
  // the refused call went back to the model as an error result
  const toolMsg = llm.requests[1].messages.at(-1)
  assert.equal(toolMsg.role, 'tool')
  const refused = toolMsg.results.find(x => x.id === 'c2')
  assert.equal(refused.isError, true)
  assert.match(refused.content, /verweigert: you cannot see/)
  assert.equal(b.stats.refusedCalls, 1)
  assert.equal(b.stats.toolCalls, 2)   // use (ok) + say; the refused use and end_turn are not work
})

test('end_turn stops the loop and is not counted as work', async () => {
  const llm = scriptedLlm([{ toolCalls: [{ id: 'c1', name: 'end_turn', input: {} }] }, { toolCalls: [{ id: 'x', name: 'say', input: { to: 'p1', text: 'nie' } }] }])
  const b = mk(llm)
  const r = await b.turn([{ kind: 'proximity', player: 'p1', state: 'enter' }], makeCtx())
  assert.equal(llm.requests.length, 1)
  assert.deepEqual(r.say, [])
  assert.equal(b.stats.toolCalls, 0)
})

test('the per-turn cap on tool calls holds', async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, name: 'use', input: { object_id: 'bench1', action: 'examine' } }))
  const llm = scriptedLlm([{ toolCalls: many }, {}])
  const b = mk(llm, 'debug', { maxToolCalls: 3 })
  const ctx = makeCtx()
  await b.turn([{ kind: 'idle' }], ctx)
  assert.equal(ctx.calls.filter(c => c[0] === 'interact').length, 3)
  const results = llm.requests[1].messages.at(-1).results
  assert.equal(results.filter(r => r.isError).length, 6)
})

test('report_finding is available in debug and reaches the recorder — content is not judged', async () => {
  const llm = scriptedLlm([{ toolCalls: [{ id: 'c1', name: 'report_finding', input: { type: 'suggestion', title: 'Hinweis zeigt nach Norden', description: 'Der Turm steht im Süden.' } }] }, {}])
  const ctx = makeCtx()
  await mk(llm).turn([{ kind: 'idle' }], ctx)
  assert.equal(ctx.calls.filter(c => c[0] === 'recordFinding').length, 1)
})

test('in passive mode report_finding is refused by the guard, not crashed on', async () => {
  const llm = scriptedLlm([{ toolCalls: [{ id: 'c1', name: 'report_finding', input: { type: 'bug', title: 't', description: 'd' } }] }, {}])
  const ctx = makeCtx({ mode: 'passive' })
  const b = mk(llm, 'passive')
  await b.turn([{ kind: 'idle' }], ctx)
  assert.equal(ctx.calls.filter(c => c[0] === 'recordFinding').length, 0)
  assert.equal(b.stats.refusedCalls, 1)
})

// ── Fallback ─────────────────────────────────────────────────────────────

test('a model error falls back to the Parley answer', async () => {
  const llm = scriptedLlm([new LlmError('boom', { kind: 'unavailable' })])
  const b = mk(llm)
  const r = await b.turn([{ kind: 'chat', player: 'p1', text: 'hallo', parley: { text: 'Tag auch.', binding: false } }], makeCtx())
  assert.equal(r.source, 'parley-fallback:unavailable')
  assert.deepEqual(r.say, [{ to: 'p1', text: 'Tag auch.' }])
  assert.equal(b.stats.fallbacks, 1)
})

test('a refusal is a fallback too, not a crash and not silence', async () => {
  const llm = scriptedLlm([{ stopReason: 'refusal', toolCalls: [] }])
  const r = await mk(llm).turn([{ kind: 'chat', player: 'p1', text: 'x', parley: { text: 'Hm.', binding: false } }], makeCtx())
  assert.equal(r.source, 'parley-fallback:refusal')
  assert.equal(r.say[0].text, 'Hm.')
})

test('rate limit before the call → fallback, no provider request', async () => {
  const llm = { name: 'f', model: 'f', requests: [], async complete() { throw new LlmError('limit', { kind: 'rate_limited' }) } }
  const r = await mk(llm).turn([{ kind: 'chat', player: 'p1', text: 'x', parley: { text: 'Gleich.', binding: false } }], makeCtx())
  assert.equal(r.source, 'parley-fallback:rate_limited')
})

test('without a Parley answer, a fallback has nothing to say — and says so honestly', async () => {
  const llm = scriptedLlm([new LlmError('boom', { kind: 'timeout' })])
  const r = await mk(llm).turn([{ kind: 'proximity', player: 'p1', state: 'enter' }], makeCtx())
  assert.equal(r.handled, false)
  assert.deepEqual(r.say, [])
})

// ── Text without say ─────────────────────────────────────────────────────

test('bare text in a chat turn is sent to the speaker anyway, marked as coerced', async () => {
  const llm = scriptedLlm([{ text: 'Ich bin Jorin.', toolCalls: [] }])
  const r = await mk(llm).turn([{ kind: 'chat', player: 'p1', text: 'wer bist du' }], makeCtx())
  assert.deepEqual(r.say, [{ to: 'p1', text: 'Ich bin Jorin.', coerced: true }])
})

test('bare text without a speaker is NOT sent anywhere', async () => {
  const llm = scriptedLlm([{ text: 'Hm.', toolCalls: [] }])
  const r = await mk(llm).turn([{ kind: 'idle' }], makeCtx())
  assert.deepEqual(r.say, [])
})

// ── Memory ───────────────────────────────────────────────────────────────

test('what was said with a player is remembered and sent next time — per player', async () => {
  const llm = scriptedLlm([
    { toolCalls: [{ id: 'c1', name: 'say', input: { to: 'p1', text: 'Jorin.' } }] }, {},
    { toolCalls: [{ id: 'c2', name: 'say', input: { to: 'p1', text: 'Ja, Mara.' } }] }, {},
  ])
  const b = mk(llm)
  await b.turn([{ kind: 'chat', player: 'p1', text: 'wer bist du' }], makeCtx())
  await b.turn([{ kind: 'chat', player: 'p1', text: 'kennst du mich' }], makeCtx())
  const second = llm.requests[2].messages
  assert.ok(second.length >= 3, 'history precedes the new message')
  assert.match(second[0].text, /p1 sagt: „wer bist du"/)
  assert.equal(second[1].role, 'assistant')
  assert.match(second[1].text, /Jorin/)
  assert.equal(b.memory.get('p2').length, 0)
})

test('Memory is bounded per player', () => {
  const m = new Memory({ maxEntries: 3 })
  for (let i = 0; i < 10; i++) m.push('p', { role: 'user', text: String(i) })
  assert.deepEqual(m.get('p').map(e => e.text), ['7', '8', '9'])
})

// ── Bundling ─────────────────────────────────────────────────────────────

test('events within the bundle window share one turn', async () => {
  const llm = scriptedLlm([{}])
  const b = mk(llm, 'debug', { bundleMs: 30 })
  const ctx = makeCtx()
  const p = b.handle({ kind: 'proximity', player: 'p1', state: 'enter' }, () => ctx)
  await b.handle({ kind: 'chat', player: 'p1', text: 'hallo' }, () => ctx)
  await p
  assert.equal(llm.requests.length, 1)
  const text = llm.requests[0].messages.at(-1).text
  assert.match(text, /kommt zu dir/)
  assert.match(text, /sagt zu dir: „hallo"/)
})

// ── Prompts ──────────────────────────────────────────────────────────────

test('describeState names ids, distances, actions and people', () => {
  const t = describeState({ self: SELF, home: { lat: SELF.lat, lon: SELF.lon, radius_m: 150 }, objects: [BENCH, COIN], players: [{ id: 'p1', name: 'Mara', near: true, lastSaid: 'hi' }], inventory: [COIN], activity: 'läuft', world: { himmel: { tageszeit: 'Abend' } }, recent: ['use(bench1) → ok'] })
  assert.match(t, /Gerade: läuft/)
  assert.match(t, /Revier: 150 m/)
  assert.match(t, /Bank \[bench1\] · \d+ m · poi · Aktionen: examine/)
  assert.match(t, /Münze \[coin1\].*tragbar/)
  assert.match(t, /Mara \[p1\] · steht bei dir · sagte zuletzt: „hi"/)
  assert.match(t, /Du trägst: Münze \[coin1\]/)
  assert.match(t, /tageszeit: Abend/)
  assert.match(t, /use\(bench1\) → ok/)
})

test('systemPrompt carries the persona text, the rules, and the debug extras only in debug', () => {
  const p = systemPrompt({ prompt: 'Du bist Jorin.', name: 'Jorin', mode: 'passive' })
  assert.match(p, /^Du bist Jorin\./)
  assert.match(p, /AUSSCHLIESSLICH über die Werkzeuge/)
  assert.doesNotMatch(p, /Prüfmodus/)
  const d = systemPrompt({ prompt: 'Du bist Jorin.', name: 'Jorin', mode: 'debug' })
  assert.match(d, /Prüfmodus/)
  assert.match(d, /report_finding/)
  assert.match(d, /Du entscheidest, was zählt/)
})
