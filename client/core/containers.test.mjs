// Tests for client/core/containers.js — what the world shows of a tree.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  worldObjects, ContainerIndex, summarize, badgeText, explodedPositions,
  placeCheck, parentIdOf, isExpanded, distanceM, PLACE_SNAP_M, placeInto,
} from './containers.js'

const S = 'srv'
const mk = (id, extra = {}) => ({ id: `${S}:${id}`, _origin: S, name: id, lat: 50.4466, lon: 7.5971, altitude: 0, state: {}, ...extra })

function welt() {
  return [
    mk('rack', { container: {} }),
    mk('s1', { parent: 'rack', state: { status: 'ok' } }),
    mk('s2', { parent: 'rack', container: { view: 'exploded' }, state: { status: 'warning' } }),
    mk('vm1', { parent: 's2', state: { status: 'error' } }),
    mk('vm2', { parent: 's2' }),
    mk('stein'),
    mk('waise', { parent: 'nicht-da' }),
  ]
}

test('parentIdOf builds the composite id from the raw one', () => {
  assert.equal(parentIdOf(mk('x', { parent: 'rack' })), 'srv:rack')
  assert.equal(parentIdOf(mk('x')), null)
})

test('collapsed by default: only the rack, the stone and the orphan show', () => {
  const shown = worldObjects(welt(), { store: {} }).map(o => o.name)
  assert.deepEqual(shown.sort(), ['rack', 'stein', 'waise'])
})

test('the badge counts every descendant and names the worst status', () => {
  const [rack] = worldObjects(welt(), { store: {} })
  assert.equal(rack._childCount, 4)
  assert.equal(rack._childStatus, 'error')
  assert.equal(rack._badge, '4 🔴2')
  assert.equal(rack.appearance.label, '{name} {badge}')
})

test('expanding the rack shows its servers but not the collapsed s2 contents', () => {
  const shown = worldObjects(welt(), { store: { 'srv:rack': true } }).map(o => o.name)
  assert.deepEqual(shown.sort(), ['rack', 's1', 's2', 'stein', 'waise'])
})

test('an exploded container lays its children in a ring on copies', () => {
  const objs = welt()
  const shown = worldObjects(objs, { store: { 'srv:rack': true, 'srv:s2': true } })
  const vm1 = shown.find(o => o.name === 'vm1'), vm2 = shown.find(o => o.name === 'vm2')
  assert.ok(vm1._exploded && vm2._exploded)
  assert.ok(Math.abs(vm1.lat - vm2.lat) > 1e-6 || Math.abs(vm1.lon - vm2.lon) > 1e-6)
  assert.equal(vm1.altitude, 0.5)
  assert.equal(objs.find(o => o.name === 'vm1').altitude, 0, 'the record itself is untouched')
  const ring = explodedPositions(objs[0], objs.slice(1, 5))
  assert.equal(ring.size, 4)
  for (const p of ring.values()) assert.ok(Math.abs(distanceM(objs[0], p) - 1.8) < 0.05)
})

test('badge modes and lazy containers', () => {
  const idx = new ContainerIndex(welt())
  const rack = welt()[0]
  const sum = summarize(idx, rack)
  assert.equal(badgeText({ ...rack, container: { badge: 'count' } }, sum), '4')
  assert.equal(badgeText({ ...rack, container: { badge: 'status' } }, sum), '🔴2')
  assert.equal(badgeText({ ...rack, container: { badge: 'none' } }, sum), '')
  assert.equal(badgeText({ ...rack, container: { badge: 'both' } }, { count: 3, status: 'ok', bad: 0 }), '3')
  assert.equal(badgeText({ ...rack, container: { load: 'on_expand' } }, { count: 0, status: null, bad: 0 }), '')
})

test('the owner default and the player override', () => {
  const rack = mk('rack', { container: { expanded: true } })
  assert.equal(isExpanded(rack, {}), true)
  assert.equal(isExpanded(rack, { 'srv:rack': false }), false)
  assert.equal(isExpanded(mk('stein'), {}), false)
})

test('placeCheck refuses self, non-containers, other servers, cycles, carried', () => {
  const objs = welt()
  const idx = new ContainerIndex(objs)
  const rack = objs[0], s2 = objs[2], stein = objs[5]
  assert.equal(placeCheck(stein, rack, idx), null)
  assert.ok(placeCheck(rack, rack, idx))
  assert.ok(placeCheck(stein, objs[1], idx))                       // s1 is no container
  assert.ok(placeCheck({ ...stein, _origin: 'other' }, rack, idx))
  assert.ok(placeCheck(rack, s2, idx))                             // rack above s2 → cycle
  assert.ok(placeCheck({ ...stein, carried_by: 'u1' }, rack, idx))
  assert.ok(placeCheck(objs[1], rack, idx))                        // already inside
})

test('placeInto keeps the place when near and snaps to the container when far', async () => {
  const calls = []
  const ajna = { updateObject: async (id, data) => { calls.push([id, data]); return {} } }
  const rack = mk('rack', { container: {} })
  await placeInto(ajna, mk('nah', { lat: rack.lat + 0.0001 }), rack)
  await placeInto(ajna, mk('fern', { lat: rack.lat + 0.01 }), rack)
  assert.deepEqual(calls[0][1], { parent: 'rack', local: { from: 'world' } })
  assert.deepEqual(calls[1][1], { parent: 'rack', local: { east: 0, north: 0, up: 0, heading: 0 } })
  assert.ok(distanceM(rack, mk('fern', { lat: rack.lat + 0.01 })) > PLACE_SNAP_M)
})
