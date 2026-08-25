// yaw — Kompasskurs in Babylon-Drehung, an EINER Stelle.
//
// DER ANLASS: Es gab drei Umrechnungen für dieselbe Sache.
//
//   world-director   π − h              (Boden)
//   world-director   π − h + OFFSET     (Flug, mit Env-Regler als Notnagel)
//   adsb-/ais-Bridge h − π/2
//
// 90 Grad Unterschied, seit dem Audit am 2026-08-14 im Code vermerkt und nie
// aufgelöst. Bemerkt hat es niemand, weil Schiffe und Flugzeuge als Emoji-Tafel
// mit Kugel gezeichnet werden — eine Kugel hat keine Vorderseite. Sobald jemand
// einem Schiff ein Modell gibt, fährt es seitwärts.
//
// DIE HERLEITUNG, damit sie nachprüfbar ist statt empirisch gestimmt:
//
//   Achsen der Szene (GeoTransformer mit invertNorthSouth):
//     Ost  → +X
//     Nord → −Z
//   Bewegungsrichtung bei Kompasskurs h (0 = Nord, im Uhrzeigersinn):
//     d = (sin h, 0, −cos h)
//
//   Babylon dreht um Y so, dass +Z bei Yaw θ auf (sin θ, 0, cos θ) zeigt.
//   Für ein Modell mit Front auf +Z:
//     sin θ = sin h  und  cos θ = −cos h   →   θ = π − h
//
// Damit ist `π − h` richtig — die Boden-Formel des Directors. `h − π/2` passt
// zu einem Modell mit Front auf +X UND zur UNGEKIPPTEN Achsenlage (Z = Nord),
// die es hier nicht gibt; der Kommentar in der AIS-Brücke sagt das sogar selbst
// („matched die ungekippte GeoTransformer-Convention"). Unter der tatsächlichen
// Achsenlage wäre für +X-Front `π/2 − h` nötig — also gespiegelt zu dem, was
// dort steht.
//
// DIE TRENNLINIE, die daraus folgt und die vorher fehlte:
//
//   Agents rechnen IMMER mit der +Z-Konvention (diese Datei).
//   Modell-Eigenheiten korrigiert der CLIENT je Datei (MODEL_YAW_RAD in
//   engine/GameObject.js, auf einem Wrapper-Node).
//
// Ein Agent kann nicht wissen, wie herum ein GLB modelliert wurde — er kennt
// die Datei gar nicht. Jede Umrechnung, die das im Agent zu berücksichtigen
// versucht, ist an der falschen Stelle und driftet zwangsläufig auseinander.
// Genau das ist hier passiert.

/** Front eines Modells in seinem eigenen Raum — Vorgabe der Konvention. */
export const FRONT_Z = 'z'
export const FRONT_X = 'x'

/**
 * Kompasskurs (Radiant) → Babylon-Yaw.
 *
 * @param {number} kursRad  0 = Nord, im Uhrzeigersinn
 * @param {string} [front]  Front des Modells; Vorgabe +Z (siehe oben)
 * @returns {number} Yaw in Radiant, auf ±π normiert
 */
export function yawFuerKurs(kursRad, front = FRONT_Z) {
  const h = Number(kursRad) || 0
  const roh = front === FRONT_X ? (Math.PI / 2 - h) : (Math.PI - h)
  return normPi(roh)
}

/** Wie yawFuerKurs, aber der Kurs kommt in Grad (0…360). */
export function yawFuerKursGrad(kursGrad, front = FRONT_Z) {
  return yawFuerKurs((Number(kursGrad) || 0) * Math.PI / 180, front)
}

/**
 * Rückweg: Babylon-Yaw → Kompasskurs in Radiant.
 * Gebraucht, wo aus einer gespeicherten Drehung wieder eine Richtung werden
 * muss (Editor, Diagnose).
 */
export function kursFuerYaw(yawRad, front = FRONT_Z) {
  const y = Number(yawRad) || 0
  const roh = front === FRONT_X ? (Math.PI / 2 - y) : (Math.PI - y)
  return (roh % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
}

/** Winkel auf (−π, π] normieren. */
export function normPi(a) {
  let x = (Number(a) || 0) % (Math.PI * 2)
  if (x > Math.PI) x -= Math.PI * 2
  if (x <= -Math.PI) x += Math.PI * 2
  return x
}

/**
 * Einheitsvektor der Bewegungsrichtung in Szenenkoordinaten.
 * Nur für Prüfungen und Diagnose — die Engine braucht ihn nicht, aber ohne ihn
 * ließe sich die Herleitung oben nicht nachrechnen.
 */
export function richtungFuerKurs(kursRad) {
  const h = Number(kursRad) || 0
  return { x: Math.sin(h), y: 0, z: -Math.cos(h) }
}

/**
 * Wohin ein Modell bei gegebenem Yaw schaut (Szenenkoordinaten).
 * Bildet Babylons Drehung um Y nach: +Z → (sin θ, 0, cos θ).
 */
export function blickFuerYaw(yawRad, front = FRONT_Z) {
  const t = Number(yawRad) || 0
  return front === FRONT_X
    ? { x: Math.cos(t), y: 0, z: -Math.sin(t) }
    : { x: Math.sin(t), y: 0, z: Math.cos(t) }
}
