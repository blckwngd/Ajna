// Tests for the pure half of pocketbase/pb_hooks/hierarchy.js — the geometry
// and the shape checks of Sammelobjekte. The $app half is covered end to end
// in tests/privacy/sammelobjekte.mjs.
//
// Loaded the way PocketBase loads it (CommonJS source wrapped in a function);
// see auth-throttle.test.mjs for why.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function ladeHook(pfad) {
  const quelle = readFileSync(new URL(pfad, import.meta.url), 'utf8')
  const modul = { exports: {} }
  new Function('module', 'exports', 'require', '__hooks', quelle)(modul, modul.exports, () => ({}), '.')
  return modul.exports
}
const H = ladeHook('./hierarchy.js')

const rack = { lat: 50.4466, lon: 7.5971, altitude: 100, heading: 0 }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

test('a child north of an unrotated parent lies north of it', () => {
  const w = H.localToWorld(rack, { east: 0, north: 10, up: 2, heading: 0 })
  assert.ok(w.lat > rack.lat && near(w.lon, rack.lon, 1e-9))
  assert.equal(w.altitude, 102)
  assert.equal(w.heading, 0)
})

test('a parent facing east turns "in front" into east and "right" into south', () => {
  const east = { ...rack, heading: 90 }
  const front = H.localToWorld(east, { east: 0, north: 10, up: 0, heading: 0 })
  assert.ok(front.lon > rack.lon && near(front.lat, rack.lat, 1e-9))
  const right = H.localToWorld(east, { east: 10, north: 0, up: 0, heading: 0 })
  assert.ok(right.lat < rack.lat && near(right.lon, rack.lon, 1e-9))
  assert.equal(front.heading, 90)
})

test('worldToLocal inverts localToWorld, with rotation', () => {
  for (const heading of [0, 37, 90, 180, 271.5]) {
    const p = { ...rack, heading }
    const local = { east: 3.5, north: -12.25, up: 1.5, heading: 45 }
    const back = H.worldToLocal(p, H.localToWorld(p, local))
    for (const k of ['east', 'north', 'up']) assert.ok(near(back[k], local[k], 1e-4), `${k} at ${heading}°: ${back[k]}`)
    assert.ok(near(back.heading, 45, 1e-6))
  }
})

test('one metre east at this latitude is about 1.4e-5 degrees', () => {
  const w = H.localToWorld(rack, { east: 1, north: 0, up: 0, heading: 0 })
  assert.ok(near((w.lon - rack.lon) * 1e5, 1.41, 0.02))
})

test('headings wrap around 360', () => {
  assert.equal(H.localToWorld({ ...rack, heading: 350 }, { east: 0, north: 0, up: 0, heading: 20 }).heading, 10)
  assert.equal(H.worldToLocal({ ...rack, heading: 350 }, { ...rack, heading: 10 }).heading, 20)
})

test('parseLocal: null, numbers, from world, bad shapes', () => {
  assert.equal(H.parseLocal(null), null)
  assert.equal(H.parseLocal(''), null)
  assert.deepEqual(H.parseLocal({ east: 1 }), { east: 1, north: 0, up: 0, heading: 0 })
  assert.deepEqual(H.parseLocal('{"north":"2.5"}'), { east: 0, north: 2.5, up: 0, heading: 0 })
  assert.deepEqual(H.parseLocal({ from: 'world' }), { from: 'world' })
  assert.throws(() => H.parseLocal({ east: 'x' }), /local\.east/)
  assert.throws(() => H.parseLocal([1, 2]), /object/)
})

test('parseContainer: defaults, enums, expanded', () => {
  assert.equal(H.parseContainer(null), null)
  assert.deepEqual(H.parseContainer({}), { badge: 'both', view: 'placed', expanded: false, load: 'always' })
  assert.deepEqual(H.parseContainer({ view: 'exploded', badge: 'none', expanded: 1, load: 'on_expand' }),
    { badge: 'none', view: 'exploded', expanded: true, load: 'on_expand' })
  assert.throws(() => H.parseContainer({ badge: 'red' }), /container\.badge/)
})

test('depth: eight levels fit, nine do not', () => {
  // parent with 6 above it (7 incl. itself) + node + height 0 = 8 → ok
  assert.ok(H.depthAllowed(7, 0))
  assert.ok(!H.depthAllowed(8, 0))
  // hanging a 3-deep subtree under a level-5 parent: 5 + 1 + 3 = 9 → no
  assert.ok(!H.depthAllowed(5, 3))
  assert.ok(H.depthAllowed(4, 3))
})

test('worstStatus ranks error over warning over unknown over ok', () => {
  assert.equal(H.worstStatus(['ok', 'ok']), 'ok')
  assert.equal(H.worstStatus(['ok', 'warning', 'unknown']), 'warning')
  assert.equal(H.worstStatus(['error', 'warning']), 'error')
  assert.equal(H.worstStatus(['ok', 'weird']), 'unknown')
  assert.equal(H.worstStatus([]), null)
})

test('samePosition tolerates sub-millimetre noise only', () => {
  assert.ok(H.samePosition(rack, { ...rack, lat: rack.lat + 1e-10 }))
  assert.ok(!H.samePosition(rack, { ...rack, lat: rack.lat + 1e-6 }))
  assert.ok(H.samePosition({ ...rack, heading: 0 }, { ...rack, heading: 360 }))
})
