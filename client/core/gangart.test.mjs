// Gangart — Animation nach tatsächlichem Tempo.
//
// Geprüft wird die eine Rechnung, an der der Eindruck „lebendig" hängt:
// Abspieltempo = tatsächliches Tempo / Tempo, für das der Zyklus gezeichnet
// wurde. Gleiten über den Boden ist der stärkste Tot-Effekt — und es entsteht
// genau dann, wenn diese Rechnung fehlt.
//
// Run: node client/core/gangart.test.mjs

import {
  gangartFuer, tempoAusSpruengen,
  STEHT_UNTER, GEH_TEMPO, LAUF_TEMPO, TEMPO_MIN, TEMPO_MAX, BEZUGS_GROESSE,
} from './gangart.js'

let failures = 0
const check = (msg, cond, info = '') => {
  if (cond) console.log(`  ✓ ${msg}${info ? ` (${info})` : ''}`)
  else { console.error(`  ✗ ${msg}${info ? ` (${info})` : ''}`); failures++ }
}
const nah = (a, b, eps = 0.02) => Math.abs(a - b) < eps

console.log('Gangart:')

// ── Stehen, Gehen, Laufen ────────────────────────────────────────────────
check('Stillstand ist idle', gangartFuer(0).zustand === 'idle')
check('ein Hauch Bewegung auch noch', gangartFuer(STEHT_UNTER * 0.5).zustand === 'idle')
check('Gehtempo ist walk', gangartFuer(GEH_TEMPO).zustand === 'walk')
check('Lauftempo ist run', gangartFuer(LAUF_TEMPO).zustand === 'run')
check('unsinniges Tempo wirft nicht', gangartFuer(NaN).zustand === 'idle')
check('negatives Tempo auch nicht', gangartFuer(-5).zustand === 'idle')

// ── Der Kern: kein Gleiten ───────────────────────────────────────────────
{
  const g = gangartFuer(GEH_TEMPO)
  check('beim Referenztempo läuft der Zyklus normal', nah(g.tempo, 1))
  check('und gleitet nicht', nah(g.gleitet, 1))

  const schnell = gangartFuer(GEH_TEMPO * 1.5, { hatLauf: false })
  check('halb so schnell wieder → Zyklus 1,5-fach', nah(schnell.tempo, 1.5))

  const langsam = gangartFuer(GEH_TEMPO * 0.8, { hatLauf: false })
  check('langsamer → Zyklus langsamer', nah(langsam.tempo, 0.8))
}

// ── Grenzen: lieber etwas Gleiten als Trickfilm ──────────────────────────
{
  const irre = gangartFuer(GEH_TEMPO * 6, { hatLauf: false })
  check('das Abspieltempo wird gedeckelt', irre.tempo === TEMPO_MAX, 'tempo=' + irre.tempo)
  check('und der Rest ehrlich als Gleiten ausgewiesen', irre.gleitet > 1.5,
    'gleitet=' + irre.gleitet.toFixed(2))

  // Ein sehr langsamer Gehzyklus sieht aus wie ein Fehler — deshalb wird
  // stattdessen zwischen Stand und Gehen gemischt.
  const schleicht = gangartFuer(GEH_TEMPO * 0.2)
  check('ganz langsam wird aus idle herausgeblendet',
    schleicht.misch.von === 'idle' && schleicht.misch.nach === 'walk')
  check('mit passendem Anteil', schleicht.misch.anteil > 0 && schleicht.misch.anteil < 1,
    'anteil=' + schleicht.misch.anteil.toFixed(2))
  check('und nie unter dem Mindest-Abspieltempo', schleicht.tempo >= TEMPO_MIN)
}

// ── Übergang Gehen → Laufen ──────────────────────────────────────────────
{
  const mitte = gangartFuer((GEH_TEMPO + LAUF_TEMPO) / 2)
  check('dazwischen wird gemischt',
    mitte.misch.von === 'walk' && mitte.misch.nach === 'run')
  check('etwa zur Hälfte', nah(mitte.misch.anteil, 0.5, 0.1),
    'anteil=' + mitte.misch.anteil.toFixed(2))

  // Der Anteil muss monoton steigen — ein Zickzack wäre als Flackern sichtbar.
  let vorher = -1, monoton = true
  for (let v = GEH_TEMPO; v <= LAUF_TEMPO; v += 0.1) {
    const a = gangartFuer(v).misch.anteil
    if (a < vorher - 1e-9) monoton = false
    vorher = a
  }
  check('der Übergang läuft monoton, ohne Flackern', monoton)

  check('ohne Laufzyklus bleibt es beim Gehen',
    gangartFuer(LAUF_TEMPO, { hatLauf: false }).zustand === 'walk')
}

// ── Größe: ein Fuchs rennt, wo ein Pferd geht ────────────────────────────
{
  const fuchs = gangartFuer(1.4, { groesse: 0.4 })
  const mensch = gangartFuer(1.4, { groesse: BEZUGS_GROESSE })
  const pferd = gangartFuer(1.4, { groesse: 2.6 })

  check('derselbe Wert ist für den Fuchs schneller',
    fuchs.zustand === 'run' && mensch.zustand === 'walk',
    `Fuchs=${fuchs.zustand}, Mensch=${mensch.zustand}`)
  check('und für das Pferd gemächlicher', pferd.tempo < mensch.tempo,
    `Pferd=${pferd.tempo.toFixed(2)}, Mensch=${mensch.tempo.toFixed(2)}`)
  check('unsinnige Größen werden geklemmt, nicht geglaubt',
    Number.isFinite(gangartFuer(1.4, { groesse: 0 }).tempo)
    && Number.isFinite(gangartFuer(1.4, { groesse: 1e6 }).tempo))
}

// ── Rückfall ohne Bewegungsplan ──────────────────────────────────────────
// Aus zwei Punkten lässt sich ein Tempo errechnen — es zappelt aber und hinkt
// hinterher. Wo `state.motion` vorliegt, ist die Angabe des Agents besser.
{
  const a = { lat: 50, lon: 7 }
  const b = { lat: 50 + 1.4 / 111320, lon: 7 }     // 1,4 m in 1 s
  const erst = tempoAusSpruengen(a, b, 1000, 0)
  check('das Tempo wird geschätzt', erst > 0 && erst < 1.4, 'v=' + erst.toFixed(2))

  // Geglättet: es nähert sich an, statt zu springen.
  let v = 0
  for (let i = 0; i < 25; i++) v = tempoAusSpruengen(a, b, 1000, v)
  check('und nähert sich dem wahren Wert', nah(v, 1.4, 0.05), 'v=' + v.toFixed(2))

  const ausreisser = tempoAusSpruengen(a, { lat: 50.01, lon: 7 }, 1000, 1.4)
  check('ein Ausreißer schickt niemanden in den Sprint', ausreisser < 12,
    'v=' + ausreisser.toFixed(1))
  check('ohne Zeitdifferenz bleibt es beim alten Wert',
    tempoAusSpruengen(a, b, 0, 2.5) === 2.5)
  check('ohne Vorgänger ebenso', tempoAusSpruengen(null, b, 1000, 2.5) === 2.5)
}

console.log(failures === 0
  ? '\nAll gangart tests passed.'
  : `\n${failures} test(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
