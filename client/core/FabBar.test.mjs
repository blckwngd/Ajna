// Tests für shouldHandleKey aus client/core/FabBar.js — die Regel, wann eine
// gedrückte Taste als Kürzel gilt.
//
// WARUM GERADE DIESE REGEL EINEN TEST VERDIENT. Sie ist die einzige Stelle, an
// der ein Tastenkürzel etwas kaputt machen kann: Greift sie zu früh, öffnet ein
// „f" im Suchfeld den Inhaltsfilter und schluckt den Buchstaben, und Strg-F
// gehört dem Browser. Ein Kürzel, das beim Tippen losgeht, ist schlimmer als
// gar keines.
//
// `shouldHandleKey` ist bewusst exportiert und arbeitet nur auf dem Ereignis —
// deshalb ohne DOM prüfbar. Die Leiste selbst (Anmelden, Ausblenden) hängt am
// DOM und wird in tests/run-ui.mjs geprüft, wie die übrigen Oberflächenteile.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldHandleKey, TOGGLE_KEY, FAB_CLASS, OFF_CLASS } from './FabBar.js'

/** Ein Tastenereignis, wie der Browser es liefert — nur die gelesenen Felder. */
const taste = (ue = {}) => ({
  key: 'f', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
  isComposing: false, repeat: false,
  target: { tagName: 'DIV', isContentEditable: false, closest: () => null },
  ...ue,
})

// ─── Der Normalfall ───────────────────────────────────────────────────────

test('eine blanke Taste auf freier Fläche gilt', () => {
  assert.equal(shouldHandleKey(taste()), true)
})

test('ohne Ereignis gilt nichts', () => {
  assert.equal(shouldHandleKey(null), false)
  assert.equal(shouldHandleKey(undefined), false)
})

// ─── Niemandem ins Tippen fallen ──────────────────────────────────────────

test('IM EINGABEFELD GILT KEINE TASTE', () => {
  // Der wichtigste Fall: wer „filter" in ein Suchfeld tippt, löst sonst beim
  // „f" den Dialog aus und verliert den Buchstaben.
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']) {
    assert.equal(shouldHandleKey(taste({ target: { tagName: tag, closest: () => null } })), false, tag)
  }
})

test('Kleinschreibung im Tag-Namen ändert nichts', () => {
  // `tagName` ist in HTML grossgeschrieben, in XHTML/SVG nicht — darauf darf
  // sich die Prüfung nicht verlassen.
  assert.equal(shouldHandleKey(taste({ target: { tagName: 'input', closest: () => null } })), false)
})

test('ein beschreibbarer Bereich zählt wie ein Eingabefeld', () => {
  const ziel = { tagName: 'DIV', isContentEditable: true, closest: () => null }
  assert.equal(shouldHandleKey(taste({ target: ziel })), false)
})

test('ein Element mit eigener Tastenbedienung behält sie', () => {
  // Schieberegler und Listen, die mit den Pfeiltasten arbeiten, markieren sich
  // mit data-keys="own" und werden nicht übergangen.
  const ziel = { tagName: 'DIV', isContentEditable: false, closest: (sel) => sel === '[data-keys="own"]' ? {} : null }
  assert.equal(shouldHandleKey(taste({ target: ziel })), false)
})

// ─── Sondertasten gehören anderen ─────────────────────────────────────────

test('mit Sondertaste gilt nichts — Strg-F gehört dem Browser', () => {
  for (const mod of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey']) {
    assert.equal(shouldHandleKey(taste({ [mod]: true })), false, mod)
  }
})

test('eine gehaltene Taste wiederholt das Umschalten nicht', () => {
  // Ohne das flackerte die Leiste, solange jemand „h" gedrückt hält.
  assert.equal(shouldHandleKey(taste({ repeat: true })), false)
})

test('während einer Zeichenkomposition gilt nichts', () => {
  // Umlaute und asiatische Eingabemethoden senden Zwischenereignisse.
  assert.equal(shouldHandleKey(taste({ isComposing: true })), false)
})

// ─── Was die Leiste zusagt ────────────────────────────────────────────────

test('die Kennungen für das Ausblenden sind gesetzt und unterschiedlich', () => {
  // Beide stehen so im eingespritzten CSS; verrutscht eine, blendet nichts
  // mehr aus, und zwar lautlos.
  assert.equal(typeof FAB_CLASS, 'string')
  assert.equal(typeof OFF_CLASS, 'string')
  assert.ok(FAB_CLASS.length > 3 && OFF_CLASS.length > 3)
  assert.notEqual(FAB_CLASS, OFF_CLASS)
})

test('die Umschalt-Taste ist ein einzelnes Kleinbuchstabe', () => {
  // Verglichen wird gegen `ev.key.toLowerCase()` — ein Grossbuchstabe hier
  // träfe nie zu.
  assert.equal(TOGGLE_KEY, TOGGLE_KEY.toLowerCase())
  assert.equal(TOGGLE_KEY.length, 1)
})
