// Bewegungsplan — wann muss ein Agent etwas sagen?
//
// Die Umkehrung, um die es geht: Nicht die Position veröffentlichen, sondern
// den Plan. Der Betrachter rechnet frameweise voraus (PositionSmoother). Diese
// Tests prüfen die eine Frage, an der alles hängt — WANN reicht der alte Plan
// nicht mehr?
//
// Wichtigster Fall ist der KNICK: Vorausgerechnet wird geradeaus, ein
// konstanter Kurs beschreibt eine Polylinie nur zwischen zwei Ecken. Wer bloß
// im Zeittakt veröffentlicht, lässt Figuren Kurven schneiden.
//
// Run: node agents/lib/bewegung.test.mjs

import {
  Bewegungsplan, bewegungsUpdate, vorausrechnen,
  kursGrad, abstandM, kursDifferenz,
} from './bewegung.mjs'

let failures = 0
const check = (msg, cond, info = '') => {
  if (cond) console.log(`  ✓ ${msg}${info ? ` (${info})` : ''}`)
  else { console.error(`  ✗ ${msg}${info ? ` (${info})` : ''}`); failures++ }
}
const nah = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

console.log('Bewegungsplan:')

// ── Winkel und Abstände ──────────────────────────────────────────────────
check('Nord ist 0°', nah(kursGrad(50, 7, 50.001, 7), 0, 0.01))
check('Ost ist 90°', nah(kursGrad(50, 7, 50, 7.001), 90, 0.01))
check('Süd ist 180°', nah(kursGrad(50, 7, 49.999, 7), 180, 0.01))
check('West ist 270°', nah(kursGrad(50, 7, 50, 6.999), 270, 0.01))

check('gleicher Kurs = 0 Grad Unterschied', kursDifferenz(90, 90) === 0)
check('rechter Winkel = 90', kursDifferenz(0, 90) === 90)
check('Gegenrichtung = 180', kursDifferenz(0, 180) === 180)
// Ohne Umlauf-Behandlung löste jeder Durchgang durch Nord eine überflüssige
// Veröffentlichung aus.
check('350° und 10° sind 20 Grad auseinander', kursDifferenz(350, 10) === 20)
check('und andersherum genauso', kursDifferenz(10, 350) === 20)

check('111 m nach Norden werden gemessen',
  Math.abs(abstandM(50, 7, 50.001, 7) - 111.3) < 1,
  abstandM(50, 7, 50.001, 7).toFixed(1) + ' m')

// ── Vorausrechnen deckt sich mit dem Client ──────────────────────────────
{
  const t = 1_000_000
  const plan = { v: 10, trk: 90, lat0: 50, lon0: 7, alt0: 0, vrate: 0, t }
  const p = vorausrechnen(plan, t + 10_000)   // 10 s × 10 m/s = 100 m nach Osten
  check('100 m Ost werden vorausgerechnet',
    Math.abs(abstandM(50, 7, p.lat, p.lon) - 100) < 1,
    abstandM(50, 7, p.lat, p.lon).toFixed(1) + ' m')
  check('und zwar nach Osten', p.lon > 7 && nah(p.lat, 50, 1e-9))
  check('rückwärts wird nicht gerechnet',
    vorausrechnen(plan, t - 5000).lon === 7)
  const steig = vorausrechnen({ ...plan, vrate: 2 }, t + 10_000)
  check('Steigrate wirkt auf die Höhe', nah(steig.altitude, 20, 1e-6))
}

// ── Wann veröffentlichen? ────────────────────────────────────────────────
{
  const t0 = 1_000_000
  const plan = new Bewegungsplan()
  const ist = { lat: 50, lon: 7, altitude: 0, v: 1.4, trk: 90 }

  check('das erste Mal immer', plan.braucht(ist, t0).noetig === true)
  plan.merke(ist, t0)

  // Eine Sekunde geradeaus: der Betrachter rechnet das selbst aus.
  const nach1s = { ...vorausrechnen(plan.letzter, t0 + 1000), v: 1.4, trk: 90 }
  const r1 = plan.braucht(nach1s, t0 + 1000)
  check('geradeaus schweigt der Agent', r1.noetig === false, r1.grund)

  // Der Knick — der eigentliche Grund für das ganze Modul.
  const knick = { ...nach1s, trk: 120 }
  const r2 = plan.braucht(knick, t0 + 1000)
  check('ein Knick wird gemeldet', r2.noetig === true && r2.grund === 'knick', r2.grund)

  // Ein winziger Kursversatz ist Rauschen, kein Knick.
  const r3 = plan.braucht({ ...nach1s, trk: 92 }, t0 + 1000)
  check('zwei Grad sind noch kein Knick', r3.noetig === false, r3.grund)

  // Tempo.
  const r4 = plan.braucht({ ...nach1s, v: 3.5 }, t0 + 1000)
  check('deutlich schneller wird gemeldet', r4.noetig === true && r4.grund === 'tempo', r4.grund)
  const r5 = plan.braucht({ ...nach1s, v: 1.45 }, t0 + 1000)
  check('geringfügig schneller nicht', r5.noetig === false, r5.grund)

  // Drift: Die Figur ist woanders, als der Betrachter sie zeichnet.
  const abgekommen = { ...nach1s }
  abgekommen.lat += 10 / 111320   // 10 m nach Norden versetzt
  const r6 = plan.braucht(abgekommen, t0 + 1000)
  check('Auseinanderlaufen wird korrigiert', r6.noetig === true && r6.grund === 'drift', r6.grund)

  // Lebenszeichen.
  const spaet = { ...vorausrechnen(plan.letzter, t0 + 11_000), v: 1.4, trk: 90 }
  const r7 = plan.braucht(spaet, t0 + 11_000)
  check('nach langer Stille ein Lebenszeichen',
    r7.noetig === true && r7.grund === 'lebenszeichen', r7.grund)
}

// ── Anhalten und Losgehen sind Zustandswechsel ───────────────────────────
{
  const t0 = 2_000_000
  const plan = new Bewegungsplan()
  const geht = { lat: 50, lon: 7, altitude: 0, v: 1.4, trk: 90 }
  plan.merke(geht, t0)

  const steht = { ...geht, v: 0 }
  const r1 = plan.braucht(steht, t0 + 200)
  check('Anhalten wird sofort gemeldet', r1.noetig === true && r1.grund === 'angehalten', r1.grund)
  // Wer stehenbleibt und es nicht sagt, läuft beim Betrachter für immer weiter.
  plan.haltAn(steht, t0 + 200)
  check('der festgeschriebene Plan steht still', plan.letzter.v === 0)

  const r2 = plan.braucht(steht, t0 + 1000)
  check('im Stillstand wird geschwiegen', r2.noetig === false, r2.grund)
  const r3 = plan.braucht(steht, t0 + 20_000)
  check('aber nicht endlos', r3.noetig === true && r3.grund === 'lebenszeichen', r3.grund)

  const r4 = plan.braucht(geht, t0 + 1000)
  check('Losgehen wird sofort gemeldet', r4.noetig === true && r4.grund === 'losgelaufen', r4.grund)
}

// ── Der bequeme Weg ──────────────────────────────────────────────────────
{
  const t0 = 3_000_000
  const plan = new Bewegungsplan()
  const ist = { lat: 50, lon: 7, altitude: 0, v: 1.4, trk: 45 }

  const u1 = bewegungsUpdate(plan, ist, { archetype: 'npc' }, t0)
  check('das erste Update kommt', !!u1)
  check('es trägt die Position', u1.lat === 50 && u1.lon === 7)
  // Betrachter ohne greifende Extrapolation (frisch geladen, Karte, alter
  // Client) brauchen weiterhin die nackte Position — deshalb IMMER beides.
  check('und den Plan', u1.state.motion.v === 1.4 && u1.state.motion.trk === 45)
  check('der übrige state bleibt erhalten', u1.state.archetype === 'npc')

  const u2 = bewegungsUpdate(plan, { ...vorausrechnen(plan.letzter, t0 + 500), v: 1.4, trk: 45 },
    { archetype: 'npc' }, t0 + 500)
  check('unverändert gibt es kein Update — genau darum geht es', u2 === null)
}

// ── Die Ersparnis, an einer echten Route gemessen ────────────────────────
// Eine Figur läuft eine Polylinie mit wenigen Ecken ab. Vorher: ein Schreib-
// vorgang je Tick. Jetzt: einer je Ecke plus Lebenszeichen.
{
  const ecken = [
    { lat: 50.4460, lon: 7.5960 },
    { lat: 50.4470, lon: 7.5960 },   // Knick nach Osten
    { lat: 50.4470, lon: 7.5980 },   // Knick nach Süden
    { lat: 50.4460, lon: 7.5980 },
  ]
  const TICK = 500, TEMPO = 1.4
  const plan = new Bewegungsplan()
  let t = 5_000_000, schreibvorgaenge = 0, ticks = 0
  let pos = { ...ecken[0] }, ziel = 1

  while (ziel < ecken.length && ticks < 4000) {
    ticks++
    const trk = kursGrad(pos.lat, pos.lon, ecken[ziel].lat, ecken[ziel].lon)
    const rest = abstandM(pos.lat, pos.lon, ecken[ziel].lat, ecken[ziel].lon)
    const schritt = Math.min(rest, TEMPO * TICK / 1000)
    const b = trk * Math.PI / 180
    pos = {
      lat: pos.lat + (schritt * Math.cos(b)) / 111320,
      lon: pos.lon + (schritt * Math.sin(b)) / (111320 * Math.cos(pos.lat * Math.PI / 180)),
    }
    if (rest - schritt < 0.5) ziel++
    if (bewegungsUpdate(plan, { ...pos, altitude: 0, v: TEMPO, trk }, {}, t)) schreibvorgaenge++
    t += TICK
  }

  check('die Route wurde abgelaufen', ziel === ecken.length, `${ticks} Ticks`)
  check('deutlich weniger Schreibvorgänge als Ticks',
    schreibvorgaenge < ticks / 4, `${schreibvorgaenge} statt ${ticks}`)
  // Jede Ecke MUSS dabei sein — sonst schneidet die Figur die Kurve und läuft
  // durch Häuser, während der Agent glaubt, sie folge der Straße.
  check('aber mehr als nur die Lebenszeichen',
    schreibvorgaenge >= ecken.length - 1, `${schreibvorgaenge} bei ${ecken.length - 1} Ecken`)
  console.log(`     → ${ticks} Ticks, ${schreibvorgaenge} Schreibvorgänge `
    + `(${(100 - schreibvorgaenge / ticks * 100).toFixed(0)} % gespart)`)
}

console.log(failures === 0
  ? '\nAll bewegung tests passed.'
  : `\n${failures} test(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
