// robot-navigator.mjs — from "go there" to "this fast, turning this much".
//
// Pure arithmetic, no clock, no hardware, no network: the same pose and the
// same target always give the same command. That is what makes a vehicle
// testable at all — every other part of the chain can be watched, but steering
// has to be *reasoned about*, and reasoning needs determinism.
//
// The geometry comes from `bewegung.mjs`, which the world director already uses
// for its figures. One bearing calculation in the project, not two.

import { kursGrad, abstandM } from './bewegung.mjs'

/**
 * Signed heading error in degrees, −180…+180. Positive means "turn left".
 *
 * `bewegung.kursDifferenz` deliberately returns the UNSIGNED distance (0…180)
 * because it answers "has the course changed enough to be worth publishing".
 * Steering needs the sign: unsigned, a robot 170° off its target would turn
 * the wrong way half the time and circle forever.
 */
export function headingError(soll, ist) {
  return ((soll - ist + 540) % 360) - 180
}

/**
 * How the machine is allowed to move, and how eagerly it chases a target.
 *
 * Gains are deliberately gentle. An overeager controller oscillates around the
 * goal, and on a real chassis that is not a wobble on a graph — it is a rover
 * sawing back and forth in front of a bench until the battery is flat.
 */
export const DEFAULT_LIMITS = {
  maxV: 1.0,             // m/s
  maxOmega: 1.0,         // rad/s
  /** Inside this, the target counts as reached. */
  toleranceM: 1.5,
  /** Beyond this heading error, turn on the spot instead of driving a curve. */
  turnFirstDeg: 35,
  /**
   * Slow down on approach: v = distance × this, capped at maxV.
   *
   * MEASURED AGAINST THE STOPPING DISTANCE, not picked for looks. At 1 m/s a
   * small rover needs a metre or two to come to rest, and the arrival
   * tolerance is 1.5 m — so the braking has to begin around four metres out.
   * The first value here was 0.5, which only starts slowing below two metres:
   * full speed straight into the goal, then a jolt. A test caught it.
   */
  approachGain: 0.25,
  /** Turn rate per degree of error (rad/s per degree). */
  turnGain: 0.03,
  /** Below this the drive cannot overcome friction — don't pretend it can. */
  minV: 0.08,
}

/**
 * One steering decision.
 *
 * @param {{lat:number, lon:number, heading:number}} pose   where we are, heading in degrees
 * @param {{lat:number, lon:number}} ziel                   where we want to be
 * @param {object} [limits]                                 see DEFAULT_LIMITS
 * @returns {{v:number, omega:number, arrived:boolean, distanceM:number,
 *            headingErrorDeg:number, mode:'arrived'|'turn'|'drive'}}
 */
export function steer(pose, ziel, limits = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits }
  const leer = { v: 0, omega: 0, arrived: false, distanceM: Infinity, headingErrorDeg: 0, mode: 'arrived' }

  if (!istPose(pose) || !istPunkt(ziel)) return leer

  const d = abstandM(pose.lat, pose.lon, ziel.lat, ziel.lon)
  if (d <= L.toleranceM) {
    return { v: 0, omega: 0, arrived: true, distanceM: d, headingErrorDeg: 0, mode: 'arrived' }
  }

  const soll = kursGrad(pose.lat, pose.lon, ziel.lat, ziel.lon)
  const fehler = headingError(soll, pose.heading)
  const omega = begrenze(L.turnGain * fehler, L.maxOmega)

  // ERST DREHEN, DANN FAHREN. Ein Fahrzeug, das 90° daneben steht und trotzdem
  // losfährt, beschreibt einen weiten Bogen — auf einem Hof die zuverlässigste
  // Art, in die Hecke zu geraten. Jenseits der Schwelle also auf der Stelle
  // drehen, und zwar mit voller Drehrate, damit es nicht ewig dauert.
  if (Math.abs(fehler) > L.turnFirstDeg) {
    return {
      v: 0,
      omega: begrenze(Math.sign(fehler) * L.maxOmega, L.maxOmega),
      arrived: false, distanceM: d, headingErrorDeg: fehler, mode: 'turn',
    }
  }

  // Annäherung: je näher, desto langsamer — aber nie unter das, was der Antrieb
  // überhaupt in Bewegung setzt, sonst steht er brummend kurz vor dem Ziel.
  let v = Math.min(L.maxV, d * L.approachGain)
  if (v < L.minV) v = L.minV
  return { v, omega, arrived: false, distanceM: d, headingErrorDeg: fehler, mode: 'drive' }
}

const zahl = (v) => Number.isFinite(v)
const istPunkt = (p) => !!p && zahl(p.lat) && zahl(p.lon)
const istPose = (p) => istPunkt(p) && zahl(p.heading)
const begrenze = (v, limit) => Math.max(-Math.abs(limit), Math.min(Math.abs(limit), zahl(v) ? v : 0))

/**
 * Walk a list of waypoints.
 *
 * Deliberately thin: it holds an index and hands the current target to
 * `steer()`. Anything cleverer — replanning, obstacles, shortcuts — belongs
 * above this, where it can see the world. A route that silently reorders itself
 * is a route nobody can debug.
 */
export class Route {
  /** @param {{lat:number, lon:number}[]} punkte */
  constructor(punkte = []) {
    this.punkte = punkte.filter(istPunkt)
    this.index = 0
  }

  get ziel() { return this.punkte[this.index] || null }
  get fertig() { return this.index >= this.punkte.length }
  get rest() { return Math.max(0, this.punkte.length - this.index) }

  /**
   * One step along the route.
   * @returns {{v:number, omega:number, fertig:boolean, ziel:object|null, mode:string}}
   */
  schritt(pose, limits = {}) {
    if (this.fertig) return { v: 0, omega: 0, fertig: true, ziel: null, mode: 'arrived' }
    const s = steer(pose, this.ziel, limits)
    if (s.arrived) {
      this.index++
      // Beim Weiterrücken SOFORT das nächste Ziel bedienen, statt eine Runde
      // stehenzubleiben — sonst ruckelt die Fahrt an jedem Wegpunkt.
      return this.fertig
        ? { v: 0, omega: 0, fertig: true, ziel: null, mode: 'arrived' }
        : { ...this.schritt(pose, limits), fertig: false }
    }
    return { v: s.v, omega: s.omega, fertig: false, ziel: this.ziel, mode: s.mode }
  }
}
