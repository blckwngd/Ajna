// Tests für client/core/geopose.js.
//
// WOGEGEN HIER GEPRÜFT WIRD. Nicht gegen die eigene Rechnung — das wäre
// zirkulär und würde genau den Fehler durchlassen, um dessen Vermeidung es
// geht. Geprüft wird gegen die geometrischen Zusicherungen, die `yaw.js`
// hergeleitet hat und die unabhängig nachrechenbar sind:
//
//   richtungFuerKurs(h) = (sin h, 0, −cos h)   Szenen-Richtung bei Kurs h
//   blickFuerYaw(θ)     = (sin θ, 0, cos θ)    wohin +Z bei Yaw θ schaut
//
// Diese beiden sind der Maßstab. Stimmt die GeoPose-Umrechnung mit ihnen
// überein, ist sie richtig; stimmt sie nur mit sich selbst, ist sie rund.
//
// DIE ZWEI ERWARTETEN FALLEN, auf die es besonders ankommt:
//   1. die Achsenabbildung Szene → ENU muss eine DREHUNG sein, keine Spiegelung
//   2. GeoPose-Yaw ist kein Kompasskurs (yaw = 90° − kurs)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { richtungFuerKurs, blickFuerYaw, yawFuerKurs, kursFuerYaw } from './yaw.js'
import {
  ENU_FROM_SCENE, enuFromScene, sceneFromEnu, norm360,
  headingToYaw, yawToHeading,
  quaternionFromYpr, yprFromQuaternion, matrixFromQuaternion,
  qMul, qNormalise, qCanonical, rotateEnu, forwardEnu,
  geoPoseFrom, toGeoPose, fromGeoPose, validateGeoPose, geoPoseForm,
  FORM_YPR, FORM_QUATERNION, SCHEMATA,
} from './geopose.js'

const DEG = 180 / Math.PI
const RAD = Math.PI / 180
const nahe = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps

/** Determinante einer 3×3-Matrix (Zeilen). */
const det3 = (m) =>
  m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
  - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
  + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])

// ─── Falle 1: die Achsenabbildung ─────────────────────────────────────────

test('DIE ABBILDUNG SZENE→ENU IST EINE DREHUNG, KEINE SPIEGELUNG', () => {
  // Determinante −1 hiesse Spiegelung, und dann käme JEDE Drehung verkehrt
  // heraus — der Fehler, den man erst sieht, wenn ein Modell eine Vorderseite
  // hat. Genau so ist es in diesem Projekt schon einmal passiert.
  assert.ok(nahe(det3(ENU_FROM_SCENE), 1), `Determinante ${det3(ENU_FROM_SCENE)}`)
})

test('die Achsen liegen einzeln richtig', () => {
  // Szene: Ost → +X, Hoch → +Y, Nord → −Z (aus yaw.js).
  assert.deepEqual(enuFromScene({ x: 1, y: 0, z: 0 }), { x: 1, y: 0, z: 0 }, 'Ost')
  assert.deepEqual(enuFromScene({ x: 0, y: 0, z: -1 }), { x: 0, y: 1, z: 0 }, 'Nord')
  assert.deepEqual(enuFromScene({ x: 0, y: 1, z: 0 }), { x: 0, y: 0, z: 1 }, 'Hoch')
})

test('hin und zurück ändert nichts', () => {
  for (const v of [{ x: 1, y: 2, z: 3 }, { x: -4, y: 0.5, z: -6 }]) {
    assert.deepEqual(sceneFromEnu(enuFromScene(v)), v)
  }
})

test('[MASSSTAB] die Bewegungsrichtung aus yaw.js stimmt in ENU', () => {
  // richtungFuerKurs ist in yaw.js hergeleitet. In ENU muss bei Kurs h die
  // Richtung (sin h, cos h, 0) herauskommen — Ost-Anteil sin h, Nord-Anteil
  // cos h. Das ist der unabhängige Maßstab für alles Weitere.
  for (const kursGrad of [0, 45, 90, 180, 270, 315]) {
    const h = kursGrad * RAD
    const enu = enuFromScene(richtungFuerKurs(h))
    assert.ok(nahe(enu.x, Math.sin(h), 1e-12), `Kurs ${kursGrad}: Ost ${enu.x}`)
    assert.ok(nahe(enu.y, Math.cos(h), 1e-12), `Kurs ${kursGrad}: Nord ${enu.y}`)
    assert.ok(nahe(enu.z, 0, 1e-12), `Kurs ${kursGrad}: Hoch ${enu.z}`)
  }
})

// ─── Falle 2: Yaw ist kein Kurs ───────────────────────────────────────────

test('GEOPOSE-YAW IST KEIN KOMPASSKURS', () => {
  // Nord ist Kurs 0, aber Yaw 90 — weil die Vorwärtsachse des inneren Rahmens
  // +X ist (also Ost bei Yaw 0) und Yaw gegen den Uhrzeigersinn läuft.
  assert.equal(headingToYaw(0), 90, 'Nord')
  assert.equal(headingToYaw(90), 0, 'Ost')
  assert.equal(headingToYaw(180), 270, 'Süd')
  assert.equal(headingToYaw(270), 180, 'West')
})

test('die Umrechnung ist selbstinvers', () => {
  for (const d of [0, 1, 45, 89.9, 90, 180, 270, 359.5]) {
    assert.ok(nahe(norm360(yawToHeading(headingToYaw(d))), norm360(d), 1e-9), `${d}`)
  }
})

test('negative und übergroße Winkel landen in [0,360)', () => {
  assert.equal(norm360(-90), 270)
  assert.equal(norm360(720), 0)
  assert.equal(headingToYaw(-10), 100)
  assert.equal(headingToYaw(450), 0)
})

// ─── Quaternionen gegen die Geometrie ─────────────────────────────────────

test('[MASSSTAB] bei Kurs h schaut der Körper in ENU nach (sin h, cos h, 0)', () => {
  // Der eigentliche Beweis, dass yaw = 90° − kurs richtig ist: die
  // Vorwärtsachse des gedrehten Rahmens muss dorthin zeigen, wohin yaw.js die
  // Bewegung schickt.
  for (const kursGrad of [0, 30, 90, 137, 180, 225, 270, 359]) {
    const q = quaternionFromYpr({ yaw: headingToYaw(kursGrad) })
    const f = forwardEnu(q)
    const h = kursGrad * RAD
    assert.ok(nahe(f.x, Math.sin(h), 1e-12), `Kurs ${kursGrad}: Ost ${f.x} statt ${Math.sin(h)}`)
    assert.ok(nahe(f.y, Math.cos(h), 1e-12), `Kurs ${kursGrad}: Nord ${f.y} statt ${Math.cos(h)}`)
    assert.ok(nahe(f.z, 0, 1e-12), `Kurs ${kursGrad}: Hoch ${f.z}`)
  }
})

test('ein Kurs nach Osten dreht nach RECHTS, nicht nach links', () => {
  // Der Vorzeichenfehler, der sich sonst erst zeigt, wenn etwas eine
  // Vorderseite hat: Nord → Ost muss im Uhrzeigersinn gehen.
  const nord = forwardEnu(quaternionFromYpr({ yaw: headingToYaw(0) }))
  const ost = forwardEnu(quaternionFromYpr({ yaw: headingToYaw(90) }))
  assert.ok(nahe(nord.y, 1, 1e-12) && nahe(nord.x, 0, 1e-12))
  assert.ok(nahe(ost.x, 1, 1e-12) && nahe(ost.y, 0, 1e-12))
})

test('Quaternionen sind normiert, wie die Norm es verlangt', () => {
  for (const ypr of [{}, { yaw: 37 }, { yaw: 10, pitch: 20, roll: 30 }, { pitch: -90 }]) {
    const q = quaternionFromYpr(ypr)
    assert.ok(nahe(Math.hypot(q.x, q.y, q.z, q.w), 1, 1e-12), JSON.stringify(ypr))
  }
})

test('Yaw/Pitch/Roll überleben den Weg durch das Quaternion', () => {
  for (const ypr of [
    { yaw: 0, pitch: 0, roll: 0 },
    { yaw: 90, pitch: 0, roll: 0 },
    { yaw: 280.612, pitch: 28.7, roll: 0 },   // Beispielwerte aus der OGC-Diskussion
    { yaw: 10, pitch: -20, roll: 30 },
    { yaw: 359, pitch: 45, roll: -45 },
  ]) {
    const back = yprFromQuaternion(quaternionFromYpr(ypr))
    assert.ok(nahe(back.yaw, norm360(ypr.yaw), 1e-6), `yaw ${back.yaw} statt ${ypr.yaw}`)
    assert.ok(nahe(back.pitch, ypr.pitch, 1e-6), `pitch ${back.pitch} statt ${ypr.pitch}`)
    assert.ok(nahe(back.roll, ypr.roll, 1e-6), `roll ${back.roll} statt ${ypr.roll}`)
  }
})

test('bei Pitch ±90 wird die Entartung GEMELDET, nicht verschwiegen', () => {
  // Dort beschreiben Yaw und Roll dieselbe Drehung. Zahlen zurückzugeben, als
  // wären sie eindeutig, wäre die unangenehmere Antwort.
  for (const p of [90, -90]) {
    const r = yprFromQuaternion(quaternionFromYpr({ yaw: 40, pitch: p, roll: 25 }))
    assert.equal(r.degenerate, true, `pitch ${p}`)
    assert.ok(nahe(r.pitch, p, 1e-6))
    assert.equal(r.roll, 0)
  }
})

test('die entartete Lage ist trotzdem DIESELBE Drehung', () => {
  // Andere Zahlen, gleiche Wirkung — das ist die Zusicherung, die zählt.
  const q = quaternionFromYpr({ yaw: 40, pitch: 90, roll: 25 })
  const r = yprFromQuaternion(q)
  const q2 = quaternionFromYpr(r)
  const f1 = forwardEnu(q), f2 = forwardEnu(q2)
  for (const k of ['x', 'y', 'z']) assert.ok(nahe(f1[k], f2[k], 1e-6), k)
})

test('die Drehmatrix ist orthogonal mit Determinante +1', () => {
  const m = matrixFromQuaternion(quaternionFromYpr({ yaw: 33, pitch: 14, roll: -7 }))
  assert.ok(nahe(det3(m), 1, 1e-12), `det ${det3(m)}`)
  for (let i = 0; i < 3; i++) {
    assert.ok(nahe(Math.hypot(...m[i]), 1, 1e-12), `Zeile ${i}`)
  }
})

test('die Schreibweise ist eindeutig: w ist nie negativ', () => {
  // q und −q sind dieselbe Drehung. Ohne festgelegte Wahl ergäben zwei gleiche
  // Lagen unterschiedliches JSON, und Vergleiche schlügen grundlos an.
  for (const kursGrad of [0, 60, 151.35, 200, 300, 359]) {
    const q = quaternionFromYpr({ yaw: headingToYaw(kursGrad) })
    assert.ok(q.w >= 0, `Kurs ${kursGrad}: w = ${q.w}`)
  }
  const gedreht = qCanonical({ x: 0, y: 0, z: -0.5101835, w: -0.8600656 })
  assert.ok(gedreht.w > 0)
})

test('die eindeutige Schreibweise ändert die DREHUNG nicht', () => {
  const q = { x: 0, y: 0, z: 0.5101835264862, w: -0.86006556104875 }
  const f1 = forwardEnu(q), f2 = forwardEnu(qCanonical(q))
  for (const k of ['x', 'y', 'z']) assert.ok(nahe(f1[k], f2[k], 1e-12), k)
})

test('qMul und qNormalise verhalten sich wie erwartet', () => {
  const eins = { x: 0, y: 0, z: 0, w: 1 }
  const q = quaternionFromYpr({ yaw: 55 })
  const p = qMul(q, eins)
  for (const k of ['x', 'y', 'z', 'w']) assert.ok(nahe(p[k], q[k], 1e-12), k)
  // Ein Null-Quaternion ist keine Drehung; qNormalise darf nicht NaN liefern.
  assert.deepEqual(qNormalise({ x: 0, y: 0, z: 0, w: 0 }), eins)
})

test('rotateEnu dreht Hoch nicht weg, solange nur Yaw gesetzt ist', () => {
  const q = quaternionFromYpr({ yaw: 123 })
  const up = rotateEnu(q, { x: 0, y: 0, z: 1 })
  assert.ok(nahe(up.z, 1, 1e-12) && nahe(up.x, 0, 1e-12) && nahe(up.y, 0, 1e-12))
})

// ─── Ajna-Datensatz → GeoPose ─────────────────────────────────────────────

const objekt = (ue = {}) => ({
  lat: 50.3591, lon: 7.5932, altitude: 0,
  rotation: { x: 0, y: 0, z: 0 },
  state: {},
  ...ue,
})

test('der Yaw kommt über die festgenagelte Umrechnung aus yaw.js', () => {
  // Ein Objekt, das nach Norden schaut: Babylon-Yaw = yawFuerKurs(0) = π.
  const rec = objekt({ rotation: { x: 0, y: yawFuerKurs(0), z: 0 }, state: { altitude_ref: 'msl' } })
  const { geopose } = toGeoPose(rec, { form: FORM_YPR })
  assert.ok(nahe(geopose.angles.yaw, 90, 1e-6), `yaw ${geopose.angles.yaw}`)
})

test('[MASSSTAB] für vier Himmelsrichtungen stimmt die Blickrichtung', () => {
  for (const [name, kursGrad] of [['Nord', 0], ['Ost', 90], ['Süd', 180], ['West', 270]]) {
    const rec = objekt({
      rotation: { x: 0, y: yawFuerKurs(kursGrad * RAD), z: 0 },
      state: { altitude_ref: 'msl' },
    })
    const { geopose } = toGeoPose(rec)
    const f = forwardEnu(geopose.quaternion)
    const h = kursGrad * RAD
    assert.ok(nahe(f.x, Math.sin(h), 1e-9), `${name}: Ost ${f.x}`)
    assert.ok(nahe(f.y, Math.cos(h), 1e-9), `${name}: Nord ${f.y}`)
  }
})

test('Position wandert unverändert mit', () => {
  const { geopose } = toGeoPose(objekt({ lat: -33.8688, lon: 151.2093, state: { altitude_ref: 'msl' } }))
  assert.equal(geopose.position.lat, -33.8688)
  assert.equal(geopose.position.lon, 151.2093)
})

// ─── Die Höhe: keine Lüge im normgerechten Umschlag ───────────────────────

test('EINE HÖHE ÜBER GRUND WIRD NICHT ALS ELLIPSOIDISCHE AUSGEGEBEN', () => {
  // Das ist der Punkt, an dem dieses Modul sich weigert zu raten. Eine Zahl
  // hinzuschreiben, die normgerecht aussieht und falsch ist, wäre schlimmer
  // als keine.
  const r = toGeoPose(objekt({ altitude: 12 }))     // altitude_ref fehlt → über Grund
  assert.equal(r.heightKnown, false)
  assert.equal(r.geopose.position.h, 0)
  assert.ok(r.notes.some(n => /über Grund/.test(n)), r.notes.join(' | '))
})

test('mit Geländehöhe wird sie richtig aufaddiert', () => {
  const r = toGeoPose(objekt({ altitude: 12 }), { groundH: 70 })
  assert.equal(r.heightKnown, true)
  assert.equal(r.geopose.position.h, 82)
  assert.deepEqual(r.notes, [])
})

test('msl zählt als bekannt, warnt aber wegen der Geoidundulation', () => {
  const r = toGeoPose(objekt({ altitude: 100, state: { altitude_ref: 'msl' } }))
  assert.equal(r.heightKnown, true)
  assert.equal(r.geopose.position.h, 100)
  assert.ok(r.notes.some(n => /Geoid/.test(n)), r.notes.join(' | '))
})

test('mit angegebener Undulation verschwindet die Warnung', () => {
  const r = toGeoPose(objekt({ altitude: 100, state: { altitude_ref: 'msl' } }), { geoidOffset: 45 })
  assert.equal(r.geopose.position.h, 145)
  assert.deepEqual(r.notes, [])
})

// ─── Pitch und Roll werden nicht geraten ──────────────────────────────────

test('PITCH UND ROLL AUS DER SZENE WERDEN NICHT GERATEN', () => {
  // Was rotation.x/.z in GeoPose-Begriffen heissen, hängt davon ab, wie das
  // Modell gebaut ist — dieselbe Trennlinie wie in yaw.js. Still mitnehmen
  // hiesse raten; still weglassen hiesse schweigen. Also: gemeldet.
  const r = toGeoPose(objekt({ rotation: { x: 0.3, y: 0, z: 0 }, state: { altitude_ref: 'msl' } }))
  assert.ok(r.notes.some(n => /rotation\.x/.test(n)), r.notes.join(' | '))
  assert.equal(r.geopose.quaternion.x, 0, 'nicht heimlich übernommen')
})

test('ohne Pitch und Roll gibt es keine überflüssige Meldung', () => {
  const r = toGeoPose(objekt({ state: { altitude_ref: 'msl' } }))
  assert.ok(!r.notes.some(n => /rotation/.test(n)), r.notes.join(' | '))
})

test('wer Pitch und Roll KENNT, gibt sie ausdrücklich an', () => {
  const gp = geoPoseFrom({ lat: 50, lon: 7, h: 100, headingDeg: 90, pitchDeg: 10, rollDeg: -5, form: FORM_YPR })
  assert.equal(gp.angles.yaw, 0)
  assert.equal(gp.angles.pitch, 10)
  assert.equal(gp.angles.roll, -5)
})

// ─── Zurück ───────────────────────────────────────────────────────────────

test('GeoPose → Ajna → GeoPose führt zurück', () => {
  const gp = geoPoseFrom({ lat: 50.3591, lon: 7.5932, h: 123.4, headingDeg: 217 })
  const ajna = fromGeoPose(gp)
  assert.ok(nahe(ajna.headingDeg, 217, 1e-6), `Kurs ${ajna.headingDeg}`)
  assert.equal(ajna.altitude, 123.4)
  assert.equal(ajna.altitude_ref, 'msl', 'die einzige Lesart, die ohne Gelände stimmt')

  const wieder = toGeoPose(
    { ...ajna, state: { altitude_ref: ajna.altitude_ref } },
    { geoidOffset: 0 })
  const f1 = forwardEnu(gp.quaternion)
  const f2 = forwardEnu(wieder.geopose.quaternion)
  for (const k of ['x', 'y', 'z']) assert.ok(nahe(f1[k], f2[k], 1e-6), k)
})

test('der Babylon-Yaw aus fromGeoPose passt zu kursFuerYaw', () => {
  const ajna = fromGeoPose(geoPoseFrom({ lat: 0, lon: 0, h: 0, headingDeg: 137 }))
  assert.ok(nahe(kursFuerYaw(ajna.rotation.y) * DEG, 137, 1e-6))
})

test('die YPR-Form wird beim Zurücklesen genauso verstanden', () => {
  const gp = geoPoseFrom({ lat: 1, lon: 2, h: 3, headingDeg: 45, form: FORM_YPR })
  assert.ok(nahe(fromGeoPose(gp).headingDeg, 45, 1e-9))
})

test('und der Blick stimmt mit blickFuerYaw zusammen', () => {
  // Letzte Verbindung zum Maßstab: der Babylon-Yaw, den fromGeoPose liefert,
  // muss ein +Z-Modell dorthin schauen lassen, wo die Richtung herkam.
  const ajna = fromGeoPose(geoPoseFrom({ lat: 0, lon: 0, h: 0, headingDeg: 300 }))
  const blick = enuFromScene(blickFuerYaw(ajna.rotation.y))
  const h = 300 * RAD
  assert.ok(nahe(blick.x, Math.sin(h), 1e-9), `Ost ${blick.x}`)
  assert.ok(nahe(blick.y, Math.cos(h), 1e-9), `Nord ${blick.y}`)
})

// ─── Prüfung gegen die Schemata ───────────────────────────────────────────

test('was dieses Modul baut, erfüllt die Schemata', () => {
  for (const form of [FORM_YPR, FORM_QUATERNION]) {
    const gp = geoPoseFrom({ lat: 50, lon: 7, h: 1, headingDeg: 12, form })
    assert.deepEqual(validateGeoPose(gp), [], form)
    assert.equal(geoPoseForm(gp), form)
  }
})

test('ein FEHLENDER Winkel ist ein Fehler, keine Null', () => {
  // Die Norm verlangt alle drei. Ein fehlendes Feld als 0 zu lesen wäre eine
  // erfundene Lage.
  const probleme = validateGeoPose({ position: { lat: 1, lon: 2, h: 3 }, angles: { yaw: 0, pitch: 0 } })
  assert.ok(probleme.some(p => /roll/.test(p)), probleme.join(' | '))
})

test('fehlende Position, unsinnige Breite, beides wird benannt', () => {
  assert.ok(validateGeoPose({ angles: { yaw: 0, pitch: 0, roll: 0 } }).some(p => /position/.test(p)))
  assert.ok(validateGeoPose({ position: { lat: 99, lon: 0, h: 0 }, angles: { yaw: 0, pitch: 0, roll: 0 } })
    .some(p => /±90/.test(p)))
  assert.ok(validateGeoPose({ position: { lat: 0, lon: 200, h: 0 }, angles: { yaw: 0, pitch: 0, roll: 0 } })
    .some(p => /±180/.test(p)))
})

test('ein nicht normiertes Quaternion wird beanstandet', () => {
  const probleme = validateGeoPose({ position: { lat: 0, lon: 0, h: 0 }, quaternion: { x: 1, y: 1, z: 1, w: 1 } })
  assert.ok(probleme.some(p => /normiert/.test(p)), probleme.join(' | '))
})

test('beide Formen gleichzeitig sind keine gültige GeoPose', () => {
  const gp = {
    position: { lat: 0, lon: 0, h: 0 },
    angles: { yaw: 0, pitch: 0, roll: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
  }
  assert.ok(validateGeoPose(gp).some(p => /genau eine/.test(p)))
  assert.equal(geoPoseForm(gp), null)
})

test('Unsinn wird abgelehnt, nicht gedeutet', () => {
  for (const x of [null, undefined, 42, 'geopose', []]) {
    assert.ok(validateGeoPose(x).length > 0, JSON.stringify(x))
  }
})

test('die Schema-Adressen zeigen auf die veröffentlichten Dateien', () => {
  for (const form of [FORM_YPR, FORM_QUATERNION]) {
    assert.match(SCHEMATA[form], /^https:\/\/schemas\.opengis\.net\/geopose\/1\.0\/schemata\/.+\.json$/)
  }
})
