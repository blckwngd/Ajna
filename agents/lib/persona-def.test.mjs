import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validatePersona, loadPersona, toObject, objectDiff, interestBox, manifestFor, sourceFor, NAME_PATTERN,
} from './persona-def.mjs'

const RAW = {
  name: 'Jorin der Wanderer',
  type: 'npc',
  lat: 50.3569, lon: 7.5890,
  description: 'Läuft herum und sieht sich alles an.',
  dialog: 'mensch',
  movement: 'free',
  appearance: { gltf: 'quaternius_men/Adventurer.gltf', emoji: '🧭' },
  mode: 'debug',
  prompt: 'Du bist Jorin.',
}

test('a valid persona passes and gets the name as figure id', () => {
  const r = validatePersona(RAW, 'wanderer')
  assert.equal(r.error, undefined)
  assert.equal(r.persona.figure.id, 'wanderer')
  assert.equal(r.persona.mode, 'debug')
  assert.equal(r.persona.prompt, 'Du bist Jorin.')
})

test('the name must be a valid handle — it becomes the account username', () => {
  assert.match(validatePersona(RAW, 'Jorin Wanderer').error, /must match/)
  assert.match(validatePersona(RAW, '').error, /must match/)
  assert.ok(NAME_PATTERN.test('wanderer-2'))
})

test('a model mode without a prompt is refused — the model would have no character', () => {
  const r = validatePersona({ ...RAW, prompt: '' }, 'wanderer')
  assert.match(r.error, /needs a "prompt"/)
})

test('basic needs no prompt', () => {
  const r = validatePersona({ ...RAW, mode: 'basic', prompt: '' }, 'wanderer')
  assert.equal(r.error, undefined)
})

test('an unknown mode is refused', () => {
  assert.match(validatePersona({ ...RAW, mode: 'turbo' }, 'wanderer').error, /allowed/)
})

test('figure validation still applies (lat/lon/type)', () => {
  assert.match(validatePersona({ ...RAW, lat: 'nord' }, 'wanderer').error, /lat/)
  assert.match(validatePersona({ ...RAW, type: 'ghost' }, 'wanderer').error, /type/)
})

test('the object carries the persona source and NOT the director marker — and never the prompt', () => {
  const { persona } = validatePersona(RAW, 'wanderer')
  const o = toObject(persona)
  assert.equal(o.state.source, 'persona-wanderer')
  assert.equal(o.state.director, undefined)
  assert.equal(o.state.persistent, true)
  assert.equal(o.state.figure_id, 'wanderer')
  assert.equal(o.state.persona, true)
  assert.equal(JSON.stringify(o).includes('Du bist Jorin'), false, 'the prompt is public if it is in state')
  assert.equal(o.appearance.gltf, '/models/quaternius_men/Adventurer.gltf')
})

test('the name is always above the head — a label template by default, the file may override it', () => {
  const { persona } = validatePersona(RAW, 'wanderer')
  assert.equal(toObject(persona).appearance.label, '{name}')
  const own = validatePersona({ ...RAW, appearance: { ...RAW.appearance, label: '{name}\n{distance}' } }, 'wanderer').persona
  assert.equal(toObject(own).appearance.label, '{name}\n{distance}')
  // and objectDiff brings an old figure without a label up to date
  const old = { ...toObject(persona), appearance: { gltf: '/models/quaternius_men/Adventurer.gltf', emoji: '🧭' } }
  assert.equal(objectDiff(persona, old).appearance.label, '{name}')
})

test('objectDiff is null when the world already matches', () => {
  const { persona } = validatePersona(RAW, 'wanderer')
  const o = toObject(persona)
  // as PocketBase would return it: extra runtime state, keys in another order
  const existing = { ...o, id: 'abc', state: { motion: { v: 0 }, ...o.state } }
  assert.equal(objectDiff(persona, existing), null)
})

test('objectDiff merges state instead of replacing it, and strips a stray director marker', () => {
  const { persona } = validatePersona(RAW, 'wanderer')
  const o = toObject(persona)
  const existing = { ...o, name: 'Alt', state: { ...o.state, director: true, motion: { v: 1 } } }
  const patch = objectDiff(persona, existing)
  assert.equal(patch.name, RAW.name)
  assert.equal(patch.state.director, undefined)
  assert.deepEqual(patch.state.motion, { v: 1 }, 'runtime state must survive')
})

test('loadPersona reads a file and reports a missing one plainly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-'))
  try {
    writeFileSync(join(dir, 'wanderer.persona.json'), JSON.stringify(RAW))
    assert.equal(loadPersona('wanderer', dir).persona.name, 'wanderer')
    assert.match(loadPersona('niemand', dir).error, /no persona file/)
    writeFileSync(join(dir, 'kaputt.persona.json'), '{ nicht json')
    assert.match(loadPersona('kaputt', dir).error, /not valid JSON/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('interestBox is a 500 m box on the privacy grid, never the exact position', () => {
  const b = interestBox(50.35691, 7.58904)
  assert.ok(b.latMax - b.latMin > 0.004 && b.latMax - b.latMin < 0.0046)
  const cLat = (b.latMin + b.latMax) / 2
  assert.notEqual(cLat, 50.35691, 'centre must be snapped to the grid')
})

test('manifest names the source and one layer', () => {
  const { persona } = validatePersona(RAW, 'wanderer')
  const m = manifestFor(persona)
  assert.equal(m.source, sourceFor('wanderer'))
  assert.equal(m.layers.length, 1)
  assert.equal(m.agent_name, RAW.name)
})
