import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measureModel, visibleSize, ModelSizes, DEFAULT_SIZES } from './model-extents.mjs'

test('NullEngine measures a real model in Node — the Wizard is about three units tall', async () => {
  const r = await measureModel('/models/quaternius_characters/Wizard.gltf')
  assert.ok(r && r.y > 2.5 && r.y < 3.5, JSON.stringify(r))
  assert.ok(r.x > 1 && r.z > 1)
  assert.equal(await measureModel('https://example.invalid/x.glb'), null, 'remote models are not fetched')
  assert.equal(await measureModel('../../package.json'), null, 'nothing outside client/models')
})

test('visibleSize applies the client normalisation: Quaternius figures are 1.8 m, the Fox 0.6 m', () => {
  const w = visibleSize('/models/quaternius_characters/Wizard.gltf', { x: 1.52, y: 3.13, z: 2.12 })
  assert.ok(Math.abs(w.h - 1.8) < 1e-9)
  assert.ok(Math.abs(w.w - 1.52 * 1.8 / 3.13) < 1e-9)
  const fox = visibleSize('/models/Fox.glb', { x: 25, y: 79, z: 155 })
  assert.ok(Math.abs(fox.h - 0.6) < 1e-9 && fox.d < 1.3)
  const dragon = visibleSize('/models/Dragon.glb', { x: 15, y: 6, z: 14 })
  assert.equal(dragon.h, 6, 'unlisted models stay 1:1')
  assert.equal(visibleSize('/models/Dragon.glb', { x: 15, y: 6, z: 14 }, 0.5).h, 3, 'appearance.scale multiplies')
  assert.equal(visibleSize('x', null), null)
})

test('ModelSizes answers at once with a default and measures in the background', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelle-'))
  try {
    let gemessen = 0
    const sizes = new ModelSizes({ dir, measure: async () => { gemessen++; return { x: 1.5, y: 3, z: 2 } } })
    const wizard = { type: 'npc', appearance: { gltf: '/models/quaternius_characters/Wizard.gltf' } }
    assert.deepEqual(sizes.sizeFor(wizard), DEFAULT_SIZES.npc, 'first answer: the default')
    await sizes.ensure(wizard.appearance.gltf)
    assert.ok(Math.abs(sizes.sizeFor(wizard).h - 1.8) < 1e-9, 'second answer: measured and normalised')
    assert.equal(gemessen, 1)
    sizes.sizeFor(wizard); sizes.sizeFor(wizard)
    assert.equal(gemessen, 1, 'measured once')
    assert.deepEqual(sizes.sizeFor({ type: 'dragon' }), DEFAULT_SIZES.dragon)
    assert.deepEqual(sizes.sizeFor({ type: 'unbekannt' }), { w: 0.8, h: 1, d: 0.8 })
    // a second instance reads the cache from disk
    const again = new ModelSizes({ dir, measure: async () => { throw new Error('should not measure') } })
    await again._loaded
    assert.ok(Math.abs(again.sizeFor(wizard).h - 1.8) < 1e-9)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
