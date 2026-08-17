#!/usr/bin/env node
//
// tests/run-unit.mjs — sammelt und startet ALLE Modul-Tests, die neben ihrem
// Modul liegen (`*.test.mjs`).
//
//   npm run test:unit          (kein Stack nötig — reine Rechnung)
//
// Warum es das gibt: diese Tests existierten schon, hingen aber an keinem
// Skript. `npm test` fuhr nur die vier E2E-Suiten, die Modul-Tests kannte man
// nur aus zwei Sätzen in docs/ und startete sie von Hand — also nie. Ein Test,
// den niemand startet, ist keine Absicherung, sondern eine Behauptung.
//
// Auffinden statt Aufzählen: eine feste Liste würde beim nächsten neuen Test
// wieder veralten. Alles unter `client/` und `agents/`, was auf `.test.mjs`
// endet, läuft mit.

import { readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SUCHE = ['client', 'agents']
const UEBERSPRINGEN = new Set(['node_modules', 'dist', 'poc'])

function sammeln(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!UEBERSPRINGEN.has(e.name)) sammeln(join(dir, e.name), out)
    } else if (e.name.endsWith('.test.mjs')) {
      out.push(join(dir, e.name))
    }
  }
  return out
}

const tests = SUCHE.flatMap(d => {
  try { return statSync(join(ROOT, d)).isDirectory() ? sammeln(join(ROOT, d)) : [] }
  catch { return [] }
}).sort()

if (!tests.length) {
  console.error('❌ Keine *.test.mjs gefunden — stimmt der Suchpfad noch?')
  process.exit(2)
}

console.log(`\n══ Modul-Tests (${tests.length}) ══`)
const fehler = []
for (const t of tests) {
  const name = relative(ROOT, t).replace(/\\/g, '/')
  const r = spawnSync(process.execPath, [t], { cwd: ROOT, encoding: 'utf8' })
  const ok = r.status === 0
  console.log(`   ${ok ? '✅' : '❌'} ${name}`)
  if (!ok) {
    fehler.push(name)
    // Nur im Fehlerfall die Ausgabe zeigen — sonst ersäuft das Ergebnis darin.
    const text = `${r.stdout || ''}${r.stderr || ''}`.trimEnd()
    if (text) console.log(text.split('\n').map(l => '        ' + l).join('\n'))
  }
}

console.log(fehler.length
  ? `\n❌ ${fehler.length} von ${tests.length} fehlgeschlagen: ${fehler.join(', ')}`
  : `\n✅ alle ${tests.length} Modul-Tests bestanden`)
process.exit(fehler.length ? 1 : 0)
