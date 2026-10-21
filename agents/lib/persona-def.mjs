// ─────────────────────────────────────────────────────────────────────────
//  Agent library · Persona definition — a figure with its own account
// ─────────────────────────────────────────────────────────────────────────
// A persona is a designed figure (`figuren/*.figur.json` semantics) that is
// NOT owned by the world-director but by an account of its own. That is the
// whole difference, and it matters: the director writes to objects it owns,
// so every rule check passes on the owner path. A persona reaches the world
// through the same routes a human player uses, and therefore hits the same
// walls a player hits. For a figure whose job is to notice what a player
// would notice, that is the point.
//
// Files live in `personas/<name>.persona.json`, one per persona. They reuse
// the figure validation from `figuren.mjs` and add what a figure never had:
//
//   mode     basic | passive | active | debug   (default for the setting)
//   prompt   persona text for the language model — German, it is content.
//            Stays in the file and in `agent_settings`; it is NEVER written
//            into `objects.state`, which anyone who sees the figure may read.
//
// The folder is deliberately separate from `figuren/`: the director adopts
// everything in there as its own and would create a second, director-owned
// copy of the figure.

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pruefeFigur, alsObjekt, unterschied } from './figuren.mjs'
import { fuzzPoint, FUZZ_GRID_M } from '../../client/core/PrivacyPolicy.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PERSONAS_DIR = join(HERE, '..', '..', 'personas')

export const MODES = ['basic', 'passive', 'active', 'debug']

/** Menu actions per figure type — labels are what the player reads. */
export const MENU_ACTIONS = {
  npc:    [{ key: 'talk', label: 'Sprechen' }, { key: 'examine', label: 'Untersuchen' }],
  animal: [{ key: 'talk', label: 'Ansprechen' }, { key: 'examine', label: 'Untersuchen' }],
  enemy:  [{ key: 'talk', label: 'Sprechen' }, { key: 'examine', label: 'Untersuchen' }],
}
/** The interaction keys a persona grants to every logged-in player. */
export const GRANTED_ACTIONS = ['talk', 'examine']

/** Same rule as `users.username` — the persona name becomes the handle. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/

/** Path of a persona file. */
export const personaPath = (name, dir = PERSONAS_DIR) => join(dir, `${name}.persona.json`)

/** The `state.source` of a persona's objects — and the name of its manifest. */
export const sourceFor = (name) => `persona-${name}`

/**
 * Validate a raw persona document. Returns `{ persona }` or `{ error }`.
 *
 * Everything a figure needs is checked by `pruefeFigur`; this adds the
 * persona-only fields. `id` defaults to the persona name so the common case
 * needs no second identifier.
 */
export function validatePersona(raw, name, source = '') {
  if (!NAME_PATTERN.test(String(name || ''))) {
    return { error: `${source || 'persona'}: name "${name}" must match ${NAME_PATTERN} (it becomes the account handle)` }
  }
  const doc = raw && typeof raw === 'object' ? { ...raw } : {}
  if (!doc.id) doc.id = name
  const { figur, fehler } = pruefeFigur(doc, source || `${name}.persona.json`)
  if (fehler) return { error: fehler }

  const mode = String(doc.mode ?? 'basic').trim().toLowerCase()
  if (!MODES.includes(mode)) {
    return { error: `${source}: "mode" is "${mode}", allowed: ${MODES.join(', ')}` }
  }
  const prompt = String(doc.prompt ?? '').trim()
  if (mode !== 'basic' && !prompt) {
    return { error: `${source}: mode "${mode}" needs a "prompt" — without one the model has no character to play` }
  }
  return {
    persona: {
      name,
      figure: figur,          // the part that becomes the world object
      mode,
      prompt,
    },
  }
}

/** Load and validate `personas/<name>.persona.json`. */
export function loadPersona(name, dir = PERSONAS_DIR) {
  const path = personaPath(name, dir)
  if (!existsSync(path)) return { error: `no persona file: ${path}` }
  let raw
  try { raw = JSON.parse(readFileSync(path, 'utf8')) }
  catch (err) { return { error: `${path}: not valid JSON (${err.message})` } }
  return validatePersona(raw, name, `${name}.persona.json`)
}

/**
 * The world object for a persona.
 *
 * Built from the figure mapping, then corrected in two places that matter:
 * `source` names the persona (its manifest, its filter entry, its provenance
 * badge), and the director's own marker is removed — otherwise the director
 * would adopt the figure as one of its own and try to maintain it.
 */
export function toObject(persona, modelBase = '/models/') {
  const o = alsObjekt(persona.figure, modelBase)
  delete o.state.director
  o.state.source = sourceFor(persona.name)
  o.state.persona = true           // a marker, nothing more — the prompt is NOT here
  // Menu actions the client offers on the figure. The same keys land in the
  // ACE (authorisation) — see the agent's ensureAce. A figure without them
  // could be looked at but never addressed.
  o.state.actions = MENU_ACTIONS[persona.figure.type] || MENU_ACTIONS.npc
  return o
}

/**
 * What differs between the file and the existing object — same approach as
 * the director: only fields that come from the file, state merged not
 * replaced, so a figure the agent is currently moving keeps its `motion`.
 */
export function objectDiff(persona, existing, modelBase = '/models/') {
  const target = toObject(persona, modelBase)
  // `unterschied` compares against the figure mapping (with the director
  // marker). Compare against OUR mapping instead, with the same field list.
  const patch = {}
  for (const field of ['name', 'type', 'description', 'lat', 'lon']) {
    if (existing?.[field] !== target[field]) patch[field] = target[field]
  }
  if (stable(existing?.appearance ?? {}) !== stable(target.appearance)) patch.appearance = target.appearance
  const have = existing?.state ?? {}
  const want = target.state
  const stateDiffers = Object.keys(want).some(k => stable(have[k]) !== stable(want[k]))
    || have.director !== undefined
  if (stateDiffers) {
    const merged = { ...have, ...want }
    delete merged.director
    patch.state = merged
  }
  return Object.keys(patch).length ? patch : null
}

// Stable JSON — key order does not matter (PocketBase returns keys sorted).
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

// Re-exported so the agent needs one import for figure handling.
export { unterschied }

/**
 * The persona's interest area: the same fuzzed 500 m box a player's client
 * publishes (`InterestArea.js`), built from the same grid. Published only
 * when the persona is configured to — a figure that stands in one place
 * would otherwise keep the director populating that spot forever.
 */
export function interestBox(lat, lon, halfM = 250) {
  const cosLat = Math.cos(lat * Math.PI / 180) || 1e-6
  const c = fuzzPoint(lat, lon, FUZZ_GRID_M)
  const dLat = halfM / 111000
  const dLon = halfM / (111000 * cosLat)
  return { latMin: c.lat - dLat, latMax: c.lat + dLat, lonMin: c.lon - dLon, lonMax: c.lon + dLon }
}

/** Manifest for the persona's source — one layer, everything. */
export function manifestFor(persona) {
  return {
    source: sourceFor(persona.name),
    agent_name: persona.figure.name,
    description: persona.figure.description || `Figur „${persona.figure.name}" mit eigenem Konto.`,
    layers: [{ key: 'all', label: persona.figure.name, predicate: null }],
  }
}
