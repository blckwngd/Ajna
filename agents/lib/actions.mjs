// ─────────────────────────────────────────────────────────────────────────
//  Agent library · Action register — one list, two callers
// ─────────────────────────────────────────────────────────────────────────
// Everything a persona can DO lives here, exactly once. The rule-based
// behaviour calls `run()` directly; a language model gets the same entries
// handed over as tool definitions. Add an action in one place and both
// sides have it — which is the whole point, because a tool the model can
// name but the agent cannot perform is a promise that breaks at runtime.
//
// THIS IS THE PLAYER'S SURFACE, not the world-director's. A persona is a
// player-shaped actor: it owns its own account and its own figure, and it
// reaches the world through the same routes a human client uses
// (`/interact`, `/pickup`, `/place`, `/chat/send`). That is deliberate.
// The director writes to objects it owns, so every rule check passes on
// the owner path — which is exactly why a broken `objects.updateRule`
// could go unnoticed for six months. An actor that walks the player's
// routes hits the same walls a player hits.
//
// FOUR PARTS PER ENTRY, and they are separate on purpose:
//
//   check()   may this happen at all? The guard against a model that
//             invents an object id or wanders off its leash.
//   expect()  what should be true afterwards. EVIDENCE, NOT A FILTER —
//             it is written into the journal next to what actually
//             happened. Nothing here decides whether something counts as
//             a finding; that judgement belongs to the model, so that
//             mistakes nobody anticipated are not silently dropped.
//   run()     the single call into the ajna library.
//   parameters  JSON-Schema subset; becomes the tool definition.
//
// Player-facing text (what a character says) is German — it is content,
// not code. Everything else here is English.

/** Actions a model may use, per persona mode. `basic` gets none: no model. */
export const MODES = ['basic', 'passive', 'active', 'debug']

const NO_TOOLS = []

/**
 * Minimal JSON-Schema check — enough for the shapes used below, and no
 * dependency. A model WILL send a number as a string, omit a required
 * field, or invent an enum value; all three have to be caught before a
 * call goes out, not after.
 */
export function validateArgs(schema, args) {
  if (!schema || schema.type !== 'object') return null
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return 'arguments must be an object'
  }
  for (const name of schema.required || []) {
    if (args[name] === undefined || args[name] === null || args[name] === '') {
      return `missing required argument "${name}"`
    }
  }
  for (const [name, value] of Object.entries(args)) {
    const prop = (schema.properties || {})[name]
    if (!prop) return `unknown argument "${name}"`
    if (prop.type === 'string' && typeof value !== 'string') return `"${name}" must be a string`
    if (prop.type === 'boolean' && typeof value !== 'boolean') return `"${name}" must be a boolean`
    if (prop.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `"${name}" must be a number`
      if (prop.minimum !== undefined && value < prop.minimum) return `"${name}" must be at least ${prop.minimum}`
      if (prop.maximum !== undefined && value > prop.maximum) return `"${name}" must be at most ${prop.maximum}`
    }
    if (prop.enum && !prop.enum.includes(value)) {
      return `"${name}" must be one of: ${prop.enum.join(', ')}`
    }
    if (prop.type === 'array') {
      if (!Array.isArray(value)) return `"${name}" must be an array`
      if (prop.items?.type === 'string' && !value.every(v => typeof v === 'string')) return `"${name}" must contain strings only`
      if (prop.maxItems !== undefined && value.length > prop.maxItems) return `"${name}" may hold at most ${prop.maxItems} entries`
    }
  }
  return null
}

// Gestures travel in Parley's notation (`anim:<clip>`), so the rules and
// the model speak one language. Only this one verb for now.
const GESTURE = /^anim:(.+)$/
export function parseGesture(entry) {
  const m = GESTURE.exec(String(entry || '').trim())
  return m ? m[1].trim() : null
}

/** Metres between two WGS84 points. Local copy: this module stays free of imports. */
export function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

// ── Shared guards ────────────────────────────────────────────────────────
// A model must never be able to name an arbitrary record. It may only act
// on what it currently perceives — that is the line between "the character
// looks around and reacts" and "a player typed an id into the chat and the
// character obeyed".

// Ids in the situation are composite (`default:km3j…`); a model will hand
// back the bare record id as often as not. Found by the persona itself:
// "walk_to verweigert Objekt, das in der Lage als in Reichweite gelistet
// ist". Compare on the record id, so the prefix is a convenience, not a
// trap — the guard still refuses anything that is not in the perception.
export const rawId = (id) => { const s = String(id ?? '').trim(); const i = s.indexOf(':'); return i >= 0 ? s.slice(i + 1) : s }
const sameId = (a, b) => rawId(a) !== '' && rawId(a) === rawId(b)

const perceivedObject = (ctx, id) =>
  (ctx?.perception?.objects || []).find(o => sameId(o.id, id)) || null

// What the figure carries is in its hands, not in its field of view —
// looking at it must work, walking to it makes no sense. Only `look_at`
// uses this wider match.
const perceivedAny = (ctx, id) =>
  perceivedObject(ctx, id)
  || (ctx?.perception?.inventory || []).find(o => sameId(o.id, id)) || null

// ── Words for the figure, not keys ───────────────────────────────────────
// `call` is a quest, not an action — the persona read "TestQuest3 · call"
// as something it could trigger and reported the refusal thirty times. A
// type is shown as a word; the key stays available to the tools via the id.
const TYPE_WORDS = {
  npc: 'Figur', enemy: 'Gegner', animal: 'Tier', dragon: 'Drache', hint: 'Hinweis',
  item: 'Gegenstand', diamond: 'Diamant', call: 'Auftrag', player: 'Spieler',
  poi: 'Ort', wifi: 'WLAN', uwb_anchor: 'Anker', aircraft: 'Flugzeug', ship: 'Schiff',
  rover: 'Rover', marker: 'Marke', building: 'Gebäude',
}
export function typeWord(type) {
  const t = String(type || '').toLowerCase()
  return TYPE_WORDS[t] || (t ? t : '')
}

/** A quest that is over is still an object — but nothing to do any more. */
export const questDone = (o) => {
  const st = o?.state?.call?.status
  return String(o?.type || '').toLowerCase() === 'call' && (st === 'done' || st === 'closed' || st === 'expired')
}

/** Actions an object offers to a player: its own list plus "examine", as the client does. */
export function offeredActions(o) {
  const own = (o?.state?.actions || []).map(a => (a && typeof a === 'object') ? a.key : a).filter(Boolean)
  return own.includes('examine') ? own : ['examine', ...own]
}

/**
 * What a player would see on looking at the object. Plain text for the
 * model — a record dump made the persona mistake its OWN record for the
 * target (the old `look_at` returned the result of its turn, i.e. itself).
 */
export function describeObject(o, self = null) {
  if (!o) return ''
  const parts = [`${o.name || '(ohne Namen)'} [${o.id}]`]
  const tw = typeWord(o.type)
  if (tw) parts.push(questDone(o) ? `${tw} (erledigt)` : tw)
  if (self && Number.isFinite(o.lat) && Number.isFinite(self.lat)) parts.push(`${Math.round(distanceM(self.lat, self.lon, o.lat, o.lon))} m entfernt`)
  if (o.carried_by) parts.push('in deiner Hand')
  if (o.state?.portable) parts.push('tragbar')
  const lines = [parts.join(' · ')]
  const desc = String(o.description || '').trim()
  if (desc) lines.push(desc.length > 300 ? desc.slice(0, 299) + '…' : desc)
  // What the players SEE: the model file, the emoji, the colour. A persona
  // judging its surroundings could not tell a chest from a key when both
  // said "ein Gegenstand" — the clients knew, the figure did not.
  const ap = (o.appearance && typeof o.appearance === 'object') ? o.appearance : {}
  const look = []
  const gltf = String(ap.gltf || o.model_url || '').trim()
  if (gltf) look.push(`Modell ${gltf.split('/').pop()}`)
  if (ap.emoji) look.push(`Symbol ${ap.emoji}`)
  if (ap.shape) look.push(`Form ${ap.shape}`)
  if (ap.color) look.push(`Farbe ${ap.color}`)
  if (ap.glow) look.push('leuchtet')
  if (look.length) lines.push(`Aussehen: ${look.join(', ')}`)
  const hint = String(o.state?.hint || '').trim()
  if (hint) lines.push(`Darauf steht: „${hint.length > 300 ? hint.slice(0, 299) + '…' : hint}"`)
  const task = String(o.state?.call?.task || o.state?.call?.summary || '').trim()
  if (task) lines.push(`Aufgabe: ${task.length > 200 ? task.slice(0, 199) + '…' : task}`)
  const hp = o.state?.hp
  if (Number.isFinite(Number(hp?.ist)) && Number(hp?.max) > 0) lines.push(`Zustand: ${hp.ist} von ${hp.max}`)
  lines.push(`Aktionen: ${offeredActions(o).join(', ')}`)
  return lines.join('\n')
}

/**
 * What the player's client would show after an interaction — the figure
 * gets the same. `examine` on a hint returned `{delivered: 0}` before; the
 * text lives in the object, the client rendered it, the persona saw nothing.
 */
export function replyFor(o, action, result = null) {
  const delivered = Number(result?.delivered)
  if (action === 'examine') {
    const hint = String(o?.state?.hint || '').trim()
    const desc = String(o?.description || '').trim()
    return hint ? `Darauf steht: „${hint}"` : (desc || 'Nichts Besonderes zu sehen.')
  }
  const who = Number.isFinite(delivered)
    ? (delivered > 0 ? 'Wer das Objekt betreibt, hat es bemerkt.' : 'Niemand, der darauf reagieren könnte, ist gerade da.')
    : ''
  return `${action} ausgelöst. ${who}`.trim()
}

const FAILURE_KEY = (objectId, action) => `${rawId(objectId)}|${action}`

/** Case-insensitive: the model writes "wave", the clip is "Wave". Local copy — this module stays import-free. */
function matchGestureName(name, gestures) {
  const n = String(name || '').trim().toLowerCase()
  if (!n) return null
  return (gestures || []).find(g => String(g).toLowerCase() === n) || null
}

/**
 * Near-duplicate of an earlier finding? Same type and either the same
 * title in other words (word overlap) or the same set of object ids. The
 * persona reported "TestQuest4: call fails" eighteen times in one
 * afternoon; the export groups, but every repeat cost a model round.
 */
export function duplicateOf(existing, f) {
  const words = (s) => new Set(String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(w => w.length > 2))
  const ids = (s) => new Set(String(s || '').match(/\b[a-z0-9]{15}\b/g) || [])
  const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n) }
  const same = (a, b) => a.size === b.size && [...a].every(x => b.has(x))
  const tw = words(f?.title), tid = ids(`${f?.title} ${f?.description}`)
  for (const e of existing || []) {
    if (e?.type !== f?.type) continue
    if (jaccard(words(e.title), tw) >= 0.5) return e
    const eid = ids(`${e.title} ${e.description}`)
    if (tid.size && same(eid, tid) && jaccard(words(e.title), tw) >= 0.2) return e
  }
  return null
}

const perceivedPlayer = (ctx, id) =>
  (ctx?.perception?.players || []).find(p => sameId(p.id, id)) || null

function withinLeash(ctx, lat, lon) {
  const leash = ctx?.limits?.roam
  if (!leash || !Number.isFinite(leash.radius_m)) return true
  const d = distanceM(leash.lat, leash.lon, lat, lon)
  return d <= leash.radius_m
}

// ── The register ─────────────────────────────────────────────────────────

export const ACTIONS = [
  {
    key: 'look_at',
    description: 'Dem genannten Objekt zuwenden, ohne hinzugehen.',
    modes: ['passive', 'active', 'debug'],
    parameters: {
      type: 'object',
      properties: { object_id: { type: 'string', description: 'Ein Objekt in Reichweite.' } },
      required: ['object_id'],
    },
    check(ctx, args) {
      return perceivedAny(ctx, args.object_id) ? null : 'you cannot see that object'
    },
    expect() { return null },          // pure presentation, no state to verify
    async run(ctx, args) {
      const target = perceivedAny(ctx, args.object_id)
      // Turn towards it — but ANSWER with the object, not with the result
      // of the turn (that was the figure's own record, and the persona
      // concluded the snack bar was a wizard). The caller converts the
      // bearing into the client's yaw convention and keeps its heading
      // (`turnTo`); without it, the bare bearing goes out — which the
      // client reads as a different direction.
      if (!target.carried_by && Number.isFinite(target.lat)) {
        try {
          const bearing = bearingTo(ctx.self, target)
          if (typeof ctx.turnTo === 'function') await ctx.turnTo(bearing)
          else await ctx.ajna.updateObject(ctx.self.id, { rotation: { x: 0, y: bearing, z: 0 } })
        } catch { /* the look matters, the turn is cosmetic */ }
      }
      return describeObject(target, ctx.self)
    },
  },

  {
    key: 'look_around',
    description: 'Dich umsehen: was vor dir, neben dir und hinter dir ist, und was ein Haus verdeckt. '
      + 'Ohne Angabe in deine Blickrichtung; sonst drehst du dich erst: links, rechts, um, Norden/Osten/Süden/Westen oder Grad.',
    modes: ['passive', 'active', 'debug'],
    parameters: {
      type: 'object',
      properties: { direction: { type: 'string', description: 'links | rechts | um | Norden | Osten | Süden | Westen | Zahl in Grad — oder leer' } },
      required: [],
    },
    check(ctx) { return typeof ctx?.lookAround === 'function' ? null : 'you cannot look around here' },
    expect() { return null },
    async run(ctx, args) { return ctx.lookAround(args.direction || '') },
  },

  {
    key: 'walk_to',
    description: 'Zu einem Objekt in Reichweite gehen. Die Figur geht — sie springt nicht.',
    modes: ['passive', 'active', 'debug'],
    parameters: {
      type: 'object',
      properties: {
        object_id: { type: 'string', description: 'Wohin — ein Objekt, das du siehst.' },
        reason: { type: 'string', description: 'Warum, in einem kurzen Satz (fürs Protokoll).' },
      },
      required: ['object_id'],
    },
    check(ctx, args) {
      const target = perceivedObject(ctx, args.object_id)
      if (!target) return 'you cannot see that object'
      if (!Number.isFinite(target.lat) || !Number.isFinite(target.lon)) return 'that object has no position'
      if (!withinLeash(ctx, target.lat, target.lon)) return 'that is outside the area you may roam'
      return null
    },
    expect(ctx, args) {
      const target = perceivedObject(ctx, args.object_id)
      return { kind: 'moving_towards', object_id: args.object_id, lat: target?.lat, lon: target?.lon }
    },
    async run(ctx, args) {
      const target = perceivedObject(ctx, args.object_id)
      const ok = await ctx.walkTo(target.lat, target.lon)   // routing stays with the caller
      // The planner may find no way (no graph, off the leash of the roads).
      // Saying "unterwegs" then — as this did — made the figure claim a walk
      // it never started. The model needs the refusal to say it, too.
      if (ok === false) return `kein Weg zu ${target.name || args.object_id} gefunden — du bleibst stehen`
      // "true" told the model nothing; it asked why it had not arrived.
      const d = distanceM(ctx.self.lat, ctx.self.lon, target.lat, target.lon)
      const v = Number(ctx.speedMps) > 0 ? Number(ctx.speedMps) : 1.3
      return `unterwegs zu ${target.name || args.object_id}: ${Math.round(d)} m, etwa ${Math.max(1, Math.round(d / v))} s. Du bist noch nicht dort.`
    },
  },

  {
    key: 'stop',
    description: 'Stehenbleiben.',
    modes: ['passive', 'active', 'debug'],
    parameters: { type: 'object', properties: {}, required: [] },
    check() { return null },
    expect() { return { kind: 'standing_still' } },
    async run(ctx) { return ctx.stop() },
  },

  {
    key: 'say',
    description: 'Jemandem etwas sagen, der mit dir gesprochen hat oder bei dir steht. '
      + 'Mit `do` kannst du dazu eine Geste machen, in der Schreibweise der Dialogregeln: "anim:<Name>".',
    modes: ['passive', 'active', 'debug'],
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Konto-Kennung aus deiner Wahrnehmung.' },
        text: { type: 'string', description: 'Was du sagst. Deutsch, höchstens ein paar Sätze.' },
        do: {
          type: 'array', items: { type: 'string' }, maxItems: 3,
          description: 'Gesten dazu, z. B. ["anim:Wave"]. Nur Namen aus deiner Liste der Gesten.',
        },
      },
      required: ['to', 'text'],
    },
    check(ctx, args) {
      if (!perceivedPlayer(ctx, args.to)) return 'you are not talking to that person'
      if (args.text.length > 800) return 'that is too long for a spoken line'
      // A gesture the model does not have falls back to its first clip —
      // which looks like a glitch. Only what the figure knows it can do.
      for (const entry of args.do || []) {
        const clip = parseGesture(entry)
        if (!clip) return `"${entry}" is not a gesture — write anim:<name>`
        if (Array.isArray(ctx.gestures) && !matchGestureName(clip, ctx.gestures)) {
          return `you have no gesture "${clip}" — yours: ${ctx.gestures.join(', ')}`
        }
      }
      return null
    },
    expect() { return null },
    async run(ctx, args) {
      const r = await ctx.ajna.sendChat(args.to, { text: args.text, object: ctx.self.id })
      try { ctx.noteSaid?.(args.to) } catch {}
      const played = []
      for (const entry of args.do || []) {
        const clip = parseGesture(entry)
        const name = Array.isArray(ctx.gestures) ? matchGestureName(clip, ctx.gestures) : clip
        if (!name) continue
        try { await ctx.playAnimation?.(name); played.push(name) } catch { /* the words went out, the gesture is extra */ }
      }
      const gesture = played.length ? ` (Geste: ${played.join(', ')})` : ''
      // delivered === 0 used to come back bare; the persona then reported
      // "I spoke, nobody answered" as a defect. Say what it means.
      if (Number(r?.delivered) === 0) {
        return (r?.stored ? 'gesagt — die Person ist gerade nicht da, sie liest es später' : 'gesagt — aber niemand hört gerade zu') + gesture
      }
      return 'gesagt' + gesture
    },
  },

  {
    key: 'use',
    description: 'Eine angebotene Aktion an einem Objekt auslösen (dieselbe, die ein Spieler im Menü sieht).',
    modes: ['passive', 'active', 'debug'],
    parameters: {
      type: 'object',
      properties: {
        object_id: { type: 'string' },
        action: { type: 'string', description: 'Ein Schlüssel aus den Aktionen dieses Objekts.' },
      },
      required: ['object_id', 'action'],
    },
    check(ctx, args) {
      const target = perceivedObject(ctx, args.object_id)
      if (!target) return 'you cannot see that object'
      // Talking is `say`, not an interaction — "talk" on a presence is the
      // client's way of opening a chat window.
      if (args.action === 'talk' || args.action === 'sprechen') return 'to talk to someone, use say'
      // STRICT. The old guard let anything through when the object listed
      // nothing, "an object may offer actions the agent has not read" — and
      // the persona then fired `call` at three finished quests, sixty times,
      // each a 403 it could not read. The list is what the player sees.
      const offered = offeredActions(target)
      if (!offered.includes(args.action)) return `that object offers: ${offered.join(', ')}`
      // Not twice into the same wall: a refusal the server gave an hour ago
      // is the same refusal now.
      const f = ctx.failed?.(FAILURE_KEY(args.object_id, args.action))
      if (f) return `that failed ${f.count}× already ("${f.error}") — do not retry it`
      return null
    },
    expect(ctx, args) { return { kind: 'interaction_accepted', object_id: args.object_id, action: args.action } },
    async run(ctx, args) {
      const target = perceivedObject(ctx, args.object_id)
      const r = await ctx.ajna.interact(args.object_id, args.action)
      return replyFor(target, args.action, r)
    },
  },

  {
    key: 'pick_up',
    description: 'Einen tragbaren Gegenstand aufheben.',
    modes: ['passive', 'active', 'debug'],
    parameters: {
      type: 'object',
      properties: { object_id: { type: 'string' } },
      required: ['object_id'],
    },
    check(ctx, args) {
      return perceivedObject(ctx, args.object_id) ? null : 'you cannot see that object'
    },
    expect(ctx, args) { return { kind: 'carried_by_me', object_id: args.object_id } },
    async run(ctx, args) { return ctx.ajna.pickup(args.object_id) },
  },

  {
    key: 'drop',
    description: 'Einen getragenen Gegenstand hier ablegen.',
    modes: ['passive', 'active', 'debug'],
    parameters: {
      type: 'object',
      properties: { object_id: { type: 'string' } },
      required: ['object_id'],
    },
    check(ctx, args) {
      const carried = (ctx?.perception?.inventory || []).some(o => sameId(o.id, args.object_id))
      return carried ? null : 'you are not carrying that'
    },
    expect(ctx, args) { return { kind: 'no_longer_carried', object_id: args.object_id } },
    async run(ctx, args) {
      return ctx.ajna.place(args.object_id, { lat: ctx.self.lat, lon: ctx.self.lon })
    },
  },

  {
    key: 'wait',
    description: 'Eine Weile nichts tun.',
    modes: ['passive', 'active', 'debug'],
    parameters: {
      type: 'object',
      // The range lives in the description as well: strict tool schemas
      // reject minimum/maximum, the guard still enforces them.
      properties: { seconds: { type: 'number', minimum: 1, maximum: 120, description: 'Sekunden, 1 bis 120.' } },
      required: ['seconds'],
    },
    check() { return null },
    expect() { return null },
    async run(ctx, args) { return ctx.wait(args.seconds) },
  },

  {
    key: 'report_finding',
    description: 'Etwas festhalten, das dir als Spieler auffällt — kaputt, widersprüchlich, '
      + 'verwirrend oder verbesserungswürdig. Du entscheidest, was zählt.',
    modes: ['debug'],
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['bug', 'suggestion', 'question'] },
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['type', 'title', 'description'],
    },
    check(ctx) {
      // The mode gate is the only rule here. What counts as a finding is
      // NOT decided in code — a predicate written in advance would only
      // ever catch the mistakes we already thought of.
      return ctx?.mode === 'debug' ? null : 'findings can only be reported in debug mode'
    },
    expect() { return null },
    async run(ctx, args) { return ctx.recordFinding(args) },
  },

  {
    key: 'end_turn',
    description: 'Nichts weiter — zurück an das gewohnte Verhalten.',
    modes: ['passive', 'active', 'debug'],
    parameters: { type: 'object', properties: {}, required: [] },
    check() { return null },
    expect() { return null },
    async run() { return { ended: true } },
  },
]

/** Direction from the figure to a target, as a yaw in radians. */
function bearingTo(self, target) {
  if (!target || !Number.isFinite(target.lat)) return self?.rotation?.y || 0
  const toRad = (d) => (d * Math.PI) / 180
  const dLon = toRad(target.lon - self.lon)
  const y = Math.sin(dLon) * Math.cos(toRad(target.lat))
  const x = Math.cos(toRad(self.lat)) * Math.sin(toRad(target.lat))
    - Math.sin(toRad(self.lat)) * Math.cos(toRad(target.lat)) * Math.cos(dLon)
  return Math.atan2(y, x)
}

/** Key under which a failed `use` is remembered (see `ctx.failed`). */
export const failureKey = FAILURE_KEY

export const byKey = (key) => ACTIONS.find(a => a.key === key) || null

/** The actions a given mode may use. `basic` never reaches a model. */
export function actionsFor(mode) {
  if (!MODES.includes(mode) || mode === 'basic') return NO_TOOLS
  return ACTIONS.filter(a => a.modes.includes(mode))
}

/**
 * Tool definitions for a model, derived from the register itself — so the
 * two can never drift apart. Provider-neutral; an adapter renames the
 * fields it needs to.
 */
export function toolDefinitions(mode) {
  return actionsFor(mode).map(a => ({
    name: a.key,
    description: a.description,
    input_schema: a.parameters,
  }))
}

/**
 * One gate in front of every call: does the action exist, is it allowed in
 * this mode, are the arguments well formed, and does the guard permit it?
 *
 * Returns `{ ok, reason }`. A refusal is not an error — it is handed back
 * to the model as the result of its call, so it can try something else
 * instead of the turn collapsing.
 */
export function guard(mode, key, args, ctx) {
  const action = byKey(key)
  if (!action) return { ok: false, reason: `unknown action "${key}"` }
  if (!action.modes.includes(mode)) return { ok: false, reason: `"${key}" is not available in mode ${mode}` }
  const malformed = validateArgs(action.parameters, args || {})
  if (malformed) return { ok: false, reason: malformed }
  const refused = action.check(ctx, args || {})
  if (refused) return { ok: false, reason: refused }
  return { ok: true, action }
}
