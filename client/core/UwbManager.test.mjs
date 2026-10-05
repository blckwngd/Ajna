// Tests für die Status-Kanten des UwbManager.
//
// ANLASS, 02.10.2026: Im Verlauf stand minutenlang immer wieder „UWB getrennt",
// obwohl sich nichts geändert hatte. Die native Schicht wiederholt den Status —
// jeder gescheiterte Auto-Reconnect-Versuch kommt als weiteres „nicht
// verbunden" an —, und `_onStatus` reichte jedes Ereignis durch.
//
// `onStatusChange` heißt nach Kanten, also feuert es auf Kanten. Wer den
// aktuellen Zustand will, fragt `isConnected(role)`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UwbManager } from './UwbManager.js'

/** Ein localStorage, das sich tatsächlich etwas merkt. */
function speicher() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  }
}

function manager() {
  globalThis.localStorage = speicher()
  const meldungen = []
  const kanten = []
  const u = new UwbManager({ notify: (t) => meldungen.push(t) })
  u.onStatusChange((verbunden, adresse, rolle) => kanten.push({ verbunden, adresse, rolle }))
  return { u, meldungen, kanten }
}

const status = (u, verbunden, address = null, role = 'viewer') =>
  u._onStatus({ role, connected: verbunden, ...(address ? { address } : {}) })

test('wiederholtes „nicht verbunden" meldet nur einmal — gar nicht', () => {
  // Vor dem ersten Ereignis gilt ein Knoten bereits als getrennt. Ein weiteres
  // „getrennt" ist also KEINE Kante und hat im Protokoll nichts zu suchen.
  const { u, meldungen, kanten } = manager()
  for (let i = 0; i < 5; i++) status(u, false)
  assert.deepEqual(meldungen.filter(m => m.includes('UWB')), [])
  assert.equal(kanten.length, 0)
})

test('die Kante von getrennt nach verbunden wird gemeldet, die Wiederholung nicht', () => {
  const { u, meldungen, kanten } = manager()
  status(u, true, 'AA:BB:CC:DD:EE:FF')
  status(u, true, 'AA:BB:CC:DD:EE:FF')
  status(u, true, 'AA:BB:CC:DD:EE:FF')
  const uwb = meldungen.filter(m => m.includes('UWB'))
  assert.equal(uwb.length, 1, uwb.join(' | '))
  assert.match(uwb[0], /verbunden/)
  assert.equal(kanten.length, 1)
  assert.equal(kanten[0].verbunden, true)
})

test('der gemeldete Ablauf einer echten Sitzung', () => {
  // Genau das Muster aus dem Bildschirmfoto: verbinden, Funkstille mit
  // wiederholten Statusmeldungen, trennen, wieder Wiederholungen.
  const { u, meldungen } = manager()
  status(u, true, 'AA:BB')
  for (let i = 0; i < 4; i++) status(u, true, 'AA:BB')
  status(u, false)
  for (let i = 0; i < 9; i++) status(u, false)
  const uwb = meldungen.filter(m => m.includes('UWB „'))
  assert.deepEqual(uwb, ['UWB „viewer" verbunden', 'UWB „viewer" getrennt'],
    `15 Ereignisse, 2 Meldungen erwartet — bekommen: ${uwb.length}`)
})

test('ein ANDERES Tag bei bestehender Verbindung ist eine Kante', () => {
  // `connected` bleibt true, trotzdem hat sich etwas geändert, das man wissen
  // will: Die Verbindung hängt an einem anderen Gerät.
  const { u, kanten } = manager()
  status(u, true, 'AA:BB')
  status(u, true, '11:22')
  assert.equal(kanten.length, 2)
  assert.equal(kanten[1].adresse, '11:22')
})

test('jede Rolle hat ihre eigene Kante', () => {
  // Stab und Betrachter tragen eigene Tags; die Verbindung des einen darf die
  // Meldung des anderen nicht verschlucken.
  const { u, kanten } = manager()
  status(u, true, 'AA:BB', 'viewer')
  status(u, true, 'CC:DD', 'wand')
  status(u, true, 'AA:BB', 'viewer')
  assert.equal(kanten.length, 2)
  assert.deepEqual(kanten.map(k => k.rolle), ['viewer', 'wand'])
})

test('der Zustand bleibt abfragbar, auch wenn nichts gemeldet wurde', () => {
  // Die Kantenerkennung darf nichts verstecken: wer den Zustand braucht,
  // fragt ihn ab, statt auf eine Meldung zu warten.
  const { u } = manager()
  status(u, true, 'AA:BB')
  for (let i = 0; i < 3; i++) status(u, true, 'AA:BB')
  assert.equal(u.isConnected('viewer'), true)
  status(u, false)
  assert.equal(u.isConnected('viewer'), false)
})
