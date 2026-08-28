#!/usr/bin/env node
//
// texte-pruefen — welche sichtbaren Texte laufen noch nicht durch `t()`?
//
// WOFÜR: Der Katalog in core/i18n.js benutzt den deutschen Satz als Schlüssel.
// Das hat einen Vorteil und einen Nachteil. Vorteil: Ein nicht übersetzter Text
// ist kein Fehler, sondern einfach Deutsch. Nachteil: Man SIEHT nicht, was noch
// fehlt — ein unverpackter Text sieht aus wie jeder andere.
//
// `window.ajnaFehlendeTexte()` im Browser findet nur, was durch `t()` lief und
// keine Übersetzung hatte. Dieses Skript findet das Gegenstück: was gar nicht
// erst durch `t()` läuft.
//
// Konstanten-Tabellen (Beschriftungen, die erst BEIM ZEICHNEN durch `t()`
// laufen) tauchen hier als offen auf. Das ist richtig so: Es sind Texte, und
// wer sie ändert, muss an die Übersetzung denken.
//
// Die Erkennung ist eine HEURISTIK — sie sucht Zeichenketten, die aussehen wie
// Anzeige (Leerzeichen, Großbuchstabe am Anfang) und nicht wie Code. Sie liegt
// gelegentlich daneben; das ist in Ordnung, solange die Liste kurz genug bleibt,
// um sie durchzusehen. Sie ist ein Wegweiser, kein Torwächter.
//
//   node scripts/texte-pruefen.mjs              Übersicht je Datei
//   node scripts/texte-pruefen.mjs QuestPanel   die Texte einer Datei
//   node scripts/texte-pruefen.mjs --alle       alles auflisten

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..')
const ORTE = ['client/core', 'client/engine', 'client']

// Zeichenkette mit Inhalt, in einfachen/doppelten Anführungszeichen oder als
// Vorlage. Kein Mehrzeiler — Anzeigetexte sind einzeilig.
const KANDIDAT = /(['"`])((?:[^'"`\\\n]|\\.){4,160})\1/g

const istAnzeige = (s) => {
  const t = s.trim()
  if (!/\s/.test(t)) return false                 // ein Wort → meist Selektor/Schlüssel
  if (!/^[A-ZÄÖÜ„]/.test(t)) return false          // Anzeige beginnt groß
  if (/^[a-z-]+\s*:/.test(t)) return false         // CSS
  if (/^(GET|POST|PUT|DELETE|PRAGMA|SELECT|CREATE) /.test(t)) return false
  if (/^[A-Z_]+ [A-Z_]+$/.test(t)) return false    // KONSTANTEN
  if (/[{<]/.test(t) && !/[äöüßÄÖÜ]/.test(t)) return false
  return true
}

/** Zeilen, die reiner Kommentar sind, zählen nicht. */
const ohneKommentar = (quelle) => quelle.split(/\r?\n/).map(z => {
  const t = z.trim()
  return (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) ? '' : z
})

const dateien = []
for (const ort of ORTE) {
  for (const n of readdirSync(join(WURZEL, ort))) {
    const p = join(ort, n).replace(/\\/g, '/')
    if (!n.endsWith('.js') || n.includes('.test.')) continue
    if (!statSync(join(WURZEL, p)).isFile()) continue
    dateien.push(p)
  }
}

const treffer = []
for (const p of dateien) {
  const zeilen = ohneKommentar(readFileSync(join(WURZEL, p), 'utf8'))
  const offen = new Set()
  let verpackt = 0
  zeilen.forEach((z, i) => {
    for (const m of z.matchAll(KANDIDAT)) {
      if (!istAnzeige(m[2])) continue
      // Verpackt, wenn auf derselben Zeile vorher ein `t(` steht — nicht nur
      // direkt davor: `t(bedingung ? 'a' : 'b')` ist genauso übersetzt.
      const davor = z.slice(0, m.index)
      if (/\bt\(/.test(davor)) { verpackt++; continue }
      offen.add(`${String(i + 1).padStart(5)}  ${m[2].trim()}`)
    }
  })
  if (offen.size || verpackt) treffer.push({ p, offen: [...offen], verpackt })
}

const wunsch = process.argv[2]
const alle = wunsch === '--alle'
treffer.sort((a, b) => b.offen.length - a.offen.length)

let summeOffen = 0, summeVerpackt = 0
for (const t of treffer) {
  summeOffen += t.offen.length
  summeVerpackt += t.verpackt
  if (wunsch && !alle && !t.p.includes(wunsch)) continue
  const kopf = `${String(t.offen.length).padStart(4)} offen  ${String(t.verpackt).padStart(4)} verpackt  ${t.p}`
  console.log(kopf)
  if (wunsch) for (const z of t.offen) console.log('   ' + z)
}

console.log(`\n${summeOffen} offen, ${summeVerpackt} verpackt` +
  (summeOffen + summeVerpackt ? ` (${Math.round(100 * summeVerpackt / (summeOffen + summeVerpackt))} % durch t())` : ''))
