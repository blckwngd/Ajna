// Tests für agents/lib/system-ca.mjs.
//
// WORUM ES GEHT. Der Helfer startet den Agenten einmal neu, damit Node
// `--use-system-ca` bekommt (Caddys interne CA). Dieser Neustart ist die
// Stelle, an der still etwas verloren gehen kann: Er baut die Argumente des
// Kindes selbst zusammen, und was er dabei vergisst, ist weg.
//
// Genau das ist passiert. Am 20.10.2026 gemessen: von neun gestarteten Agents
// hatten nur drei eine Heap-Grenze — die drei, die über `http://` gehen und
// deshalb gar nicht re-exec'en. Die übrigen sechs meldeten „Heap-Grenze
// 4288 MB", also keine. Das Speicherbudget war dort wirkungslos, wo es gebraucht
// wird, und auf dem Server fiel es nicht auf, weil der Wrapper das Flag selbst
// mitgibt und der Re-Exec entfällt.
//
// Geprüft wird deshalb an ECHTEN Kindprozessen, nicht an der Absicht: ein
// Skript, das sagt, mit welchen Schaltern und welcher Heap-Grenze es läuft.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HIER = new URL('./system-ca.mjs', import.meta.url).href

/**
 * Ein Wegwerf-Skript, das den Helfer aufruft und danach berichtet, was es
 * mitbekommen hat. Läuft es durch den Re-Exec, berichtet das KIND — und genau
 * dessen Zahlen sind die Frage.
 */
function laufe(env = {}, nodeArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'ajna-ca-'))
  const skript = join(dir, 'probe.mjs')
  writeFileSync(skript, `
import v8 from 'node:v8'
import { maybeReexecWithSystemCa } from ${JSON.stringify(HIER)}
maybeReexecWithSystemCa(process.env.PROBE_URL || '')
console.log(JSON.stringify({
  execArgv: process.execArgv,
  grenzeMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576),
}))
`)
  const r = spawnSync(process.execPath, [...nodeArgs, skript], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, ...env },
  })
  const zeile = String(r.stdout || '').trim().split('\n').pop()
  let bericht = null
  try { bericht = JSON.parse(zeile) } catch { }
  return { status: r.status, bericht, stderr: r.stderr, stdout: r.stdout }
}

const GRENZE = ['--max-old-space-size=96', '--max-semi-space-size=4']

// ─── Der Fehler, um den es geht ───────────────────────────────────────────

test('DIE HEAP-GRENZE ÜBERLEBT DEN RE-EXEC', () => {
  // Ohne das weitergegebene `process.execArgv` meldete das Kind hier 4288 MB.
  const ohne = laufe({ PROBE_URL: 'http://127.0.0.1:1' }, GRENZE)
  assert.equal(ohne.status, 0, ohne.stderr)
  const vergleich = ohne.bericht.grenzeMb

  const mit = laufe({ PROBE_URL: 'https://127.0.0.1:1' }, GRENZE)
  assert.equal(mit.status, 0, mit.stderr)
  assert.equal(mit.bericht.grenzeMb, vergleich,
    `nach dem Re-Exec ${mit.bericht.grenzeMb} MB statt ${vergleich} MB — execArgv verloren`)
})

test('und das Flag ist danach auch wirklich gesetzt', () => {
  const mit = laufe({ PROBE_URL: 'https://127.0.0.1:1' }, GRENZE)
  assert.ok(mit.bericht.execArgv.includes('--use-system-ca'),
    JSON.stringify(mit.bericht.execArgv))
})

test('die eigenen Schalter stehen VOR dem Flag', () => {
  // Reihenfolge ist bei Node-Schaltern nicht beliebig; die Grenzen gehören
  // zuerst, damit ein späteres Flag sie nicht überschreibt.
  const mit = laufe({ PROBE_URL: 'https://127.0.0.1:1' }, GRENZE)
  const a = mit.bericht.execArgv
  assert.ok(a.indexOf('--max-old-space-size=96') < a.indexOf('--use-system-ca'), JSON.stringify(a))
})

// ─── Wann NICHT re-exec't wird ────────────────────────────────────────────

test('http braucht keinen Re-Exec', () => {
  const r = laufe({ PROBE_URL: 'http://127.0.0.1:1' }, GRENZE)
  assert.ok(!r.bericht.execArgv.includes('--use-system-ca'))
})

test('ohne Adresse passiert nichts', () => {
  const r = laufe({ PROBE_URL: '' }, GRENZE)
  assert.ok(!r.bericht.execArgv.includes('--use-system-ca'))
})

test('AJNA_NO_SYSTEM_CA=1 schaltet es ab', () => {
  const r = laufe({ PROBE_URL: 'https://127.0.0.1:1', AJNA_NO_SYSTEM_CA: '1' }, GRENZE)
  assert.ok(!r.bericht.execArgv.includes('--use-system-ca'))
  assert.equal(r.bericht.grenzeMb, laufe({ PROBE_URL: '' }, GRENZE).bericht.grenzeMb)
})

test('ÜBER NODE_OPTIONS GESETZT ZÄHLT AUCH — kein zweiter Start', () => {
  // Flags aus NODE_OPTIONS tauchen NICHT in execArgv auf; ohne diese Prüfung
  // startete sich der Agent ein zweites Mal, obwohl das Flag längst wirkt.
  const r = laufe({ PROBE_URL: 'https://127.0.0.1:1', NODE_OPTIONS: '--use-system-ca' }, GRENZE)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!r.bericht.execArgv.includes('--use-system-ca'),
    'execArgv trägt es nicht — es kam aus NODE_OPTIONS')
  assert.equal(r.bericht.grenzeMb, laufe({ PROBE_URL: '' }, GRENZE).bericht.grenzeMb,
    'die Grenze muss auch hier stehen')
})

// ─── Ohne eigene Schalter ─────────────────────────────────────────────────

test('ohne eigene Schalter bleibt die Liste bis auf das Flag leer', () => {
  const r = laufe({ PROBE_URL: 'https://127.0.0.1:1' }, [])
  assert.deepEqual(r.bericht.execArgv, ['--use-system-ca'])
})
