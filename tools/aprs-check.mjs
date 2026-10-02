#!/usr/bin/env node
// aprs-check.mjs — hold a capture against the parser and report what it made of it.
//
// WHY THIS EXISTS. `agents/lib/aprs.mjs` was written against the APRS 1.01
// specification, not against packets from the air. This tool closes that gap
// without needing to know what each packet "should" say, because the capture
// itself carries the answer:
//
//   THE FILTER RADIUS IS GROUND TRUTH. APRS-IS filtered the recording
//   server-side to a circle around one point. Every packet in the file came
//   from inside it. So any position this parser decodes OUTSIDE that circle is
//   a parser bug — no reference data required. That check is strongest exactly
//   where it is needed most: MIC-E, where the latitude hides in the destination
//   callsign and an off-by-one in the character tables lands a car in the sea.
//
// The report is plain ASCII with every byte above 126 escaped, so it survives a
// paste through a terminal and a chat window — which the raw packets do not.
//
//   node tools/aprs-check.mjs /tmp/aprs.txt
//   node tools/aprs-check.mjs /tmp/aprs.txt --lat=50.4297 --lon=7.4608 --radius=150

import fs from 'node:fs'
import { parseFrame, parsePacket, abstandKm, symbolInfo } from '../agents/lib/aprs.mjs'

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const DATEI = process.argv.slice(2).find(a => !a.startsWith('-'))
if (!DATEI) {
  console.error('Args: aprs-check.mjs <mitschnitt> [--lat=] [--lon=] [--radius=]')
  process.exit(2)
}
const LAT = Number(arg('lat', 50.4297))
const LON = Number(arg('lon', 7.4608))
const RADIUS = Number(arg('radius', 150))
const ZEIGE = Number(arg('show', 6))

/** Every byte above 126 (and the control range) as \xNN — paste-safe. */
const sicher = (text) => String(text).replace(/[^\x20-\x7e]/g,
  (z) => '\\x' + z.charCodeAt(0).toString(16).padStart(2, '0'))

const zeilen = fs.readFileSync(DATEI, 'latin1').split(/\r?\n/).filter(z => z && !z.startsWith('#'))

const arten = new Map()   // Kennzeichen → { n, ok, weit, fehler: [] }
const eintrag = (k) => {
  if (!arten.has(k)) arten.set(k, { n: 0, ok: 0, weit: 0, fehler: [], proben: [] })
  return arten.get(k)
}

let ohneRahmen = 0
const symbole = new Map()
let mitMotion = 0, mitWetter = 0

for (const z of zeilen) {
  const f = parseFrame(z)
  if (!f) { ohneRahmen++; continue }
  const kennzeichen = f.payload[0] || '?'
  const a = eintrag(kennzeichen)
  a.n++

  const p = parsePacket(z)
  if (!p) {
    if (a.fehler.length < ZEIGE) a.fehler.push(z)
    continue
  }
  if (p.deleted) { a.ok++; continue }
  a.ok++

  const km = abstandKm(LAT, LON, p.lat, p.lon)
  if (km > RADIUS) {
    a.weit++
    if (a.proben.length < ZEIGE) a.proben.push({ z, p, km })
  } else if (kennzeichen === '`' || kennzeichen === "'") {
    // MIC-E immer zeigen, auch wenn es passt: sechs Pakete sind wenig, und
    // plausibel heisst nicht richtig.
    if (a.proben.length < ZEIGE) a.proben.push({ z, p, km })
  }
  symbole.set(p.symbol, (symbole.get(p.symbol) || 0) + 1)
  if (p.weather) mitWetter++
  if (p.course !== null && p.speed !== null) mitMotion++
}

console.log(`Mitschnitt: ${DATEI}`)
console.log(`Zeilen: ${zeilen.length}${ohneRahmen ? ` (${ohneRahmen} ohne gültigen Rahmen)` : ''}`)
console.log(`Prüfkreis: ${RADIUS} km um ${LAT}, ${LON}`)
console.log('')
console.log('Kennz.  ges.  erkannt  AUSSERHALB  Bedeutung')
const bedeutung = {
  '!': 'Position ohne Zeit', '=': 'Position ohne Zeit (Nachricht möglich)',
  '@': 'Position mit Zeit', '/': 'Position mit Zeit', '`': 'MIC-E', "'": 'MIC-E (alte Form)',
  ';': 'Objekt', ')': 'Item', '_': 'Wetter ohne Position', '>': 'Status',
  ':': 'Nachricht', 'T': 'Telemetrie', '<': 'Fähigkeiten', '$': 'NMEA roh',
}
for (const [k, a] of [...arten].sort((x, y) => y[1].n - x[1].n)) {
  const warn = a.weit ? ` ${String(a.weit).padStart(10)}` : '          -'
  console.log(`${JSON.stringify(k).padEnd(7)} ${String(a.n).padStart(4)} ${String(a.ok).padStart(8)}${warn}  ${bedeutung[k] || '(unbekannt)'}`)
}

console.log('')
console.log(`verstanden mit Kurs UND Tempo: ${mitMotion}`)
console.log(`Wetterstationen: ${mitWetter}`)
console.log(`Symbole: ${[...symbole].sort((a, b) => b[1] - a[1])
  .map(([s, n]) => `${JSON.stringify(s)}×${n} (${symbolInfo(s).label})`).join(', ')}`)

// ─── Die Stellen, auf die es ankommt ──────────────────────────────────────

for (const [k, a] of arten) {
  if (!a.proben.length && !a.fehler.length) continue
  console.log('')
  console.log('─'.repeat(72))
  console.log(`${JSON.stringify(k)} — ${bedeutung[k] || '(unbekannt)'}`)
  for (const { z, p, km } of a.proben) {
    const marke = km > RADIUS ? '!! AUSSERHALB' : 'im Kreis'
    console.log(`  ${marke}  ${km.toFixed(1)} km  →  ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`
      + `  Symbol ${JSON.stringify(p.symbolTable + p.symbol)}`
      + `  Kurs ${p.course ?? '—'}  Tempo ${p.speed === null ? '—' : (p.speed * 3.6).toFixed(0) + ' km/h'}`)
    console.log(`     roh: ${sicher(z)}`)
  }
  for (const z of a.fehler) {
    console.log(`  NICHT ERKANNT`)
    console.log(`     roh: ${sicher(z)}`)
  }
}

const weit = [...arten.values()].reduce((s, a) => s + a.weit, 0)
console.log('')
if (weit) {
  console.log(`⚠ ${weit} Position(en) liegen außerhalb des Prüfkreises — das sind Parser-Fehler,`)
  console.log('  keine Datenfehler: der Server hatte den Mitschnitt schon gefiltert.')
  process.exit(1)
}
console.log('✓ Keine Position außerhalb des Prüfkreises.')
