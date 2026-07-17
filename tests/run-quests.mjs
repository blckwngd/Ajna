#!/usr/bin/env node
//
// tests/run-quests.mjs — E2E-Regressionsnetz für Quests/Handel.
//
//   npm run test:quests            (Stack muss laufen: npm run stack)
//   AJNA_TEST_PB=http://host:8090 npm run test:quests
//
// Prüft die server-autoritative Kette (pb_hooks/quests.js + die quest/*-Routen):
// gedeckte Belohnungen, Treuhand, atomarer Tausch, Gattungs-Forderungen,
// Agent-Verifikation, Wiederholbarkeit, Selbstheilung verwaister Bindungen.
//
// Wichtig: PocketBase lädt pb_hooks NICHT neu — nach Hook-Änderungen den Stack
// neu starten, sonst testet man gegen alten Code.

import { reachable, createContext } from './quests/_harness.mjs'

import * as basic from './quests/basic.mjs'
import * as requires from './quests/requires.mjs'
import * as repeat from './quests/repeat.mjs'
import * as self from './quests/self.mjs'
import * as orphan from './quests/orphan.mjs'
import * as save from './quests/save.mjs'
import * as revive from './quests/revive.mjs'

const SUITES = [basic, requires, repeat, self, orphan, save, revive]

if (!(await reachable())) {
  console.error('❌ Keine erreichbare Ajna-Instanz (AJNA_TEST_PB, Default http://127.0.0.1:8090).')
  console.error('   Stack starten:  npm run stack')
  process.exit(2)
}

let passed = 0
const failed = []
let leftovers = 0

for (let i = 0; i < SUITES.length; i++) {
  const suite = SUITES[i]
  const prefix = `qtest${i}`
  const t = createContext(prefix)
  console.log(`\n── ${suite.name}`)
  try {
    await suite.run(t)
  } catch (err) {
    t.failed.push(`${suite.name}: Abbruch — ${err?.message || err}`)
    console.log(`   ❌ Abbruch: ${err?.message || err}`)
  } finally {
    // Immer aufräumen, auch nach einem Abbruch — sonst bleiben Wegwerf-Objekte
    // in der Welt des Nutzers liegen.
    try { leftovers += await t.cleanup() } catch { /* best effort */ }
  }
  passed += t.passed.length
  failed.push(...t.failed.map(f => `${suite.name}: ${f}`))
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`${passed} bestanden, ${failed.length} fehlgeschlagen (${SUITES.length} Suiten)`)
if (leftovers) console.log(`⚠ ${leftovers} Testobjekt(e) konnten nicht entfernt werden`)
if (failed.length) {
  console.log('\nFehlgeschlagen:')
  for (const f of failed) console.log('  ❌ ' + f)
  process.exit(1)
}
console.log('✅ alles grün')
