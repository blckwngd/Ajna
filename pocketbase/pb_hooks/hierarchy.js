/// <reference path="../pb_data/types.d.ts" />
// hierarchy — Sammelobjekte: ein Objekt enthält andere (docs/sammelobjekte.md).
//
// Loaded via require() from main.pb.js (hook callbacks share no module scope).
//
// Fields on `objects` (migration 1793100000):
//   parent     → objects   the container this object sits in
//   local      json        { east, north, up, heading } — offset in metres and
//                          degrees relative to the parent; null = own position
//   heading    number      orientation around the vertical axis, degrees
//                          clockwise from north
//   acl_break  bool        true = does not inherit the parent's ACEs
//   container  json        present = may contain others: { badge, view, expanded, load }
//
// The tree is strict (one parent), at most MAX_DEPTH levels, no cycles. A
// relative child's world position is written by the server from the parent's
// position plus `local`, so everything that reads lat/lon keeps working.
//
// The first half is pure (plain values in, plain values out) and runs in Node
// tests; the second half touches $app.

const MAX_DEPTH = 8          // building → floor → room → rack → server → VM → service → sensor
const MAX_TREE_NODES = 2000  // per /api/objects/tree call
const EARTH_R = 6371000

const CONTAINER_DEFAULTS = { badge: "both", view: "placed", expanded: false, load: "always" }
const CONTAINER_ENUMS = {
  badge: ["count", "status", "both", "none"],
  view: ["placed", "exploded"],
  load: ["always", "on_expand"],
}
const STATUS_RANK = { ok: 0, unknown: 1, warning: 2, error: 3 }

// ── pure ─────────────────────────────────────────────────────────────────

const toRad = d => d * Math.PI / 180
const norm360 = d => ((d % 360) + 360) % 360
const num = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def }

/**
 * Validate a `local` value. Returns {east,north,up,heading}, or null for "own
 * position", or { from: "world" } when the caller asks the server to derive
 * the offset from the object's current world position. Throws on bad shape.
 */
function parseLocal(value) {
  if (value === null || value === undefined || value === "") return null
  const o = typeof value === "object" ? value : JSON.parse(String(value))
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("local must be an object")
  if (o.from === "world") return { from: "world" }
  const out = {}
  for (const k of ["east", "north", "up", "heading"]) {
    const v = o[k]
    if (v === undefined || v === null) { out[k] = 0; continue }
    const n = Number(v)
    if (!Number.isFinite(n)) throw new Error(`local.${k} must be a number`)
    out[k] = n
  }
  return out
}

/** Normalise a container config; null = not a container. Throws on bad values. */
function parseContainer(value) {
  if (value === null || value === undefined || value === "") return null
  const o = typeof value === "object" ? value : JSON.parse(String(value))
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("container must be an object")
  const out = Object.assign({}, CONTAINER_DEFAULTS)
  for (const k of Object.keys(CONTAINER_ENUMS)) {
    if (o[k] === undefined || o[k] === null) continue
    if (CONTAINER_ENUMS[k].indexOf(o[k]) === -1) throw new Error(`container.${k} must be one of ${CONTAINER_ENUMS[k].join("/")}`)
    out[k] = o[k]
  }
  if (o.expanded !== undefined && o.expanded !== null) out.expanded = !!o.expanded
  return out
}

/**
 * World position of a relative child. `local.east/north` are in the parent's
 * frame: north is where the parent faces (its heading), east is to its right.
 */
function localToWorld(parent, local) {
  const h = toRad(num(parent.heading))
  const east = local.east * Math.cos(h) + local.north * Math.sin(h)
  const north = -local.east * Math.sin(h) + local.north * Math.cos(h)
  const lat0 = num(parent.lat), lon0 = num(parent.lon)
  return {
    lat: lat0 + (north / EARTH_R) * 180 / Math.PI,
    lon: lon0 + (east / (EARTH_R * Math.cos(toRad(lat0)))) * 180 / Math.PI,
    altitude: num(parent.altitude) + local.up,
    heading: norm360(num(parent.heading) + local.heading),
  }
}

/** The inverse: which `local` puts the child where it is now. */
function worldToLocal(parent, child) {
  const north = toRad(num(child.lat) - num(parent.lat)) * EARTH_R
  const east = toRad(num(child.lon) - num(parent.lon)) * EARTH_R * Math.cos(toRad(num(parent.lat)))
  const h = toRad(num(parent.heading))
  return {
    east: east * Math.cos(h) - north * Math.sin(h),
    north: east * Math.sin(h) + north * Math.cos(h),
    up: num(child.altitude) - num(parent.altitude),
    heading: norm360(num(child.heading) - num(parent.heading)),
  }
}

/** Two world positions equal for our purposes (1e-9° ≈ 0.1 mm, 1 mm, 1e-6°). */
function samePosition(a, b) {
  return Math.abs(num(a.lat) - num(b.lat)) < 1e-9
    && Math.abs(num(a.lon) - num(b.lon)) < 1e-9
    && Math.abs(num(a.altitude) - num(b.altitude)) < 1e-3
    && Math.abs(norm360(num(a.heading)) - norm360(num(b.heading))) < 1e-6
}

/**
 * May a node with `height` levels below it be hung under a parent that has
 * `ancestorCount` objects above it (the parent included)?
 * Levels: parent sits at ancestorCount, the node at ancestorCount + 1, its
 * deepest descendant at ancestorCount + 1 + height — all ≤ MAX_DEPTH.
 */
function depthAllowed(ancestorCount, height) {
  return ancestorCount + 1 + height <= MAX_DEPTH
}

/** The worst of several status words; unknown words count as `unknown`. */
function worstStatus(list) {
  let worst = null
  for (const s of list) {
    const w = STATUS_RANK[s] === undefined ? "unknown" : s
    if (worst === null || STATUS_RANK[w] > STATUS_RANK[worst]) worst = w
  }
  return worst
}

// ── $app ─────────────────────────────────────────────────────────────────

function jsonObject(v, def) { return require(`${__hooks}/utf8.js`).jsonObject(v, def) }

function readLocal(rec) { return parseLocal(jsonObject(rec.get("local"), null)) }
function readContainer(rec) { return parseContainer(jsonObject(rec.get("container"), null)) }
function isContainer(rec) { try { return readContainer(rec) !== null } catch (err) { return false } }

function worldOf(rec) {
  return { lat: rec.get("lat"), lon: rec.get("lon"), altitude: rec.get("altitude"), heading: rec.get("heading") }
}
function setWorld(rec, w) {
  rec.set("lat", w.lat); rec.set("lon", w.lon); rec.set("altitude", w.altitude); rec.set("heading", w.heading)
}

function findObject(id) { try { return $app.findRecordById("objects", id) } catch (err) { return null } }

function childrenOf(id) {
  return $app.findRecordsByFilter("objects", "parent = {:p}", "", 1000, 0, { p: id })
}

/** IDs from `parentId` upward, the parent included. Stops at a cycle or MAX_DEPTH + 1. */
function ancestorIds(parentId) {
  const ids = []
  let cur = parentId
  while (cur && ids.length <= MAX_DEPTH) {
    if (ids.indexOf(cur) !== -1) break
    ids.push(cur)
    const r = findObject(cur)
    if (!r) break
    cur = r.get("parent") || ""
  }
  return ids
}

/** Levels below `id` (0 = leaf). Stops counting at `limit`. */
function subtreeHeight(id, limit) {
  let frontier = [id], h = 0
  while (frontier.length && h <= limit) {
    const next = []
    for (const pid of frontier) for (const k of childrenOf(pid)) next.push(k.id)
    if (!next.length) return h
    frontier = next
    h++
  }
  return h
}

/** All descendants, breadth-first (parents before children). */
function descendants(id) {
  const out = []
  let frontier = [id], guard = 0
  while (frontier.length && guard++ <= MAX_DEPTH) {
    const next = []
    for (const pid of frontier) for (const k of childrenOf(pid)) { out.push(k); next.push(k.id) }
    frontier = next
  }
  return out
}

function isSuperuser(user) { return !!(user && user.collection && user.collection().name === "_superusers") }

function hasRight(user, rec, right) {
  if (!user) return false
  if (isSuperuser(user)) return true
  if (String(rec.get("owner")) === String(user.id)) return true
  const { resolveEffective } = require(`${__hooks}/permissions.js`)
  const r = resolveEffective(user, rec).rights || []
  return r.indexOf(right) !== -1 || r.indexOf("owner") !== -1
}

/**
 * Validate and complete a record before it is saved: parent, depth, cycle,
 * container config, `local`, and the world position of a relative child.
 *
 * @param {Record} rec           the record with the new data applied
 * @param {object} o
 * @param {Record|null} o.old    stored state (null for a new record)
 * @param {object} o.body        the request body (which fields were sent)
 * @param {Record|null} o.user   who asks (null = trusted internal caller)
 * @returns {null|{status:number,error:string,code:string}}
 */
function validateHierarchy(rec, { old = null, body = {}, user = null } = {}) {
  const fail = (status, error, code) => ({ status, error, code })

  let container
  try { container = readContainer(rec) } catch (err) { return fail(400, err.message, "bad_container") }
  if (container !== null) rec.set("container", container)
  // A container with contents stays a container — otherwise its children
  // would be stuck under something that may not hold them.
  if (container === null && old && isContainer(old) && childrenOf(rec.id).length) {
    return fail(409, "the object still contains others", "has_children")
  }

  let local
  try { local = readLocal(rec) } catch (err) { return fail(400, err.message, "bad_local") }

  const parentId = rec.get("parent") || ""
  const oldParent = old ? (old.get("parent") || "") : ""

  if (!parentId) {
    if (local) rec.set("local", null)   // an offset without a parent means nothing
    if (oldParent && user && old) {
      // taking it out: edit on the object (the rule) and on the old container
      const op = findObject(oldParent)
      if (op && !hasRight(user, op, "edit")) return fail(403, "no edit right on the current container", "parent_forbidden")
    }
    return null
  }

  if (parentId === rec.id) return fail(400, "an object cannot contain itself", "cycle")
  const parent = findObject(parentId)
  if (!parent) {
    // A container deleted past the hooks (expiry cron, superuser) leaves its
    // children pointing at nothing. They heal into free objects on their next
    // write instead of being stuck; only a NEW parent must exist.
    if (parentId === oldParent) { rec.set("parent", ""); rec.set("local", null); return null }
    return fail(400, "parent not found", "parent_not_found")
  }
  if (!isContainer(parent)) return fail(400, "parent is not a container", "not_a_container")
  if (parent.get("carried_by")) return fail(400, "parent is carried, not in the world", "parent_carried")

  const chain = ancestorIds(parentId)
  if (chain.indexOf(rec.id) !== -1) return fail(400, "that would make a cycle", "cycle")
  const height = old ? subtreeHeight(rec.id, MAX_DEPTH) : 0
  if (!depthAllowed(chain.length, height)) return fail(400, `at most ${MAX_DEPTH} levels`, "too_deep")

  if (parentId !== oldParent && user) {
    if (!hasRight(user, parent, "edit")) return fail(403, "no edit right on the container", "parent_forbidden")
    if (oldParent) {
      const op = findObject(oldParent)
      if (op && !hasRight(user, op, "edit")) return fail(403, "no edit right on the current container", "parent_forbidden")
    }
  }

  // Position. `local` in the request wins; a world position in the request
  // (the gizmo, a drag on the map) re-derives `local`; a new child with
  // neither sits on the parent.
  const sentLocal = Object.prototype.hasOwnProperty.call(body, "local")
  const sentWorld = ["lat", "lon", "altitude", "heading"].some(k => Object.prototype.hasOwnProperty.call(body, k))
  const pw = worldOf(parent)
  if (local && local.from === "world") local = worldToLocal(pw, worldOf(rec))
  else if (local && !sentLocal && sentWorld) local = worldToLocal(pw, worldOf(rec))
  else if (!local && !old && !sentWorld) local = { east: 0, north: 0, up: 0, heading: 0 }
  else if (!local && !old && parentId !== oldParent && !sentLocal && sentWorld) local = null   // own position, as sent

  if (local) {
    rec.set("local", local)
    setWorld(rec, localToWorld(pw, local))
  }
  return null
}

/** After a container moved or turned: re-derive every relative child (saves cascade). */
function propagatePosition(rec) {
  const kids = childrenOf(rec.id)
  if (!kids.length) return 0
  const pw = worldOf(rec)
  let n = 0
  for (const k of kids) {
    let local
    try { local = readLocal(k) } catch (err) { continue }
    if (!local || local.from) continue
    const w = localToWorld(pw, local)
    if (samePosition(worldOf(k), w)) continue
    setWorld(k, w)
    try { $app.save(k); n++ } catch (err) { console.log(`[hierarchy] child ${k.id} not moved: ${err && err.message}`) }
  }
  return n
}

module.exports = {
  MAX_DEPTH, MAX_TREE_NODES, CONTAINER_DEFAULTS, STATUS_RANK,
  parseLocal, parseContainer, localToWorld, worldToLocal, samePosition, depthAllowed, worstStatus,
  readLocal, readContainer, isContainer, worldOf, setWorld, findObject, childrenOf,
  ancestorIds, subtreeHeight, descendants, hasRight, isSuperuser,
  validateHierarchy, propagatePosition,
}
