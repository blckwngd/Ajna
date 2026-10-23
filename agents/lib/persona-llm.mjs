// ─────────────────────────────────────────────────────────────────────────
//  Agent library · Persona + language model — one turn at a time
// ─────────────────────────────────────────────────────────────────────────
// This is the seam between the rule-based figure and the model. It owns
// three things and nothing else:
//
//   1. WHEN the model is asked: never per tick, only for an event (someone
//      spoke, someone came near, the figure arrived, a timer for its own
//      initiative). Events that arrive while a turn runs are bundled into
//      the next one.
//   2. WHAT it is told: the persona prompt, a compact description of the
//      situation (`describeState`), the player's words, and what Parley
//      would have answered — as material, not as a verdict.
//   3. WHAT it may do: only the actions of the register, each call passed
//      through `guard()` first. A refused call is handed back to the model
//      as the result of its call; it can try something else.
//
// PARLEY FIRST, ALWAYS. Every utterance runs through the dialogue rules
// before the model sees it. A rule marked `binding: true` answers verbatim
// and the model is not consulted for that line — quest directions, prices,
// promises. Everything else is the model's to phrase.
//
// THE FALLBACK IS PARLEY. Timeout, rate limit, provider error, refusal: the
// figure answers from its rules, as it did before any model existed. A
// persona must never go mute because a cloud service hiccupped.
//
// NOTHING HERE DECIDES WHAT A FINDING IS. In debug mode the model gets the
// `report_finding` tool and the journal of what happened; whether something
// is worth reporting is its judgement alone.

import { actionsFor, toolDefinitions, guard, byKey, typeWord, questDone, offeredActions } from './actions.mjs'

const hhmm = (ms) => { try { return new Date(ms).toTimeString().slice(0, 5) } catch { return '' } }
import { LlmError } from './llm.mjs'
import { BoundedCache } from './bounded-cache.mjs'

const MODEL_MODES = new Set(['passive', 'active', 'debug'])

/**
 * A compact, German description of the situation for the model.
 *
 * Pure: takes plain data, returns text. Distances are rounded; ids are
 * included because the tools need them — the model can only act on what
 * is named here (that is the guard's rule, enforced in `actions.mjs`).
 *
 * @param {object} s
 * @param {{lat:number,lon:number}} s.self
 * @param {{lat:number,lon:number,radius_m?:number}} [s.home]
 * @param {Array<{id:string,name?:string,type?:string,lat?:number,lon?:number,state?:object}>} [s.objects]
 * @param {Array<{id:string,name?:string,near?:boolean,lastSaid?:string}>} [s.players]
 * @param {Array<{id:string,name?:string}>} [s.inventory]
 * @param {object} [s.world]       Weltkontext.varsFuer(...)
 * @param {string} [s.activity]    what the figure is doing right now
 * @param {string[]} [s.recent]    last journal lines
 */
export function describeState(s) {
  const lines = []
  if (s.activity) lines.push(`Gerade: ${s.activity}.`)
  if (s.home && Number.isFinite(s.home.radius_m)) {
    const d = s.self && Number.isFinite(s.self.lat) ? Math.round(distanceM(s.self.lat, s.self.lon, s.home.lat, s.home.lon)) : null
    lines.push(`Dein Revier: ${s.home.radius_m} m um deinen Heimatort${d !== null ? `, du bist ${d} m davon entfernt` : ''}.`)
  }
  const objects = (s.objects || []).filter(o => o && o.id)
  // Where the figure IS, in the world's terms: coordinates (so it can name
  // them), the nearest street, the place. Without it the figure knew its
  // surroundings but not its address — a tester cannot report "at the
  // corner of X" without X.
  if (s.location && Number.isFinite(s.location.lat)) {
    const teile = [`${s.location.lat.toFixed(5)}, ${s.location.lon.toFixed(5)}`]
    if (s.location.street) teile.push(`an der ${s.location.street}${Number.isFinite(s.location.streetDistM) ? ` (${s.location.streetDistM} m)` : ''}`)
    const ort = s.world?.ort?.text || [s.world?.ort?.stadt, s.world?.ort?.land].filter(Boolean).join(', ')
    if (ort) teile.push(ort)
    lines.push(`Standort: ${teile.join(' · ')}.`)
  }
  // The view: heading first, then each object with where it is relative
  // to the figure — "vorn", "links", "hinten", "verdeckt hinter Haus".
  if (s.view?.richtung) lines.push(`Du blickst nach ${s.view.richtung}.`)
  if (objects.length) {
    lines.push('In Reichweite:')
    for (const o of objects.slice(0, 25)) {
      const d = (s.self && Number.isFinite(o.lat)) ? ` · ${Math.round(distanceM(s.self.lat, s.self.lon, o.lat, o.lon))} m` : ''
      // The type as a WORD and the actions as "Aktionen: …", always — the
      // bare key `call` was read as an action, and a missing list as "no
      // actions" (there is always examine).
      const tw = typeWord(o.type)
      const v = o._view
      const lage = v ? (v.imBlick ? (v.sichtbar ? v.sektor : `${v.sektor}, verdeckt hinter ${v.verdecktVon}`) : `${v.sektor}, nicht im Blick`) : null
      const extra = [lage,
                     tw ? (questDone(o) ? `${tw} (erledigt)` : tw) : null,
                     `Aktionen: ${offeredActions(o).join(', ')}`,
                     o.state?.portable ? 'tragbar' : null]
        .filter(Boolean).join(' · ')
      lines.push(`- ${o.name || '(ohne Namen)'} [${o.id}]${d}${extra ? ' · ' + extra : ''}`)
    }
    if (objects.length > 25) lines.push(`- … und ${objects.length - 25} weitere`)
  } else {
    lines.push('In Reichweite: nichts, das du benutzen könntest.')
  }
  const players = (s.players || []).filter(p => p && p.id)
  if (players.length) {
    lines.push('Leute:')
    for (const p of players) {
      // When the figure last spoke to them: the model greeted the same
      // person five times in a row because nothing told it that it had.
      const said = Number(p.saidAt) > 0 ? ` · von dir angesprochen um ${hhmm(p.saidAt)}` : ''
      lines.push(`- ${p.name || 'jemand'} [${p.id}]${p.near ? ' · steht bei dir' : ''}${p.lastSaid ? ` · sagte zuletzt: „${p.lastSaid}"` : ''}${said}`)
    }
  }
  const inv = (s.inventory || []).filter(o => o && o.id)
  // With the type: a figure that carries an "enemy" should be able to notice
  // that something is off — it cannot, if all it sees is a name.
  if (inv.length) lines.push(`Du trägst: ${inv.map(o => `${o.name || '?'} [${o.id}]${o.type ? ` (${typeWord(o.type)})` : ''}`).join(', ')}.`)
  // What is already on record — so it is not recorded again.
  const known = (s.findings || []).filter(f => f && f.title)
  if (known.length) {
    lines.push('Schon festgehalten (nicht noch einmal melden):')
    for (const f of known.slice(-8)) lines.push(`- ${f.title}${Number(f.count) > 1 ? ` (×${f.count})` : ''}`)
  }
  if (s.world && Object.keys(s.world).length) {
    const w = []
    for (const [k, v] of Object.entries(s.world)) {
      if (v && typeof v === 'object') {
        for (const [k2, v2] of Object.entries(v)) if (typeof v2 === 'string' || typeof v2 === 'number') w.push(`${k2}: ${v2}`)
      } else if (typeof v === 'string' || typeof v === 'number') w.push(`${k}: ${v}`)
    }
    if (w.length) lines.push(`Umgebung: ${w.slice(0, 12).join(' · ')}.`)
  }
  if (s.recent?.length) {
    lines.push('Zuletzt passiert:')
    for (const r of s.recent.slice(-8)) lines.push(`- ${r}`)
  }
  return lines.join('\n')
}

/** Haversine, metres. */
export function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** The fixed part of the system prompt — the rules of the game, in the figure's language. */
export function systemPrompt({ prompt, name, mode, parleyNote = true, gestures = null }) {
  const parts = [
    prompt.trim(),
    '',
    'REGELN:',
    `- Du bist eine Figur in einer Welt, die Spieler über ihr Telefon sehen. Dein Name: ${name}.`,
    '- Du handelst AUSSCHLIESSLICH über die Werkzeuge. Was du sagen willst, sagst du mit `say`. Wenn nichts zu tun ist: `end_turn`.',
    '- Du kennst nur, was in der Beschreibung der Lage steht. Erfinde keine Orte, Personen oder Kennungen. Benutze nur die Kennungen [id], die dort stehen.',
    '- Wird dir eine Aktion verweigert, versuche etwas anderes oder sag, dass es nicht geht. Behaupte nie, etwas getan zu haben, das verweigert wurde.',
    '- Was du TUST, tust du mit einem Werkzeug — gehen heißt `walk_to`, ansehen heißt `look_at`. „Ich gehe jetzt hin" ohne Aufruf ist gelogen: Die Spieler sehen, ob du gehst.',
    '- Sprich kurz, in deiner Rolle, auf Deutsch. Keine Listen, keine Erklärungen über dich als Programm.',
  ]
  // The figure's gestures, once: `say` takes `do: ["anim:<Name>"]`, the
  // same notation as the dialogue rules. Listed here instead of per turn —
  // the system prompt is cached, the situation is not.
  if (Array.isArray(gestures) && gestures.length) {
    parts.push(`- Gesten: Bei \`say\` kannst du \`do\` mitgeben, z. B. ["anim:${gestures[0]}"]. Deine Gesten: ${gestures.join(', ')}. Andere hast du nicht — verlangt jemand eine, die fehlt (tanzen, hinfallen), nimm die passendste aus der Liste und sag dazu, was du tust, oder sag, dass du das nicht kannst. Behaupte nie eine Geste, die nicht auf der Liste steht.`)
  }
  if (parleyNote) {
    parts.push('- Manchmal steht dabei, was deine vorbereiteten Antworten sagen würden. Das ist Material für dich, kein Zwang — aber widersprich ihm nicht.')
  }
  if (mode === 'debug') {
    parts.push('', 'ZUSÄTZLICH, weil du im Prüfmodus bist:',
      '- Du probierst aus, was die Welt dir anbietet, und achtest darauf, ob es tut, was es verspricht.',
      '- Was dir als Spieler an deiner Stelle auffiele — kaputt, widersprüchlich, verwirrend, verbesserungswürdig —, hältst du mit `report_finding` fest. Du entscheidest, was zählt; es gibt keine Liste. Was schon festgehalten ist, meldest du nicht noch einmal, und was einmal fehlschlug, probierst du nicht gleich wieder.',
      '- Beschreibe in jedem Befund, was du versucht hast, was du erwartet hast und was stattdessen geschah. Nenne Kennungen.')
  }
  return parts.join('\n')
}

/**
 * Per-player short-term memory: a ring of compact transcript entries.
 * Bounded twice — entries per player and players overall — because a
 * persona on a public server meets strangers all day.
 */
export class Memory {
  constructor({ maxPlayers = 50, maxEntries = 24, ttlMs = 6 * 60 * 60_000 } = {}) {
    this.maxEntries = maxEntries
    this.cache = new BoundedCache({ maxEntries: maxPlayers, ttlMs })
  }
  get(playerId) { return this.cache.get(playerId) || [] }
  push(playerId, entry) {
    const list = this.get(playerId).slice()
    list.push(entry)
    while (list.length > this.maxEntries) list.shift()
    this.cache.set(playerId, list)
    return list
  }
  /** Everything, for persistence or diagnosis. */
  dump() {
    const out = {}
    for (const [k, v] of this.cache._map?.entries?.() || []) {
      const list = Array.isArray(v) ? v : (Array.isArray(v?.value) ? v.value : null)
      if (list) out[k] = list
    }
    return out
  }
  /** The inverse of dump() — what a restart reads back. Bad input is ignored, not fatal. */
  load(obj) {
    if (!obj || typeof obj !== 'object') return 0
    let n = 0
    for (const [k, list] of Object.entries(obj)) {
      if (!Array.isArray(list)) continue
      this.cache.set(k, list.slice(-this.maxEntries))
      n++
    }
    return n
  }
}

/**
 * The turn runner.
 *
 * @param {object} deps
 * @param {import('./llm.mjs').LlmClient} deps.llm
 * @param {{name:string, prompt:string}} deps.persona
 * @param {() => string} deps.mode            current mode (may change at runtime)
 * @param {Function} deps.log
 * @param {Function} [deps.warn]
 * @param {Function} [deps.onJournal]         (entry) => void — evidence, for step 5
 * @param {number} [deps.maxToolCalls]         per turn
 * @param {number} [deps.bundleMs]             how long to wait for more events before a turn
 * @param {Memory} [deps.memory]
 * @param {() => number} [deps.now]
 */
export class LlmBehaviour {
  constructor({ llm, persona, mode, log, warn, onJournal = null, onTrace = null, maxToolCalls = 6, maxRounds = 3, bundleMs = 1200, memory = null, now = () => Date.now() } = {}) {
    if (!llm) throw new Error('LlmBehaviour: llm is required')
    this.llm = llm
    this.persona = persona
    this.mode = mode
    this.log = log || (() => {})
    this.warn = warn || this.log
    this.onJournal = onJournal
    // Called once per turn with everything the turn consisted of — for the
    // transcript on disk (journal.mjs). Nothing here depends on it.
    this.onTrace = onTrace
    this.maxToolCalls = maxToolCalls
    // Rounds = model requests per turn. Each one resends the whole transcript,
    // so this is the cost lever: one turn used to allow up to seven. The model
    // can put several tool calls into one round; it does not need more.
    this.maxRounds = Math.max(1, maxRounds)
    this.bundleMs = bundleMs
    this.memory = memory || new Memory()
    this.now = now
    this.pending = []        // bundled events
    this.timer = null
    this.running = null      // Promise of the turn in flight
    this.stats = { turns: 0, toolCalls: 0, refusedCalls: 0, fallbacks: 0, tokensIn: 0, tokensOut: 0 }
  }

  /** Is the model in charge right now? */
  get active() { return MODEL_MODES.has(this.mode()) }

  /**
   * Queue an event. Returns a promise that resolves when the turn that
   * includes this event is done (or immediately if the model is off).
   *
   * event: { kind: 'chat'|'proximity'|'interact'|'arrived'|'idle', player?, text?, action?, state? }
   * ctxFn: () => ctx for the action register (fresh perception each turn)
   */
  async handle(event, ctxFn) {
    if (!this.active) return { handled: false, reason: 'model off' }
    this.pending.push({ ...event, at: this.now() })
    this.ctxFn = ctxFn
    if (this.running) return this.running
    this.running = new Promise((resolve) => {
      this.timer = setTimeout(async () => {
        const events = this.pending.splice(0)
        let result
        try { result = await this.turn(events, this.ctxFn()) }
        catch (err) { this.warn(`turn failed: ${err?.message || err}`); result = { handled: false, reason: String(err?.message || err) } }
        this.running = null
        resolve(result)
        // Events that arrived during the turn get their own.
        if (this.pending.length) this.handle(this.pending.pop(), this.ctxFn).catch(() => {})
      }, this.bundleMs)
    })
    return this.running
  }

  /**
   * One turn: Parley first, then the model with tools, then fallback.
   * Exposed for tests; `handle()` is the entry point in the agent.
   */
  async turn(events, ctx) {
    const mode = this.mode()
    const chats = events.filter(e => e.kind === 'chat' && e.player && e.text)
    const speaker = chats.length ? chats[chats.length - 1].player : null
    // The transcript of this turn — filled as it goes, handed out at the end.
    const trace = { kind_of: events.map(e => e.kind).join('+'), events: this.eventLines(events), situation: null, system: null, rounds: [], outcome: null }

    // ── Parley first ──────────────────────────────────────────────────
    // Each utterance through the rules. A binding answer short-circuits.
    const parleyAnswers = []
    for (const c of chats) {
      const a = c.parley || null       // { text, binding, do } — the agent ran Parley already
      if (a?.binding && a.text) {
        this.log(`binding answer for ${c.player}: „${a.text.slice(0, 50)}"`)
        trace.outcome = { source: 'parley-binding', said: [{ to: c.player, text: a.text }] }
        this._emitTrace(trace)
        return { handled: true, source: 'parley-binding', say: [{ to: c.player, text: a.text, do: a.do || [] }] }
      }
      if (a?.text) parleyAnswers.push({ player: c.player, text: a.text })
    }

    // ── The model ─────────────────────────────────────────────────────
    const tools = toolDefinitions(mode)
    const system = systemPrompt({ prompt: this.persona.prompt, name: this.persona.name, mode, gestures: this.persona.gestures || null })
    const messages = speaker ? this.memory.get(speaker).slice() : []
    messages.push({ role: 'user', text: this.narrate(events, parleyAnswers, ctx) })
    trace.situation = messages[messages.length - 1].text
    trace.system = system

    const said = []
    const journal = []
    let calls = 0
    let ended = false
    let lastText = ''
    try {
      for (let round = 0; round < this.maxRounds && !ended; round++) {
        const res = await this.llm.complete({ system, messages, tools })
        this.stats.turns++
        this.stats.tokensIn += res.usage.input; this.stats.tokensOut += res.usage.output
        this.log(`model ${res.model}: ${res.stopReason}, ${res.toolCalls.length} call(s), ${res.usage.input}+${res.usage.output} tok, ${res.latencyMs} ms`)
        if (res.stopReason === 'refusal') throw new LlmError('the model declined', { kind: 'refusal' })
        if (res.stopReason === 'max_tokens' && res.toolCalls.length) throw new LlmError('tool input truncated (max_tokens)', { kind: 'error' })

        if (res.text) lastText = res.text
        messages.push({ role: 'assistant', text: res.text || undefined, toolCalls: res.toolCalls })
        const runde = { model: res.model, stopReason: res.stopReason, text: res.text || '', usage: res.usage, latencyMs: res.latencyMs, calls: [] }
        trace.rounds.push(runde)
        if (!res.toolCalls.length) break

        const results = []
        for (const call of res.toolCalls) {
          if (calls >= this.maxToolCalls) { results.push({ id: call.id, name: call.name, content: 'genug für diesen Moment', isError: true }); continue }
          calls++
          const g = guard(mode, call.name, call.input, ctx)
          if (!g.ok) {
            this.stats.refusedCalls++
            this.log(`refused ${call.name}: ${g.reason}`)
            journal.push(`${call.name} verweigert: ${g.reason}`)
            results.push({ id: call.id, name: call.name, content: `verweigert: ${g.reason}`, isError: true })
            continue
          }
          if (call.name === 'end_turn') { ended = true; results.push({ id: call.id, name: call.name, content: 'ok' }); continue }
          this.stats.toolCalls++
          const expect = g.action.expect(ctx, call.input)
          let outcome
          try {
            const r = await g.action.run(ctx, call.input)
            outcome = { ok: true, result: compact(r) }
            // `sent: true` — the tool already delivered it. The caller must
            // not send it a second time (it did, once: every answer showed up
            // twice in the chat).
            if (call.name === 'say') said.push({ to: call.input.to, text: call.input.text, sent: true })
          } catch (err) {
            // THE SERVER'S OWN WORDS. Ajna's routes answer `{error: "…"}`,
            // PocketBase's built-ins `{message: "…"}`; the SDK's `.message`
            // is a generic sentence whenever it finds neither where it
            // looks. The persona saw "Something went wrong while
            // processing your request" sixty times and never the 403
            // "not allowed to perform 'call'" behind it.
            const body = err?.response || err?.data || null
            const text = body?.error || body?.message || body?.data?.message || err?.message || String(err)
            const status = Number(err?.status) > 0 ? ` (HTTP ${err.status})` : ''
            outcome = { ok: false, error: `${String(text).slice(0, 200)}${status}` }
            if (call.input?.object_id && call.input?.action) {
              try { ctx.noteFailure?.(call.input.object_id, call.input.action, outcome.error) } catch {}
            }
          }
          const entry = { at: this.now(), action: call.name, input: call.input, expect, outcome }
          journal.push(`${call.name}(${shortArgs(call.input)}) → ${outcome.ok ? 'ok' : 'FEHLER: ' + outcome.error}`)
          if (this.onJournal) { try { this.onJournal(entry) } catch {} }
          results.push({ id: call.id, name: call.name, content: outcome.ok ? (outcome.result ?? 'ok') : `Fehler: ${outcome.error}`, isError: !outcome.ok })
        }
        messages.push({ role: 'tool', results })
        runde.calls = res.toolCalls.map(c => {
          const r = results.find(x => x.id === c.id)
          return { name: c.name, input: c.input, result: r?.content, isError: !!r?.isError }
        })
      }
    } catch (err) {
      // ── Fallback: the rules ─────────────────────────────────────────
      const kind = err instanceof LlmError ? err.kind : 'error'
      this.stats.fallbacks++
      this.warn(`model unavailable (${kind}: ${err?.message || err}) — answering from Parley`)
      const fallback = parleyAnswers.map(a => ({ to: a.player, text: a.text }))
      trace.outcome = { source: `parley-fallback:${kind}`, reason: String(err?.message || err), said: fallback }
      this._emitTrace(trace)
      return { handled: fallback.length > 0, source: `parley-fallback:${kind}`, say: fallback, journal }
    }

    // A chat answered with bare text and no `say`: send it anyway. A mute
    // figure because the model forgot the tool is the worse outcome.
    if (speaker && !said.length && lastText.trim()) {
      said.push({ to: speaker, text: lastText.trim(), coerced: true })
      this.log('model answered in text, not via say — sent it anyway')
    }

    // ── Memory ────────────────────────────────────────────────────────
    if (speaker) {
      for (const c of chats) this.memory.push(speaker, { role: 'user', text: `${c.player} sagt: „${c.text}"` })
      for (const s of said) if (s.to === speaker) this.memory.push(speaker, { role: 'assistant', text: s.text })
    }
    trace.outcome = { source: 'model', said: said.map(s => ({ to: s.to, text: s.text, coerced: s.coerced === true })), calls }
    this._emitTrace(trace)
    return { handled: true, source: 'model', say: said, calls, journal }
  }

  _emitTrace(trace) {
    if (!this.onTrace) return
    try { this.onTrace(trace) } catch (err) { this.warn(`trace: ${err?.message || err}`) }
  }

  /** What happened, one line per event — the first part of the user message, and the transcript's header. */
  eventLines(events) {
    const lines = []
    for (const e of events) {
      if (e.kind === 'chat') lines.push(`${e.player} sagt zu dir: „${e.text}"`)
      else if (e.kind === 'proximity') lines.push(e.state === 'leave' ? `${e.player} geht weg.` : `${e.player} kommt zu dir.`)
      else if (e.kind === 'interact') lines.push(`${e.player} wählt „${e.action}" an dir.`)
      else if (e.kind === 'arrived') lines.push('Du bist angekommen.')
      else if (e.kind === 'idle') lines.push('Nichts passiert gerade. Du hast Zeit.')
      else if (e.text) lines.push(e.text)
    }
    return lines
  }

  /** The user message for a bundle of events. */
  narrate(events, parleyAnswers, ctx) {
    const lines = this.eventLines(events)
    for (const a of parleyAnswers) lines.push(`(Deine vorbereiteten Antworten würden ${a.player} sagen: „${a.text}")`)
    lines.push('', 'LAGE:', describeState(ctx?.describe ? ctx.describe() : {
      self: ctx?.self, home: ctx?.limits?.roam, objects: ctx?.perception?.objects,
      players: ctx?.perception?.players, inventory: ctx?.perception?.inventory, world: ctx?.world, activity: ctx?.activity, recent: ctx?.recent,
    }))
    return lines.join('\n')
  }
}

function compact(r) {
  if (r === undefined || r === null) return 'ok'
  // A description (look_at) is prose and worth its length; records stay short.
  if (typeof r === 'string') return r.slice(0, 700)
  try {
    const s = JSON.stringify(r)
    return s.length > 300 ? s.slice(0, 300) + '…' : s
  } catch { return 'ok' }
}
function shortArgs(input) {
  try { const s = JSON.stringify(input || {}); return s.length > 80 ? s.slice(0, 80) + '…' : s } catch { return '' }
}
