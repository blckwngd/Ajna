// model-extents.mjs — how big is a model, in metres, as the players see it.
//
// THIS IS WHERE BABYLON'S NULLENGINE EARNS ITS PLACE in an agent: it runs
// the real glTF loader in Node, without WebGL, and gives the hierarchy's
// bounding box. Measured 23.10.2026: import 1.8 s once, then 12–74 ms per
// model (Wizard.gltf 1.52 × 3.13 × 2.12, Dragon.glb 15 × 6 × 14, Fox.glb
// 25 × 79 × 155 in its own units). The client normalises some of those
// (core/modelSizes.js: Fox → 0.6 m, Quaternius figures → 1.8 m); the same
// rule is applied here, so the figure's idea of a fox matches the picture.
//
// Loading is asynchronous and happens in the background; `sizeFor()` is
// synchronous and answers from the cache or with a plausible default per
// type. A perception that waited for a model load would stall a turn.
//
// Files only, from client/models — a remote model is not fetched here.

import { readFileSync, promises as fsp } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cacheWurzel } from './quellcache.mjs'
import { targetHeightFor } from '../../client/core/modelSizes.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
export const MODELS_DIR = resolve(HERE, '..', '..', 'client', 'models')

/** Plausible sizes (w, h, d in metres) when the model is unknown or still loading. */
export const DEFAULT_SIZES = {
  npc: { w: 0.6, h: 1.8, d: 0.6 }, player: { w: 0.6, h: 1.8, d: 0.6 }, robot: { w: 0.8, h: 1.2, d: 0.8 },
  enemy: { w: 1, h: 2, d: 1 }, animal: { w: 0.5, h: 1, d: 1 }, dragon: { w: 6, h: 6, d: 6 },
  item: { w: 0.5, h: 0.5, d: 0.5 }, diamond: { w: 0.4, h: 0.4, d: 0.4 }, hint: { w: 0.6, h: 1.2, d: 0.1 },
  call: { w: 0.6, h: 1, d: 0.6 }, poi: { w: 0.5, h: 0.5, d: 0.5 }, wifi: { w: 0.3, h: 0.3, d: 0.3 },
}
const FALLBACK = { w: 0.8, h: 1, d: 0.8 }

// ── XMLHttpRequest over the file system ──────────────────────────────────
// Babylon loads a .gltf's siblings (.bin, textures) by URL through XHR.
// Node has fetch but no XHR; this is the smallest thing that satisfies the
// loader for file:// URLs. Installed only when nothing else provides one.
class FileXHR {
  constructor() { this.readyState = 0; this.status = 0; this.response = null; this.responseText = ''; this.responseType = ''; this._l = {} }
  open(method, url) { this._url = url; this.readyState = 1 }
  setRequestHeader() {}
  getResponseHeader(h) { return String(h).toLowerCase() === 'content-type' ? 'application/octet-stream' : null }
  addEventListener(ev, fn) { (this._l[ev] ||= []).push(fn) }
  removeEventListener(ev, fn) { this._l[ev] = (this._l[ev] || []).filter(f => f !== fn) }
  _fire(ev, arg) { for (const f of this._l[ev] || []) f.call(this, arg); const h = this['on' + ev]; if (typeof h === 'function') h.call(this, arg) }
  abort() {}
  send() {
    setImmediate(() => {
      try {
        const p = String(this._url).startsWith('file://') ? fileURLToPath(this._url) : this._url
        const buf = readFileSync(p)
        this.status = 200
        if (this.responseType === 'arraybuffer') this.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        else { this.responseText = buf.toString('utf8'); this.response = this.responseText }
      } catch { this.status = 404; this.response = null }
      this.readyState = 4
      this._fire('readystatechange'); this._fire(this.status === 200 ? 'load' : 'error'); this._fire('loadend')
    })
  }
}

let babylon = null
async function engine() {
  if (babylon) return babylon
  if (typeof globalThis.XMLHttpRequest === 'undefined') globalThis.XMLHttpRequest = FileXHR
  const core = await import('@babylonjs/core')
  await import('@babylonjs/loaders/glTF/index.js')
  try { core.Logger.LogLevels = core.Logger.NoneLogLevel } catch { /* quiet is a wish, not a need */ }
  const eng = new core.NullEngine()
  const scene = new core.Scene(eng)
  babylon = { core, eng, scene }
  return babylon
}

/** Local file for a model reference, or null (remote, escaping, empty). */
function fileFor(ref, modelsDir) {
  const s = String(ref || '').trim()
  if (!s || /^https?:/i.test(s)) return null
  const rel = s.replace(/^\/?models\//, '').replace(/^\/+/, '')
  const file = resolve(modelsDir, rel)
  return file.startsWith(resolve(modelsDir) + sep) ? file : null
}

/**
 * Raw extents of a model in its own units, via the glTF loader — or null.
 * @param {string} ref  `appearance.gltf` as the object carries it
 */
export async function measureModel(ref, { modelsDir = MODELS_DIR } = {}) {
  const file = fileFor(ref, modelsDir)
  if (!file) return null
  const { core, scene } = await engine()
  const dir = pathToFileURL(file.slice(0, file.lastIndexOf(sep) + 1)).href
  const name = file.slice(file.lastIndexOf(sep) + 1)
  const r = await core.SceneLoader.ImportMeshAsync('', dir, name, scene)
  let min = null, max = null
  try {
    for (const m of r.meshes) {
      m.computeWorldMatrix(true)
      const b = m.getHierarchyBoundingVectors(true)
      min = min ? min.minimizeInPlace(b.min) : b.min.clone()
      max = max ? max.maximizeInPlace(b.max) : b.max.clone()
    }
  } finally {
    for (const m of r.meshes) { try { m.dispose() } catch {} }
    for (const g of r.animationGroups || []) { try { g.dispose() } catch {} }
    for (const s of r.skeletons || []) { try { s.dispose() } catch {} }
  }
  if (!min || !max) return null
  const d = max.subtract(min)
  return { x: d.x, y: d.y, z: d.z }
}

/** Extents as the players see them: the client's height normalisation and `appearance.scale`. */
export function visibleSize(ref, raw, scale = 1) {
  if (!raw || !(raw.y > 0)) return null
  const target = targetHeightFor(ref)
  const s = (target ? target / raw.y : 1) * (Number(scale) > 0 ? Number(scale) : 1)
  return { w: raw.x * s, h: raw.y * s, d: raw.z * s }
}

/**
 * A cache of model extents that measures in the background.
 * `sizeFor(obj)` never waits: cache hit, else a default by type — and the
 * measurement is scheduled, so the next situation has the real size.
 */
export class ModelSizes {
  constructor({ dir = cacheWurzel('modelle'), modelsDir = MODELS_DIR, warn = console.warn, measure = measureModel } = {}) {
    this.dir = dir
    this.modelsDir = modelsDir
    this.warn = warn
    this.measure = measure
    this.raw = new Map()          // ref → {x,y,z} | null (null = measured, nothing)
    this.pending = new Map()      // ref → Promise
    this._loaded = this._load()
  }

  get _file() { return join(this.dir, 'extents.json') }

  async _load() {
    try {
      const j = JSON.parse(await fsp.readFile(this._file, 'utf8'))
      for (const [k, v] of Object.entries(j || {})) this.raw.set(k, v)
    } catch { /* nothing cached yet */ }
  }

  async _save() {
    try {
      await fsp.mkdir(this.dir, { recursive: true })
      await fsp.writeFile(this._file, JSON.stringify(Object.fromEntries(this.raw)), 'utf8')
    } catch (err) { this.warn(`[modelle] Ablage: ${err?.message || err}`) }
  }

  /** Measure once (idempotent); resolves to the raw extents or null. */
  ensure(ref) {
    const key = String(ref || '')
    if (!key || !fileFor(key, this.modelsDir)) return Promise.resolve(null)
    if (this.raw.has(key)) return Promise.resolve(this.raw.get(key))
    if (this.pending.has(key)) return this.pending.get(key)
    const p = (async () => {
      await this._loaded
      if (this.raw.has(key)) return this.raw.get(key)
      let r = null
      try { r = await this.measure(key, { modelsDir: this.modelsDir }) }
      catch (err) { this.warn(`[modelle] ${key}: ${err?.message || err}`) }
      this.raw.set(key, r)
      await this._save()
      return r
    })().finally(() => this.pending.delete(key))
    this.pending.set(key, p)
    return p
  }

  /**
   * Size for an object, synchronously. Unknown models are measured in the
   * background and answer with the type default until then.
   * @returns {{w:number,h:number,d:number}}
   */
  sizeFor(obj) {
    const ref = String(obj?.appearance?.gltf || obj?.model_url || '').trim()
    const scale = Number(obj?.appearance?.scale) || 1
    if (ref) {
      if (this.raw.has(ref)) {
        const v = visibleSize(ref, this.raw.get(ref), scale)
        if (v) return v
      } else {
        this.ensure(ref).catch(() => {})
      }
    }
    const d = DEFAULT_SIZES[String(obj?.type || '').toLowerCase()] || FALLBACK
    return { w: d.w * scale, h: d.h * scale, d: d.d * scale }
  }
}
