// robot-driver.mjs — the contract between Ajna and a piece of moving hardware.
//
// THE WHOLE POINT IS THIS ONE BOUNDARY. Everything above it — waypoints, game
// actions, dialogue, telemetry — is written once and never again. Everything
// below it is specific to one machine: two hub motors on a hoverboard, six legs
// on a hexapod, tracks, whatever comes.
//
// THE CUT IS AT SPEED AND TURN RATE, not at motors and not at waypoints:
//
//     drive({ v, omega })      v     = m/s forward, negative is backwards
//                              omega = rad/s, positive turns left (CCW)
//
// This is the same boundary ROS has drawn as `cmd_vel` for years, and it has
// held across wheels, tracks and legs. The core turns "go to the fountain" into
// "0.8 m/s, 0.2 rad/s"; the driver turns that into wheel speeds or a gait
// cycle. A HEXAPOD'S WALKING STYLE IS THE HEXAPOD'S BUSINESS, not the game's.
//
// Cutting lower (motor currents) would drag the game into every chassis. Cutting
// higher (goTo(lat, lon)) would make every platform reimplement navigation.
//
// ─── WHAT A DRIVER MUST IMPLEMENT ────────────────────────────────────────
//
//   async start()                 open the link. Throws → the agent does not run.
//   async drive({ v, omega })     command body velocity. Called ~5×/s.
//   async halt()                  stop NOW. Must work even when things are broken.
//   async stop()                  close the link (shutdown).
//   state()                       → { v, omega, pose?, battery?, error?, … }
//   capabilities()                → see `CAPABILITY_SHAPE` below
//
// `halt()` is the one method that is allowed no excuses. If it can throw, the
// driver is wrong: swallow what you must, cut the motors, report the problem
// through `state().error`.
//
// ─── WHAT A DRIVER MUST NOT DO ───────────────────────────────────────────
//
// IT MUST NOT BE THE SAFETY LAYER. The dead-man's switch belongs in the
// firmware below: no fresh command within ~300 ms and the machine stops, full
// stop, without asking anybody. A driver on this side runs in a browser or in
// Node, behind a garbage collector and a radio link — it is the wrong place for
// the one thing that must never fail. The driver's duty is only to keep the
// heartbeat going while it is alive.

/** Clamp to ±limit. Shared because every driver needs it. */
export const clamp = (v, limit) =>
  (!Number.isFinite(v) ? 0 : Math.max(-Math.abs(limit), Math.min(Math.abs(limit), v)))

/**
 * What `capabilities()` returns.
 *
 * The core reads this to keep itself honest: it never commands faster than the
 * machine can go, and it offers the player exactly the actions this machine
 * actually has. A hexapod can sit down; a hoverboard cannot — and the game
 * logic learns that from here instead of knowing about platforms.
 */
export const CAPABILITY_SHAPE = {
  maxV: 1.0,            // m/s
  maxOmega: 1.0,        // rad/s
  turnsInPlace: true,   // false for a car-like chassis that needs to roll to steer
  holonomic: false,     // true if it can also move sideways (not used yet)
  /** Extra Ajna actions this platform offers, e.g. [{ key: 'sit', label: 'Hinsetzen' }] */
  extraActions: [],
}

const FUNKTIONEN = ['start', 'drive', 'halt', 'stop', 'state', 'capabilities']

/**
 * Does this object fulfil the contract? Returns a list of complaints.
 *
 * Meant for whoever writes the second driver: run it once in a test and you
 * learn what is missing, instead of finding out on a machine that is already
 * rolling.
 */
export function checkDriver(driver) {
  const fehlt = []
  for (const f of FUNKTIONEN) {
    if (typeof driver?.[f] !== 'function') fehlt.push(`${f}() fehlt`)
  }
  if (fehlt.length) return fehlt

  const c = driver.capabilities()
  if (!c || typeof c !== 'object') fehlt.push('capabilities() liefert kein Objekt')
  else {
    if (!(Number.isFinite(c.maxV) && c.maxV > 0)) fehlt.push('capabilities().maxV fehlt oder ist nicht positiv')
    if (!(Number.isFinite(c.maxOmega) && c.maxOmega > 0)) fehlt.push('capabilities().maxOmega fehlt oder ist nicht positiv')
    if (c.extraActions && !Array.isArray(c.extraActions)) fehlt.push('capabilities().extraActions ist kein Array')
  }
  const s = driver.state()
  if (!s || typeof s !== 'object') fehlt.push('state() liefert kein Objekt')
  return fehlt
}

/**
 * A driver without hardware — differential drive, dead-reckoned.
 *
 * NOT A TOY. This is how the whole chain gets tested without a machine, and it
 * is what Stufe 0 of the work package runs on: the agent, the navigation, the
 * game actions and the Ajna object are all real, only the wheels are not. Every
 * bug that is not in the motors shows up here first, where it costs nothing.
 *
 * It also serves as its own position source: `state().pose` is integrated from
 * the commanded velocity. On a real machine the pose comes from GPS or UWB
 * instead — the core takes it from wherever it is told.
 */
export class SimDriver {
  /**
   * @param {object} [opts]
   * @param {{lat:number, lon:number, heading?:number}} [opts.start]  where it stands
   * @param {number} [opts.maxV=1.2]        m/s
   * @param {number} [opts.maxOmega=1.2]    rad/s
   * @param {number} [opts.slipp=0]         0…1, how much of the commanded speed is lost
   * @param {() => number} [opts.now]       injectable clock, for tests
   */
  constructor({ start = { lat: 50.4514, lon: 7.5363, heading: 0 },
                maxV = 1.2, maxOmega = 1.2, slipp = 0, now = Date.now } = {}) {
    this.maxV = maxV
    this.maxOmega = maxOmega
    this.slipp = Math.max(0, Math.min(1, slipp))
    this._now = now
    this.pose = { lat: start.lat, lon: start.lon, heading: start.heading || 0 }
    this._v = 0
    this._omega = 0
    this._t = now()
    this._laeuft = false
    this.odometerM = 0
  }

  async start() { this._laeuft = true; this._t = this._now() }
  async stop() { await this.halt(); this._laeuft = false }

  async drive({ v = 0, omega = 0 } = {}) {
    this._integrate()
    this._v = clamp(v, this.maxV) * (1 - this.slipp)
    this._omega = clamp(omega, this.maxOmega)
  }

  async halt() {
    this._integrate()
    this._v = 0
    this._omega = 0
  }

  state() {
    this._integrate()
    return {
      v: this._v, omega: this._omega,
      pose: { ...this.pose },
      battery: 1,
      error: null,
      odometerM: this.odometerM,
      simuliert: true,
    }
  }

  capabilities() {
    return {
      maxV: this.maxV, maxOmega: this.maxOmega,
      turnsInPlace: true, holonomic: false,
      extraActions: [],
    }
  }

  /**
   * Move the pose along by however long it has been since last time.
   *
   * Integrating on READ rather than on a timer keeps the simulation exact under
   * test: a test can step the clock by a second and get a second's worth of
   * travel, with no scheduler in the way.
   */
  _integrate() {
    const t = this._now()
    const dt = Math.max(0, (t - this._t) / 1000)
    this._t = t
    if (!this._laeuft || dt === 0) return
    this.pose.heading = ((this.pose.heading + (this._omega * 180 / Math.PI) * dt) % 360 + 360) % 360
    const s = this._v * dt
    if (s === 0) return
    const rad = this.pose.heading * Math.PI / 180
    this.pose.lat += (s * Math.cos(rad)) / 111320
    this.pose.lon += (s * Math.sin(rad)) / (111320 * Math.max(0.01, Math.cos(this.pose.lat * Math.PI / 180)))
    this.odometerM += Math.abs(s)
  }
}
