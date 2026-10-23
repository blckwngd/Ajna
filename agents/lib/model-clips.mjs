// Which animation clips does a figure's model have?
//
// A persona may gesture while it speaks (`say` with `do: ["anim:Wave"]`,
// the same notation Parley uses). For that it has to know its clips — and
// they must not be guessed: a name the model does not have falls back to
// the first clip, which looks like a glitch. So the names are read from
// the model file itself, once at start. glTF is JSON; GLB is the same JSON
// in a binary wrapper (12-byte header, then a JSON chunk).
//
// Besides the clip names the client understands a few GENERIC gestures
// (`wave`, `dance`, `jump`, `think`, `idle`) and maps them to whatever
// the model offers (GameObject.js, ANIM_ALIASES). Those are always allowed.

import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clipForAlias } from '../../client/core/animAliases.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
export const MODELS_DIR = resolve(HERE, '..', '..', 'client', 'models')

/**
 * Generic gestures the client resolves by alias (core/animAliases.js) — but
 * ONLY where the model has a real clip for them. "dance" was always on the
 * list; the Wizard has no dance clip, the alias chain ended at idle, and the
 * figure stood still while claiming to dance. A player asked three times.
 */
export const GENERIC_GESTURES = ['wave', 'dance', 'jump', 'think', 'idle']

/**
 * Clip names of a model, or [] when the file cannot be read. `ref` is what
 * the object carries in `appearance.gltf`: `/models/x/y.gltf`, `x/y.gltf`
 * or an absolute URL (then nothing is read — a remote model stays unknown).
 * @param {string} ref
 * @param {{modelsDir?: string}} [opts]
 * @returns {string[]}
 */
export function clipsOf(ref, { modelsDir = MODELS_DIR } = {}) {
  const s = String(ref || '').trim()
  if (!s || /^https?:/i.test(s)) return []
  const rel = s.replace(/^\/?models\//, '').replace(/^\/+/, '')
  // Stay inside the models directory — the reference comes from a data file.
  const file = resolve(modelsDir, rel)
  if (!file.startsWith(resolve(modelsDir) + sep)) return []
  let json
  try {
    const buf = readFileSync(file)
    json = /\.glb$/i.test(file) ? glbJson(buf) : JSON.parse(buf.toString('utf8'))
  } catch { return [] }
  const names = (json?.animations || []).map(a => String(a?.name || '').trim()).filter(Boolean)
  return [...new Set(names)]
}

/** The JSON chunk of a GLB container. */
function glbJson(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546C67) throw new Error('not a GLB')   // "glTF"
  const len = buf.readUInt32LE(12)
  const type = buf.readUInt32LE(16)
  if (type !== 0x4E4F534A) throw new Error('first chunk is not JSON')                        // "JSON"
  return JSON.parse(buf.subarray(20, 20 + len).toString('utf8'))
}

/**
 * What a figure may play: the generic gestures the model can actually
 * resolve, then its own clips. Nothing on this list is a promise the
 * client cannot keep — the model decides which of its real clips passes
 * for a dance when it has none.
 * @param {string[]} clips
 * @returns {string[]}
 */
export function gesturesFor(clips) {
  const own = clips || []
  const generic = GENERIC_GESTURES.filter(g => !!clipForAlias(g, own))
  const rest = own.filter(c => !generic.includes(String(c).toLowerCase()))
  return [...generic, ...rest]
}

/** Case-insensitive lookup: the model writes "wave", the clip is "Wave". */
export function matchGesture(name, gestures) {
  const n = String(name || '').trim().toLowerCase()
  if (!n) return null
  return (gestures || []).find(g => String(g).toLowerCase() === n) || null
}
