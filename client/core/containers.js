// containers — Sammelobjekte on the client (docs/sammelobjekte.md).
//
// The server keeps the tree (parent, local, heading, acl_break, container) and
// writes every relative child's world position. This module is the display
// side of it: which objects get drawn, what a collapsed container's badge says,
// where an exploded container's children sit, and the per-player expanded
// state. Map, AR, minimap and the nearby list all go through worldObjects().
//
// Composite ids: records carry `id = "<server>:<raw>"`, but `parent` is the raw
// id as the server stores it — parentIdOf() builds the composite, rawId() the
// other way round. Hanging in only works on one server.

import { t } from './i18n.js'

const STORE = 'ajna.containers.expanded'       // { [compositeId]: true|false }, per device
const MARK = '__ajnaPlacing'                    // the object marked for „Hierin platzieren"
export const CHANGED_EVENT = 'ajna:containers-changed'
export const PLACE_SNAP_M = 50                  // farther away than this, it is put ON the container
export const CONTAINER_DEFAULTS = { badge: 'both', view: 'placed', expanded: false, load: 'always' }
/** For the first load: children of „load on expand" containers stay on the server. */
export const LAZY_FILTER = "parent = '' || parent.container.load != 'on_expand'"

const STATUS_RANK = { ok: 0, unknown: 1, warning: 2, error: 3 }
const STATUS_GLYPH = { error: '🔴', warning: '🟠', unknown: '⚪' }
const EARTH_R = 6371000

// ── records ──────────────────────────────────────────────────────────────

export function isContainer(rec) { return !!(rec && rec.container && typeof rec.container === 'object') }
export function containerConfig(rec) { return isContainer(rec) ? { ...CONTAINER_DEFAULTS, ...rec.container } : null }
export function rawId(id) { const s = String(id || ''); const i = s.indexOf(':'); return i < 0 ? s : s.slice(i + 1) }

/** The parent's composite id, or null. */
export function parentIdOf(rec) {
  if (!rec || !rec.parent) return null
  const p = String(rec.parent)
  return p.includes(':') ? p : (rec._origin ? `${rec._origin}:${p}` : p)
}

/** `state.status`, normalised: ok / warning / error / unknown, or null when absent. */
export function statusOf(rec) {
  const s = rec?.state?.status
  if (s === undefined || s === null || s === '') return null
  return STATUS_RANK[s] === undefined ? 'unknown' : s
}

export function distanceM(a, b) {
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLon = (b.lon - a.lon) * Math.PI / 180 * Math.cos(a.lat * Math.PI / 180)
  return Math.hypot(dLat, dLon) * EARTH_R
}

export function offsetLatLon(lat, lon, east, north, altitude) {
  return {
    lat: lat + (north / EARTH_R) * 180 / Math.PI,
    lon: lon + (east / (EARTH_R * Math.cos(lat * Math.PI / 180))) * 180 / Math.PI,
    altitude,
  }
}

// ── expanded state (per player, per device) ──────────────────────────────

function loadStore() { try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {} } catch { return {} } }
function saveStore(m) { try { localStorage.setItem(STORE, JSON.stringify(m)) } catch {} }
function notify() { try { window.dispatchEvent(new CustomEvent(CHANGED_EVENT)) } catch {} }

/** Player override first, then the owner's default. */
export function isExpanded(rec, store = loadStore()) {
  const cfg = containerConfig(rec)
  if (!cfg) return false
  const o = store[rec.id]
  return typeof o === 'boolean' ? o : !!cfg.expanded
}
export function setExpanded(id, on) { const m = loadStore(); m[id] = !!on; saveStore(m); notify() }
export function toggleExpanded(rec) { const on = !isExpanded(rec); setExpanded(rec.id, on); return on }
export function onChanged(cb) {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(CHANGED_EVENT, cb)
  return () => window.removeEventListener(CHANGED_EVENT, cb)
}

// ── the tree as the client sees it ───────────────────────────────────────

export class ContainerIndex {
  constructor(objects) {
    this.byId = new Map()
    this.kids = new Map()
    for (const o of objects) if (o && o.id) this.byId.set(o.id, o)
    for (const o of objects) {
      const p = parentIdOf(o)
      if (!p || !this.byId.has(p)) continue      // parent not visible to me: the child stands alone
      if (!this.kids.has(p)) this.kids.set(p, [])
      this.kids.get(p).push(o)
    }
  }
  children(id) { return this.kids.get(id) || [] }
  parent(rec) { const p = parentIdOf(rec); return p ? (this.byId.get(p) || null) : null }
  descendants(id) {
    const out = [], stack = [id]
    let guard = 0
    while (stack.length && guard++ < 10000) {
      const cur = stack.pop()
      for (const k of this.children(cur)) { out.push(k); stack.push(k.id) }
    }
    return out
  }
  /** Is `id` above `rec` in the tree? */
  isAncestor(id, rec) {
    let cur = this.parent(rec), guard = 0
    while (cur && guard++ < 16) { if (cur.id === id) return true; cur = this.parent(cur) }
    return false
  }
}

/** Count and worst status of everything below — only what the client has, so only what it may see. */
export function summarize(index, rec) {
  let count = 0, worst = null, bad = 0
  for (const x of index.descendants(rec.id)) {
    count++
    const s = statusOf(x)
    if (!s) continue
    if (s !== 'ok') bad++
    if (worst === null || STATUS_RANK[s] > STATUS_RANK[worst]) worst = s
  }
  return { count, status: worst, bad }
}

export function badgeText(rec, summary) {
  const cfg = containerConfig(rec)
  if (!cfg || cfg.badge === 'none') return ''
  if (cfg.load === 'on_expand' && !summary.count) return ''   // nothing loaded, nothing known
  const parts = []
  if (cfg.badge === 'count' || cfg.badge === 'both') parts.push(String(summary.count))
  if ((cfg.badge === 'status' || cfg.badge === 'both') && summary.status && summary.status !== 'ok') {
    parts.push(`${STATUS_GLYPH[summary.status]}${summary.bad}`)
  }
  return parts.join(' ')
}

/** Exploded view: the children in a ring around the parent, half a metre up. */
export function explodedPositions(parent, children) {
  const out = new Map()
  const n = children.length
  if (!n || !Number.isFinite(parent?.lat) || !Number.isFinite(parent?.lon)) return out
  const r = Math.min(6, Math.max(1.5, 0.45 * n))
  children.forEach((c, i) => {
    const a = (i / n) * 2 * Math.PI
    out.set(c.id, offsetLatLon(parent.lat, parent.lon, r * Math.sin(a), r * Math.cos(a), (Number(parent.altitude) || 0) + 0.5))
  })
  return out
}

/**
 * What the world shows: free objects, containers (with `_badge`, `_expanded`,
 * `_childCount`, `_childStatus` on a copy), and children whose containers are
 * all expanded. Children of an exploded container get ring positions on a
 * copy (`_exploded`); the records themselves stay untouched.
 */
export function worldObjects(objects, { store = loadStore() } = {}) {
  const index = new ContainerIndex(objects)
  const expandedCache = new Map()
  const expanded = (rec) => {
    let v = expandedCache.get(rec.id)
    if (v === undefined) { v = isExpanded(rec, store); expandedCache.set(rec.id, v) }
    return v
  }
  const hiddenCache = new Map()
  const hidden = (rec) => {
    if (hiddenCache.has(rec.id)) return hiddenCache.get(rec.id)
    hiddenCache.set(rec.id, false)              // guards a (server-prevented) cycle
    const p = index.parent(rec)
    const h = !!p && (!expanded(p) || hidden(p))
    hiddenCache.set(rec.id, h)
    return h
  }
  const out = []
  const exploded = new Map()
  for (const o of objects) {
    if (!o || hidden(o)) continue
    if (!isContainer(o)) { out.push(o); continue }
    const cfg = containerConfig(o)
    const sum = summarize(index, o)
    const badge = badgeText(o, sum)
    const copy = { ...o, _badge: badge, _expanded: expanded(o), _childCount: sum.count, _childStatus: sum.status }
    if (badge) {
      const l = typeof copy.appearance?.label === 'string' ? copy.appearance.label : ''
      copy.appearance = { ...(copy.appearance || {}), label: !l ? '{name} {badge}' : (/\{badge\}/.test(l) ? l : `${l} {badge}`) }
    }
    out.push(copy)
    if (cfg.view === 'exploded' && expanded(o)) {
      for (const [id, pos] of explodedPositions(o, index.children(o.id))) exploded.set(id, pos)
    }
  }
  return exploded.size ? out.map(o => exploded.has(o.id) ? { ...o, ...exploded.get(o.id), _exploded: true } : o) : out
}

// ── placing ──────────────────────────────────────────────────────────────

/** null when `child` may go into `container`, otherwise the reason (German, for the player). */
export function placeCheck(child, container, index = null) {
  if (!child || !container) return t('Nichts vorgemerkt')
  if (child.id === container.id) return t('Ein Objekt kann sich nicht selbst enthalten')
  if (!isContainer(container)) return t('Kein Sammelobjekt')
  if ((child._origin || '') !== (container._origin || '')) return t('Beide Objekte müssen auf demselben Server liegen')
  if (child.carried_by || container.carried_by) return t('Getragene Objekte lassen sich nicht einhängen')
  if (parentIdOf(child) === container.id) return t('Steckt schon darin')
  if (index && index.isAncestor(child.id, container)) return t('Das wäre ein Kreis')
  return null
}

/**
 * „Hierin platzieren": the object keeps its place (the server turns the
 * world position into an offset) — unless it is farther than PLACE_SNAP_M
 * away; then it is put on the container and the player is told.
 */
export async function placeInto(ajna, child, container, { notify: say = null } = {}) {
  const far = Number.isFinite(child.lat) && Number.isFinite(container.lat) && distanceM(child, container) > PLACE_SNAP_M
  const local = far ? { east: 0, north: 0, up: 0, heading: 0 } : { from: 'world' }
  const res = await ajna.updateObject(child.id, { parent: rawId(container.id), local })
  if (far) say?.(t('„{name}" war weiter als {m} m entfernt und steht jetzt am Sammelobjekt.', { name: child.name || child.id, m: PLACE_SNAP_M }))
  if (placingId() === child.id) markForPlacing(null)
  return res
}

/** „Herausnehmen": one level up (the server does that), world position kept. */
export function takeOut(ajna, child) { return ajna.updateObject(child.id, { parent: '' }) }

/**
 * Delete, and if the object contains others, ask what happens to them —
 * first from what the client knows, then again if the server says 409
 * has_children (children it never loaded).
 */
export async function deleteAsked(ajna, rec, index = null) {
  const name = rec.name || rec.id
  const ask = (n) => window.confirm(t('„{name}" enthält {n} Objekte. Inhalt mitlöschen?\n\nOK — alles löschen\nAbbrechen — nur das Sammelobjekt, der Inhalt rückt eine Ebene hoch', { name, n }))
  const n = index ? index.descendants(rec.id).length : 0
  let children = n ? (ask(n) ? 'delete' : 'detach') : null
  try {
    return await ajna.deleteObject(rec.id, children ? { children } : {})
  } catch (err) {
    if (err?.response?.code !== 'has_children' || children) throw err
    children = ask(err.response.children ?? '?') ? 'delete' : 'detach'
    return ajna.deleteObject(rec.id, { children })
  }
}

export function markForPlacing(rec) { globalThis[MARK] = rec ? rec.id : null; notify() }
export function placingId() { return globalThis[MARK] || null }
export function placingCandidate(ajna) {
  const id = placingId()
  if (!id) return null
  const r = ajna.getObjectById?.(id) || null
  if (!r) globalThis[MARK] = null
  return r
}
