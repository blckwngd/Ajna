// Tests für das Chat-Abo des MessageLogPanel.
//
// ANLASS, 02.10.2026: Jede eingehende Dialogzeile stand zweimal im Verlauf —
// „Lena Stein: Gutes Wetter…" doppelt, „Ich winke immer…" doppelt. Die eigene
// Zeile („Du: …") NICHT, und genau daran war zu erkennen, wo es herkam: die
// eigene wird lokal geschrieben, die fremden kommen über das Abo.
//
// `onAuthChanged` hängt an `authStore.onChange` und feuert auch bei jeder
// Token-Erneuerung, nicht nur beim Login. Lief dann noch das `await` des
// vorigen Abos, fand der neue Lauf nichts zum Abbestellen — beide blieben am
// Thema hängen, und PocketBase ruft je Abo einmal zurück.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MessageLogPanel } from './MessageLogPanel.js'

/**
 * Ein Panel ohne Oberfläche.
 *
 * `Object.create` statt `new`: geprüft wird die Abo-Logik, nicht der Aufbau des
 * Fensters. Ein echtes DOM dafür hochzuziehen hiesse, den halben Browser zu
 * bauen, um sechs Zeilen zu prüfen.
 */
function panel(ajna, empfangen) {
  const p = Object.create(MessageLogPanel.prototype)
  p.ajna = ajna
  p._chatOff = null
  p._onChat = (m) => empfangen.push(m)
  return p
}

/** Ein ajna, bei dem der Zeitpunkt des Abo-Abschlusses steuerbar ist. */
function fakeAjna() {
  const abos = new Set()
  const offen = []
  let authCb = null
  return {
    abos,
    aufloesen: () => { const f = offen.shift(); if (f) f() },
    authWechsel: () => authCb?.(),
    sende: (m) => { for (const cb of [...abos]) cb(m) },
    isLoggedIn: () => true,
    onAuthChanged: (cb) => { authCb = cb },
    onChat: (cb) => new Promise((res) => offen.push(() => {
      abos.add(cb)
      res(() => abos.delete(cb))
    })),
  }
}

const tick = () => new Promise(r => setTimeout(r, 0))

test('ein überholtes Abo bestellt sich selbst wieder ab', async () => {
  // DAS WETTRENNEN: Abo 1 läuft noch, da feuert eine Token-Erneuerung und
  // startet Abo 2. Ohne Nummer fand Abo 2 kein `_chatOff` zum Abbestellen,
  // und Abo 1 blieb unbemerkt hängen.
  const ajna = fakeAjna()
  const empfangen = []
  const p = panel(ajna, empfangen)

  p._subscribeChat()
  await tick()
  ajna.authWechsel()          // zweiter Lauf startet, während der erste wartet
  await tick()
  ajna.aufloesen()            // Abo 1 wird fertig …
  ajna.aufloesen()            // … dann Abo 2
  await tick()

  assert.equal(ajna.abos.size, 1, `${ajna.abos.size} Abos am Thema statt einem`)

  ajna.sende({ from: 'x', text: 'Gutes Wetter. Ich merke mir das für den Winter.' })
  assert.equal(empfangen.length, 1, 'die Zeile stand doppelt im Verlauf')
})

test('auch drei überholende Läufe hinterlassen genau ein Abo', async () => {
  const ajna = fakeAjna()
  const empfangen = []
  const p = panel(ajna, empfangen)

  p._subscribeChat()
  await tick()
  ajna.authWechsel()
  ajna.authWechsel()
  await tick()
  for (let i = 0; i < 3; i++) ajna.aufloesen()
  await tick()

  assert.equal(ajna.abos.size, 1)
  ajna.sende({ from: 'x', text: 'was fliegt da oben' })
  assert.equal(empfangen.length, 1)
})

test('der gewöhnliche Ablauf bleibt unberührt', async () => {
  // Ein Abo, das in Ruhe fertig wird, und danach ein Auth-Wechsel: das alte
  // wird abbestellt, das neue übernimmt. Am Ende genau eines.
  const ajna = fakeAjna()
  const empfangen = []
  const p = panel(ajna, empfangen)

  p._subscribeChat()
  await tick()
  ajna.aufloesen()
  await tick()
  assert.equal(ajna.abos.size, 1, 'nach dem ersten Lauf')

  ajna.authWechsel()
  await tick()
  ajna.aufloesen()
  await tick()
  assert.equal(ajna.abos.size, 1, 'nach dem Auth-Wechsel')

  ajna.sende({ from: 'x', text: 'Hallo' })
  assert.equal(empfangen.length, 1)
})

test('ohne Anmeldung wird gar nicht abonniert', async () => {
  const ajna = { ...fakeAjna(), isLoggedIn: () => false }
  const p = panel(ajna, [])
  p._subscribeChat()
  await tick()
  assert.equal(ajna.abos.size, 0)
})

test('ein Panel ohne onChat kippt nicht um', async () => {
  const p = panel({ isLoggedIn: () => true }, [])
  await p._subscribeChat()      // darf einfach nichts tun
})
