#!/usr/bin/env node
// tools/wiki-nav.mjs — erzeugt Kopf- und Fußnavigation in allen Wiki-Seiten
// sowie die Seitenleiste `_Sidebar.md`, alles aus der Gliederung unten.
//
//   node tools/wiki-nav.mjs
//
// Idempotent: die Blöcke zwischen den Markern `<!-- nav -->` / `<!-- navfuss -->`
// werden ersetzt, nicht verdoppelt. Nach jeder neuen Seite einmal laufen lassen.
//
// Warum überhaupt: `_Sidebar.md` rendert NUR im GitHub-Wiki. Beim Blättern im
// Repository gibt es keine Navigation — dort tragen die Seiten sie selbst.
// Deshalb beides aus einer Quelle.
//
// Eine neue Seite wird HIER in ABSCHNITTE eingetragen; Reihenfolge, Vor/Zurück
// und Seitenleiste ziehen dann von selbst nach.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const WIKI = join(dirname(fileURLToPath(import.meta.url)), '..', 'wiki')

const ABSCHNITTE = [
  { name: 'Benutzen', seiten: [
    ['Erste Schritte', 'Erste-Schritte.md'],
    ['Die App', 'Die-App.md'],
    ['Privatsphäre', 'Privatsphaere.md'],
  ]},
  { name: 'Betreiben', seiten: [
    ['Server betreiben', 'Server-betreiben.md'],
    ['Agents betreiben', 'Agents-betreiben.md'],
    ['Berechtigungen', 'Berechtigungen.md'],
  ]},
  { name: 'Entwickeln', seiten: [
    ['Einen Agent bauen', 'Einen-Agent-bauen.md'],
    ['Ajna-Library', 'Ajna-Library.md'],
    ['Agent-Library', 'Agent-Library.md'],
    ['Objektmodell', 'Objektmodell.md'],
    ['Dialoge', 'Dialoge.md'],
    ['Architektur', 'Architektur.md'],
  ]},
]

// Lesereihenfolge über alle Abschnitte
const reihe = [['Start', 'Home.md'], ...ABSCHNITTE.flatMap(a => a.seiten)]

const A = '<!-- nav -->', E = '<!-- /nav -->'
const AF = '<!-- navfuss -->', EF = '<!-- /navfuss -->'
const AT = '<!-- seiteninhalt -->', ET = '<!-- /seiteninhalt -->'

// Ab so vielen H2-Überschriften bekommt eine Seite ein eigenes Inhaltsverzeichnis.
const TOC_AB = 6

const strip = (s) => s
  .replace(new RegExp(`${A}[\\s\\S]*?${E}\\n*`, 'g'), '')
  .replace(new RegExp(`${AF}[\\s\\S]*?${EF}\\n*`, 'g'), '')
  .replace(new RegExp(`${AT}[\\s\\S]*?${ET}\\n*`, 'g'), '')

/**
 * Anker einer Überschrift, wie GitHub ihn bildet: kleinschreiben, HTML-Tags und
 * alle Zeichen außer Buchstaben/Zahlen/Leerzeichen/Bindestrich/Unterstrich
 * entfernen, dann Leerzeichen zu Bindestrichen. Umlaute bleiben erhalten.
 * Gegen `github-slugger` geprüft.
 */
const anker = (text) => text
  .toLowerCase().trim()
  .replace(/<[^>]*>/g, '')
  .replace(/[^\p{L}\p{N} _-]/gu, '')
  .replace(/ /g, '-')

for (const abschnitt of ABSCHNITTE) {
  for (const [titel, datei] of abschnitt.seiten) {
    const pfad = `${WIKI}/${datei}`
    let s = strip(readFileSync(pfad, 'utf8'))

    // Geschwister des Abschnitts; die aktuelle Seite fett und ohne Link
    const geschwister = abschnitt.seiten
      .map(([t, d]) => d === datei ? `**${t}**` : `[${t}](${d})`)
      .join(' · ')
    const kopf = `${A}\n[← Inhalt](Home.md#inhalt) · ${abschnitt.name}: ${geschwister}\n${E}`

    // Vor/Zurück in der Gesamtreihenfolge
    const i = reihe.findIndex(([, d]) => d === datei)
    const vor = i > 0 ? reihe[i - 1] : null
    const nach = i >= 0 && i < reihe.length - 1 ? reihe[i + 1] : null
    const teile = []
    if (vor) teile.push(`← [${vor[0]}](${vor[1]})`)
    teile.push('[Inhalt](Home.md#inhalt)')
    if (nach) teile.push(`[${nach[0]}](${nach[1]}) →`)
    const fuss = `${AF}\n---\n\n${teile.join(' · ')}\n${EF}`

    // Seiteneigenes Inhaltsverzeichnis — nur bei langen Seiten. Überschriften
    // in Codeblöcken sehen wie H2 aus (`## …` in einem Beispiel), zählen aber
    // nicht: deshalb Zaunzeilen mitverfolgen.
    const zeilen = s.split('\n')
    let imCode = false
    const h2 = []
    for (const l of zeilen) {
      if (l.startsWith('```')) { imCode = !imCode; continue }
      if (!imCode && l.startsWith('## ')) h2.push(l.slice(3).trim())
    }
    let toc = ''
    if (h2.length >= TOC_AB) {
      const punkte = h2.map(t => `[${t.replace(/`/g, '')}](#${anker(t)})`).join(' · ')
      toc = `${AT}\n**Auf dieser Seite:** ${punkte}\n${ET}`
    }

    // Kopf direkt hinter die H1-Zeile
    const h1 = zeilen.findIndex(l => l.startsWith('# '))
    if (h1 === -1) { console.log('  ! keine H1:', datei); continue }
    zeilen.splice(h1 + 1, 0, '', kopf, ...(toc ? ['', toc] : []))
    s = zeilen.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n\n' + fuss + '\n'

    writeFileSync(pfad, s, 'utf8')
    console.log('  ✓', datei)
  }
}

// Sidebar (nur GitHub-Wiki) aus derselben Quelle erzeugen
const sidebar = [
  '<!-- Nur für den optionalen Export ins GitHub-Wiki (tools/wiki-publish.mjs).',
  '     Im Repository navigieren die Seiten über ihre eigenen Kopfzeilen. -->',
  '### [Ajna](Home.md)', '']
for (const a of ABSCHNITTE) {
  sidebar.push(`**${a.name}**`)
  for (const [t, d] of a.seiten) sidebar.push(`- [${t}](${d})`)
  sidebar.push('')
}
writeFileSync(`${WIKI}/_Sidebar.md`, sidebar.join('\n').trimEnd() + '\n', 'utf8')
console.log('  ✓ _Sidebar.md')
