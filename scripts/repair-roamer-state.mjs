#!/usr/bin/env node
//
// scripts/repair-roamer-state.mjs — einmalige Reparatur.
//
// ANLASS (2026-08-24): Beim Umbau auf den Bewegungsplan schrieb der
// World-Director bei jedem Update `state` mit — und griff dabei für Roamer
// (Tiere, Drachen) auf ein `baseState` zurück, das `makeRoamer` gar nicht
// setzte. Der Rückfall war ein leeres Objekt, also ersetzte jeder Schreibvorgang
// den kompletten Zustand durch `{ motion }`.
//
// Verloren gingen damit: `actions` (deshalb ließ sich kein Drache mehr rufen),
// `archetype`, `director`, `source`, `dialogs`. Und weil der Director seine
// Objekte an `state.director === true` erkennt, sah er sie danach überhaupt
// nicht mehr — er konnte sie weder bewegen noch aufräumen noch heilen. Sie
// blieben als stumme Waisen stehen, während er daneben neue spawnte.
//
// Die Ursache ist behoben (`makeRoamer` führt `baseState`, und der
// Schreibhelfer schreibt `state` NIE ohne Grundlage). Dieses Skript räumt den
// Schaden auf, der bis dahin entstanden ist.
//
// WARUM REPARIEREN STATT LÖSCHEN: Die Angaben sind vollständig ableitbar —
// `type` ist der Archetyp, die Aktionen stehen in der Tabelle des Directors,
// das Modell steht in `appearance`. Löschen wäre einfacher, würde aber Position
// und Aussehen wegwerfen und dem Betrachter einen Schwung verschwindender und
// neu auftauchender Figuren zumuten.
//
// SICHERHEITSNETZ: Angefasst wird nur, was ALLE Merkmale erfüllt —
//   • gehört dem Director-Konto,
//   • `type` ist einer seiner Archetypen,
//   • `state` enthält NICHTS außer `motion`.
// Ein Objekt, das jemand von Hand angelegt hat, erfüllt das nicht.
//
// Aufruf:  node scripts/repair-roamer-state.mjs [--doit]
//          ohne --doit nur anzeigen, was geschähe.

import { bootAgent } from '../agents/lib/agent-base.mjs'
import { randomUUID } from 'node:crypto'

const DOIT = process.argv.includes('--doit')

// Dieselben Aktionen wie in world-director.mjs. Bewusst hier kopiert statt
// importiert: Ein Reparaturskript soll auch dann noch laufen, wenn der Director
// inzwischen umgebaut wurde — es repariert einen Stand von damals.
const AKTIONEN = {
  npc:     [{ key: 'talk', label: 'Sprechen' }, { key: 'examine', label: 'Untersuchen' }],
  enemy:   [{ key: 'attack', label: 'Angreifen' }, { key: 'talk', label: 'Sprechen' }, { key: 'examine', label: 'Untersuchen' }],
  animal:  [{ key: 'feed', label: 'Füttern' }, { key: 'talk', label: 'Ansprechen' }, { key: 'examine', label: 'Untersuchen' }],
  dragon:  [{ key: 'call', label: 'Rufen' }, { key: 'talk', label: 'Sprechen' }, { key: 'examine', label: 'Untersuchen' }],
  item:    [],
  hint:    [{ key: 'examine', label: 'Lesen' }],
  diamond: [],
}

const { ajna } = await bootAgent('world-director')
const ich = ajna.currentUser()?.id
if (!ich) { console.error('nicht angemeldet'); process.exit(1) }

await ajna.refreshObjects()
const alle = ajna.getObjects()

const kaputt = alle.filter(o => {
  if (String(o.owner || '') !== ich) return false
  if (!(o.type in AKTIONEN)) return false
  const st = o.state
  if (!st || typeof st !== 'object') return false
  const schluessel = Object.keys(st)
  // Nur was AUSSCHLIESSLICH `motion` trägt — alles andere ist nicht dieser Schaden.
  return schluessel.length > 0 && schluessel.every(k => k === 'motion')
})

console.log(`[repair] ${alle.length} Objekte geprüft · ${kaputt.length} Waisen gefunden`)
const proTyp = {}
for (const o of kaputt) proTyp[o.type] = (proTyp[o.type] || 0) + 1
console.log('[repair] nach Typ:', JSON.stringify(proTyp))

if (!kaputt.length) { console.log('[repair] nichts zu tun.'); process.exit(0) }
if (!DOIT) {
  for (const o of kaputt.slice(0, 5)) console.log(`   – ${o.type.padEnd(7)} ${o.name}  (${o.id})`)
  if (kaputt.length > 5) console.log(`   … und ${kaputt.length - 5} weitere`)
  console.log('\n[repair] Probelauf. Mit --doit wirklich schreiben.')
  process.exit(0)
}

let ok = 0, fehler = 0
for (const o of kaputt) {
  const state = {
    ...o.state,                       // motion bleibt — die Figur läuft weiter
    director: true,
    source: 'world-director',
    archetype: o.type,
    actions: AKTIONEN[o.type],
  }
  // spawn_id war Teil der Identität und ist verloren. Ein frischer Wert ist
  // ehrlicher als gar keiner: Er sagt „diese Figur existiert", ohne eine
  // Herkunft zu erfinden, die niemand mehr kennt.
  state.spawn_id = randomUUID()
  if (o.type === 'diamond') { state.stackable = true; state.portable = true }
  try {
    await ajna.updateObject(o.id, { state })
    ok++
  } catch (err) {
    fehler++
    console.warn(`[repair] ${o.id}: ${err?.message || err}`)
  }
}
console.log(`[repair] ${ok} geheilt, ${fehler} fehlgeschlagen.`)
process.exit(fehler ? 1 : 0)
