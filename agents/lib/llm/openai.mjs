// ─────────────────────────────────────────────────────────────────────────
//  LLM adapter · OpenAI-compatible — Ollama, vLLM, LM Studio, and the like
// ─────────────────────────────────────────────────────────────────────────
// Raw `fetch` against `/chat/completions`, on purpose: the point of this
// adapter is a LOCAL model without a cloud account, and the protocol is
// simple enough that an SDK would only add a dependency and a second set
// of error classes. Ollama: `baseUrl: http://127.0.0.1:11434/v1`, any key.
//
// Local models are much less reliable with tools than the hosted ones: an
// argument string that is not JSON, a tool name that does not exist, a
// call with no id. All of that is normalised here into a result the guard
// in the action register can refuse cleanly, instead of throwing.

import { LlmError, strictTools } from '../llm.mjs'

export class OpenAiAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.model
   * @param {string} [opts.apiKey]    many local servers ignore it; Ollama accepts anything
   * @param {string} [opts.baseUrl]   default https://api.openai.com/v1
   * @param {Function} [opts.fetch]   for tests
   */
  constructor({ model, apiKey = '', baseUrl = 'https://api.openai.com/v1', fetch: f } = {}) {
    if (!model) throw new LlmError('openai adapter: model is required', { kind: 'bad_request' })
    this.name = 'openai'
    this.model = model
    this.apiKey = apiKey
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.fetch = f || globalThis.fetch
  }

  async complete({ system, messages, tools = [], maxTokens = 1024, temperature, timeoutMs = 20_000 }) {
    const body = {
      model: this.model,
      max_tokens: maxTokens,
      messages: toWire(system, messages),
    }
    if (tools.length) {
      body.tools = strictTools(tools).map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }))
      body.tool_choice = 'auto'
    }
    if (temperature !== undefined && temperature !== null) body.temperature = temperature

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    let res
    try {
      res = await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      if (err?.name === 'AbortError') throw new LlmError(`timeout after ${timeoutMs} ms`, { kind: 'timeout', cause: err })
      throw new LlmError(`provider unreachable: ${err?.message || err}`, { kind: 'unavailable', cause: err })
    }
    clearTimeout(timer)

    if (!res.ok) {
      let detail = ''
      try { detail = (await res.text()).slice(0, 300) } catch {}
      const status = res.status
      const kind = status === 401 || status === 403 ? 'auth'
        : status === 429 ? 'rate_limited'
        : status === 400 || status === 404 ? 'bad_request'
        : status >= 500 ? 'unavailable' : 'error'
      throw new LlmError(`HTTP ${status}: ${detail || res.statusText}`, { kind, status })
    }

    let data
    try { data = await res.json() }
    catch (err) { throw new LlmError('response is not JSON', { kind: 'error', cause: err }) }
    return fromWire(data)
  }
}

/** Neutral transcript → chat messages. One `tool` message per result. */
export function toWire(system, messages) {
  const out = []
  if (system) out.push({ role: 'system', content: String(system) })
  for (const m of messages || []) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: String(m.text ?? '') })
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text ? String(m.text) : null }
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map(c => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
        }))
      }
      out.push(msg)
    } else if (m.role === 'tool') {
      for (const r of m.results || []) {
        out.push({
          role: 'tool', tool_call_id: r.id,
          content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? null),
        })
      }
    }
  }
  return out
}

/** Chat completion → neutral result. Malformed tool calls are kept, marked, and left to the guard. */
export function fromWire(data) {
  const choice = data?.choices?.[0] || {}
  const msg = choice.message || {}
  const toolCalls = []
  for (const [i, c] of (msg.tool_calls || []).entries()) {
    let input = {}
    let parseError = null
    const raw = c?.function?.arguments
    if (typeof raw === 'string' && raw.trim()) {
      try { input = JSON.parse(raw) } catch (err) { parseError = `arguments are not JSON: ${raw.slice(0, 80)}` }
    } else if (raw && typeof raw === 'object') {
      input = raw
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) { input = {}; parseError = parseError || 'arguments are not an object' }
    toolCalls.push({
      id: c?.id || `call_${i}`,
      name: String(c?.function?.name || ''),
      input,
      ...(parseError ? { parseError } : {}),
    })
  }
  const finish = choice.finish_reason
  const stopReason = finish === 'tool_calls' ? 'tool_use'
    : finish === 'stop' ? 'end_turn'
    : finish === 'length' ? 'max_tokens'
    : finish === 'content_filter' ? 'refusal'
    : toolCalls.length ? 'tool_use' : 'other'
  return {
    text: typeof msg.content === 'string' ? msg.content : '',
    toolCalls,
    stopReason,
    usage: { input: data?.usage?.prompt_tokens || 0, output: data?.usage?.completion_tokens || 0 },
    model: data?.model || null,
  }
}
