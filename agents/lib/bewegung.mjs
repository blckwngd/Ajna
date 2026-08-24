// bewegung — Plan statt Position veröffentlichen.
//
// DAS PROBLEM: Ein Agent, der eine Figur bewegt, schreibt bisher bei JEDEM Tick
// eine neue Position. Der World-Director tickt alle 500 ms — bei 38 Figuren
// sind das ~76 Schreibvorgänge pro Sekunde, jeder davon mit Realtime-Fan-out an
// alle Betrachter. Genau diese Last hat schon einmal die Bildrate gekostet, und
// dazwischen springen die Figuren trotzdem, weil 2 Hz kein flüssiges Bild
// ergeben.
//
// DIE UMKEHRUNG: Nicht die Position veröffentlichen, sondern den PLAN — wo die
// Figur war, wie schnell und in welche Richtung sie läuft. Der Betrachter
// rechnet daraus frameweise voraus. Die Client-Seite dafür gibt es bereits und
// ist ausdrücklich quellenunabhängig gebaut: `PositionSmoother` liest
// `state.motion` und extrapoliert; die Flugzeug-Brücke nutzt denselben Weg seit
// jeher (historisch unter `state.adsb`).
//
// Zu bauen war also nur diese Seite: WANN muss neu veröffentlicht werden?
//
// DIE ANTWORT — und der Fallstrick, der alles entscheidet:
//
//   Vorausgerechnet wird GERADEAUS. Ein konstanter Kurs beschreibt eine
//   Polylinie nur zwischen zwei Knicken. Wer bloß im Zeittakt veröffentlicht,
//   lässt Figuren Kurven schneiden — sie laufen durch Häuser, während der Agent
//   glaubt, sie folgten der Straße.
//
//   Deshalb ist der KNICK der wichtigste Auslöser, nicht die Zeit. Veröffentlicht
//   wird, wenn sich der Kurs merklich ändert, das Tempo merklich ändert, die
//   Bewegung beginnt oder endet — und sonst nur als Lebenszeichen.
//
// ZWEITER FALLSTRICK: `MAX_INTERP_MS = 1500` im PositionSmoother ist auf die
// heutigen 500-ms-Takte bemessen. Seltener zu schreiben OHNE `state.motion`
// lässt Objekte springen. Diese Datei schreibt deshalb IMMER beides —
// Position und Plan. Wer nur den Plan schickt, bricht jeden Betrachter, dessen
// Extrapolation gerade nicht greift.

/** Wie stark der Kurs sich ändern darf, bevor neu veröffentlicht wird (Grad). */
export const KURS_SCHWELLE_GRAD = 8

/** Wie stark das Tempo sich ändern darf (Anteil, 0.2 = 20 %). */
export const TEMPO_SCHWELLE = 0.2

/** Spätestens nach dieser Zeit ein Lebenszeichen (ms). */
export const LEBENSZEICHEN_MS = 10_000

/**
 * Wie weit die Vorausrechnung abweichen darf, bevor korrigiert wird (Meter).
 *
 * Auch ohne Knick läuft die Rechnung auseinander — Rundung, Netzlaufzeit, ein
 * Tick, der zu spät kam. Diese Schranke misst die tatsächliche Abweichung und
 * korrigiert, bevor sie sichtbar wird.
 */
export const DRIFT_M = 4

const R = 6371000
const gradToBog = (g) => g * Math.PI / 180
const bogToGrad = (b) => b * 180 / Math.PI

/** Kompass-Kurs (0 = Nord, im Uhrzeigersinn) zwischen zwei Punkten, in Grad. */
export function kursGrad(lat1, lon1, lat2, lon2) {
  const dLon = gradToBog(lon2 - lon1)
  const f1 = gradToBog(lat1), f2 = gradToBog(lat2)
  const y = Math.sin(dLon) * Math.cos(f2)
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dLon)
  return (bogToGrad(Math.atan2(y, x)) + 360) % 360
}

/** Abstand in Metern (äquirektangulare Näherung — auf diesen Skalen genau genug). */
export function abstandM(lat1, lon1, lat2, lon2) {
  const dLat = gradToBog(lat2 - lat1)
  const dLon = gradToBog(lon2 - lon1) * Math.cos(gradToBog((lat1 + lat2) / 2))
  return Math.sqrt(dLat * dLat + dLon * dLon) * R
}

/**
 * Kleinster Winkelabstand zweier Kurse in Grad (0…180).
 * 350° und 10° sind 20° auseinander, nicht 340° — ohne diesen Umlauf löste
 * jeder Durchgang durch Nord eine überflüssige Veröffentlichung aus.
 */
export function kursDifferenz(a, b) {
  return Math.abs(((a - b) % 360 + 540) % 360 - 180)
}

/**
 * Position aus einem Plan vorausrechnen — dieselbe Rechnung wie im Client.
 *
 * Hier absichtlich noch einmal: Der Agent muss wissen, was der BETRACHTER
 * gerade sieht, um die Abweichung zu messen. Läge die Rechnung nur im Client,
 * könnte er sie nicht prüfen.
 *
 * @param {{v:number, trk:number, lat0:number, lon0:number, alt0?:number, vrate?:number, t:number}} plan
 * @param {number} [jetzt]
 */
export function vorausrechnen(plan, jetzt = Date.now()) {
  const s = Math.max(0, (jetzt - plan.t) / 1000)
  const strecke = (Number(plan.v) || 0) * s
  const trk = gradToBog(Number(plan.trk) || 0)
  const cosLat = Math.cos(gradToBog(plan.lat0)) || 1e-6
  return {
    lat: plan.lat0 + (strecke * Math.cos(trk)) / 111320,
    lon: plan.lon0 + (strecke * Math.sin(trk)) / (111320 * cosLat),
    altitude: (Number(plan.alt0) || 0) + (Number(plan.vrate) || 0) * s,
  }
}

/**
 * Der Bewegungsplan einer Figur.
 *
 * Der Agent bewegt die Figur weiter wie bisher — er sagt nur nicht mehr bei
 * jedem Schritt Bescheid, sondern fragt `braucht()`, ob sich das Bild geändert
 * hat, das der Betrachter vor sich sieht.
 */
export class Bewegungsplan {
  /**
   * @param {{
   *   kursSchwelleGrad?: number,
   *   tempoSchwelle?: number,
   *   lebenszeichenMs?: number,
   *   driftM?: number,
   * }} [opts]
   */
  constructor({
    kursSchwelleGrad = KURS_SCHWELLE_GRAD,
    tempoSchwelle = TEMPO_SCHWELLE,
    lebenszeichenMs = LEBENSZEICHEN_MS,
    driftM = DRIFT_M,
  } = {}) {
    this.kursSchwelleGrad = kursSchwelleGrad
    this.tempoSchwelle = tempoSchwelle
    this.lebenszeichenMs = lebenszeichenMs
    this.driftM = driftM
    this.letzter = null      // zuletzt veröffentlichter Plan
  }

  /**
   * Muss der Betrachter etwas Neues erfahren?
   *
   * @param {{lat:number, lon:number, altitude?:number, v:number, trk:number, vrate?:number}} ist
   * @param {number} [jetzt]
   * @returns {{noetig: boolean, grund: string}}
   */
  braucht(ist, jetzt = Date.now()) {
    const l = this.letzter
    if (!l) return { noetig: true, grund: 'erster' }

    // Stillstand ist ein Zustandswechsel, kein Sonderfall: Wer stehenbleibt und
    // es nicht sagt, läuft beim Betrachter für immer weiter.
    const stehtJetzt = (Number(ist.v) || 0) < 0.05
    const stand = (Number(l.v) || 0) < 0.05
    if (stehtJetzt !== stand) return { noetig: true, grund: stehtJetzt ? 'angehalten' : 'losgelaufen' }
    if (stehtJetzt && stand) {
      return (jetzt - l.t) >= this.lebenszeichenMs
        ? { noetig: true, grund: 'lebenszeichen' }
        : { noetig: false, grund: 'steht' }
    }

    // Der Knick — der eigentliche Grund für diese ganze Datei.
    if (kursDifferenz(ist.trk, l.trk) >= this.kursSchwelleGrad) {
      return { noetig: true, grund: 'knick' }
    }

    const dv = Math.abs((Number(ist.v) || 0) - (Number(l.v) || 0))
    if (dv > Math.max(0.05, Math.abs(l.v) * this.tempoSchwelle)) {
      return { noetig: true, grund: 'tempo' }
    }

    // Auseinandergelaufen? Gegen das messen, was der Betrachter GERADE sieht.
    const soll = vorausrechnen(l, jetzt)
    if (abstandM(soll.lat, soll.lon, ist.lat, ist.lon) > this.driftM) {
      return { noetig: true, grund: 'drift' }
    }

    if ((jetzt - l.t) >= this.lebenszeichenMs) {
      return { noetig: true, grund: 'lebenszeichen' }
    }
    return { noetig: false, grund: 'unverändert' }
  }

  /**
   * Plan festschreiben und den `state.motion`-Teil zurückgeben.
   * Der Aufrufer baut daraus sein Update — er weiß, was sonst noch in `state`
   * gehört.
   */
  merke(ist, jetzt = Date.now()) {
    this.letzter = {
      v: Math.max(0, Number(ist.v) || 0),
      trk: ((Number(ist.trk) || 0) % 360 + 360) % 360,
      lat0: ist.lat,
      lon0: ist.lon,
      alt0: Number(ist.altitude) || 0,
      vrate: Number(ist.vrate) || 0,
      t: jetzt,
    }
    return { ...this.letzter }
  }

  /** Beim Anhalten: Plan auf Stillstand setzen, damit niemand weiterläuft. */
  haltAn(ist, jetzt = Date.now()) {
    return this.merke({ ...ist, v: 0, vrate: 0 }, jetzt)
  }

  /** Vergessen — die Figur wird nicht mehr geführt. */
  zuruecksetzen() { this.letzter = null }
}

/**
 * Bequemer Weg für den häufigsten Fall: Der Agent kennt die aktuelle und die
 * vorige Position und will wissen, ob und was er schreiben soll.
 *
 * Gibt `null` zurück, wenn nichts zu tun ist — der Aufrufer spart sich dann den
 * Schreibvorgang, und genau darum geht es.
 *
 * @returns {{lat, lon, altitude, state: {motion}} | null}
 */
export function bewegungsUpdate(plan, ist, basisState = {}, jetzt = Date.now()) {
  const { noetig, grund } = plan.braucht(ist, jetzt)
  if (!noetig) return null
  const motion = plan.merke(ist, jetzt)
  return {
    grund,
    lat: ist.lat,
    lon: ist.lon,
    altitude: Number(ist.altitude) || 0,
    // Position UND Plan: Betrachter ohne greifende Extrapolation (frisch
    // geladen, Karte, alter Client) brauchen weiterhin die nackte Position.
    state: { ...basisState, motion },
  }
}
