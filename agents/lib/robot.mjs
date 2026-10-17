// robot.mjs — the part of a robot that is the same on every platform.
//
// WHAT RUNS WHERE:
//
//   Ajna-Server      Objekt, Rechte, Weltdaten, Aufträge
//        |  Sekunden, Internet
//   DIESER KERN      Wegpunkte, Spielaktionen, Telemetrie, Totmann-Takt
//        |  Millisekunden, BLE/USB
//   Antriebs-Treiber Motoren, Gangart          (robot-driver.mjs)
//        |
//   Firmware         DIE NOTBREMSE
//
// NO DOM, NO CAPACITOR, NO BROWSER. Everything comes in through the
// constructor: an `ajna`, a driver, a position source, a clock. That is what
// lets the identical file run headless on a Raspberry Pi under Node and inside
// the Android app — the app is a special case of this, not the other way round.
// If you ever find yourself reaching for `window` or `navigator` in here, the
// thing you want belongs in the caller.
//
// THE SAFETY STORY, IN ONE PLACE. There are three independent stops, and they
// are deliberately not the same mechanism:
//
//   1. Firmware dead-man      no command for ~300 ms → motors off. Below us,
//                             survives a crashed phone and a dead network.
//   2. This core's watchdog   no fresh pose, driver error, link lost, or target
//                             gone → commands halt. Catches "the software is
//                             running but has lost the plot".
//   3. The operator           `halt` action and E-stop. A human overrides.
//
// None of these three can replace another. This file owns only the second.

import { steer, Route, DEFAULT_LIMITS } from './robot-navigator.mjs'
import { checkDriver } from './robot-driver.mjs'

/** How the robot explains itself when somebody looks. */
const ZUSTAND_TEXT = {
  idle: 'wartet auf einen Auftrag',
  driving: 'unterwegs',
  turning: 'dreht sich',
  arrived: 'am Ziel',
  stopped: 'angehalten',
  fault: 'Störung',
}

export class Robot {
  /**
   * @param {object} opts
   * @param {object} opts.ajna            AjnaManager/-Client (eingeloggt)
   * @param {object} opts.driver          siehe robot-driver.mjs
   * @param {() => ({lat,lon,heading,t?}|null)} [opts.pose]
   *        Woher die Position kommt. Fehlt sie, wird `driver.state().pose`
   *        genommen — das ist der Simulations- und Koppelnavigations-Fall.
   *        Auf einer echten Maschine zeigt das auf GPS, UWB oder deren Fusion.
   * @param {string} [opts.name]          Name des Objekts in der Welt
   * @param {string} [opts.source='robot'] Quellname (Agent-Manifest)
   * @param {string} [opts.objectId]      vorhandenes Objekt übernehmen
   * @param {number} [opts.tickMs=200]    Regeltakt. `0` legt KEINEN Timer an —
   *        der Aufrufer ruft `tick()` dann selbst. So lässt sich die Regelung
   *        Schritt für Schritt prüfen, und ein Einbettungs-Fall (die App mit
   *        eigener Schleife) muss nicht gegen einen fremden Takt arbeiten.
   * @param {number} [opts.publishMs=1000] Melde-Takt nach Ajna
   * @param {number} [opts.poseMaxAgeMs=3000] ältere Position gilt als keine
   * @param {object} [opts.limits]        siehe DEFAULT_LIMITS
   * @param {() => number} [opts.now]
   */
  constructor({
    ajna, driver, pose = null, name = 'Rover', source = 'robot', objectId = null,
    tickMs = 200, publishMs = 1000, poseMaxAgeMs = 3000, limits = {},
    log = console.log, warn = console.warn, now = Date.now,
  } = {}) {
    const fehlt = checkDriver(driver)
    if (fehlt.length) throw new Error(`Treiber unvollständig: ${fehlt.join(', ')}`)
    if (!ajna) throw new Error('Robot: ajna fehlt')

    this.ajna = ajna
    this.driver = driver
    this.name = name
    this.source = source
    this.objectId = objectId
    this.tickMs = tickMs
    this.publishMs = publishMs
    this.poseMaxAgeMs = poseMaxAgeMs
    this.log = log
    this.warn = warn
    this._now = now

    // Die Grenzen der Maschine schlagen die Wunschwerte. Ein Kern, der
    // schneller befiehlt, als der Treiber kann, erzeugt nur Regelfehler.
    const c = driver.capabilities()
    this.limits = {
      ...DEFAULT_LIMITS, ...limits,
      maxV: Math.min(limits.maxV ?? DEFAULT_LIMITS.maxV, c.maxV),
      maxOmega: Math.min(limits.maxOmega ?? DEFAULT_LIMITS.maxOmega, c.maxOmega),
    }

    this._poseQuelle = pose || (() => {
      const p = driver.state()?.pose
      return p ? { ...p, t: this._now() } : null
    })

    this.route = new Route([])
    this.zustand = 'idle'
    this.letzterFehler = null
    this._timer = null
    this._letztePublikation = 0
    this._letzterKontakt = this._now()
    this._abos = []
  }

  // ─── Leben ──────────────────────────────────────────────────────────

  /** Objekt sicherstellen, Abos legen, Regelschleife starten. */
  async start() {
    await this.driver.start()
    await this._objektSicherstellen()
    await this._aboLegen()
    if (this.tickMs > 0) {
      this._timer = setInterval(() => {
        this.tick().catch(err => this.warn(`Takt: ${err?.message || err}`))
      }, this.tickMs)
    }
    this.log(`bereit als ${this.objectId} · ${this.limits.maxV} m/s · `
      + (this.tickMs > 0 ? `Takt ${this.tickMs} ms` : 'Takt vom Aufrufer'))
  }

  /** Anhalten und abmelden. Hält auch dann an, wenn das Abmelden scheitert. */
  async stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    try { await this.driver.halt() } catch (err) { this.warn(`halt: ${err?.message || err}`) }
    for (const off of this._abos) { try { off?.() } catch {} }
    this._abos = []
    try { await this.driver.stop() } catch (err) { this.warn(`stop: ${err?.message || err}`) }
  }

  // ─── Befehle ────────────────────────────────────────────────────────

  /** Eine Fahrt aufgeben. Ersetzt die laufende. */
  fahreZu(ziele) {
    const liste = Array.isArray(ziele) ? ziele : [ziele]
    this.route = new Route(liste)
    this._letzterKontakt = this._now()
    this.zustand = this.route.fertig ? 'idle' : 'driving'
    return this.route.rest
  }

  /** Alles stehen lassen. Der eine Befehl, der immer durchkommt. */
  async halt(grund = 'angehalten') {
    this.route = new Route([])
    this.zustand = 'stopped'
    try { await this.driver.halt() }
    catch (err) { this.warn(`halt: ${err?.message || err}`) }
    this.log(grund)
  }

  /** Was der Roboter über sich sagen kann — für „untersuchen" und Telemetrie. */
  status() {
    const s = this.driver.state() || {}
    const p = this._pose()
    return {
      zustand: this.zustand,
      text: ZUSTAND_TEXT[this.zustand] || this.zustand,
      wegpunkteOffen: this.route.rest,
      ziel: this.route.ziel,
      pose: p,
      v: s.v ?? 0,
      battery: s.battery ?? null,
      odometerM: s.odometerM ?? null,
      fehler: this.letzterFehler,
    }
  }

  // ─── Regelschleife ──────────────────────────────────────────────────

  /**
   * Ein Takt: Lage prüfen, lenken, fahren, gelegentlich melden.
   *
   * Öffentlich, weil `tickMs: 0` genau dafür da ist — die App bringt ihre
   * eigene Schleife mit, und ein Test will Schritt für Schritt vorgehen.
   *
   * DIE PRÜFUNGEN STEHEN VOR DEM LENKEN, nicht danach. Wer erst rechnet und
   * dann fragt, ob die Daten taugten, hat den Befehl schon abgeschickt.
   */
  async tick() {
    const s = this.driver.state() || {}
    if (s.error) return this._stillstand(`Treiber meldet: ${s.error}`, 'fault')

    const p = this._pose()
    if (!p) return this._stillstand('keine Position', 'fault')
    if (this._now() - (p.t ?? this._now()) > this.poseMaxAgeMs) {
      return this._stillstand('Position veraltet', 'fault')
    }

    if (this.route.fertig) {
      if (this.zustand === 'driving' || this.zustand === 'turning') {
        this.zustand = 'arrived'
        this.log('Ziel erreicht')
        await this.driver.halt()
        await this._melden(p, true)
      }
      return
    }

    const schritt = this.route.schritt(p, this.limits)
    this.zustand = schritt.mode === 'turn' ? 'turning' : 'driving'
    this.letzterFehler = null
    await this.driver.drive({ v: schritt.v, omega: schritt.omega })
    await this._melden(p)
  }

  /** Anhalten mit Begründung — einmal melden, nicht bei jedem Takt. */
  async _stillstand(grund, zustand) {
    const neu = this.letzterFehler !== grund
    this.letzterFehler = grund
    this.zustand = zustand
    try { await this.driver.halt() } catch {}
    // NUR BEI ÄNDERUNG MELDEN. Fünfmal je Sekunde „keine Position" ist
    // dieselbe Sorte Lärm wie wiederholte Statusmeldungen anderswo.
    if (neu) this.warn(grund)
  }

  _pose() {
    try {
      const p = this._poseQuelle()
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return null
      return { lat: p.lat, lon: p.lon, heading: Number.isFinite(p.heading) ? p.heading : 0, t: p.t ?? this._now() }
    } catch (err) {
      this.warn(`Positionsquelle: ${err?.message || err}`)
      return null
    }
  }

  // ─── Ajna ───────────────────────────────────────────────────────────

  /**
   * Das Objekt in der Welt anlegen oder übernehmen.
   *
   * Bewusst NICHT über `lib/fleet.mjs`: Eine Flotte verwaltet viele gleichartige
   * Spiegel und räumt weg, was eine Weile nicht gesehen wurde. Ein Roboter ist
   * genau einer, und er soll nicht verschwinden, weil er zehn Minuten in der
   * Garage stand.
   */
  async _objektSicherstellen() {
    const c = this.driver.capabilities()
    const actions = [
      { key: 'come', label: 'Herkommen', max_distance: 60 },
      { key: 'halt', label: 'Anhalten', max_distance: 60 },
      ...(c.extraActions || []),
    ]
    const koerper = {
      name: this.name,
      type: 'robot',
      description: this._beschreibung(),
      appearance: { emoji: '🤖' },
      state: {
        source: this.source,
        robot: true,
        label: this.name,
        moving: true,
        actions,
        capabilities: { maxV: c.maxV, maxOmega: c.maxOmega, turnsInPlace: !!c.turnsInPlace },
      },
    }
    const p = this._pose()
    if (p) { koerper.lat = p.lat; koerper.lon = p.lon }

    if (this.objectId) {
      await this.ajna.updateObject(this.objectId, koerper)
      return this.objectId
    }
    const obj = await this.ajna.createObject({ altitude: 0, lat: 0, lon: 0, ...koerper })
    this.objectId = obj.id
    return this.objectId
  }

  /** Spieler-Interaktionen annehmen. */
  async _aboLegen() {
    if (typeof this.ajna.subscribeInteract !== 'function') return
    const off = await this.ajna.subscribeInteract(this.objectId, (evt) => {
      this._interaktion(evt).catch(err => this.warn(`Interaktion: ${err?.message || err}`))
    })
    this._abos.push(off)
  }

  /**
   * Was ein Spieler auslösen darf.
   *
   * `come` fährt zum Aufrufer. Die Reichweite am Objekt (`max_distance: 60`)
   * sorgt dafür, dass nur jemand in der Nähe das kann — wer den Rover rufen
   * will, muss in Rufweite stehen. Das ist zugleich Spielregel und Sicherung.
   */
  async _interaktion(evt) {
    const aktion = String(evt?.action || '').toLowerCase()
    this._letzterKontakt = this._now()

    if (aktion === 'halt' || aktion === 'anhalten') {
      await this.halt(`angehalten durch ${evt?.source || 'jemanden'}`)
      return
    }
    if (aktion === 'come' || aktion === 'herkommen') {
      const ziel = targetFrom(evt)
      if (!ziel) { this.warn('„Herkommen" ohne Position im Aufruf'); return }
      const n = this.fahreZu(ziel)
      this.log(`fahre zu ${ziel.lat.toFixed(5)}, ${ziel.lon.toFixed(5)} (${n} Wegpunkt(e))`)
      return
    }
    // Alles andere gehört der Plattform: Ein Hexapod meldet `sit` als eigene
    // Aktion an, und nur sein Treiber weiss, was das heisst.
    if (typeof this.driver.extraAction === 'function') {
      await this.driver.extraAction(aktion, evt?.payload)
    }
  }

  /**
   * Position nach Ajna melden — gedrosselt, mit Bewegungsvektor.
   *
   * `state.motion` ist der Grund, warum ein Takt von einer Sekunde reicht: Der
   * Client rechnet daraus frameweise voraus (`PositionSmoother`), wie bei
   * Flugzeugen, Schiffen und C-ITS. Ohne den Vektor spränge der Rover im
   * Sekundentakt über die Karte.
   */
  async _melden(p, erzwingen = false) {
    const jetzt = this._now()
    if (!erzwingen && jetzt - this._letztePublikation < this.publishMs) return
    this._letztePublikation = jetzt
    const s = this.driver.state() || {}
    const v = Number.isFinite(s.v) ? s.v : 0
    try {
      await this.ajna.updateObject(this.objectId, {
        lat: p.lat, lon: p.lon,
        description: this._beschreibung(),
        state: {
          source: this.source,
          robot: true,
          label: this.name,
          moving: true,
          zustand: this.zustand,
          battery: s.battery ?? null,
          odometer_m: s.odometerM ?? null,
          waypoints_left: this.route.rest,
          motion: { v: Math.abs(v) < 0.05 ? 0 : v, trk: p.heading, vrate: 0,
                    lat0: p.lat, lon0: p.lon, alt0: 0, t: jetzt },
        },
      })
    } catch (err) {
      this.warn(`Melden: ${err?.message || err}`)
    }
  }

  _beschreibung() {
    const s = this.status()
    const kopf = [`${this.name} — ${s.text}`]
    if (s.v) kopf.push(`${(Math.abs(s.v) * 3.6).toFixed(1)} km/h`)
    const detail = []
    if (s.wegpunkteOffen) detail.push(`noch ${s.wegpunkteOffen} Wegpunkt(e)`)
    if (s.battery !== null && s.battery !== undefined) detail.push(`Akku ${Math.round(s.battery * 100)} %`)
    if (s.odometerM) detail.push(`${(s.odometerM / 1000).toFixed(2)} km gefahren`)
    if (s.fehler) detail.push(`Störung: ${s.fehler}`)
    return detail.length ? `${kopf.join(' · ')}\n\n${detail.join('\n')}` : kopf.join(' · ')
  }
}

/**
 * Wohin soll er? Aus der Nutzlast, sonst aus der Position des Aufrufers.
 *
 * Beides kommt vor: Ein Skript schickt Koordinaten mit, ein Spieler tippt nur
 * „Herkommen" — dann ist sein eigener Standort gemeint.
 */
export function targetFrom(evt) {
  const p = evt?.payload
  if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) return { lat: p.lat, lon: p.lon }
  const q = evt?.position || evt?.from
  if (q && Number.isFinite(q.lat) && Number.isFinite(q.lon)) return { lat: q.lat, lon: q.lon }
  return null
}
