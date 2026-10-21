import { test } from 'node:test'
import assert from 'node:assert/strict'
import Anthropic from '@anthropic-ai/sdk'
import { AnthropicAdapter, toWire, fromWire, DEFAULT_MODEL } from './anthropic.mjs'

const TOOLS = [
  { name: 'say', description: 'Etwas sagen', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
]

function fakeClient(response) {
  const calls = []
  return {
    calls,
    messages: {
      async create(params, options) {
        calls.push({ params, options })
        if (response instanceof Error) throw response
        return typeof response === 'function' ? response(params) : response
      },
    },
  }
}

const OK = {
  model: 'claude-opus-5-5',
  stop_reason: 'tool_use',
  content: [
    { type: 'text', text: 'Ich gehe mal hin.' },
    { type: 'tool_use', id: 'toolu_1', name: 'say', input: { text: 'Guten Tag.' } },
  ],
  usage: { input_tokens: 120, output_tokens: 30 },
}

// ── Request shape ────────────────────────────────────────────────────────

test('the request carries system, tools (strict), auto tool choice, effort — and no thinking parameter', async () => {
  const c = fakeClient(OK)
  const ad = new AnthropicAdapter({ client: c })
  await ad.complete({ system: 'Du bist Jorin.', messages: [{ role: 'user', text: 'hallo' }], tools: TOOLS, maxTokens: 500, effort: 'low', timeoutMs: 1234 })
  const { params, options } = c.calls[0]
  assert.equal(params.model, DEFAULT_MODEL)
  assert.equal(params.max_tokens, 500)
  assert.equal(params.system, 'Du bist Jorin.')
  assert.equal(params.tools[0].strict, true)
  assert.equal(params.tools[0].input_schema.additionalProperties, false)
  assert.deepEqual(params.tool_choice, { type: 'auto' })
  assert.deepEqual(params.output_config, { effort: 'low' })
  assert.equal(params.thinking, undefined, 'thinking is adaptive by default on this model — do not send it')
  assert.equal(params.temperature, undefined, 'temperature is rejected on current models')
  assert.equal(options.timeout, 1234)
})

test('without tools, no tool fields are sent at all', async () => {
  const c = fakeClient({ ...OK, content: [{ type: 'text', text: 'hm' }], stop_reason: 'end_turn' })
  await new AnthropicAdapter({ client: c }).complete({ messages: [{ role: 'user', text: 'x' }] })
  assert.equal(c.calls[0].params.tools, undefined)
  assert.equal(c.calls[0].params.tool_choice, undefined)
})

// ── Transcript mapping ───────────────────────────────────────────────────

test('toWire: assistant tool calls become tool_use blocks, tool results a user turn of tool_result blocks', () => {
  const w = toWire([
    { role: 'user', text: 'Wer bist du?' },
    { role: 'assistant', text: 'Moment.', toolCalls: [{ id: 't1', name: 'look_at', input: { object_id: 'o1' } }] },
    { role: 'tool', results: [{ id: 't1', name: 'look_at', content: { ok: true } }, { id: 't2', name: 'use', content: 'nein', isError: true }] },
  ])
  assert.deepEqual(w[0], { role: 'user', content: 'Wer bist du?' })
  assert.equal(w[1].role, 'assistant')
  assert.deepEqual(w[1].content[0], { type: 'text', text: 'Moment.' })
  assert.deepEqual(w[1].content[1], { type: 'tool_use', id: 't1', name: 'look_at', input: { object_id: 'o1' } })
  assert.equal(w[2].role, 'user')
  assert.deepEqual(w[2].content[0], { type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' })
  assert.deepEqual(w[2].content[1], { type: 'tool_result', tool_use_id: 't2', content: 'nein', is_error: true })
})

test('toWire: an assistant turn with neither text nor calls still has content (the API rejects empty)', () => {
  const w = toWire([{ role: 'assistant' }])
  assert.ok(w[0].content.length >= 1)
})

// ── Response mapping ─────────────────────────────────────────────────────

test('fromWire: text and tool calls are separated, usage and model carried', () => {
  const r = fromWire(OK)
  assert.equal(r.text, 'Ich gehe mal hin.')
  assert.deepEqual(r.toolCalls, [{ id: 'toolu_1', name: 'say', input: { text: 'Guten Tag.' } }])
  assert.equal(r.stopReason, 'tool_use')
  assert.deepEqual(r.usage, { input: 120, output: 30 })
  assert.equal(r.model, 'claude-opus-5-5')
  assert.equal(r.refusal, null)
})

test('fromWire: a refusal is a normal result with stopReason=refusal and the details attached', () => {
  const r = fromWire({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' }, usage: {} })
  assert.equal(r.stopReason, 'refusal')
  assert.equal(r.refusal.category, 'cyber')
  assert.deepEqual(r.toolCalls, [])
})

test('fromWire: max_tokens is reported so the caller does not run a truncated tool input', () => {
  assert.equal(fromWire({ content: [], stop_reason: 'max_tokens', usage: {} }).stopReason, 'max_tokens')
  assert.equal(fromWire({ content: [], stop_reason: 'pause_turn', usage: {} }).stopReason, 'other')
})

test('fromWire: a tool_use with a non-object input becomes an empty object, not a crash', () => {
  const r = fromWire({ content: [{ type: 'tool_use', id: 'x', name: 'say', input: null }], stop_reason: 'tool_use', usage: {} })
  assert.deepEqual(r.toolCalls[0].input, {})
})

// ── Error mapping ────────────────────────────────────────────────────────

function sdkError(Cls, status, message) {
  // The SDK's error constructors take (status, error, message, headers).
  try { return new Cls(status, { type: 'error', error: { message } }, message, new Headers()) }
  catch { const e = new Error(message); e.status = status; return e }
}

test('SDK errors are mapped to kinds the persona can act on', async () => {
  const cases = [
    [sdkError(Anthropic.AuthenticationError, 401, 'invalid x-api-key'), 'auth'],
    [sdkError(Anthropic.RateLimitError, 429, 'slow down'), 'rate_limited'],
    [sdkError(Anthropic.BadRequestError, 400, 'tool_choice not supported'), 'bad_request'],
    [sdkError(Anthropic.InternalServerError, 500, 'boom'), 'unavailable'],
  ]
  for (const [err, kind] of cases) {
    const ad = new AnthropicAdapter({ client: fakeClient(err) })
    await assert.rejects(() => ad.complete({ messages: [{ role: 'user', text: 'x' }] }), (e) => e.kind === kind, `${kind}`)
  }
})

test('an API key never appears in the error text', async () => {
  const err = new Error('bad key sk-ant-api03-SECRETSECRET'); err.status = 401
  const ad = new AnthropicAdapter({ client: fakeClient(err) })
  await assert.rejects(() => ad.complete({ messages: [{ role: 'user', text: 'x' }] }), (e) => !/SECRET/.test(e.message) && e.kind === 'auth')
})
