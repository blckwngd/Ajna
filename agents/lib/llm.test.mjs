import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError, RateLimiter, withTimeout, strictTools, LlmClient, createLlmClient } from './llm.mjs'

// ── RateLimiter ──────────────────────────────────────────────────────────

test('the bucket allows N calls per minute, then refuses with a wait time', () => {
  let t = 0
  const rl = new RateLimiter({ perMinute: 2, now: () => t })
  rl.take(); rl.take()
  assert.throws(() => rl.take(), (e) => e instanceof LlmError && e.kind === 'rate_limited')
  assert.ok(rl.waitMs() > 0)
  t = 60_001
  assert.equal(rl.waitMs(), 0)
  rl.take()
})

test('perMinute 0 means: never', () => {
  const rl = new RateLimiter({ perMinute: 0 })
  assert.equal(rl.waitMs(), Infinity)
  assert.throws(() => rl.take(), /rate limit/)
})

// ── withTimeout ──────────────────────────────────────────────────────────

test('withTimeout rejects with kind=timeout and leaves a fast promise alone', async () => {
  const slow = new Promise(res => setTimeout(() => res('spät'), 200))
  await assert.rejects(() => withTimeout(slow, 20, 'probe'), (e) => e.kind === 'timeout' && /probe/.test(e.message))
  assert.equal(await withTimeout(Promise.resolve('schnell'), 1000), 'schnell')
  assert.equal(await withTimeout(Promise.resolve('ohne'), 0), 'ohne')   // 0 = no timeout
})

// ── strictTools ──────────────────────────────────────────────────────────

test('strictTools adds additionalProperties:false and a required list', () => {
  const t = strictTools([{ name: 'x', description: 'd', input_schema: { type: 'object', properties: { a: { type: 'string' } } } }])
  assert.equal(t[0].input_schema.additionalProperties, false)
  assert.deepEqual(t[0].input_schema.required, [])
  assert.equal(t[0].name, 'x')
})

// ── LlmClient ────────────────────────────────────────────────────────────

function fakeAdapter(result, { delayMs = 0, name = 'fake', model = 'fake-1' } = {}) {
  const calls = []
  return {
    name, model, calls,
    async complete(req) {
      calls.push(req)
      if (delayMs) await new Promise(r => setTimeout(r, delayMs))
      if (result instanceof Error) throw result
      return result
    },
  }
}

test('the client passes policy down, measures latency and normalises the result', async () => {
  let t = 1000
  const ad = fakeAdapter({ text: 'Hallo', toolCalls: [{ id: '1', name: 'say', input: {} }], stopReason: 'tool_use', usage: { input: 10, output: 5 } })
  const c = new LlmClient(ad, { timeoutMs: 5000, maxTokens: 333, effort: 'medium', now: () => (t += 50) })
  const r = await c.complete({ system: 'S', messages: [{ role: 'user', text: 'hi' }], tools: [{ name: 'say', description: 'd', input_schema: { type: 'object', properties: {} } }] })
  assert.equal(ad.calls[0].maxTokens, 333)
  assert.equal(ad.calls[0].effort, 'medium')
  assert.equal(ad.calls[0].timeoutMs, 5000)
  assert.equal(r.text, 'Hallo')
  assert.equal(r.toolCalls.length, 1)
  assert.equal(r.stopReason, 'tool_use')
  assert.deepEqual(r.usage, { input: 10, output: 5 })
  assert.equal(r.latencyMs, 50)
  assert.equal(r.model, 'fake-1')
})

test('a missing field in the adapter result becomes a safe default, never undefined', async () => {
  const c = new LlmClient(fakeAdapter({}), { limiter: new RateLimiter({ perMinute: 10 }) })
  const r = await c.complete({ messages: [] })
  assert.equal(r.text, '')
  assert.deepEqual(r.toolCalls, [])
  assert.equal(r.stopReason, 'other')
  assert.deepEqual(r.usage, { input: 0, output: 0 })
})

test('the rate limit is checked BEFORE the adapter is called', async () => {
  const ad = fakeAdapter({ text: 'x' })
  const c = new LlmClient(ad, { limiter: new RateLimiter({ perMinute: 1 }) })
  await c.complete({ messages: [] })
  await assert.rejects(() => c.complete({ messages: [] }), (e) => e.kind === 'rate_limited')
  assert.equal(ad.calls.length, 1, 'the second call must not reach the provider')
})

test('a slow adapter is cut off by the client timeout', async () => {
  const c = new LlmClient(fakeAdapter({ text: 'x' }, { delayMs: 300 }), { timeoutMs: 30 })
  await assert.rejects(() => c.complete({ messages: [] }), (e) => e.kind === 'timeout')
})

test('adapter errors pass through unchanged', async () => {
  const c = new LlmClient(fakeAdapter(new LlmError('nope', { kind: 'auth' })))
  await assert.rejects(() => c.complete({ messages: [] }), (e) => e.kind === 'auth')
})

test('an adapter without complete() is refused at construction', () => {
  assert.throws(() => new LlmClient({}), /adapter\.complete/)
})

// ── createLlmClient ──────────────────────────────────────────────────────

test('createLlmClient wires an Anthropic adapter with an injected client', async () => {
  const fake = { messages: { async create() { return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, model: 'claude-opus-5-5' } } } }
  const c = await createLlmClient({ provider: 'anthropic', model: 'claude-opus-5-5', ratePerMinute: 3 }, { anthropicClient: fake })
  assert.equal(c.name, 'anthropic')
  const r = await c.complete({ messages: [{ role: 'user', text: 'hi' }] })
  assert.equal(r.text, 'ok')
})

test('createLlmClient wires an OpenAI-compatible adapter with an injected fetch', async () => {
  const fetchFake = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'moin' }, finish_reason: 'stop' }], usage: {} }) })
  const c = await createLlmClient({ provider: 'openai', model: 'llama3', baseUrl: 'http://127.0.0.1:11434/v1' }, { fetch: fetchFake })
  assert.equal(c.name, 'openai')
  assert.equal((await c.complete({ messages: [{ role: 'user', text: 'hi' }] })).text, 'moin')
})

test('an unknown provider is a bad_request, named', async () => {
  await assert.rejects(() => createLlmClient({ provider: 'gemini', model: 'x' }), (e) => e.kind === 'bad_request' && /gemini/.test(e.message))
})
