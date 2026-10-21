// ─────────────────────────────────────────────────────────────────────────
//  LLM adapter · Anthropic — the official SDK, non-streaming
// ─────────────────────────────────────────────────────────────────────────
// A persona's turn is short: a few hundred tokens of context, one or two
// tool calls back. Non-streaming `messages.create` fits that; the SDK's own
// per-request `timeout` keeps a hung connection from hanging the figure.
//
// MODEL NOTES (Claude Opus 5.5 / Sonnet 5.5 / Haiku 5.5):
//   • thinking is adaptive and always on — the `thinking` parameter is
//     omitted; depth is controlled with `output_config.effort`, which
//     defaults to `medium` on Opus 5.5. A game character does not need to
//     deliberate: `low` unless configured otherwise.
//   • forcing a tool (`tool_choice: any/tool`) returns a 400 on these
//     models — `auto` plus the instruction in the system prompt, and
//     `strict: true` so the arguments that do come back match the schema.
//   • `stop_reason: "refusal"` is a normal response (HTTP 200). The persona
//     falls back to Parley then; no server-side fallback model is used —
//     an NPC that stays in character beats one that answers from a second
//     model, and it keeps a beta flag out of the game.
//
// Errors are mapped to `LlmError.kind` so the persona can decide without
// looking at provider classes: wait (rate_limited), fix config (auth),
// fall back (everything else).

import Anthropic from '@anthropic-ai/sdk'
import { LlmError, strictTools } from '../llm.mjs'

export const DEFAULT_MODEL = 'claude-opus-5-5'

export class AnthropicAdapter {
  /**
   * @param {object} opts
   * @param {string} [opts.model]
   * @param {string} [opts.apiKey]   from the environment; the SDK also reads ANTHROPIC_API_KEY itself
   * @param {object} [opts.client]   for tests: anything with `messages.create(params, options)`
   */
  constructor({ model = DEFAULT_MODEL, apiKey, client } = {}) {
    this.name = 'anthropic'
    this.model = model
    this.client = client || new Anthropic(apiKey ? { apiKey } : {})
  }

  async complete({ system, messages, tools = [], maxTokens = 1024, temperature, effort = 'low', timeoutMs = 20_000 }) {
    const params = {
      model: this.model,
      max_tokens: maxTokens,
      system: system || undefined,
      messages: toWire(messages),
    }
    if (tools.length) {
      params.tools = strictTools(tools).map(t => ({ ...t, strict: true }))
      params.tool_choice = { type: 'auto' }
    }
    if (effort) params.output_config = { effort }
    // Temperature is rejected on the current models; only pass it through
    // when someone insists on it for an older one.
    if (temperature !== undefined && temperature !== null) params.temperature = temperature

    let res
    try {
      res = await this.client.messages.create(params, { timeout: timeoutMs })
    } catch (err) {
      throw mapError(err)
    }
    return fromWire(res)
  }
}

/** Neutral transcript → Anthropic messages. Tool results become a user turn of tool_result blocks. */
export function toWire(messages) {
  const out = []
  for (const m of messages || []) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: String(m.text ?? '') })
    } else if (m.role === 'assistant') {
      const content = []
      if (m.text) content.push({ type: 'text', text: String(m.text) })
      for (const c of m.toolCalls || []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input || {} })
      if (!content.length) content.push({ type: 'text', text: '…' })   // an empty assistant turn is rejected
      out.push({ role: 'assistant', content })
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: (m.results || []).map(r => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? null),
          ...(r.isError ? { is_error: true } : {}),
        })),
      })
    }
  }
  return out
}

/** Anthropic response → neutral result. */
export function fromWire(res) {
  const text = (res?.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
  const toolCalls = (res?.content || []).filter(b => b.type === 'tool_use')
    .map(b => ({ id: b.id, name: b.name, input: (b.input && typeof b.input === 'object') ? b.input : {} }))
  const stop = res?.stop_reason
  const stopReason = stop === 'end_turn' || stop === 'tool_use' || stop === 'max_tokens' || stop === 'refusal'
    ? stop : 'other'
  return {
    text, toolCalls, stopReason,
    usage: { input: res?.usage?.input_tokens || 0, output: res?.usage?.output_tokens || 0 },
    model: res?.model || null,
    refusal: stop === 'refusal' ? (res?.stop_details || null) : null,
  }
}

function mapError(err) {
  if (err instanceof LlmError) return err
  const status = err?.status ?? null
  const msg = String(err?.message || err).replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-…')
  if (err instanceof Anthropic.AuthenticationError || status === 401 || status === 403) {
    return new LlmError(`authentication failed (${status}): ${msg}`, { kind: 'auth', cause: err, status })
  }
  if (err instanceof Anthropic.RateLimitError || status === 429) {
    return new LlmError(`rate limited by the provider: ${msg}`, { kind: 'rate_limited', cause: err, status })
  }
  if (err instanceof Anthropic.BadRequestError || status === 400 || status === 404) {
    return new LlmError(`bad request (${status}): ${msg}`, { kind: 'bad_request', cause: err, status })
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError || /timed? ?out/i.test(msg)) {
    return new LlmError(`timeout: ${msg}`, { kind: 'timeout', cause: err, status })
  }
  if (err instanceof Anthropic.APIConnectionError || (status && status >= 500)) {
    return new LlmError(`provider unavailable (${status || 'network'}): ${msg}`, { kind: 'unavailable', cause: err, status })
  }
  return new LlmError(msg, { kind: 'error', cause: err, status })
}
