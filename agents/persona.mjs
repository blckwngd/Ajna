#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
//  Persona — one figure, one account, one process
// ─────────────────────────────────────────────────────────────────────────
//
//   node agents/persona.mjs --persona wanderer --setup   first time: create the account
//   node agents/persona.mjs --persona wanderer           afterwards
//
// WHAT THIS IS. A designed figure (personas/<name>.persona.json) that is
// owned by an account of its own — not by the world-director. That is the
// whole difference, and it is the point: the director writes to objects it
// owns and passes every rule check on the owner path. A persona reaches the
// world the way a player does and hits the walls a player hits. A broken
// `objects.updateRule` stayed invisible to the director for six months; a
// persona would have met it on day one.
//
// WHAT THIS STEP DOES, AND DOES NOT. This is the character WITHOUT a
// language model: account, figure, manifest, menu actions, Parley dialogue,
// walking, presence. It proves that the player-shaped form carries — before
// a single token is spent. The modes `passive`/`active`/`debug` are
// configured and announced, but behave like `basic` until the model is wired
// in (the action register in lib/actions.mjs is the seam for that).
//
// ONE PROCESS PER PERSONA. `bootAgent` logs in exactly one account, and a
// crashing model loop must not take the other characters with it. Price:
// Node's base load (~49 MB) plus heap, per figure.
//
// Player-facing text (what the figure says, menu labels) is German — it is
// content. Everything else here is English.

import readline from 'node:readline/promises'
import { bootAgent, die, mitDelegierten } from './lib/agent-base.mjs'
import { loadAgentEnv } from './lib/env.mjs'
import { maybeReexecWithSystemCa } from './lib/system-ca.mjs'
import {
  loadPersona, toObject, objectDiff, interestBox, manifestFor, sourceFor, GRANTED_ACTIONS, MODES,
} from './lib/persona-def.mjs'
import { runSetup, emailFor } from './lib/persona-setup.mjs'
import { Konfig } from './lib/konfig.mjs'
import { AjnaGeo } from '../client/core/AjnaGeo.js'
import {
  stepAlongPath, buildWayGraph, nearestNodeKey, randomReachableTarget, shortestPath, haversine,
} from '../client/core/StreetNav.js'
import { Bewegungsplan, bewegungsUpdate } from './lib/bewegung.mjs'
import { yawFuerKurs } from '../client/core/yaw.js'
import { npcParley } from './lib/dialogs.mjs'
import { dialogNameFor, dialogVarsFor, talkSessionId } from '../client/core/Parley.js'

// ─── Arguments ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const argAfter = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null }
const NAME = argAfter('--persona') || process.env.PERSONA_NAME || ''
const WANT_SETUP = argv.includes('--setup')
const YES = argv.includes('--yes')
const RESET_PW = argv.includes('--reset-password')

if (!NAME) {
  console.error('Usage: node agents/persona.mjs --persona <name> [--setup [--yes] [--reset-password]]')
  console.error('       <name> is personas/<name>.persona.json and becomes the account handle.')
  process.exit(2)
}
const AGENT = `persona-${NAME}`
const TAG = `persona:${NAME}`

// Layered env first (persona file, then root .env — the root holds the
// superuser credentials the setup needs). bootAgent loads the same layers
// again later; that is idempotent, nothing is overwritten.
loadAgentEnv(AGENT)
const URL = process.env.AJNA_URL || 'http://127.0.0.1:8090'
// The setup below talks HTTPS to the instance; it needs the system CA just
// as much as the agent proper. Re-exec now, once — bootAgent's own call is
// then a no-op.
maybeReexecWithSystemCa(URL)

const loaded = loadPersona(NAME)
if (loaded.error) die(loaded.error)
const persona = loaded.persona

// ─── Setup: an account of its own ────────────────────────────────────────
//
// Runs with --setup, or when there is no persona login yet. The second case
// is not silent: creating accounts is a superuser act, so without a terminal
// it needs --yes. After a successful setup the process simply continues —
// "set it up, then run" is the normal first start.
const hasOwnLogin = process.env.AJNA_USER === emailFor(NAME) && !!process.env.AJNA_PASS
if (WANT_SETUP || !hasOwnLogin) {
  if (!WANT_SETUP) {
    console.log(`[${TAG}] no login for this persona yet (${emailFor(NAME)}) — running setup`)
  }
  let go = YES
  if (!go) {
    if (!process.stdin.isTTY) die('setup without a terminal needs --yes')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const a = await rl.question(
      `Create account ${emailFor(NAME)} as superuser ${process.env.AJNA_SU || '?'} at ${URL}, sealed, `
      + `and write agents/.env.${AGENT}? [y/N] `)
    rl.close()
    go = /^(y|j|yes|ja)$/i.test(a.trim())
  }
  if (!go) die('setup cancelled')
  try {
    const r = await runSetup(persona, {
      url: URL, su: process.env.AJNA_SU, suPass: process.env.AJNA_SU_PASS, resetPassword: RESET_PW,
    })
    console.log(`[${TAG}] account ${r.created ? 'created' : 'found'}: ${r.email} (${r.id})`
      + `${r.sealed ? ' · sealed' : ' · NOT sealed'}${r.password ? ' · new password' : ''}`)
    console.log(`[${TAG}] login written to ${r.envPath}`)
  } catch (err) {
    die(`setup failed: ${err?.message || err}`)
  }
  // Do not carry the setup flags into bootAgent's re-exec.
  process.argv = process.argv.filter(a => !['--setup', '--yes', '--reset-password'].includes(a))
}

// ─── Boot ────────────────────────────────────────────────────────────────
const { ajna, log, warn } = await bootAgent(AGENT, {
  tag: TAG,
  handle: NAME,
  connect: true,
  memoryExtra: () => ({ fsm: c?.fsm || '-', path: c?.path ? c.path.length : 0, talks: parley.openCount }),
})

// Never run the character on the shared agent account. The root .env has
// AJNA_USER for the other agents; if the persona env is missing we would
// silently log in as that account and create a figure it owns.
const me = ajna.currentUser()
if (!me || me.email !== emailFor(NAME)) {
  die(`logged in as ${me?.email || '?'} — expected ${emailFor(NAME)}. Run with --setup.`)
}
if (me.agent_seal !== true) warn('account is not sealed — the client will show it as unconfirmed. Re-run --setup.')

// ─── Settings: the persona's own, in agent_settings ───────────────────────
//
// Per persona by construction: each persona is its own account, and
// agent_settings are readable by their owner only. That is where the mode
// and (later) the model settings belong — never in objects.state, which
// anyone who sees the figure may read.
const konf = await Konfig.eigene(ajna, { praefix: 'persona', log: (m) => log(`settings: ${m}`) })
const R = {
  mode:           ['PERSONA_MODE',           persona.mode,                      `basic | passive | active | debug (file: ${persona.mode})`],
  publish_area:   ['PERSONA_PUBLISH_AREA',   persona.mode === 'debug' ? 'on' : 'off', 'publish an interest area so the director populates the surroundings'],
  roam_radius_m:  ['PERSONA_ROAM_RADIUS_M',  150,  'how far from home the figure may roam, in metres'],
  speed:          ['PERSONA_SPEED',          1.3,  'walking speed in m/s'],
  tick_ms:        ['PERSONA_TICK_MS',        500,  'movement loop interval in milliseconds'],
  pause_s:        ['PERSONA_PAUSE_S',        12,   'pause between two walks, in seconds'],
  talk_halt_s:    ['PERSONA_TALK_HALT_S',    45,   'how long the figure stands still after being addressed, in seconds'],
  heartbeat_s:    ['PERSONA_HEARTBEAT_S',    60,   'manifest heartbeat, in seconds'],
  area_refresh_s: ['PERSONA_AREA_REFRESH_S', 120,  'how often the interest area is renewed (server TTL is 180 s)'],
  // THE AREA TO INVESTIGATE: home plus roam radius. Set here (or by a
  // summon) and the figure moves — no database edit, no drag on the map;
  // the agent is the only writer of its position and would undo both.
  // ONE key, not two: lat and lon written separately would be seen by the
  // settings subscription as two changes with a half-updated point between
  // them — and the figure jumped there. A JSON value changes atomically.
  home:           ['PERSONA_HOME',           `{"lat":${persona.figure.lat},"lon":${persona.figure.lon}}`, 'JSON {"lat":…,"lon":…} — overrides the file; a summon writes it'],
  call_walk_m:    ['PERSONA_CALL_WALK_M',    400,  'summoned within this distance the figure walks; beyond it, it jumps (0 = always jump)'],
  call_allow:     ['PERSONA_CALL_ALLOW',     '*',  'who may summon ("Rufen"): * = every logged-in player, or comma-separated account ids'],
}
await konf.saee(Object.entries(R).map(([name, [envName, vorgabe, note]]) => ({ name, envName, vorgabe, note })))
const num = (k) => konf.zahl(k, R[k][0], R[k][1])
const mode = () => {
  const m = konf.text('mode', R.mode[0], R.mode[1]).toLowerCase()
  return MODES.includes(m) ? m : 'basic'
}
const publishArea = () => konf.jaNein('publish_area', R.publish_area[0], R.publish_area[1] === 'on')
// Home: the setting wins over the file, and a summon writes the setting —
// so the area the figure investigates survives a restart.
const parseHome = (v) => {
  if (!v) return null
  let o = v
  if (typeof v === 'string') {
    const s = v.trim()
    try { o = JSON.parse(s) }
    catch { const m = s.split(/[,;\s]+/); o = { lat: Number(m[0]), lon: Number(m[1]) } }
  }
  const lat = Number(o?.lat), lon = Number(o?.lon)
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null
}
const effectiveHome = () =>
  parseHome(konf.objekt('home', null))            // the setting (a summon writes it)
  || parseHome(process.env.PERSONA_HOME)          // or the env
  || { lat: persona.figure.lat, lon: persona.figure.lon }   // or the file
{
  const h = effectiveHome()
  if (h.lat !== persona.figure.lat || h.lon !== persona.figure.lon) {
    log(`home from settings: ${h.lat.toFixed(5)}, ${h.lon.toFixed(5)} (file: ${persona.figure.lat}, ${persona.figure.lon})`)
    persona.figure.lat = h.lat
    persona.figure.lon = h.lon
  }
}

// ─── The figure ──────────────────────────────────────────────────────────
const MODEL_BASE = '/models/'
const SOURCE = sourceFor(NAME)

let figure = ajna.getObjects().find(o =>
  o?.state?.figure_id === NAME && o?.state?.source === SOURCE)

if (figure && figure.owner && figure.owner !== me.id) {
  die(`a figure "${NAME}" with source ${SOURCE} exists but belongs to ${figure.owner}, not to this account — not touching it`)
}
if (!figure) {
  figure = await ajna.createObject(toObject(persona, MODEL_BASE))
  log(`figure created: ${figure.id} („${figure.name}")`)
} else {
  const patch = objectDiff(persona, figure, MODEL_BASE)
  if (patch) {
    figure = await ajna.updateObject(figure.id, patch)
    log(`figure updated: ${Object.keys(patch).join(', ')}`)
  } else {
    log(`figure found: ${figure.id} („${figure.name}")`)
  }
}

// Every logged-in player may see and address the figure. `view` only — the
// figure is not editable by others, and the persona grants nothing it does
// not need to.
async function ensureAce() {
  const existing = await ajna.listPermissions(figure.id)
  const ace = existing.find(a => a.subject_type === 'authenticated' && !a.subject)
  const want = GRANTED_ACTIONS
  if (ace) {
    const same = JSON.stringify(ace.interact_actions || []) === JSON.stringify(want)
      && (ace.rights || []).includes('view')
    if (!same) await ajna.updatePermission(ace.id, { rights: ['view'], interact_actions: want })
  } else {
    await ajna.addPermission(figure.id, { subject_type: 'authenticated', rights: ['view'], interact_actions: want })
  }
}
try { await ensureAce() } catch (err) { warn(`ACE: ${err?.response?.data ? JSON.stringify(err.response.data) : err?.message || err}`) }

// ─── Manifest ────────────────────────────────────────────────────────────
async function publishManifest() {
  try { await ajna.upsertAgentManifest(mitDelegierten(manifestFor(persona))) }
  catch (err) { warn(`manifest: ${err?.message || err}`) }
}
await publishManifest()
log(`manifest published: ${SOURCE}`)

// ─── Re-timeable intervals (settings may change the pace at runtime) ─────
const TICKS = []
function every(fn, msFn) {
  let ms = msFn()
  let h = setInterval(fn, ms)
  TICKS.push({ retime() { const n = msFn(); if (!Number.isFinite(n) || n <= 0 || n === ms) return; clearInterval(h); ms = n; h = setInterval(fn, ms) } })
}
every(publishManifest, () => num('heartbeat_s') * 1000)

// ─── Walking ─────────────────────────────────────────────────────────────
//
// A compact walker, same mechanics as the director's (StreetNav route on
// the way graph, Bewegungsplan so viewers extrapolate, straight-line
// fallback when the geo service is down) — but on a leash: targets stay
// within `roam_radius_m` of the figure's home, and a figure declared
// `movement: still` never moves at all.
const geo = new AjnaGeo(ajna)
let home = { ...effectiveHome() }
const c = {
  id: figure.id,
  lat: figure.lat, lon: figure.lon,
  baseState: withoutRun(figure.state),
  fsm: 'idle', path: null, cursor: { segIdx: 0, segT: 0 },
  nextPlanAt: Date.now() + 5000,
  lastTickAt: Date.now(),
  busy: false,
  anim: figure.animation_state || 'idle', animOpen: false,
  attendUntil: 0,
  plan: new Bewegungsplan({ kursSchwelleGrad: 8, driftM: 4 }),
}
function withoutRun(state) { const { walk_path, motion, ...rest } = state || {}; return rest }
const stills = persona.figure.movement === 'still'

let graph = null, graphAt = 0, geoWarned = 0
async function wayGraph() {
  if (graph && Date.now() - graphAt < 30 * 60_000) return graph
  try {
    const res = await withTimeout(geo.waysNear(home.lat, home.lon, Math.min(2000, num('roam_radius_m') + 300), 'walkable'), 10_000, 'way graph')
    const g = buildWayGraph(res?.features || [])
    if (g.nodes.size >= 2) { graph = g; graphAt = Date.now(); log(`way graph: ${g.nodes.size} nodes`) }
  } catch (err) {
    if (Date.now() - geoWarned > 5 * 60_000) { geoWarned = Date.now(); warn(`geo unavailable (${err?.message || err}) — walking straight lines`) }
  }
  return graph
}
function withTimeout(p, ms, what) {
  let t
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: ${ms} ms exceeded`)), ms) }),
  ])
}
function setAnim(v) { if (c.anim !== v) { c.anim = v; c.animOpen = true } }
const headingDeg = (rad) => ((rad * 180 / Math.PI) % 360 + 360) % 360

// A short straight-ish walk when there is no way graph — kept short so a
// blind figure does not march through town.
function fallbackPath() {
  const pts = [[c.lat, c.lon]]
  let lat = c.lat, lon = c.lon, course = Math.random() * Math.PI * 2
  const total = 20 + Math.random() * 40
  for (let i = 0; i < 3; i++) {
    course += (Math.random() - 0.5) * 0.8
    const d = total / 3
    const nLat = lat + (d * Math.cos(course)) / 111320
    const nLon = lon + (d * Math.sin(course)) / (111320 * Math.cos(lat * Math.PI / 180))
    if (haversine(home.lat, home.lon, nLat, nLon) > num('roam_radius_m')) break
    lat = nLat; lon = nLon
    pts.push([lat, lon])
  }
  return pts.length >= 2 ? pts : null
}

/** Route to a point (for the action register later) or to a random target. */
async function planWalk(target = null) {
  c.busy = true; c.fsm = 'planning'
  try {
    const g = await wayGraph()
    let path = null
    if (g) {
      const startKey = nearestNodeKey(g, c.lat, c.lon)
      let targetKey = null
      if (target) {
        targetKey = nearestNodeKey(g, target.lat, target.lon)
      } else {
        // Pick within the leash; a few tries, then give up on the graph.
        for (let i = 0; i < 6 && startKey; i++) {
          const k = randomReachableTarget(g, startKey, { minDistM: 30, maxDistM: num('roam_radius_m') })
          if (!k) break
          const n = g.nodes.get(k)
          if (n && haversine(home.lat, home.lon, n.lat, n.lon) <= num('roam_radius_m')) { targetKey = k; break }
        }
      }
      if (startKey && targetKey) path = shortestPath(g, startKey, targetKey)
    }
    if ((!path || path.length < 2) && !target) path = fallbackPath()
    if ((!path || path.length < 2) && target) path = [[c.lat, c.lon], [target.lat, target.lon]]
    if (!path || path.length < 2) { c.fsm = 'idle'; c.nextPlanAt = Date.now() + 15_000; return false }

    c.path = path; c.cursor = { segIdx: 0, segT: 0 }; c.lastTickAt = Date.now(); c.fsm = 'walking'
    setAnim('walk')
    await ajna.updateObject(c.id, { state: { ...c.baseState, walk_path: path } })
    let len = 0
    for (let i = 1; i < path.length; i++) len += haversine(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1])
    log(`▶ walking ${len.toFixed(0)} m (${path.length} pts)`)
    return true
  } catch (err) {
    warn(`plan: ${err?.message || err}`); c.fsm = 'idle'; c.nextPlanAt = Date.now() + 15_000; return false
  } finally { c.busy = false }
}

async function writeMotion({ lat, lon, v, trk, rotation, state }) {
  const u = bewegungsUpdate(c.plan, { lat, lon, altitude: 0, v, trk, vrate: 0 }, state || c.baseState)
  if (!u && !c.animOpen) return false
  const patch = u ? { lat: u.lat, lon: u.lon, altitude: u.altitude, rotation } : { lat, lon, altitude: 0, rotation }
  if (u) patch.state = u.state
  if (c.animOpen) { patch.animation_state = c.anim; c.animOpen = false }
  await ajna.updateObject(c.id, patch)
  return true
}

async function stopHere({ holdMs = 0 } = {}) {
  for (let i = 0; c.busy && i < 30; i++) await new Promise(r => setTimeout(r, 50))
  c.busy = true
  try {
    c.path = null; c.fsm = 'idle'
    c.attendUntil = Math.max(c.attendUntil, Date.now() + holdMs)
    c.nextPlanAt = Math.max(c.nextPlanAt, Date.now() + holdMs)
    setAnim('idle')
    const halt = c.plan.haltAn({ lat: c.lat, lon: c.lon, altitude: 0, trk: 0 })
    const patch = { state: { ...c.baseState, motion: halt } }
    if (c.animOpen) { patch.animation_state = c.anim; c.animOpen = false }
    await ajna.updateObject(c.id, patch)
  } finally { c.busy = false }
}

// ─── Moving house ────────────────────────────────────────────────────────
//
// Two ways to give the figure a new area to investigate, both ending here:
// the operator sets `persona.home.*` in agent_settings, or a player summons
// the figure ("Rufen"). A summon that is close enough is walked — the figure
// moves like a player; beyond `call_walk_m` it jumps, because sending a
// tester across town is an operator's decision, not gameplay.

/** Put the figure at `to` now, make it home, and tell the world. */
async function relocate(to, reason) {
  // Already home there (the figure may be walking towards it): nothing to do.
  if (haversine(home.lat, home.lon, to.lat, to.lon) < 1) return
  for (let i = 0; c.busy && i < 30; i++) await new Promise(r => setTimeout(r, 50))
  c.busy = true
  try {
    home = { lat: to.lat, lon: to.lon }
    c.lat = to.lat; c.lon = to.lon
    c.path = null; c.fsm = 'idle'; c.summonTarget = null
    c.nextPlanAt = Date.now() + 8000
    graph = null                     // the way graph belongs to the old place
    setAnim('idle')
    c.plan.zuruecksetzen()
    const halt = c.plan.haltAn({ lat: c.lat, lon: c.lon, altitude: 0, trk: 0 })
    const patch = { lat: c.lat, lon: c.lon, altitude: 0, state: { ...c.baseState, motion: halt } }
    if (c.animOpen) { patch.animation_state = c.anim; c.animOpen = false }
    await ajna.updateObject(c.id, patch)
    log(`🚩 relocated to ${to.lat.toFixed(5)}, ${to.lon.toFixed(5)} (${reason})`)
  } finally { c.busy = false }
  await refreshArea()
}

/** Make the current home durable — it is the operator's regler, so write it there. */
async function persistHome() {
  const me = ajna.currentUser()
  try {
    const rec = await ajna.pb.collection('agent_settings')
      .getFirstListItem(`owner = "${me.id}" && key = "persona.home"`, { requestKey: null })
    await ajna.pb.collection('agent_settings').update(rec.id, { value: { lat: home.lat, lon: home.lon } }, { requestKey: null })
  } catch (err) {
    warn(`could not persist persona.home: ${err?.message || err}`)
  }
}

/** A player called the figure. */
async function summon(evt) {
  const who = evt?.source || ''
  const allow = konf.text('call_allow', R.call_allow[0], R.call_allow[1]).trim()
  const allowed = allow === '*' || allow.split(',').map(s => s.trim()).filter(Boolean).includes(who)
  if (!allowed) {
    log(`📣 call by ${who} refused (call_allow)`)
    if (who) await ajna.sendChat(who, { text: 'Ich komme nicht auf Zuruf — frag die, die mich hier hingestellt haben.', object: figure.id }).catch(() => {})
    return
  }
  const at = evt?.payload?.at
  const lat = Number(at?.lat), lon = Number(at?.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    log(`📣 call by ${who} without a position — ignored`)
    return
  }
  const d = haversine(c.lat, c.lon, lat, lon)
  const walkM = num('call_walk_m')
  log(`📣 called by ${who}: ${Math.round(d)} m away, ${at?.precise ? 'exact' : 'approximate'} position`)
  if (walkM > 0 && d <= walkM) {
    // Walk there; the arrival makes it home (see advance()).
    c.attendUntil = 0
    c.summonTarget = { lat, lon }
    const ok = await planWalk({ lat, lon })
    if (!ok) await relocate({ lat, lon }, `summon by ${who}, no path — jumped`)
    else { home = { lat, lon }; await refreshArea() }
  } else {
    await relocate({ lat, lon }, `summon by ${who}`)
  }
  await persistHome()
}

async function advance() {
  c.busy = true
  try {
    const now = Date.now()
    const dt = Math.min(2, (now - c.lastTickAt) / 1000)
    c.lastTickAt = now
    if (now < c.attendUntil) return
    const step = stepAlongPath(c.path, c.cursor, num('speed') * dt)
    c.lat = step.lat; c.lon = step.lon
    c.cursor = { segIdx: step.segIdx, segT: step.segT }
    await writeMotion({
      lat: c.lat, lon: c.lon, v: num('speed'), trk: headingDeg(step.headingRad),
      rotation: { x: 0, y: yawFuerKurs(step.headingRad), z: 0 },
      state: { ...c.baseState, walk_path: c.path },
    })
    if (step.done) {
      const pause = num('pause_s') * 1000 + Math.floor(Math.random() * 10_000)
      c.fsm = 'idle'; c.path = null; c.nextPlanAt = now + pause
      setAnim('idle')
      const halt = c.plan.haltAn({ lat: c.lat, lon: c.lon, altitude: 0, trk: 0 })
      const patch = { state: { ...c.baseState, motion: halt } }
      if (c.animOpen) { patch.animation_state = c.anim; c.animOpen = false }
      await ajna.updateObject(c.id, patch)
      if (c.summonTarget) { c.summonTarget = null; log(`🚩 arrived where I was called — this is home now`) }
      else log(`⏸ arrived — pause ${(pause / 1000) | 0} s`)
    }
  } catch (err) {
    if (err?.status === 404) { die('the figure was deleted — stopping') }
    warn(`tick: ${err?.message || err}`); c.fsm = 'idle'; c.nextPlanAt = Date.now() + 15_000
  } finally { c.busy = false }
}

function tick() {
  if (stills || c.busy) return
  const now = Date.now()
  if (c.fsm === 'walking') advance()
  else if (c.fsm === 'idle' && now >= c.nextPlanAt && now >= c.attendUntil) planWalk()
}
every(tick, () => num('tick_ms'))

// ─── Presence: the interest area ─────────────────────────────────────────
//
// Published only when configured. Through the raw client, not the manager:
// the manager applies the player's privacy level from browser storage, which
// does not exist here — it would silently skip the call.
let areaOn = false
async function refreshArea() {
  const on = publishArea()
  try {
    if (on) {
      await ajna.defaultClient.publishInterestArea(interestBox(c.lat, c.lon), [])
      if (!areaOn) log('interest area: on — the director will populate the surroundings')
    } else if (areaOn) {
      await ajna.defaultClient.deleteInterestArea?.()
      log('interest area: off')
    }
    areaOn = on
  } catch (err) { warn(`interest area: ${err?.message || err}`) }
}
await refreshArea()
every(refreshArea, () => num('area_refresh_s') * 1000)

// ─── Talking (Parley) ────────────────────────────────────────────────────
//
// Same mechanics as the director: a session per player and figure, the
// dialogue set from `dialog`, `do: anim` as the only side effect. In model
// modes this stays the source of everything binding.
const parley = npcParley()
const lastLine = new Map()      // userId → timestamp (one answer per 400 ms)

async function say(userId, text) {
  const conv = parley.open(dialogNameFor(figure), talkSessionId(userId, figure.id), { vars: dialogVarsFor(figure) })
  const answer = conv.say(text)
  if (!answer.text) return
  await ajna.sendChat(userId, {
    text: answer.text, object: figure.id,
    meta: answer.choices ? { choices: answer.choices, input: answer.input } : null,
  })
  for (const a of answer.do || []) {
    if (a?.action === 'anim' && a.value) {
      try { await ajna.setAnimation(figure.id, String(a.value)); c.anim = String(a.value) } catch {}
    }
  }
}

ajna.onChat(async (msg) => {
  try {
    const from = msg?.from, text = String(msg?.text || '').trim()
    if (!from || !text) return
    if (msg.object && msg.object !== figure.id) return      // addressed to another object of this account? there is none
    const now = Date.now()
    if (now - (lastLine.get(from) || 0) < 400) return
    lastLine.set(from, now)
    c.attendUntil = Math.max(c.attendUntil, now + num('talk_halt_s') * 1000)
    log(`💬 ${from}: ${text.slice(0, 60)}`)
    await say(from, text)
  } catch (err) { warn(`chat: ${err?.message || err}`) }
}).then(() => log(`listening for chat (dialogue set: ${dialogNameFor(figure)})`))
  .catch(err => warn(`chat subscription: ${err?.message || err}`))

setInterval(() => { const n = parley.sweep(15 * 60_000); if (n) log(`${n} idle conversation(s) forgotten`) }, 60_000).unref()

// ─── Being addressed and approached ──────────────────────────────────────
ajna.onInteract(figure.id, (evt) => {
  const action = evt?.action
  if (!action || action === 'examine') return
  if (action === 'call') { summon(evt).catch(err => warn(`summon: ${err?.message || err}`)); return }
  if (action === 'talk' && evt?.source) say(evt.source, 'hallo').catch(err => warn(`greeting: ${err?.message || err}`))
  stopHere({ holdMs: num('talk_halt_s') * 1000 }).catch(() => {})
  log(`👂 ${action} by ${evt?.source || '?'} — holding ${num('talk_halt_s')} s`)
}).catch(err => warn(`interact subscription: ${err?.message || err}`))

// Someone stepped into the figure's vicinity (player opt-in level "Nähe").
// No coordinates arrive — only that, and who. For now the figure stops and
// turns attentive; in the model modes this is the main trigger.
ajna.onProximity(figure.id, (evt) => {
  if (evt?.state === 'enter') {
    log(`👀 ${evt.source || 'someone'} is near`)
    stopHere({ holdMs: 20_000 }).catch(() => {})
  } else if (evt?.state === 'leave') {
    log(`👋 ${evt.source || 'someone'} left`)
  }
}).catch(err => warn(`proximity subscription: ${err?.message || err}`))

// ─── Settings changes ────────────────────────────────────────────────────
konf.beiAenderung((key) => {
  for (const t of TICKS) t.retime()
  if (key === 'persona.mode') log(`mode → ${mode()}${mode() === 'basic' ? '' : ' (model not wired yet — behaves like basic)'}`)
  if (key === 'persona.publish_area') refreshArea().catch(() => {})
  if (key === 'persona.home') {
    // The agent writes this key itself after a summon; the subscription then
    // hands it back. Only a value that differs from what is already home is
    // an operator's decision.
    const h = effectiveHome()
    if (haversine(home.lat, home.lon, h.lat, h.lon) >= 1) {
      relocate(h, 'settings').catch(err => warn(`relocate: ${err?.message || err}`))
    }
  }
})

log(`ready — @${NAME} as „${figure.name}", mode ${mode()}${mode() === 'basic' ? '' : ' (model not wired yet — behaves like basic)'}, `
  + `${stills ? 'stands still' : `roams ${num('roam_radius_m')} m around home`}, interest area ${publishArea() ? 'on' : 'off'}`)
