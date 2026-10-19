// Tests für den Anmeldezustand in AjnaClient.
//
// WARUM ES DIESE DATEI GIBT. In der Oberfläche war zu sehen: „Einstellungen →
// Zugang" zeigte „eingeloggt", die Serverliste zeigte an keinem Server eine
// Anmeldung, und es waren keine Inhalte da. Drei Symptome, eine Ursache — zwei
// Stellen fragten VERSCHIEDENE Dinge am selben Speicher:
//
//   isLoggedIn()   → authStore.isValid   (prüft die Ablaufzeit)
//   currentUser()  → authStore.record    (prüft, ob ein Datensatz liegt)
//
// Bei einem abgelaufenen Token bleibt der Datensatz liegen. Die Tests hier
// halten fest, dass beide Antworten übereinstimmen MÜSSEN — das ist die
// eigentliche Zusicherung, nicht die Einzelwerte.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AjnaClient } from './AjnaClient.js'

const NUTZER = { id: 'u1', username: 'anna', email: 'anna@example.org' }

/** Ein AjnaClient mit untergeschobenem PocketBase — kein Netz, kein Browser. */
const clientMit = (authStore) =>
  new AjnaClient({ id: 'srv1', pb: { authStore, baseUrl: 'http://example.invalid' } })

const angemeldet   = () => clientMit({ isValid: true,  record: NUTZER })
const abgelaufen   = () => clientMit({ isValid: false, record: NUTZER })
const nieAngemeldet = () => clientMit({ isValid: false, record: null })

// ─── Die Zusicherung, um die es geht ──────────────────────────────────────

test('DIE BEIDEN ANTWORTEN STIMMEN ÜBEREIN — in jedem Zustand', () => {
  // Genau hier lag der Fehler: bei `abgelaufen` sagte isLoggedIn() nein und
  // currentUser() ja, und die Oberfläche zeigte beides an verschiedenen Stellen.
  for (const [name, c] of [
    ['angemeldet', angemeldet()],
    ['abgelaufen', abgelaufen()],
    ['nie angemeldet', nieAngemeldet()],
  ]) {
    assert.equal(c.isLoggedIn(), !!c.currentUser(),
      `${name}: isLoggedIn=${c.isLoggedIn()} aber currentUser=${!!c.currentUser()}`)
  }
})

test('ein abgelaufenes Token ist keine Anmeldung', () => {
  const c = abgelaufen()
  assert.equal(c.isLoggedIn(), false)
  assert.equal(c.currentUser(), null, 'der liegengebliebene Datensatz täuscht keine Anmeldung vor')
})

test('angemeldet liefert den Nutzer samt Herkunft', () => {
  const u = angemeldet().currentUser()
  assert.equal(u.id, 'u1')
  assert.equal(u.username, 'anna')
  assert.equal(u._origin, 'srv1', 'die Herkunft muss dranhängen, für Besitzvergleiche')
})

// ─── sessionState ─────────────────────────────────────────────────────────

test('sessionState unterscheidet die drei Fälle', () => {
  assert.equal(angemeldet().sessionState(), 'valid')
  assert.equal(abgelaufen().sessionState(), 'expired')
  assert.equal(nieAngemeldet().sessionState(), 'none')
})

test('ABGELAUFEN IST NICHT „NIE ANGEMELDET"', () => {
  // Beides ist nicht eingeloggt, aber nur eines ist eine Auskunft. Fiele der
  // Unterschied weg, sässe der Nutzer wieder vor einem unerklärten Formular.
  assert.notEqual(abgelaufen().sessionState(), nieAngemeldet().sessionState())
})

test('sessionState passt immer zu isLoggedIn', () => {
  for (const c of [angemeldet(), abgelaufen(), nieAngemeldet()]) {
    assert.equal(c.sessionState() === 'valid', c.isLoggedIn())
  }
})

test('der ältere `model`-Name wird weiterhin gelesen', () => {
  // Ältere PocketBase-SDKs führten den Datensatz als `model`. Wer eine solche
  // Fassung im Einsatz hat, soll nicht als „nie angemeldet" gelten.
  const c = clientMit({ isValid: false, record: null, model: NUTZER })
  assert.equal(c.sessionState(), 'expired')
  const d = clientMit({ isValid: true, record: null, model: NUTZER })
  assert.equal(d.currentUser()?.id, 'u1')
})

// ─── currentUserRaw ───────────────────────────────────────────────────────

test('currentUserRaw zeigt den Datensatz AUCH nach dem Ablauf', () => {
  // Das ist der Grund, warum er bleibt: um sagen zu können, WESSEN Sitzung
  // abgelaufen ist, statt nur „abgelaufen".
  const c = abgelaufen()
  assert.equal(c.currentUser(), null)
  assert.equal(c.currentUserRaw()?.username, 'anna')
})

test('currentUserRaw schreibt die Herkunft NICHT dazu', () => {
  // „roh" heisst roh — die Umschrift ist Sache von currentUser().
  assert.equal(angemeldet().currentUserRaw()._origin, undefined)
})

test('ohne jeden Datensatz gibt es auch roh nichts', () => {
  assert.equal(nieAngemeldet().currentUserRaw(), null)
})
