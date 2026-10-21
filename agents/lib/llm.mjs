// ─────────────────────────────────────────────────────────────────────────
//  Agent library · LLM — one interface, interchangeable providers
// ─────────────────────────────────────────────────────────────────────────
// What a persona needs from a language model is small and always the same:
// a system prompt, a transcript, a list of tools, and back come text and/or
// tool calls. This module is that contract. The adapters in `llm/` map it
// onto a provider's wire format; nothing above them knows which one runs.
//
// THE TRANSCRIPT IS PROVIDER-NEUTRAL. Three kinds of entries:
//
//   { role: 'user',      text }
//   { role: 'assistant', text?, toolCalls?: [{ id, name, input }] }
//   { role: 'tool',      results: [{ id, name, content, isError? }] }
//
// Anthropic folds tool results into a user turn of `tool_result` blocks;
// OpenAI-compatible endpoints want one `tool` message per result. Both are
// the adapter's business — the persona only ever appends these entries.
//
// WHAT STAYS OUT. Retries and provider SDK details live in the adapters;
// rate limiting and timeouts live here because they are policy, not wire
// format. Secrets come in as options (read from the environment by the
// caller) and are never logged.

/** Something the caller can act on: wait, fall back, or give up. */
export class LlmError extends Error {
  constructor(message, { kind = 'error', cause = null, status = null } = {}) {
    super(message)
    this.name = 'LlmError'
    this.kind = kind          // 'timeout' | 'rate_limited' | 'auth' | 'bad_request' | 'unavailable' | 'error'
    this.cause = cause
    this.status = status
  }
}

/**
 * Token-bucket limit per minute. One bucket per persona: the brief asks for
 * a limit per NPC, and a persona is a process, so a module-level instance
 * would be the same thing — but passing it in keeps tests honest.
 */
export class RateLimiter {
  constructor({ perMinute = 6, now = () => Date.now() } = {}) {
    this.perMinute = Math.max(0, Number(perMinute) || 0)
    this.now = now
    this.stamps = []
  }
  /** Milliseconds until the next call is allowed (0 = now). */
  waitMs() {
    if (this.perMinute <= 0) return Infinity
    const t = this.now()
    this.stamps = this.stamps.filter(s => t - s < 60_000)
    if (this.stamps.length < this.perMinute) return 0
    return 60_000 - (t - this.stamps[0])
  }
  /** Record a call. Throws when the bucket is empty — the caller decides what to do. */
  take() {
    const wait = this.waitMs()
    if (wait > 0) {
      throw new LlmError(`rate limit: ${this.perMinute}/min reached, next in ${Math.ceil(wait / 1000)} s`,
        { kind: 'rate_limited' })
    }
    this.stamps.push(this.now())
  }
}

/** Race a promise against a deadline; the loser is abandoned, not awaited. */
export function withTimeout(promise, ms, what = 'LLM call') {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  let t
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new LlmError(`${what}: ${ms} ms exceeded`, { kind: 'timeout' })), ms)
    }),
  ])
}

/**
 * Tool definitions in the provider-neutral shape the action register emits:
 * `{ name, description, input_schema }`. Both adapters accept exactly this.
 * `strict` schema use needs `additionalProperties: false`; added here once
 * so neither the register nor the adapters have to remember.
 */
export function strictTools(tools) {
  return (tools || []).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: {
      ...sanitizeSchema(t.input_schema),
      additionalProperties: false,
      required: t.input_schema?.required || [],
    },
  }))
}

// Keywords a strict tool schema may carry. Measured on the first live call:
// `tools.7.custom: For 'number' type, properties maximum, minimum are not
// supported` — the register's `wait` tool has a 1–120 s range. The range
// still holds, in `validateArgs` on our side; the model gets the shape and
// the words, not the constraint keywords.
const SCHEMA_KEYWORDS = new Set(['type', 'description', 'enum', 'properties', 'required', 'items', 'additionalProperties'])

/** Strip schema keywords the strict mode rejects, recursively. */
export function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema
  const out = {}
  for (const [k, v] of Object.entries(schema)) {
    if (!SCHEMA_KEYWORDS.has(k)) continue
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v).map(([n, p]) => [n, sanitizeSchema(p)]))
    } else if (k === 'items') {
      out.items = sanitizeSchema(v)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * The result every adapter returns.
 * @typedef {object} LlmResult
 * @property {string} text               concatenated text blocks ('' if none)
 * @property {Array<{id:string,name:string,input:object}>} toolCalls
 * @property {'end_turn'|'tool_use'|'max_tokens'|'refusal'|'other'} stopReason
 * @property {{input:number,output:number}} usage
 * @property {number} latencyMs
 * @property {string} model
 */

/**
 * Wraps an adapter with the policy that is the same for every provider:
 * rate limit before the call, timeout around it, latency measured, secrets
 * never in the error text.
 */
export class LlmClient {
  /**
   * @param {object} adapter   { name, model, complete({system, messages, tools, maxTokens, temperature, effort, timeoutMs}) }
   * @param {object} [opts]
   * @param {RateLimiter} [opts.limiter]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxTokens]
   * @param {number} [opts.temperature]
   * @param {string} [opts.effort]
   * @param {() => number} [opts.now]
   */
  constructor(adapter, {
    limiter = new RateLimiter(), timeoutMs = 20_000, maxTokens = 1024,
    temperature = undefined, effort = 'low', now = () => Date.now(),
  } = {}) {
    if (!adapter || typeof adapter.complete !== 'function') throw new Error('LlmClient: adapter.complete is required')
    this.adapter = adapter
    this.limiter = limiter
    this.timeoutMs = timeoutMs
    this.maxTokens = maxTokens
    this.temperature = temperature
    this.effort = effort
    this.now = now
  }

  get name() { return this.adapter.name }
  get model() { return this.adapter.model }

  /** @returns {Promise<LlmResult>} */
  async complete({ system, messages, tools = [] }) {
    this.limiter.take()
    const t0 = this.now()
    const result = await withTimeout(this.adapter.complete({
      system, messages, tools,
      maxTokens: this.maxTokens, temperature: this.temperature, effort: this.effort,
      timeoutMs: this.timeoutMs,
    }), this.timeoutMs, `${this.adapter.name} ${this.adapter.model}`)
    const latencyMs = this.now() - t0
    return {
      text: String(result.text || ''),
      toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls : [],
      stopReason: result.stopReason || 'other',
      usage: { input: Number(result.usage?.input) || 0, output: Number(result.usage?.output) || 0 },
      latencyMs,
      model: result.model || this.adapter.model,
    }
  }
}

/**
 * Build a client from plain settings — the shape the persona reads from its
 * env and agent_settings. Secrets arrive here already resolved; the
 * persona reads them from the environment, never from the database.
 *
 * @param {object} cfg
 * @param {'anthropic'|'openai'} cfg.provider
 * @param {string} cfg.model
 * @param {string} [cfg.apiKey]
 * @param {string} [cfg.baseUrl]       OpenAI-compatible endpoint (Ollama: http://127.0.0.1:11434/v1)
 * @param {number} [cfg.ratePerMinute]
 * @param {number} [cfg.timeoutMs]
 * @param {number} [cfg.maxTokens]
 * @param {number} [cfg.temperature]
 * @param {string} [cfg.effort]
 * @param {object} [deps]              for tests: { anthropicClient, fetch }
 */
export async function createLlmClient(cfg, deps = {}) {
  const provider = String(cfg.provider || 'anthropic').toLowerCase()
  let adapter
  if (provider === 'anthropic') {
    const { AnthropicAdapter } = await import('./llm/anthropic.mjs')
    adapter = new AnthropicAdapter({ model: cfg.model, apiKey: cfg.apiKey, client: deps.anthropicClient })
  } else if (provider === 'openai') {
    const { OpenAiAdapter } = await import('./llm/openai.mjs')
    adapter = new OpenAiAdapter({ model: cfg.model, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, fetch: deps.fetch })
  } else {
    throw new LlmError(`unknown provider "${provider}" (anthropic | openai)`, { kind: 'bad_request' })
  }
  return new LlmClient(adapter, {
    limiter: new RateLimiter({ perMinute: cfg.ratePerMinute ?? 6 }),
    timeoutMs: cfg.timeoutMs ?? 20_000,
    maxTokens: cfg.maxTokens ?? 1024,
    temperature: cfg.temperature,
    effort: cfg.effort || 'low',
  })
}
