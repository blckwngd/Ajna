// Gemeinsame Runner-Mechanik für die E2E-Suiten-Familien (quests, privacy, …).
//
// Hier steht nur das Drumherum: Erreichbarkeit, Suiten nacheinander laufen
// lassen, IMMER aufräumen (auch nach Abbruch), zählen, Exit-Code. Was geprüft
// wird, steht in den Suiten.

import { reachable, createContext } from './_harness.mjs'

/**
 * @param {string} title      Überschrift des Laufs
 * @param {string} prefixTag  fließt in die Wegwerf-E-Mails (je Familie eindeutig)
 * @param {Array<{name: string, run: (t:any)=>Promise<void>}>} suites
 */
export async function runSuites(title, prefixTag, suites) {
  if (!(await reachable())) {
    console.error('❌ Keine erreichbare Ajna-Instanz (AJNA_TEST_PB, Default http://127.0.0.1:8090).')
    console.error('   Stack starten:  npm run stack')
    process.exit(2)
  }

  let passed = 0
  const failed = []
  let leftovers = 0

  for (let i = 0; i < suites.length; i++) {
    const suite = suites[i]
    const t = createContext(`${prefixTag}${i}`)
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
  console.log(`${title}: ${passed} bestanden, ${failed.length} fehlgeschlagen (${suites.length} Suiten)`)
  if (leftovers) console.log(`⚠ ${leftovers} Testobjekt(e) konnten nicht entfernt werden`)
  if (failed.length) {
    console.log('\nFehlgeschlagen:')
    for (const f of failed) console.log('  ❌ ' + f)
    process.exit(1)
  }
  console.log('✅ alles grün')
}
