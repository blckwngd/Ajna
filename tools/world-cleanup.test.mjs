// Tests für die Entscheidungsregel aus tools/world-cleanup.mjs.
//
// Das Werkzeug löscht Objekte unwiderruflich — die Regel gehört also geprüft,
// nicht nur gelesen. Zwei Fälle sind dabei wichtiger als alle anderen:
// Was einem Menschen gehört, bleibt. Was geschützt ist, bleibt.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { urteil } from './world-cleanup.mjs'

const MENSCH = 'u_mensch', TEST = 'u_test', AGENT = 'u_agent'
const mailVon = (id) => ({
  [MENSCH]: 'blackwinged@online.de',
  [TEST]: 'vtest-mtk1s3md@example.invalid',
  [AGENT]: 'claude@ajna.local',
}[id] || '')

// Neuwied — dort, wo wirklich gespielt wird.
const ANKER = [{ lat: 50.4514, lon: 7.5363 }]
const obj = (o) => ({ owner: MENSCH, type: 'item', lat: 50.4514, lon: 7.5363, state: {}, ...o })

// ─── Was bleiben MUSS ─────────────────────────────────────────────────────

test('was einem Menschen gehört, bleibt', () => {
  for (const type of ['item', 'diamond', 'npc', 'animal', 'default', '', 'enemy', 'call']) {
    const u = urteil(obj({ type }), mailVon, ANKER)
    assert.equal(u.weg, false, `${type || '(leer)'} würde gelöscht: ${u.grund}`)
  }
})

test('ein Objekt eines Menschen bleibt auch weit weg und uralt', () => {
  // Alter und Entfernung sind für eigene Sachen kein Grund. Wer sich etwas
  // irgendwohin gestellt hat, hat sich dabei etwas gedacht.
  assert.equal(urteil(obj({ lat: 47.07, lon: 15.44 }), mailVon, ANKER).weg, false)
})

test('UWB-Anker und AR-Marker sind unantastbar — auch von Testkonten', () => {
  for (const type of ['uwb_anchor', 'marker', 'ar_marker']) {
    assert.equal(urteil(obj({ type, owner: TEST }), mailVon, ANKER).weg, false, type)
    assert.equal(urteil(obj({ type, owner: TEST, state: { source: 'cits' } }), mailVon, ANKER).weg,
      false, `${type} auch mit Spiegel-Quelle`)
  }
})

test('Figuren des World-Directors bleiben — sie leben gerade', () => {
  const npc = obj({ owner: AGENT, type: 'npc', state: { source: 'world-director' } })
  assert.equal(urteil(npc, mailVon, ANKER).weg, false)
})

// ─── Was weg MUSS ─────────────────────────────────────────────────────────

test('Spiegel fliegen, egal wem sie gehören', () => {
  for (const source of ['cits', 'opensky', 'vesselfinder', 'aprs', 'aisstream']) {
    assert.equal(urteil(obj({ owner: MENSCH, state: { source } }), mailVon, ANKER).weg, true, source)
  }
})

test('ortsfeste Spiegel: die Entfernung entscheidet, nicht das Alter', () => {
  // DER GEMELDETE FALL: WLAN-Netze im Median 3,8 km weg, weil ein Agent um ein
  // falsch eingestelltes Zentrum gesammelt hat. In Reichweite bleiben sie —
  // sie neu zu holen kostet fremdes Kontingent.
  const nah = obj({ owner: AGENT, type: 'wifi', state: { source: 'wigle' } })
  const fern = obj({ owner: AGENT, type: 'wifi', lat: 50.50, lon: 7.60, state: { source: 'wigle' } })
  assert.equal(urteil(nah, mailVon, ANKER).weg, false)
  assert.equal(urteil(fern, mailVon, ANKER).weg, true)
  assert.match(urteil(fern, mailVon, ANKER).grund, /ausser Reichweite/)
})

test('ohne Anker wird über ortsfeste Spiegel NICHT geurteilt', () => {
  // Kein Spieler, kein Bezugspunkt — dann ist jede Entfernungsaussage geraten.
  const fern = obj({ owner: AGENT, type: 'wifi', lat: 48, lon: 11, state: { source: 'wigle' } })
  assert.equal(urteil(fern, mailVon, []).weg, false)
})

test('Rückstände aus Testläufen fliegen', () => {
  assert.equal(urteil(obj({ owner: TEST }), mailVon, ANKER).weg, true)
  assert.equal(urteil(obj({ owner: AGENT, state: { source: 'prueflabor-3v5bc5' } }), mailVon, ANKER).weg, true)
  assert.equal(urteil(obj({ owner: AGENT, state: { source: 'b-quelle-mszqh6gx' } }), mailVon, ANKER).weg, true)
})

test('herrenlose Objekte fliegen', () => {
  assert.equal(urteil(obj({ owner: '' }), mailVon, ANKER).weg, true)
  assert.equal(urteil(obj({ owner: 'gibt-es-nicht-mehr' }), mailVon, ANKER).weg, true)
})

test('jedes Urteil nennt einen Grund', () => {
  for (const o of [obj({}), obj({ owner: TEST }), obj({ type: 'uwb_anchor' }),
                   obj({ state: { source: 'cits' } })]) {
    const u = urteil(o, mailVon, ANKER)
    assert.ok(u.grund && u.grund.length > 5, JSON.stringify(u))
  }
})
