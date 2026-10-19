// geopose — OGC GeoPose 1.0 in beide Richtungen, an EINER Stelle.
//
// WARUM ES DIESE DATEI GIBT. Nicht der Interoperabilität zuliebe — die ist das
// Nebenprodukt. Ajna trägt seine Achsen- und Drehkonvention implizit über
// Babylon, das Geo-System und die Agents verteilt, und genau das hat schon
// einmal einen Fehler gekostet: drei verschiedene Umrechnungen für dieselbe
// Sache, 90 Grad Unterschied, zwei Jahre unbemerkt, weil Kugeln keine
// Vorderseite haben (siehe den Kopf von `yaw.js`). Eine fremde Norm mit einer
// fremden Testsuite ist der billigste Weg, diese Konvention festzunageln.
//
// DIE NORM. OGC GeoPose 1.0 (21-056r11), zwei einfache Zielformen, hier gegen
// die veröffentlichten JSON-Schemata gebaut:
//
//   Basic-YPR         { position: {lat, lon, h}, angles: {yaw, pitch, roll} }
//   Basic-Quaternion  { position: {lat, lon, h}, quaternion: {x, y, z, w} }
//
// Alle Felder sind Pflicht. Winkel in GRAD, Drehungen um die Achsen z, y, x in
// dieser Reihenfolge. Der äussere Rahmen ist WGS-84 (EPSG 4979), der innere ein
// lokales ENU: **Ost → X, Nord → Y, Hoch → Z**.
//
// ─── DIE ZWEI STELLEN, AN DENEN ES SCHIEFGEHT ───────────────────────────────
//
// 1. DIE ACHSEN SIND NICHT DIE VON AJNA. Die Szene ist (laut `yaw.js`, dort
//    hergeleitet und nicht gestimmt):
//
//      Ost → +X     Hoch → +Y     Nord → −Z
//
//    ENU ist Ost → X, Nord → Y, Hoch → Z. Die Abbildung ist damit
//
//      x_ENU = x_Szene      y_ENU = −z_Szene      z_ENU = y_Szene
//
//    also eine Drehung um +90° um X, Determinante +1 — eine echte Drehung,
//    keine Spiegelung. Das ist nicht selbstverständlich und wird unten geprüft:
//    wäre es eine Spiegelung, kämen alle Drehungen verkehrt heraus.
//
// 2. GEOPOSE-YAW IST KEIN KOMPASSKURS. Der innere Rahmen hat bei
//    Yaw=Pitch=Roll=0 dieselben Achsen wie ENU, und „Pitch um y, Roll um x"
//    ergibt nur Sinn, wenn **+X die Vorwärtsrichtung** ist (Roll um die
//    Längsachse, Pitch um die Querachse). Bei Yaw 0 schaut ein Körper also nach
//    OSTEN, und Yaw läuft mathematisch positiv um Hoch, also gegen den
//    Uhrzeigersinn. Ein Kompasskurs läuft von Nord im Uhrzeigersinn. Daraus:
//
//      yaw = 90° − kurs       und, weil selbstinvers:  kurs = 90° − yaw
//
//    Das ist genau die Verwechslung, die in `yaw.js` schon als `h − π/2` gegen
//    `π − h` dokumentiert ist. Sie kostet 90 Grad und fällt nicht auf, solange
//    niemand ein Modell mit Vorderseite benutzt.
//
//    ACHTUNG, DAS IST EINE FOLGERUNG UND KEIN ZITAT. Die Feldnamen, die
//    Einheit (Grad) und die Reihenfolge (z, y, x) stehen in den
//    veröffentlichten Schemata und im Normtext. Dass die VORWÄRTSACHSE des
//    inneren Rahmens +X ist, habe ich daraus geschlossen, dass „Pitch um y,
//    Roll um x" nur so zusammenpasst — nachlesen konnte ich es nicht, die
//    HTML-Fassung der Norm trägt eingebettete Bilder und war nicht am Stück
//    lesbar. Sollte eine Prüfung gegen die OGC-Konformitätssuite etwas anderes
//    ergeben, ist `headingToYaw()` die EINZIGE Stelle, die sich ändert — genau
//    dafür steht die Umrechnung dort allein und nicht verteilt.
//    Suite: https://cite.opengeospatial.org/te2/about/geopose10/1.0/site/
//
// ─── WAS DIESES MODUL BEWUSST NICHT TUT ─────────────────────────────────────
//
// Es rät NICHT, was Babylons `rotation.x` und `rotation.z` in GeoPose-Begriffen
// bedeuten. Das hängt davon ab, wie herum ein Modell gebaut wurde, und der
// Agent kennt die Datei gar nicht — dieselbe Trennlinie, die `yaw.js` zieht.
// Ein Datensatz mit Pitch oder Roll kommt deshalb mit einem ausdrücklichen
// Hinweis zurück, statt still falsch zu werden. Wer Pitch und Roll in
// GeoPose-Begriffen kennt, benutzt `geoPoseFrom()` und gibt sie an.
//
// Und es erfindet KEINE HÖHE. Ajnas `altitude` ist Meter ÜBER GRUND
// (`state.altitude_ref === 'msl'` schaltet auf Meereshöhe), GeoPose `h` ist
// ellipsoidische Höhe. Ohne Geländehöhe am Ort ist die Umrechnung nicht
// möglich; dann bleibt `h` null und `heightKnown` false. Eine Höhe über Grund
// als ellipsoidische Höhe auszugeben wäre eine Lüge in einem normgerechten
// Umschlag — die schlimmste Sorte Fehler, weil sie gültig aussieht.

import { kursFuerYaw, yawFuerKurs, normPi } from './yaw.js'

const DEG = 180 / Math.PI
const RAD = Math.PI / 180

/** Die beiden Zielformen, benannt wie in der Norm. */
export const FORM_QUATERNION = 'quaternion'
export const FORM_YPR = 'ypr'

/** Adressen der normativen Schemata — für Doku und Prüfwerkzeuge. */
export const SCHEMATA = {
  [FORM_YPR]: 'https://schemas.opengis.net/geopose/1.0/schemata/GeoPose.Basic.YPR.Schema.json',
  [FORM_QUATERNION]: 'https://schemas.opengis.net/geopose/1.0/schemata/GeoPose.Basic.Quaternion.Schema.json',
}

/**
 * Abbildung Szene → ENU, als Zeilen (ENU-Komponente aus Szenen-Komponenten).
 * Exportiert, weil ein Test nachrechnen können muss, dass sie eine DREHUNG ist
 * (Determinante +1) und keine Spiegelung.
 */
export const ENU_FROM_SCENE = [
  [1, 0, 0],   // Ost  = Ost
  [0, 0, -1],  // Nord = −Süd
  [0, 1, 0],   // Hoch = Hoch
]

// `+ 0` macht aus −0 eine 0. Kosmetik? Nein: −0 überlebt Rechnungen, und ein
// Aufrufer, der zwei Vektoren mit deepStrictEqual vergleicht, bekommt sonst
// einen Fehlschlag, den niemand versteht. In JSON sieht man den Unterschied
// nicht, in Tests sehr wohl.
const null0 = (v) => v + 0

/** Ein Szenen-Vektor in ENU. */
export function enuFromScene({ x = 0, y = 0, z = 0 } = {}) {
  return { x: null0(x), y: null0(-z), z: null0(y) }
}

/** Zurück: ein ENU-Vektor in Szenenkoordinaten. */
export function sceneFromEnu({ x = 0, y = 0, z = 0 } = {}) {
  return { x: null0(x), y: null0(z), z: null0(-y) }
}

/** Auf [0, 360) bringen. */
export function norm360(deg) {
  const d = Number(deg) || 0
  return ((d % 360) + 360) % 360
}

/**
 * Kompasskurs (Grad, 0 = Nord, im Uhrzeigersinn) → GeoPose-Yaw (Grad).
 * Selbstinvers — derselbe Aufruf führt zurück. Siehe Punkt 2 im Kopf.
 */
export function headingToYaw(headingDeg) {
  return norm360(90 - (Number(headingDeg) || 0))
}

/** GeoPose-Yaw (Grad) → Kompasskurs (Grad). Dieselbe Rechnung. */
export const yawToHeading = headingToYaw

// ─── Quaternionen ──────────────────────────────────────────────────────────
// Eigene Umsetzung statt Babylon: dieses Modul läuft auch in den Agents, und
// die haben kein Babylon. Die Formeln sind Standard; geprüft wird sie gegen die
// geometrischen Zusicherungen aus `yaw.js`, nicht gegen sich selbst.

/** Hamilton-Produkt a ⊗ b. */
export function qMul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  }
}

/** Auf Einheitslänge bringen. Die Norm verlangt sie ausdrücklich. */
export function qNormalise(q) {
  const n = Math.hypot(q.x, q.y, q.z, q.w)
  if (!(n > 0)) return { x: 0, y: 0, z: 0, w: 1 }
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n }
}

/**
 * Eindeutige Schreibweise: `w ≥ 0`.
 *
 * q und −q sind DIESELBE Drehung — die Norm verlangt hier nichts. Aber ohne
 * eine festgelegte Wahl ergeben zwei gleiche Lagen unterschiedliches JSON, und
 * dann schlagen Vergleiche, Zwischenspeicher und Änderungsprüfungen grundlos
 * an. Also eine Wahl treffen, statt es dem Zufall der Rechnung zu lassen.
 */
export function qCanonical(q) {
  const n = qNormalise(q)
  if (!(n.w < 0)) return n
  // `+ 0` gegen −0: beim Negieren wird aus 0 sonst −0, und `assert.strictEqual`
  // (wie `Object.is`) unterscheidet die beiden. Siehe `null0` oben.
  return { x: null0(-n.x), y: null0(-n.y), z: null0(-n.z), w: null0(-n.w) }
}

/**
 * Yaw/Pitch/Roll (Grad) → Quaternion, Drehungen um z, y, x in dieser
 * Reihenfolge, wie die Norm es sagt.
 */
export function quaternionFromYpr({ yaw = 0, pitch = 0, roll = 0 } = {}) {
  const hz = (Number(yaw) || 0) * RAD / 2
  const hy = (Number(pitch) || 0) * RAD / 2
  const hx = (Number(roll) || 0) * RAD / 2
  const qz = { x: 0, y: 0, z: Math.sin(hz), w: Math.cos(hz) }
  const qy = { x: 0, y: Math.sin(hy), z: 0, w: Math.cos(hy) }
  const qx = { x: Math.sin(hx), y: 0, z: 0, w: Math.cos(hx) }
  return qCanonical(qMul(qMul(qz, qy), qx))
}

/** Quaternion → Drehmatrix (Zeilen). */
export function matrixFromQuaternion(q) {
  const { x, y, z, w } = qNormalise(q)
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ]
}

/**
 * Quaternion → Yaw/Pitch/Roll (Grad), passend zu `quaternionFromYpr`.
 *
 * BEI PITCH ±90° IST ES ENTARTET („gimbal lock"): Yaw und Roll beschreiben dort
 * dieselbe Drehung, und `atan2(0, 0)` wäre bedeutungslos. Dann wird der Roll
 * auf 0 gelegt und alles in den Yaw gefaltet — das ist die übliche Wahl und
 * liefert dieselbe Drehung zurück, nur nicht dieselben Zahlen.
 */
export function yprFromQuaternion(q) {
  const m = matrixFromQuaternion(q)
  const sinPitch = -m[2][0]
  const grenze = 1 - 1e-9
  if (sinPitch > grenze || sinPitch < -grenze) {
    const pitch = sinPitch > 0 ? 90 : -90
    const yaw = Math.atan2(-m[0][1], m[1][1]) * DEG
    return { yaw: norm360(yaw), pitch, roll: 0, degenerate: true }
  }
  return {
    yaw: norm360(Math.atan2(m[1][0], m[0][0]) * DEG),
    pitch: Math.asin(sinPitch) * DEG,
    roll: Math.atan2(m[2][1], m[2][2]) * DEG,
  }
}

/** Einen ENU-Vektor mit einem Quaternion drehen. */
export function rotateEnu(q, v) {
  const m = matrixFromQuaternion(q)
  return {
    x: m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
    y: m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
    z: m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
  }
}

/**
 * Wohin ein Körper schaut, in ENU. Die Vorwärtsachse des inneren Rahmens ist
 * +X (siehe Punkt 2 im Kopf), also die erste Spalte der Drehmatrix.
 */
export function forwardEnu(q) {
  const m = matrixFromQuaternion(q)
  return { x: m[0][0], y: m[1][0], z: m[2][0] }
}

// ─── Bauen ─────────────────────────────────────────────────────────────────

/**
 * Eine GeoPose aus ausdrücklichen Angaben. Der Weg für Aufrufer, die Pitch und
 * Roll in GeoPose-Begriffen KENNEN — dieses Modul rät sie nicht.
 *
 * @param {object} o
 * @param {number} o.lat
 * @param {number} o.lon
 * @param {number} o.h          ellipsoidische Höhe in Metern
 * @param {number} [o.headingDeg]  Kompasskurs, 0 = Nord, im Uhrzeigersinn
 * @param {number} [o.yawDeg]      alternativ direkt der GeoPose-Yaw
 * @param {number} [o.pitchDeg]
 * @param {number} [o.rollDeg]
 * @param {string} [o.form]
 */
export function geoPoseFrom(o = {}) {
  const form = o.form === FORM_YPR ? FORM_YPR : FORM_QUATERNION
  const yaw = o.yawDeg != null ? norm360(o.yawDeg) : headingToYaw(o.headingDeg || 0)
  const pitch = Number(o.pitchDeg) || 0
  const roll = Number(o.rollDeg) || 0
  const position = {
    lat: Number(o.lat) || 0,
    lon: Number(o.lon) || 0,
    h: Number(o.h) || 0,
  }
  if (form === FORM_YPR) return { position, angles: { yaw, pitch, roll } }
  return { position, quaternion: quaternionFromYpr({ yaw, pitch, roll }) }
}

/**
 * Ein Ajna-Objekt als GeoPose.
 *
 * @param {object} record  Objekt-Datensatz (lat, lon, altitude, rotation, state)
 * @param {object} [opts]
 * @param {string} [opts.form]
 * @param {number|null} [opts.groundH]  ellipsoidische Höhe des GELÄNDES am Ort.
 *   Ohne sie ist eine Höhe über Grund nicht umrechenbar — siehe Kopf.
 * @param {number} [opts.geoidOffset]   Geoidundulation, falls `altitude_ref`
 *   auf `msl` steht: ellipsoidisch = MSL + Undulation (in Deutschland rund
 *   +45 m). Ohne Angabe 0, und das wird im Ergebnis vermerkt.
 * @returns {{geopose: object, heightKnown: boolean, notes: string[]}}
 */
export function toGeoPose(record, opts = {}) {
  const { form = FORM_QUATERNION, groundH = null, geoidOffset = 0 } = opts
  const notes = []

  const lat = Number(record?.lat) || 0
  const lon = Number(record?.lon) || 0
  const altitude = Number(record?.altitude) || 0
  const ref = record?.state?.altitude_ref === 'msl' ? 'msl' : 'ground'

  // Höhe: nur ausgeben, was wirklich eine ellipsoidische Höhe ist.
  let h = 0
  let heightKnown = false
  if (ref === 'msl') {
    h = altitude + (Number(geoidOffset) || 0)
    heightKnown = true
    if (!geoidOffset) {
      notes.push('Höhe aus MSL ohne Geoidundulation übernommen — in Deutschland '
        + 'rund 45 m zu niedrig. geoidOffset angeben, wenn es auf Meter ankommt.')
    }
  // `groundH != null` MUSS DAVOR STEHEN. `Number(null)` ist 0, nicht NaN —
  // `Number.isFinite(Number(null))` ist also true, und eine fehlende
  // Geländehöhe hätte als Meereshöhe 0 gegolten. Die Höhe wäre dann „bekannt"
  // und um die Geländehöhe falsch gewesen, in einem normgerechten Umschlag.
  // Dieselbe Falle hat in `kvm.mjs` schon einmal einen Eintrag in den Golf von
  // Guinea gesetzt; ein Test hat sie hier gefangen.
  } else if (groundH != null && Number.isFinite(Number(groundH))) {
    h = Number(groundH) + altitude
    heightKnown = true
  } else {
    notes.push('altitude ist Meter über Grund und ohne Geländehöhe nicht in eine '
      + 'ellipsoidische Höhe umrechenbar — h bleibt 0. groundH angeben.')
  }

  // Drehung: nur der Yaw, und der über die festgenagelte Umrechnung in yaw.js.
  const rot = record?.rotation || {}
  const headingRad = kursFuerYaw(Number(rot.y) || 0)
  const yaw = headingToYaw(headingRad * DEG)

  const pitchRot = Number(rot.x) || 0
  const rollRot = Number(rot.z) || 0
  if (Math.abs(normPi(pitchRot)) > 1e-6 || Math.abs(normPi(rollRot)) > 1e-6) {
    notes.push('rotation.x/rotation.z sind gesetzt und wurden NICHT übernommen: '
      + 'was sie in GeoPose-Begriffen bedeuten, hängt davon ab, wie das Modell '
      + 'gebaut ist. Mit geoPoseFrom() ausdrücklich angeben.')
  }

  return {
    geopose: geoPoseFrom({ lat, lon, h, yawDeg: yaw, form }),
    heightKnown,
    notes,
  }
}

/**
 * Eine GeoPose in Ajna-Felder.
 *
 * Die Höhe kommt als `altitude` mit `altitude_ref: 'msl'` zurück — das ist die
 * einzige der beiden Ajna-Lesarten, die ohne Geländehöhe stimmt. Wer „über
 * Grund" braucht, zieht die Geländehöhe selbst ab.
 *
 * @returns {{lat, lon, altitude, rotation: {x,y,z}, altitude_ref: string,
 *            headingDeg: number, pitchDeg: number, rollDeg: number}}
 */
export function fromGeoPose(gp) {
  const pos = gp?.position || {}
  const ypr = gp?.angles
    ? {
        yaw: Number(gp.angles.yaw) || 0,
        pitch: Number(gp.angles.pitch) || 0,
        roll: Number(gp.angles.roll) || 0,
      }
    : yprFromQuaternion(gp?.quaternion || { x: 0, y: 0, z: 0, w: 1 })

  const headingDeg = yawToHeading(ypr.yaw)
  return {
    lat: Number(pos.lat) || 0,
    lon: Number(pos.lon) || 0,
    altitude: Number(pos.h) || 0,
    altitude_ref: 'msl',
    // Nur der Yaw wandert in die Szene — aus demselben Grund wie oben.
    rotation: { x: 0, y: yawFuerKurs(headingDeg * RAD), z: 0 },
    headingDeg,
    pitchDeg: ypr.pitch,
    rollDeg: ypr.roll,
  }
}

// ─── Prüfen ────────────────────────────────────────────────────────────────

/**
 * Erfüllt das Objekt eines der beiden Schemata? Liefert eine Liste von
 * Beanstandungen — leer heisst gültig.
 *
 * Bewusst streng bei den PFLICHTFELDERN: die Norm verlangt alle drei Winkel
 * bzw. alle vier Quaternion-Glieder, und ein fehlendes Feld als 0 zu lesen
 * wäre eine erfundene Lage.
 */
export function validateGeoPose(gp) {
  const probleme = []
  if (!gp || typeof gp !== 'object') return ['kein Objekt']

  const p = gp.position
  if (!p || typeof p !== 'object') probleme.push('position fehlt')
  else {
    for (const k of ['lat', 'lon', 'h']) {
      if (!Number.isFinite(Number(p[k]))) probleme.push(`position.${k} fehlt oder ist keine Zahl`)
    }
    if (Number.isFinite(Number(p.lat)) && Math.abs(Number(p.lat)) > 90) probleme.push('lat ausserhalb ±90')
    if (Number.isFinite(Number(p.lon)) && Math.abs(Number(p.lon)) > 180) probleme.push('lon ausserhalb ±180')
  }

  const hatWinkel = gp.angles && typeof gp.angles === 'object'
  const hatQuat = gp.quaternion && typeof gp.quaternion === 'object'
  if (!hatWinkel && !hatQuat) probleme.push('weder angles noch quaternion')
  if (hatWinkel && hatQuat) probleme.push('angles UND quaternion — die Norm kennt je Form genau eine')

  if (hatWinkel) {
    for (const k of ['yaw', 'pitch', 'roll']) {
      if (!Number.isFinite(Number(gp.angles[k]))) probleme.push(`angles.${k} fehlt oder ist keine Zahl`)
    }
  }
  if (hatQuat) {
    for (const k of ['x', 'y', 'z', 'w']) {
      if (!Number.isFinite(Number(gp.quaternion[k]))) probleme.push(`quaternion.${k} fehlt oder ist keine Zahl`)
    }
    const n = Math.hypot(
      Number(gp.quaternion.x) || 0, Number(gp.quaternion.y) || 0,
      Number(gp.quaternion.z) || 0, Number(gp.quaternion.w) || 0)
    if (Number.isFinite(n) && Math.abs(n - 1) > 1e-6) {
      probleme.push(`quaternion ist nicht normiert (Länge ${n.toFixed(6)})`)
    }
  }
  return probleme
}

/** Welche Form liegt vor? null, wenn keine passt. */
export function geoPoseForm(gp) {
  if (gp?.angles && !gp?.quaternion) return FORM_YPR
  if (gp?.quaternion && !gp?.angles) return FORM_QUATERNION
  return null
}
