// The transcript: what the model was told and what it answered, per turn.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Journal, readTranscript, formatTranscript } from './journal.mjs'

const TURN = (i, extra = {}) => ({
  kind_of: 'chat', events: [`p1 sagt zu dir: „Hallo ${i}"`], situation: 'LAGE: Standort: 50.1, 7.1.',
  system: 'Du bist Jorin. REGELN …',
  rounds: [{ model: 'fake-1', stopReason: 'tool_use', text: `Antwort ${i}`, usage: { input: 100, output: 20 }, latencyMs: 300,
             calls: [{ name: 'say', input: { to: 'p1', text: `Antwort ${i}` }, result: 'gesagt', isError: false }] }],
  outcome: { source: 'model', said: [{ to: 'p1', text: `Antwort ${i}` }], calls: 1 },
  ...extra,
})

test('a turn is one line; the system prompt only when it changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-'))
  try {
    const j = new Journal(dir, { warn: () => {} })
    j.trace(TURN(1)); j.trace(TURN(2)); j.trace(TURN(3, { system: 'Du bist Jorin, jetzt im Prüfmodus.' })); j.trace(TURN(4, { system: 'Du bist Jorin, jetzt im Prüfmodus.' }))
    const lines = readFileSync(join(dir, 'transcript.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.deepEqual(lines.map(l => l.kind), ['system', 'turn', 'turn', 'system', 'turn', 'turn'])
    assert.equal(lines[1].system, undefined, 'the prompt is not repeated in every turn line')
    assert.equal(lines[1].rounds[0].calls[0].name, 'say')
    assert.equal(lines[1].situation, 'LAGE: Standort: 50.1, 7.1.')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('readTranscript gives the last N turns with the prompt that applied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-'))
  try {
    const j = new Journal(dir, { warn: () => {} })
    for (let i = 1; i <= 6; i++) j.trace(TURN(i, { system: i < 4 ? 'alt' : 'neu' }))
    const last2 = readTranscript(dir, { last: 2 })
    assert.deepEqual(last2.map(l => l.kind), ['system', 'turn', 'turn'], 'the prompt that applied comes along, even from before the window')
    assert.equal(last2[0].text, 'neu')
    assert.equal(last2[2].events[0], 'p1 sagt zu dir: „Hallo 6"')
    const last3 = readTranscript(dir, { last: 3 })
    assert.deepEqual(last3.map(l => l.kind), ['system', 'turn', 'turn', 'turn'])
    assert.equal(last3[0].text, 'neu')
    assert.ok(!readTranscript(dir, { last: 3 }).some(l => l.kind === 'system' && l.text === 'alt'), 'a prompt no turn in the window used is left out')
    assert.ok(readTranscript(dir, { last: 5 }).some(l => l.kind === 'system' && l.text === 'alt'), 'turns 2 and 3 used it, so it comes along')
    assert.equal(readTranscript(join(dir, 'nichts')).length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the transcript rotates on its own counter, and the new file starts with the prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-'))
  try {
    // ~450 bytes per turn: one rotation somewhere in the middle of eight
    const j = new Journal(dir, { warn: () => {}, maxJournalBytes: 2000 })
    for (let i = 1; i <= 8; i++) j.trace(TURN(i))
    assert.ok(existsSync(join(dir, 'transcript.jsonl.1')), 'rotated')
    assert.ok(!existsSync(join(dir, 'journal.jsonl')), 'the journal is untouched')
    const neu = readFileSync(join(dir, 'transcript.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.equal(neu[0].kind, 'system', 'the new file starts with the prompt')
    const alle = readTranscript(dir, { last: 100 })
    const n = alle.filter(l => l.kind === 'turn').length
    assert.ok(n >= 6 && n <= 8, `both files are read (${n} turns)`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('formatTranscript reads like a log, with tool calls and results', () => {
  const text = formatTranscript([
    { kind: 'system', at: '2026-10-23T09:00:00Z', text: 'Du bist Jorin.' },
    { kind: 'turn', at: '2026-10-23T09:03:13Z', ...TURN(1) },
    { kind: 'turn', at: '2026-10-23T09:04:00Z', ...TURN(2, { rounds: [], outcome: { source: 'parley-fallback:rate', reason: 'rate limit' } }) },
  ])
  assert.match(text, /── Systemprompt \(.*14 Zeichen\)/)
  assert.match(text, /chat · fake-1 · 1 Runde\(n\) · 100\+20 tok · 0\.3 s · model/)
  assert.match(text, /p1 sagt zu dir: „Hallo 1"/)
  assert.match(text, /🗣 Antwort 1/)
  assert.match(text, /↳ say\(\{"to":"p1","text":"Antwort 1"\}\) → gesagt/)
  assert.match(text, /⚠ rate limit/)
  assert.ok(!/LAGE:/.test(text))
  assert.match(formatTranscript([{ kind: 'turn', at: '2026-10-23T09:03:13Z', ...TURN(1) }], { full: true }), /LAGE:\n\s+LAGE: Standort/)
})
