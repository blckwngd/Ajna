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
  }
  return null
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

const perceivedObject = (ctx, id) =>
  (ctx?.perception?.objects || []).find(o => String(o.id) === String(id)) || null

const perceivedPlayer = (ctx, id) =>
  (ctx?.perception?.players || []).find(p => String(p.id) === String(id)) || null

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
      return perceivedObject(ctx, args.object_id) ? null : 'you cannot see that object'
    },
    expect() { return null },          // pure presentation, no state to verify
    async run(ctx, args) {
      const target = perceivedObject(ctx, args.object_id)
      return ctx.ajna.updateObject(ctx.self.id, {
        rotation: { x: 0, y: bearingTo(ctx.self, target), z: 0 },
      })
    },
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
      return ctx.walkTo(target.lat, target.lon)   // routing stays with the caller
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
    description: 'Jemandem etwas sagen, der mit dir gesprochen hat oder bei dir steht.',
    modes: ['passive', 'active', 'debug'],
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Konto-Kennung aus deiner Wahrnehmung.' },
        text: { type: 'string', description: 'Was du sagst. Deutsch, höchstens ein paar Sätze.' },
      },
      required: ['to', 'text'],
    },
    check(ctx, args) {
      if (!perceivedPlayer(ctx, args.to)) return 'you are not talking to that person'
      if (args.text.length > 800) return 'that is too long for a spoken line'
      return null
    },
    expect() { return null },
    async run(ctx, args) {
      return ctx.ajna.sendChat(args.to, { text: args.text, object: ctx.self.id })
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
      const offered = (target.state?.actions || []).map(a => a.key || a)
      // Deliberately NOT a hard stop when the list is empty: an object may
      // offer actions the agent has not read. Only a contradiction counts.
      if (offered.length && !offered.includes(args.action)) {
        return `that object offers: ${offered.join(', ')}`
      }
      return null
    },
    expect(ctx, args) { return { kind: 'interaction_accepted', object_id: args.object_id, action: args.action } },
    async run(ctx, args) { return ctx.ajna.interact(args.object_id, args.action) },
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
      const carried = (ctx?.perception?.inventory || []).some(o => String(o.id) === String(args.object_id))
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
