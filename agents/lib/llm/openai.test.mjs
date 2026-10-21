import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAiAdapter, toWire, fromWire } from './openai.mjs'

const TOOLS = [
  { name: 'say', description: 'Etwas sagen', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
]

function fakeFetch(reply) {
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    if (reply instanceof Error) throw reply
    if (typeof reply === 'function') return reply(init)
    return { ok: true, status: 200, statusText: 'OK', json: async () => reply, text: async () => JSON.stringify(reply) }
  }
  f.calls = calls
  return f
}

const OK = {
  model: 'llama3.1',
  choices: [{
    finish_reason: 'tool_calls',
    message: {
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'say', arguments: '{"text":"Hallo"}' } }],
    },
  }],
  usage: { prompt_tokens: 50, completion_tokens: 12 },
}

// ── Request shape ────────────────────────────────────────────────────────

test('the request goes to <baseUrl>/chat/completions with bearer auth, function tools and auto choice', async () => {
  const f = fakeFetch(OK)
  const ad = new OpenAiAdapter({ model: 'llama3.1', apiKey: 'k', baseUrl: 'http://127.0.0.1:11434/v1/', fetch: f })
  await ad.complete({ system: 'S', messages: [{ role: 'user', text: 'hi' }], tools: TOOLS, maxTokens: 200, timeoutMs: 5000 })
  const { url, init, body } = f.calls[0]
  assert.equal(url, 'http://127.0.0.1:11434/v1/chat/completions', 'trailing slash on baseUrl must not double')
  assert.equal(init.headers.authorization, 'Bearer k')
  assert.equal(body.model, 'llama3.1')
  assert.equal(body.max_tokens, 200)
  assert.deepEqual(body.messages[0], { role: 'system', content: 'S' })
  assert.equal(body.tools[0].type, 'function')
  assert.equal(body.tools[0].function.name, 'say')
  assert.equal(body.tools[0].function.parameters.additionalProperties, false)
  assert.equal(body.tool_choice, 'auto')
})

test('without an api key no authorization header is sent (local servers)', async () => {
  const f = fakeFetch({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] })
  await new OpenAiAdapter({ model: 'm', fetch: f }).complete({ messages: [{ role: 'user', text: 'hi' }] })
  assert.equal(f.calls[0].init.headers.authorization, undefined)
})

test('a model is required', () => {
  assert.throws(() => new OpenAiAdapter({}), /model is required/)
})

// ── Transcript mapping ───────────────────────────────────────────────────

test('toWire: tool calls serialise arguments as a JSON string; each result is its own tool message', () => {
  const w = toWire('S', [
    { role: 'user', text: 'a' },
    { role: 'assistant', text: 'b', toolCalls: [{ id: 'c1', name: 'say', input: { text: 'x' } }] },
    { role: 'tool', results: [{ id: 'c1', name: 'say', content: { ok: 1 } }, { id: 'c2', name: 'use', content: 'nein', isError: true }] },
  ])
  assert.equal(w[0].role, 'system')
  assert.deepEqual(w[2].tool_calls[0], { id: 'c1', type: 'function', function: { name: 'say', arguments: '{"text":"x"}' } })
  assert.deepEqual(w[3], { role: 'tool', tool_call_id: 'c1', content: '{"ok":1}' })
  assert.deepEqual(w[4], { role: 'tool', tool_call_id: 'c2', content: 'nein' })
})

// ── Response mapping ─────────────────────────────────────────────────────

test('fromWire: tool_calls are parsed, usage and model carried, finish_reason mapped', () => {
  const r = fromWire(OK)
  assert.deepEqual(r.toolCalls, [{ id: 'call_1', name: 'say', input: { text: 'Hallo' } }])
  assert.equal(r.stopReason, 'tool_use')
  assert.deepEqual(r.usage, { input: 50, output: 12 })
  assert.equal(r.model, 'llama3.1')
  assert.equal(r.text, '')
})

test('fromWire: a local model that sends broken JSON arguments does not crash — the call is kept and marked', () => {
  const r = fromWire({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { name: 'say', arguments: '{"text": Hallo' } }] } }] })
  assert.equal(r.toolCalls.length, 1)
  assert.deepEqual(r.toolCalls[0].input, {})
  assert.match(r.toolCalls[0].parseError, /not JSON/)
})

test('fromWire: a call without an id gets one, arrays as arguments are refused', () => {
  const r = fromWire({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'say', arguments: '[1,2]' } }] } }] })
  assert.equal(r.toolCalls[0].id, 'call_0')
  assert.deepEqual(r.toolCalls[0].input, {})
  assert.match(r.toolCalls[0].parseError, /not an object/)
})

test('fromWire: finish reasons', () => {
  const mk = (finish_reason, extra = {}) => fromWire({ choices: [{ finish_reason, message: { content: 'x', ...extra } }] })
  assert.equal(mk('stop').stopReason, 'end_turn')
  assert.equal(mk('length').stopReason, 'max_tokens')
  assert.equal(mk('content_filter').stopReason, 'refusal')
  assert.equal(mk(undefined).stopReason, 'other')
  assert.equal(mk(undefined, { tool_calls: [{ id: 'a', function: { name: 'say', arguments: '{}' } }] }).stopReason, 'tool_use')
})

// ── Errors ───────────────────────────────────────────────────────────────

test('HTTP errors are mapped to kinds', async () => {
  for (const [status, kind] of [[401, 'auth'], [429, 'rate_limited'], [400, 'bad_request'], [404, 'bad_request'], [503, 'unavailable']]) {
    const f = fakeFetch(() => ({ ok: false, status, statusText: 's', text: async () => 'detail' }))
    const ad = new OpenAiAdapter({ model: 'm', fetch: f })
    await assert.rejects(() => ad.complete({ messages: [{ role: 'user', text: 'x' }] }), (e) => e.kind === kind && e.status === status, `${status} → ${kind}`)
  }
})

test('an unreachable server is "unavailable", an abort is "timeout"', async () => {
  const down = fakeFetch(new TypeError('fetch failed'))
  await assert.rejects(() => new OpenAiAdapter({ model: 'm', fetch: down }).complete({ messages: [] }), (e) => e.kind === 'unavailable')

  const slow = async (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e) }))
  await assert.rejects(() => new OpenAiAdapter({ model: 'm', fetch: slow }).complete({ messages: [], timeoutMs: 20 }), (e) => e.kind === 'timeout')
})

test('a non-JSON body is an error, not a crash', async () => {
  const f = fakeFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('nope') } }))
  await assert.rejects(() => new OpenAiAdapter({ model: 'm', fetch: f }).complete({ messages: [] }), (e) => /not JSON/.test(e.message))
})
