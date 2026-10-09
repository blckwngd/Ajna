// Tests für client/core/advancedMode.js.
//
// Der Schalter entscheidet, ob jemand beim ersten Öffnen der Einstellungen mit
// „UWB-Ortung" und „Zauberstab" konfrontiert wird. Zwei Dinge müssen stimmen:
// die Vorgabe ist AUS, und ein blockierter Speicher nimmt nicht die ganze
// Einstellungsseite mit.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAdvanced, setAdvanced } from './advancedMode.js'

/** Ein localStorage, das sich etwas merkt. */
function speicher() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  }
}

test('die Vorgabe ist AUS', () => {
  // Der ganze Zweck: Wer die App installiert, sieht zunächst nichts davon.
  globalThis.localStorage = speicher()
  assert.equal(isAdvanced(), false)
})

test('ein- und ausschalten hält', () => {
  globalThis.localStorage = speicher()
  setAdvanced(true)
  assert.equal(isAdvanced(), true)
  setAdvanced(false)
  assert.equal(isAdvanced(), false)
})

test('ausschalten räumt den Eintrag weg, statt „0" zu hinterlassen', () => {
  // Sonst sammelt sich im Speicher ein Feld, das „aus" bedeutet und doch da
  // ist — und beim nächsten Umbau liest es jemand als gesetzt.
  const s = speicher()
  globalThis.localStorage = s
  setAdvanced(true)
  setAdvanced(false)
  assert.equal(s._map.has('ajna_advanced'), false)
})

test('ein blockierter Speicher nimmt nichts mit', () => {
  // Privates Fenster, gesperrte Seitendaten: Der Zugriff wirft. Die
  // Einstellungsseite darf daran nicht scheitern — sie zeigt dann eben den
  // einfachen Umfang.
  globalThis.localStorage = {
    getItem() { throw new Error('SecurityError') },
    setItem() { throw new Error('SecurityError') },
    removeItem() { throw new Error('SecurityError') },
  }
  assert.equal(isAdvanced(), false)
  assert.equal(setAdvanced(true), true, 'der Aufrufer bekommt trotzdem eine Antwort')
  assert.doesNotThrow(() => setAdvanced(false))
})

test('ganz ohne localStorage läuft es auch', () => {
  delete globalThis.localStorage
  assert.equal(isAdvanced(), false)
  assert.doesNotThrow(() => setAdvanced(true))
})
