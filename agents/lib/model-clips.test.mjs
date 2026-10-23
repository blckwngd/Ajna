import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clipsOf, gesturesFor, matchGesture, GENERIC_GESTURES } from './model-clips.mjs'

test('reads the clip names of a glTF model, as the object references it', () => {
  const clips = clipsOf('/models/quaternius_characters/Wizard.gltf')
  assert.ok(clips.includes('Idle_Weapon'), clips.join(', '))
  assert.ok(clips.includes('Spell1'))
  assert.deepEqual(clipsOf('quaternius_characters/Wizard.gltf'), clips, 'with or without the /models/ prefix')
})

test('reads a GLB (binary) model too', () => {
  const clips = clipsOf('/models/Dragon.glb')
  assert.ok(clips.length > 0, 'the dragon has clips')
})

test('an unreadable, remote or escaping reference yields nothing — never a throw', () => {
  assert.deepEqual(clipsOf('/models/gibt-es-nicht.gltf'), [])
  assert.deepEqual(clipsOf('https://example.invalid/x.gltf'), [])
  assert.deepEqual(clipsOf('../../package.json'), [])
  assert.deepEqual(clipsOf(''), [])
})

test('gestures: only the generic ones the model can really play, then its own clips', () => {
  const g = gesturesFor(['Idle', 'Wave', 'Spell1'])
  assert.ok(g.includes('wave'), 'Wave resolves wave')
  assert.ok(g.includes('think'), 'Spell1 resolves think')
  assert.ok(g.includes('idle'))
  assert.ok(!g.includes('dance'), 'no dance clip, no dance promise')
  assert.ok(!g.includes('jump'))
  assert.ok(g.includes('Spell1'))
  assert.equal(g.filter(x => x.toLowerCase() === 'wave').length, 1, 'a model clip that is a generic gesture is not listed twice')
  assert.equal(matchGesture('spell1', g), 'Spell1')
  assert.equal(matchGesture('tanz', g), null)
  assert.deepEqual(gesturesFor([]), [], 'a model without clips has no gestures — not even idle')
  assert.ok(GENERIC_GESTURES.includes('dance'), 'dance stays a known alias for models that have one')
})

test('the Wizard has no dance — and the list says so', () => {
  const g = gesturesFor(clipsOf('/models/quaternius_characters/Wizard.gltf'))
  assert.ok(!g.includes('dance'))
  assert.ok(g.includes('Idle_Weapon') && g.includes('Spell1') && g.includes('Roll'))
})
