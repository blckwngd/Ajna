// Sammelobjekte in der Bibliothek: Oberfläche und Agenten gehen für Einhängen,
// Herausnehmen und den Blick in den Baum über diese Methoden — kein
// `updateObject({ parent })` von Hand. Geprüft mit einem untergeschobenen
// `pb`, das nur aufschreibt, was die Bibliothek ihm schickt.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AjnaClient } from './AjnaClient.js'

function pbStub(items = []) {
  const calls = []
  return {
    calls,
    authStore: { isValid: true, record: { id: 'u1' } },
    baseUrl: 'http://example.invalid',
    realtime: { subscribe: async () => () => {} },
    collection() {
      return {
        getFullList: async () => items.map(o => ({ ...o })),
        update: async (id, data) => { calls.push(['update', id, data]); return { id, ...data } },
        delete: async (id, opts) => { calls.push(['delete', id, opts]) },
        subscribe: async () => () => {},
      }
    },
  }
}

const rec = (id, extra = {}) => ({ id, name: id, lat: 50.4466, lon: 7.5971, altitude: 0, state: {}, ...extra })
const WELT = [
  rec('rack', { container: {} }),
  rec('s1', { parent: 'rack' }),
  rec('s2', { parent: 'rack', container: {} }),
  rec('vm', { parent: 's2' }),
  rec('stein'),
]

async function client() {
  const pb = pbStub(WELT)
  const c = new AjnaClient({ id: 'srv', pb })
  await c.refreshObjects()
  return { c, pb }
}

test('placeInto: stehen lassen, Versatz setzen oder neue Weltlage — immer mit roher Eltern-ID', async () => {
  const { c, pb } = await client()
  await c.placeInto('srv:stein', 'srv:rack')
  await c.placeInto('srv:stein', 'rack', { local: { up: 2 } })
  await c.placeInto('srv:stein', 'srv:rack', { lat: 1, lon: 2, altitude: 3 })
  assert.deepEqual(pb.calls.map(k => k[2]), [
    { parent: 'rack', local: { from: 'world' } },
    { parent: 'rack', local: { up: 2 } },
    { parent: 'rack', lat: 1, lon: 2, altitude: 3 },
  ])
  assert.ok(pb.calls.every(k => k[1] === 'stein'))
})

test('takeOut, setLocal, setContainer sind die benannten Änderungen', async () => {
  const { c, pb } = await client()
  await c.takeOut('srv:s1')
  await c.setLocal('srv:s1', { east: 1, north: 0, up: 0, heading: 90 })
  await c.setContainer('srv:stein', { view: 'exploded' })
  await c.setContainer('srv:stein', null)
  assert.deepEqual(pb.calls.map(k => k[2]), [
    { parent: '' },
    { local: { east: 1, north: 0, up: 0, heading: 90 } },
    { container: { view: 'exploded' } },
    { container: null },
  ])
})

test('parentOf, childrenOf, descendantsOf lesen den Zwischenspeicher mit zusammengesetzten IDs', async () => {
  const { c } = await client()
  assert.equal(c.parentOf('srv:vm')?.id, 'srv:s2')
  assert.equal(c.parentOf('srv:rack'), null)
  assert.deepEqual(c.childrenOf('srv:rack').map(o => o.id).sort(), ['srv:s1', 'srv:s2'])
  assert.deepEqual(c.childrenOf('rack').map(o => o.id).sort(), ['srv:s1', 'srv:s2'])
  assert.deepEqual(c.descendantsOf('srv:rack').map(o => o.id).sort(), ['srv:s1', 'srv:s2', 'srv:vm'])
  assert.deepEqual(c.descendantsOf('srv:stein'), [])
})

test('deleteObject reicht die Ansage für den Inhalt als Query weiter', async () => {
  const { c, pb } = await client()
  await c.deleteObject('srv:rack', { children: 'detach' })
  await c.deleteObject('srv:stein')
  assert.deepEqual(pb.calls, [['delete', 'rack', { query: { children: 'detach' } }], ['delete', 'stein', {}]])
})
