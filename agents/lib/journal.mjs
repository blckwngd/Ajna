// ─────────────────────────────────────────────────────────────────────────
//  Agent library · Journal — evidence on disk, findings on disk, memory on disk
// ─────────────────────────────────────────────────────────────────────────
// Three files per persona, all under `agents/data/personas/<name>/`:
//
//   journal.jsonl    one line per action or event — intent, call, result,
//                    expectation, observation. EVIDENCE. Written by the
//                    runner, never judged here.
//   findings.jsonl   one line per finding the model chose to report, each
//                    carrying the journal lines that led to it. JUDGEMENT —
//                    the model's, not a predicate's.
//   memory.json      the per-player short-term memory, so a restart does
//                    not make the figure forget who it talked to.
//   transcript.jsonl one line per MODEL TURN — what the figure was told
//                    (events and situation), what the model answered, which
//                    tools it called with what result, tokens and latency.
//                    The system prompt once, as its own line, whenever it
//                    changes. This is the "what was it thinking" file;
//                    the journal is "what did it do". Rotates like the
//                    journal. Knob `llm.transcript`.
//
// Append-only JSONL for the first two: a crash loses at most the line being
// written, and the file can be read while the agent runs. No database
// table and no HTTP endpoint on purpose — a file can be read by anyone with
// shell access and nobody else, and that is the right audience: the
// operator and the assistant working on the code.
//
// These files contain what players said to the figure. They stay on the
// server (`agents/data/` is gitignored) and are never sent anywhere.

import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = join(HERE, '..', 'data', 'personas')

export const personaDataDir = (name, base = DATA_DIR) => join(base, name)

export class Journal {
  /**
   * @param {string} dir   directory for this persona's files
   * @param {object} [opts]
   * @param {number} [opts.maxJournalBytes]  rotate journal.jsonl beyond this (default 8 MB)
   * @param {Function} [opts.warn]
   * @param {() => number} [opts.now]
   */
  constructor(dir, { maxJournalBytes = 8 * 1024 * 1024, warn = console.warn, now = () => Date.now() } = {}) {
    this.dir = dir
    this.maxJournalBytes = maxJournalBytes
    this.warn = warn
    this.now = now
    this.journalPath = join(dir, 'journal.jsonl')
    this.findingsPath = join(dir, 'findings.jsonl')
    this.memoryPath = join(dir, 'memory.json')
    this.transcriptPath = join(dir, 'transcript.jsonl')
    this.bytes = 0
    this.transcriptBytes = 0
    this._lastSystem = null
    mkdirSync(dir, { recursive: true })
    try { if (existsSync(this.journalPath)) this.bytes = readFileSync(this.journalPath).length } catch {}
    try { if (existsSync(this.transcriptPath)) this.transcriptBytes = readFileSync(this.transcriptPath).length } catch {}
  }

  /**
   * One model turn. `trace` comes from LlmBehaviour (onTrace): events,
   * situation, rounds with answer/tool calls/results, outcome. The system
   * prompt travels along but is written only when it changed — it is the
   * same few kilobytes every turn.
   */
  trace(trace) {
    const { system, ...rest } = trace || {}
    // Rotate BEFORE deciding about the prompt line: a file that starts
    // without the prompt that applies to its turns is useless on its own.
    this._maybeRotate('transcript', this.transcriptPath)
    if (typeof system === 'string' && system !== this._lastSystem) {
      this._lastSystem = system
      this._append(this.transcriptPath, JSON.stringify({ at: new Date(this.now()).toISOString(), kind: 'system', text: system }), 'transcript')
    }
    const line = JSON.stringify({ at: new Date(this.now()).toISOString(), kind: 'turn', ...rest })
    this._append(this.transcriptPath, line, 'transcript')
    return line
  }

  /** One evidence line. `entry` is whatever the runner hands over, plus a timestamp. */
  entry(entry) {
    const line = JSON.stringify({ at: new Date(this.now()).toISOString(), ...entry })
    this._append(this.journalPath, line, 'journal')
    return line
  }

  /** One finding. Carries the evidence it was based on. */
  finding({ type, title, description, context = [], persona = null }) {
    const rec = {
      at: new Date(this.now()).toISOString(),
      persona, type: String(type || 'bug'), title: String(title || '').slice(0, 200),
      description: String(description || '').slice(0, 4000),
      context: Array.isArray(context) ? context.slice(-12) : [],
    }
    this._append(this.findingsPath, JSON.stringify(rec), null)
    return rec
  }

  /** Keep one previous file; older evidence is cheap to lose. Findings are never rotated. */
  _maybeRotate(which, path) {
    const key = which === 'journal' ? 'bytes' : which === 'transcript' ? 'transcriptBytes' : null
    if (!key || this[key] <= this.maxJournalBytes) return false
    try { renameSync(path, path + '.1') } catch {}
    this[key] = 0
    if (which === 'transcript') this._lastSystem = null   // the new file starts with the prompt again
    return true
  }

  /** @param {'journal'|'transcript'|null} rotate  which byte counter rotates this file (null = never) */
  _append(path, line, rotate) {
    try {
      const key = rotate === 'journal' ? 'bytes' : rotate === 'transcript' ? 'transcriptBytes' : null
      if (rotate) this._maybeRotate(rotate, path)
      appendFileSync(path, line + '\n', 'utf8')
      if (key) this[key] += Buffer.byteLength(line) + 1
    } catch (err) {
      this.warn(`[journal] could not write ${path}: ${err?.message || err}`)
    }
  }

  /** Memory on disk — whole file, small, written seldom. */
  saveMemory(obj) {
    try { writeFileSync(this.memoryPath, JSON.stringify(obj), 'utf8'); return true }
    catch (err) { this.warn(`[journal] could not save memory: ${err?.message || err}`); return false }
  }
  loadMemory() {
    try { return existsSync(this.memoryPath) ? JSON.parse(readFileSync(this.memoryPath, 'utf8')) : null }
    catch (err) { this.warn(`[journal] memory unreadable, starting empty: ${err?.message || err}`); return null }
  }
}

/**
 * The last `last` model turns of a persona (and the system prompt lines in
 * between), oldest first. Reads the current file and, when that holds fewer
 * than asked, the rotated one before it.
 */
export function readTranscript(dir, { last = 20 } = {}) {
  const lines = []
  for (const name of ['transcript.jsonl.1', 'transcript.jsonl']) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { lines.push(JSON.parse(line)) } catch {}
    }
  }
  const turns = lines.filter(l => l.kind === 'turn')
  const keep = new Set(turns.slice(-Math.max(0, last)))
  // keep system lines that precede a kept turn
  const out = []
  let pendingSystem = null
  for (const l of lines) {
    if (l.kind === 'system') { pendingSystem = l; continue }
    if (keep.has(l)) { if (pendingSystem) { out.push(pendingSystem); pendingSystem = null } out.push(l) }
  }
  return out
}

const kurz = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const zeit = (iso) => { try { return new Date(iso).toLocaleString('de-DE', { hour12: false }) } catch { return String(iso) } }

/**
 * A transcript as a human reads it: one block per turn, the events, the
 * model's words, each tool call with its result. `full: true` adds the
 * whole situation text the model saw.
 */
export function formatTranscript(lines, { full = false } = {}) {
  const out = []
  for (const l of lines) {
    if (l.kind === 'system') {
      out.push(`── Systemprompt (${zeit(l.at)}, ${String(l.text || '').length} Zeichen)${full ? '\n' + l.text : ''}`)
      continue
    }
    const rounds = l.rounds || []
    const tokIn = rounds.reduce((a, r) => a + (r.usage?.input || 0), 0)
    const tokOut = rounds.reduce((a, r) => a + (r.usage?.output || 0), 0)
    const ms = rounds.reduce((a, r) => a + (r.latencyMs || 0), 0)
    const model = rounds.find(r => r.model)?.model || '–'
    out.push(`── ${zeit(l.at)} · ${l.kind_of || l.events_kind || 'Zug'} · ${model} · ${rounds.length} Runde(n) · ${tokIn}+${tokOut} tok · ${(ms / 1000).toFixed(1)} s · ${l.outcome?.source || ''}`)
    for (const e of l.events || []) out.push(`   ${e}`)
    if (full && l.situation) out.push('   LAGE:', ...String(l.situation).split('\n').map(x => '     ' + x))
    for (const r of rounds) {
      if (r.text) out.push(`   🗣 ${kurz(r.text, 300)}`)
      for (const c of r.calls || []) {
        const res = c.result === undefined ? '' : ` → ${kurz(c.result, 140)}`
        out.push(`   ${c.isError ? '✗' : '↳'} ${c.name}(${kurz(JSON.stringify(c.input || {}), 120)})${res}`)
      }
    }
    if (l.outcome?.reason) out.push(`   ⚠ ${l.outcome.reason}`)
  }
  return out.join('\n')
}

/** All findings of a persona, oldest first. Broken lines are skipped, not fatal. */
export function readFindings(dir) {
  const path = join(dir, 'findings.jsonl')
  if (!existsSync(path)) return []
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

/**
 * Group for the export: same type + title → one row with a count and the
 * latest description. GROUPED, NOT FILTERED — nothing is withheld, the
 * reader sees how often something came up.
 */
export function groupFindings(findings) {
  const groups = new Map()
  for (const f of findings) {
    const key = `${f.type}|${String(f.title || '').trim().toLowerCase()}`
    const g = groups.get(key) || { type: f.type, title: f.title, count: 0, first: f.at, last: f.at, description: f.description, context: f.context || [] }
    g.count++
    if (f.at > g.last) { g.last = f.at; g.description = f.description; g.context = f.context || [] }
    if (f.at < g.first) g.first = f.at
    groups.set(key, g)
  }
  const order = { bug: 0, suggestion: 1, question: 2 }
  return [...groups.values()].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || b.count - a.count || (a.last < b.last ? 1 : -1))
}

/** Plain-text export for a terminal. */
export function formatFindings(findings, { name = '' } = {}) {
  if (!findings.length) return `Keine Befunde${name ? ` für ${name}` : ''}.`
  const groups = groupFindings(findings)
  const lines = [`${findings.length} Befund(e)${name ? ` von ${name}` : ''}, ${groups.length} verschieden:`, '']
  for (const g of groups) {
    lines.push(`[${g.type}] ${g.title}${g.count > 1 ? `  (×${g.count})` : ''}`)
    lines.push(`  zuletzt ${g.last}`)
    for (const l of String(g.description).split('\n')) lines.push(`  ${l}`)
    if (g.context?.length) {
      lines.push('  Beweise:')
      for (const c of g.context.slice(-6)) lines.push(`    · ${c}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
