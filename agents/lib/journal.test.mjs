import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Journal, readFindings, groupFindings, formatFindings, personaDataDir } from './journal.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'journal-'))

test('entries and findings are appended as one JSON line each, with a timestamp', () => {
  const dir = tmp()
  try {
    let t = 1_700_000_000_000
    const j = new Journal(dir, { now: () => (t += 1000) })
    j.entry({ action: 'use', input: { object_id: 'o1' }, outcome: { ok: true } })
    j.entry({ action: 'say', input: { to: 'p1', text: 'hi' }, outcome: { ok: false, error: 'nope' } })
    const lines = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0])
    assert.equal(first.action, 'use')
    assert.match(first.at, /^2023-/)
    const f = j.finding({ type: 'bug', title: 'Knopf ohne Draht', description: 'Nichts passiert.', context: ['use(o1) → ok'], persona: 'x' })
    assert.equal(f.type, 'bug')
    const fl = readFileSync(join(dir, 'findings.jsonl'), 'utf8').trim().split('\n')
    assert.equal(fl.length, 1)
    assert.deepEqual(JSON.parse(fl[0]).context, ['use(o1) → ok'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the journal rotates beyond its byte limit; findings never rotate', () => {
  const dir = tmp()
  try {
    const j = new Journal(dir, { maxJournalBytes: 200 })
    for (let i = 0; i < 20; i++) j.entry({ action: 'wait', input: { seconds: i }, outcome: { ok: true } })
    assert.ok(existsSync(join(dir, 'journal.jsonl.1')), 'a previous file exists after rotation')
    assert.ok(readFileSync(join(dir, 'journal.jsonl')).length < 1000)
    for (let i = 0; i < 20; i++) j.finding({ type: 'bug', title: 't' + i, description: 'd' })
    assert.equal(readFindings(dir).length, 20)
    assert.ok(!existsSync(join(dir, 'findings.jsonl.1')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a finding is clipped to sane sizes and typed', () => {
  const dir = tmp()
  try {
    const j = new Journal(dir)
    const f = j.finding({ title: 'x'.repeat(500), description: 'y'.repeat(9000), type: undefined })
    assert.equal(f.title.length, 200)
    assert.equal(f.description.length, 4000)
    assert.equal(f.type, 'bug')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('memory round-trips through disk; an unreadable file means: start empty, do not crash', () => {
  const dir = tmp()
  try {
    const j = new Journal(dir, { warn: () => {} })
    assert.equal(j.loadMemory(), null)
    assert.equal(j.saveMemory({ p1: [{ role: 'user', text: 'hi' }] }), true)
    assert.deepEqual(j.loadMemory(), { p1: [{ role: 'user', text: 'hi' }] })
    writeFileSync(join(dir, 'memory.json'), '{ kaputt')
    assert.equal(j.loadMemory(), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('readFindings skips a broken line instead of losing the file', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'findings.jsonl'), '{"type":"bug","title":"a","at":"1"}\n{ kaputt\n{"type":"bug","title":"b","at":"2"}\n')
    assert.deepEqual(readFindings(dir).map(f => f.title), ['a', 'b'])
    assert.deepEqual(readFindings(join(dir, 'leer')), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('groupFindings counts repeats and keeps the latest description — nothing is dropped', () => {
  const g = groupFindings([
    { type: 'suggestion', title: 'Schild', at: '2026-01-01', description: 'alt' },
    { type: 'bug', title: 'Tür', at: '2026-01-02', description: 'd1', context: ['a'] },
    { type: 'bug', title: 'tür', at: '2026-01-03', description: 'd2', context: ['b'] },
    { type: 'question', title: 'Wer', at: '2026-01-04', description: 'q' },
  ])
  assert.equal(g.length, 3)
  assert.equal(g[0].type, 'bug')
  assert.equal(g[0].count, 2)
  assert.equal(g[0].description, 'd2')
  assert.deepEqual(g[0].context, ['b'])
  assert.equal(g[0].first, '2026-01-02')
  assert.equal(g[1].type, 'suggestion')
  assert.equal(g[2].type, 'question')
})

test('formatFindings is readable in a terminal and says plainly when there is nothing', () => {
  assert.match(formatFindings([], { name: 'wanderer' }), /Keine Befunde für wanderer/)
  const txt = formatFindings([
    { type: 'bug', title: 'Tür', at: '2026-01-02T10:00:00Z', description: 'Geht nicht auf.\nZweite Zeile.', context: ['use(tuer) → FEHLER 404'] },
    { type: 'bug', title: 'Tür', at: '2026-01-03T10:00:00Z', description: 'Immer noch.', context: ['use(tuer) → FEHLER 404'] },
  ], { name: 'wanderer' })
  assert.match(txt, /2 Befund\(e\) von wanderer, 1 verschieden/)
  assert.match(txt, /\[bug\] Tür  \(×2\)/)
  assert.match(txt, /zuletzt 2026-01-03/)
  assert.match(txt, /Immer noch\./)
  assert.match(txt, /Beweise:\n\s+· use\(tuer\) → FEHLER 404/)
})

test('personaDataDir is per persona', () => {
  assert.match(personaDataDir('wanderer', '/base'), /[\\/]base[\\/]wanderer$/)
})
