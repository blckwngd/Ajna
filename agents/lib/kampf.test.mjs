// Kampf — Trefferpunkte, Reichweite, Beute.
//
// Geprüft wird vor allem, was NICHT passieren darf: aus zehn Kilometern
// zuschlagen, im Millisekundentakt dreschen, eine Leiche weiterprügeln — und
// dass Diamanten selten bleiben. Beute wird ERZEUGT, nicht gedeckt; wären
// Diamanten häufig, entwertete das die Auftragswährung.
//
// Run: node agents/lib/kampf.test.mjs

import {
  Kampf, hpVon, lebt, schadenFuer, wuerfleBeute, beuteObjekt,
  HP_VORGABE, SCHADEN_VORGABE, BEUTE_TABELLEN,
} from './kampf.mjs'

let failures = 0
const check = (msg, cond, info = '') => {
  if (cond) console.log(`  ✓ ${msg}${info ? ` (${info})` : ''}`)
  else { console.error(`  ✗ ${msg}${info ? ` (${info})` : ''}`); failures++ }
}

console.log('Kampf:')

const ORT = { lat: 50.4466, lon: 7.5971 }
const gegner = (extra = {}) => ({
  id: 'g1', type: 'enemy', ...ORT,
  state: { archetype: 'enemy', actions: [{ key: 'attack', label: 'Angreifen', max_distance: 30 }], ...extra },
})
/** Punkt in `m` Metern nördlich. */
const noerdlich = (m) => ({ lat: ORT.lat + m / 111320, lon: ORT.lon })

// ── Trefferpunkte ────────────────────────────────────────────────────────
check('ohne Angabe gilt die Vorgabe des Archetyps',
  hpVon(gegner()).max === HP_VORGABE.enemy)
check('und volle Punkte zu Beginn', hpVon(gegner()).ist === HP_VORGABE.enemy)
check('eigene Angabe geht vor', hpVon(gegner({ hp: { ist: 5, max: 50 } })).ist === 5)
check('negatives wird abgefangen', hpVon(gegner({ hp: { ist: -9, max: 50 } })).ist === 0)
check('lebt, solange Punkte da sind', lebt(gegner()) === true)
check('bei 0 nicht mehr', lebt(gegner({ hp: { ist: 0, max: 30 } })) === false)
check('Schaden hat eine Vorgabe', schadenFuer(gegner()) === SCHADEN_VORGABE)
check('am Objekt überschreibbar', schadenFuer(gegner({ schaden: 7 })) === 7)

// ── Reichweite: der Kern ─────────────────────────────────────────────────
{
  const k = new Kampf()
  // Aus 10 km zuschlagen — genau das darf nicht gehen.
  let r = k.schlag({ ziel: gegner(), angreifer: 'u1', absender: noerdlich(10000) })
  check('aus der Ferne geht nichts', !r.ok && r.grund === 'zu-weit', r.grund)
  check('mit verständlicher Auskunft', /Zu weit weg/.test(r.text || ''))

  // Ohne jede Positionsangabe (Stufe „Verborgen") ebenfalls nicht.
  r = k.schlag({ ziel: gegner(), angreifer: 'u2', absender: null })
  check('ohne Standort-Freigabe auch nicht', !r.ok && r.grund === 'keine-position')
  check('und es steht dabei, was fehlt', /„Nähe"/.test(r.text || ''), r.text)

  // Die Nähe-Meldung reicht — SIE ist die Antwort, nicht ihr Ersatz.
  r = k.schlag({ ziel: gegner(), angreifer: 'u3', istNah: true })
  check('eine Nähe-Meldung genügt', r.ok && r.grund === 'treffer')

  // Ein Gegner OHNE Reichweite ist von überall angreifbar — Rückwärts-
  // vertäglichkeit für bestehende Objekte.
  const offen = gegner({ actions: [{ key: 'attack', label: 'Angreifen' }] })
  r = new Kampf().schlag({ ziel: offen, angreifer: 'u4', absender: noerdlich(9000) })
  check('ohne max_distance gibt es keine Grenze', r.ok, r.grund)
}

// ── Abklingzeit ──────────────────────────────────────────────────────────
{
  const k = new Kampf({ abklingzeitMs: 1000 })
  const t = 1_000_000
  let r = k.schlag({ ziel: gegner(), angreifer: 'u1', istNah: true, jetzt: t })
  check('der erste Schlag trifft', r.ok)
  r = k.schlag({ ziel: gegner(), angreifer: 'u1', istNah: true, jetzt: t + 200 })
  check('gleich danach nicht', !r.ok && r.grund === 'zu-schnell')
  r = k.schlag({ ziel: gegner(), angreifer: 'u1', istNah: true, jetzt: t + 1100 })
  check('nach der Abklingzeit wieder', r.ok)
  // Zwei Spieler behindern einander nicht.
  r = k.schlag({ ziel: gegner(), angreifer: 'u2', istNah: true, jetzt: t + 1150 })
  check('ein anderer Spieler ist davon unberührt', r.ok)
}

// ── Bis zum Tod ──────────────────────────────────────────────────────────
{
  const k = new Kampf({ abklingzeitMs: 0, rnd: () => 0.5 })
  let hp = HP_VORGABE.enemy, schlaege = 0, letzte = null
  let ziel = gegner()
  while (schlaege < 20) {
    const r = k.schlag({ ziel, angreifer: 'u1', istNah: true, jetzt: 2_000_000 + schlaege })
    if (!r.ok) break
    schlaege++
    letzte = r
    ziel = gegner({ hp: r.hp, archetype: 'enemy' })
    if (r.tot) break
  }
  check('nach mehreren Schlägen tot', letzte?.tot === true, schlaege + ' Schläge')
  check('Trefferpunkte enden bei 0', letzte?.hp.ist === 0)
  check('und es fällt Beute', Array.isArray(letzte?.beute))

  // Eine Leiche lässt sich nicht weiterprügeln.
  const r = k.schlag({ ziel, angreifer: 'u1', istNah: true, jetzt: 2_000_100 })
  check('eine Leiche nimmt keinen Schaden mehr', !r.ok && r.grund === 'schon-tot')
}

// ── Beute ────────────────────────────────────────────────────────────────
{
  // Am Objekt festgelegte Beute geht vor jeder Tabelle.
  const fest = wuerfleBeute(gegner({ loot: [{ name: 'Siegelring', anzahl: 2 }] }), () => 0.1)
  check('festgelegte Beute geht vor', fest[0]?.name === 'Siegelring' && fest[0]?.anzahl === 2)
  check('mit Wahrscheinlichkeit gefiltert',
    wuerfleBeute(gegner({ loot: [{ name: 'X', chance: 0.1 }] }), () => 0.9).length === 0)

  // DIAMANTEN MÜSSEN SELTEN BLEIBEN — sie sind Auftragswährung, und was man
  // erschlagen kann, soll sie nicht entwerten.
  let dias = 0, leer = 0
  const N = 20000
  let seed = 12345
  const rnd = () => (seed = (1103515245 * seed + 12345) & 0x7fffffff) / 0x7fffffff
  for (let i = 0; i < N; i++) {
    const b = wuerfleBeute(gegner(), rnd)
    if (!b.length) leer++
    else if (b[0].name === 'Diamant') dias++
  }
  const quote = dias / N
  check('Diamanten sind selten', quote > 0 && quote < 0.03, (quote * 100).toFixed(2) + ' %')
  check('manchmal fällt gar nichts', leer > 0, (leer / N * 100).toFixed(0) + ' %')
  check('meistens fällt Material', (N - leer - dias) / N > 0.8)

  // Jede Gattung der Tabelle muss auch vorkommen — ein Eintrag, den niemand je
  // sieht, ist ein toter Eintrag.
  const gesehen = new Set()
  for (let i = 0; i < 5000; i++) {
    const b = wuerfleBeute(gegner(), rnd)
    if (b.length) gesehen.add(b[0].name)
  }
  const erwartet = BEUTE_TABELLEN.enemy.filter(e => e.name).map(e => e.name)
  check('jede Gattung kommt vor', erwartet.every(n => gesehen.has(n)),
    [...gesehen].join(', '))
}

// ── Das herumliegende Stück ──────────────────────────────────────────────
{
  const o = beuteObjekt('Wolfsfell', { ...ORT, quelle: 'world-director' })
  check('Beute ist ein Gegenstand', o.type === 'item')
  check('sie ist einsammelbar', o.state.portable === true)
  check('sie gehört niemandem', o.owner === undefined)
  check('sie ist als Beute erkennbar', o.state.beute === true)
  check('mit Aussehen', !!o.appearance.emoji)
  check('und mit Quelle für den Filter', o.state.source === 'world-director')
  check('unbekannte Gattung bekommt trotzdem ein Aussehen',
    !!beuteObjekt('Irgendwas', ORT).appearance.emoji)
}

// ── Aufräumen ────────────────────────────────────────────────────────────
{
  const k = new Kampf({ abklingzeitMs: 0, liegezeitMs: 5000, rnd: () => 0.5 })
  const t = 3_000_000
  k.schlag({ ziel: gegner({ hp: { ist: 5, max: 30 } }), angreifer: 'u1', istNah: true, jetzt: t })
  check('das Ziel gilt als tot', k.istTot('g1'))
  check('kurz danach bleibt es liegen', k.abgelaufen(t + 1000).length === 0)
  check('nach der Liegezeit wird es abgeräumt', k.abgelaufen(t + 6000).includes('g1'))
  k.vergiss('g1')
  check('danach ist es vergessen', !k.istTot('g1') && k.abgelaufen(t + 6000).length === 0)
}

console.log(failures === 0
  ? '\nAll kampf tests passed.'
  : `\n${failures} test(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
