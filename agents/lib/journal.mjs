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
    this.bytes = 0
    mkdirSync(dir, { recursive: true })
    try { if (existsSync(this.journalPath)) this.bytes = readFileSync(this.journalPath).length } catch {}
  }

  /** One evidence line. `entry` is whatever the runner hands over, plus a timestamp. */
  entry(entry) {
    const line = JSON.stringify({ at: new Date(this.now()).toISOString(), ...entry })
    this._append(this.journalPath, line, true)
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
    this._append(this.findingsPath, JSON.stringify(rec), false)
    return rec
  }

  _append(path, line, rotate) {
    try {
      if (rotate && this.bytes > this.maxJournalBytes) {
        // Keep one previous file; older evidence is cheap to lose, findings
        // are not rotated at all.
        try { renameSync(path, path + '.1') } catch {}
        this.bytes = 0
      }
      appendFileSync(path, line + '\n', 'utf8')
      if (rotate) this.bytes += Buffer.byteLength(line) + 1
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
