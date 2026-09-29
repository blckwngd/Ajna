// Tests für agents/lib/agent-base.mjs — den gemeinsamen Unterbau der Agents.
//
// Schwerpunkt ist `ladeBestand`: die Funktion, die verhindert, dass ein Agent
// eine gescheiterte Liste für eine leere hält. Sie ist der einzige Ort, an dem
// diese Entscheidung noch fällt (früher elfmal, siehe Kommentar dort).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ladeBestand, commandAllowed } from './agent-base.mjs'

/** Ein AjnaManager-Doppel: `fehler` Fehlschläge, danach `objekte`. */
function ajnaDoppel(fehler, objekte = [{ id: 'a' }, { id: 'b' }]) {
  let versuche = 0
  return {
    get versuche() { return versuche },
    async refreshObjects() {
      versuche++
      if (versuche <= fehler) throw new Error(`Ausfall ${versuche}`)
    },
    getObjects() { return objekte },
  }
}

const still = () => {}

test('im Normalfall kommt der Bestand zurück', async () => {
  const ajna = ajnaDoppel(0)
  const objekte = await ladeBestand(ajna, { warn: still })
  assert.equal(objekte.length, 2)
  assert.equal(ajna.versuche, 1)
})

test('ein einzelner Ausfall wird ausgesessen', async () => {
  // Beim gemeinsamen Hochfahren von Stack und Agents ist der Server im ersten
  // Moment regelmäßig noch nicht da. Das ist kein Grund aufzugeben.
  const ajna = ajnaDoppel(2)
  const objekte = await ladeBestand(ajna, { warn: still, pauseMs: 1 })
  assert.equal(objekte.length, 2)
  assert.equal(ajna.versuche, 3)
})

test('bleibt es dabei, gibt der Agent auf — er läuft NICHT leer weiter', async () => {
  // Das ist der ganze Zweck: „ich konnte nicht fragen" darf nie zu „es gibt
  // nichts" werden. Ein Agent, der mit leerem Bestand weiterläuft, legt alles
  // ein zweites Mal an — am 17.09.2026 waren das 281 Dubletten in 25 Minuten.
  const ajna = ajnaDoppel(99)
  let aufgegeben = null
  const ergebnis = await ladeBestand(ajna, {
    warn: still, pauseMs: 1, versuche: 2,
    aufgeben: (msg) => { aufgegeben = msg; return undefined },
  })
  assert.equal(ajna.versuche, 2, 'genau so oft versucht wie angegeben')
  assert.ok(aufgegeben, 'es wurde aufgegeben')
  assert.match(aufgegeben, /Bestand nicht lesbar/)
  assert.match(aufgegeben, /neu anlegen/, 'die Meldung sagt, WARUM das schlimm ist')
  assert.equal(ergebnis, undefined, 'und liefert keine leere Liste als Ersatz')
})

test('die Meldung nennt den Grund des Servers, nicht nur „fehlgeschlagen"', async () => {
  const ajna = {
    async refreshObjects() {
      const err = new Error('Request failed')
      err.response = { data: { message: 'The request requires valid record authorization token.' } }
      throw err
    },
    getObjects() { return [] },
  }
  let msg = ''
  await ladeBestand(ajna, { warn: still, pauseMs: 1, versuche: 1, aufgeben: (m) => { msg = m } })
  assert.match(msg, /valid record authorization token/)
})

test('der Log-Präfix kommt aus dem Tag', async () => {
  let gewarnt = ''
  await ladeBestand(ajnaDoppel(1), {
    tag: 'poi', pauseMs: 1, warn: (m) => { gewarnt = m },
  })
  assert.match(gewarnt, /^\[poi\]/)
})

// ─── commandAllowed ───────────────────────────────────────────────────────

test('ohne Liste darf jeder Angemeldete Kommandos geben', () => {
  assert.equal(commandAllowed({ source: 'wer-auch-immer' }, ''), true)
  assert.equal(commandAllowed({ source: 'x' }, undefined), true)
})

test('mit Liste gilt sie strikt', () => {
  assert.equal(commandAllowed({ source: 'abc' }, 'abc,def'), true)
  assert.equal(commandAllowed({ source: 'xyz' }, 'abc,def'), false)
  assert.equal(commandAllowed({}, 'abc'), false)
})
