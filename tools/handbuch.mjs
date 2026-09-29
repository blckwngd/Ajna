#!/usr/bin/env node
//
// tools/handbuch.mjs — aus den Markdown-Dateien ein lesbares Handbuch bauen.
//
// WOFÜR: Die Doku liegt versioniert im Repo und ist auf GitHub gut lesbar —
// aber wer eine Ajna-Instanz betreibt, hat den Server vor sich und nicht
// unbedingt das Repo. Dieser Generator legt dieselben Texte als statische
// Seiten unter `client/handbuch/` ab. Caddy liefert `client/` ohnehin aus,
// also braucht es dafür keine einzige Zeile in der Caddy-Konfiguration.
//
// STATISCH GEBAUT, NICHT ZUR LAUFZEIT GERENDERT. Drei Gründe:
//   * Kein Markdown-Parser im Browser-Bündel und keiner im laufenden Server.
//   * Die Seiten funktionieren ohne JavaScript — eine Anleitung, die erst ein
//     Programm braucht, ist eine schlechte Anleitung.
//   * Sie wandern in die Android-App mit, weil Capacitor `client/` einpackt.
//
// `npm run build` ruft es mit auf, und `scripts/deploy.sh` ruft `npm run build`
// — auf dem Server ist das Handbuch damit immer so frisch wie der Code.
//
// ROH-HTML IST ABGESCHALTET (`html: false`), und das ist hier nicht nur die
// sichere, sondern auch die RICHTIGE Einstellung: In der Doku stehen
// Platzhalter wie `<name>` oder `<source>` im Fließtext. Als HTML gedeutet
// verschwänden sie spurlos; so werden sie sichtbar, wie sie gemeint sind.
// Einzige Ausnahme ist `<br/>` in Tabellenzellen — dafür siehe `UMBRUCH`.

import { mkdir, readdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import MarkdownIt from 'markdown-it'

const HIER = dirname(fileURLToPath(import.meta.url))
export const WURZEL = join(HIER, '..')
export const ZIEL = join(WURZEL, 'client', 'handbuch')

/**
 * `<br/>` überlebt, alles andere nicht.
 *
 * 33-mal steht in den Tabellen ein Zeilenumbruch, und Tabellenzellen kennen
 * keinen anderen Weg. Der Platzhalter geht unbeschadet durch den Parser (er
 * enthält kein Sonderzeichen) und wird danach ersetzt.
 */
const UMBRUCH = 'zzbruchzz'

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false })

/**
 * Überschrift → Ankername, so wie GitHub es macht.
 *
 * Muss zu GitHub passen, weil die Texte Sprungmarken enthalten, die dort
 * geschrieben wurden (`[Inhaltsverzeichnis](#inhalt)`). Kleinschreibung,
 * Leerzeichen zu Bindestrichen, Satzzeichen weg — Umlaute bleiben.
 */
export function anker(text) {
  return String(text)
    .trim().toLowerCase()
    .replace(/[`*_~\[\]()]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

// Überschriften bekommen ihre Sprungmarke. Ohne sie zeigt jeder Link mit `#`
// ins Leere — und das sind in dieser Doku nicht wenige.
md.renderer.rules.heading_open = (tokens, i, opts, env, self) => {
  const inhalt = tokens[i + 1]?.content || ''
  const id = anker(inhalt)
  if (id) tokens[i].attrSet('id', id)
  return self.renderToken(tokens, i, opts)
}

/** Wohin ein Verweis zeigt, den das Handbuch nicht selbst enthält. */
const REPO = 'https://github.com/blckwngd/Ajna/'

/**
 * Einen relativen Pfad gegen den Ordner der Quelldatei auflösen.
 *
 * Ohne diesen Schritt bleibt jeder Verweis INNERHALB von `docs/` liegen:
 * `[Gastkonten](gastkonten.md)` in `docs/betrieb.md` meint `docs/gastkonten.md`,
 * nicht `gastkonten.md` im Wurzelverzeichnis. Beim ersten Lauf waren das 18
 * tote Verweise — alle in derselben Form.
 */
export function aufloesen(pfad, basis) {
  const teile = [...String(basis || '').split('/').filter(Boolean)]
  for (const stueck of String(pfad).split('/')) {
    if (stueck === '' || stueck === '.') continue
    if (stueck === '..') teile.pop()
    else teile.push(stueck)
  }
  return teile.join('/')
}

/** Repo-Pfad → Schlüssel in der Seitenliste (`docs/uwb` bzw. `Die-App`). */
export function zielName(repoPfad) {
  const teile = String(repoPfad).split('/')
  const datei = basename(teile.pop(), '.md')
  const ordner = teile.pop() || ''
  return (ordner === 'docs' ? 'docs/' : '') + datei
}

/** Ein Ziel aus der Seitenliste, gesehen von einer Seite in der Tiefe `tiefe`. */
export function relativ(ziel, tiefe) {
  if (!tiefe) return ziel
  return ziel.startsWith('docs/') ? ziel.slice('docs/'.length) : '../' + ziel
}

/**
 * Verweise umbiegen: `.md` → `.html`, alles andere ins Repo.
 *
 * Ein Handbuch, dessen Querverweise den Leser hinauswerfen, ist nur eine halbe
 * Übersetzung. Zwei Sorten Ziel, zwei Antworten:
 *
 *   * Ein Dokument, das wir erzeugen → die Seite daneben, mit der richtigen
 *     Tiefe. `docs/betrieb.md` verweist auf `gastkonten.md` und meint die
 *     Nachbardatei, nicht eine im Wurzelverzeichnis.
 *   * Eine QUELLDATEI (`client/core/yaw.js`, `scripts/deploy.sh`) → ins Repo.
 *     Die Doku verweist oft auf Code; im Handbuch gäbe das sonst einen toten
 *     Klick. Beides fand erst der Test über die echten Dateien: 44 Verweise,
 *     die ins Leere zeigten.
 */
export function verweisUmbiegen(href, seiten, basis = 'wiki', tiefe = 0) {
  if (!href) return href
  const github = /^https?:\/\/github\.com\/[^/]+\/Ajna\/(?:blob|tree)\/[^/]+\/(.+)$/.exec(href)
  const roh = github ? github[1] : href
  if (!github && /^[a-z]+:/i.test(roh)) return href       // echte externe Adresse
  const [pfad, marke] = roh.split('#')
  if (!pfad) return href                                  // reiner Sprung auf derselben Seite
  // Bilder liegen kopiert daneben; sie sind das Einzige, was wir mitnehmen.
  if (!github && /^img\//.test(pfad)) return href
  const repoPfad = github ? pfad : aufloesen(pfad, basis)

  if (/\.md$/i.test(pfad)) {
    const name = zielName(repoPfad)
    if (seiten.has(name)) return relativ(seiten.get(name), tiefe) + (marke ? '#' + marke : '')
  }
  // Ordner brauchen `tree`, Dateien `blob` — sonst zeigt GitHub eine Fehlseite.
  const art = /\.[a-z0-9]+$/i.test(repoPfad) ? 'blob' : 'tree'
  return `${REPO}${art}/main/${repoPfad}${marke ? '#' + marke : ''}`
}

/** Navigation aus `wiki/_Sidebar.md` — keine zweite Liste, die veralten kann. */
export function navLesen(text) {
  const gruppen = []
  let aktuell = null
  for (const zeile of String(text).split('\n')) {
    const titel = /^\*\*(.+?)\*\*\s*$/.exec(zeile.trim())
    if (titel) { aktuell = { titel: titel[1], seiten: [] }; gruppen.push(aktuell); continue }
    const link = /^[-*]\s*\[([^\]]+)\]\(([^)]+)\)/.exec(zeile.trim())
    if (link && aktuell) aktuell.seiten.push({ text: link[1], ziel: zielName(link[2]) })
  }
  return gruppen
}

/**
 * Was `wiki-nav.mjs` erzeugt hat, fliegt raus.
 *
 * Diese Blöcke sind die Navigation FÜR GITHUB. Das Handbuch hat eine eigene;
 * beide nebeneinander wären zwei Wegweiser am selben Pfosten.
 */
export function generiertesEntfernen(text) {
  return String(text)
    .replace(/<!--\s*nav\s*-->[\s\S]*?<!--\s*\/nav\s*-->/g, '')
    .replace(/<!--\s*navfuss\s*-->[\s\S]*?<!--\s*\/navfuss\s*-->/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function rendern(markdown, seiten, basis = 'wiki', tiefe = 0) {
  const vorbereitet = generiertesEntfernen(markdown).replace(/<br\s*\/?>/gi, UMBRUCH)
  const html = md.render(vorbereitet)
  return html
    .split(UMBRUCH).join('<br>')
    // `| | |` als Kopfzeile ist in dieser Doku die übliche Art, eine Tabelle
    // OHNE Kopf zu schreiben. Gerendert bleibt davon ein leerer grauer Balken.
    .replace(/<thead>\s*<tr>(?:\s*<th[^>]*><\/th>)+\s*<\/tr>\s*<\/thead>/g, '')
    // Verweise nachträglich umbiegen: markdown-it hat die Ziele schon
    // maskiert, ein zweiter Durchgang über das Ergebnis ist die knappste
    // Stelle dafür — und die einzige, die auch verlinkte Bilder erwischt.
    .replace(/(<a [^>]*href=")([^"]+)(")/g, (_, a, href, z) => a + verweisUmbiegen(href, seiten, basis, tiefe) + z)
}

const SEITE = (titel, nav, inhalt, tiefe) => {
  const w = tiefe ? '../' : ''
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titel} — Ajna-Handbuch</title>
<link rel="stylesheet" href="${w}handbuch.css">
</head>
<body>
<a class="sprung" href="#inhalt">Zum Inhalt</a>
<nav class="seitenleiste">
<a class="marke" href="${w}index.html">Ajna-Handbuch</a>
${nav}
</nav>
<main id="inhalt">
${inhalt}
</main>
</body>
</html>
`
}

const CSS = `/* Handbuch — erzeugt von tools/handbuch.mjs, Änderungen gehen dort hin. */
:root {
  color-scheme: light dark;
  --grund: #fbfbfa; --text: #1b1b1a; --leise: #5c5c58; --linie: #e2e0da;
  --rand: #d8d5cc; --akzent: #3a6b52; --kasten: #f2f0ea;
}
@media (prefers-color-scheme: dark) {
  :root {
    --grund: #17181a; --text: #e6e4df; --leise: #9a978f; --linie: #2c2e31;
    --rand: #33353a; --akzent: #7db79a; --kasten: #1f2123;
  }
}
* { box-sizing: border-box }
body {
  margin: 0; background: var(--grund); color: var(--text);
  font: 16px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  display: grid; grid-template-columns: 17rem 1fr;
}
.sprung { position: absolute; left: -9999px }
.sprung:focus { left: 0; top: 0; padding: .6rem 1rem; background: var(--akzent); color: #fff; z-index: 9 }
.seitenleiste {
  border-right: 1px solid var(--linie); padding: 1.6rem 1.2rem 3rem;
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
}
.marke { display: block; font-weight: 600; font-size: 1.05rem; margin-bottom: 1.4rem;
         color: var(--text); text-decoration: none }
.seitenleiste h2 { font-size: .72rem; text-transform: uppercase; letter-spacing: .09em;
                   color: var(--leise); margin: 1.5rem 0 .4rem; font-weight: 600 }
.seitenleiste a { display: block; padding: .22rem 0; color: var(--text);
                  text-decoration: none; border-radius: 3px }
.seitenleiste a:hover { color: var(--akzent) }
.seitenleiste a.hier { color: var(--akzent); font-weight: 600 }
main { padding: 2.4rem clamp(1rem, 4vw, 3.5rem) 6rem; max-width: 62rem; min-width: 0 }
h1, h2, h3, h4 { line-height: 1.25; margin: 2.2rem 0 .7rem }
h1 { font-size: 1.9rem; margin-top: 0 }
h2 { font-size: 1.35rem; padding-bottom: .3rem; border-bottom: 1px solid var(--linie) }
h3 { font-size: 1.1rem }
p, ul, ol, blockquote, table, pre { margin: .8rem 0 }
a { color: var(--akzent) }
code { font: .89em/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
       background: var(--kasten); padding: .12em .34em; border-radius: 3px }
pre { background: var(--kasten); border: 1px solid var(--linie); border-radius: 6px;
      padding: .85rem 1rem; overflow-x: auto }
pre code { background: none; padding: 0 }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto }
th, td { border: 1px solid var(--rand); padding: .45rem .7rem; text-align: left; vertical-align: top }
th { background: var(--kasten); font-weight: 600 }
blockquote { border-left: 3px solid var(--akzent); margin-left: 0; padding: .1rem 0 .1rem 1rem;
             color: var(--leise) }
hr { border: 0; border-top: 1px solid var(--linie); margin: 2rem 0 }
img { max-width: 100%; height: auto; border-radius: 6px }
li > ul, li > ol { margin: .2rem 0 }
.fuss { margin-top: 4rem; padding-top: 1rem; border-top: 1px solid var(--linie);
        color: var(--leise); font-size: .85rem }
@media (max-width: 720px) {
  body { grid-template-columns: 1fr }
  .seitenleiste { position: static; height: auto; border-right: 0;
                  border-bottom: 1px solid var(--linie) }
  main { padding-top: 1.4rem }
}
`

/** Alle Dokumente einsammeln: `wiki/` ist das Handbuch, `docs/` die Vertiefung. */
async function dokumenteSammeln() {
  const seiten = new Map()   // Schlüssel → Ausgabepfad (relativ zu ZIEL)
  const quellen = []

  for (const datei of (await readdir(join(WURZEL, 'wiki'))).sort()) {
    if (extname(datei) !== '.md' || datei.startsWith('_')) continue
    const name = basename(datei, '.md')
    const aus = name === 'Home' ? 'index.html' : `${name}.html`
    seiten.set(name, aus)
    quellen.push({ quelle: join(WURZEL, 'wiki', datei), aus, titel: name.replace(/-/g, ' '), tiefe: 0, basis: 'wiki' })
  }
  if (existsSync(join(WURZEL, 'docs'))) {
    for (const datei of (await readdir(join(WURZEL, 'docs'))).sort()) {
      if (extname(datei) !== '.md') continue
      const name = basename(datei, '.md')
      const aus = `docs/${name}.html`
      seiten.set('docs/' + name, aus)
      quellen.push({ quelle: join(WURZEL, 'docs', datei), aus, titel: name.replace(/-/g, ' '), tiefe: 1, basis: 'docs' })
    }
  }
  return { seiten, quellen }
}

function navBauen(gruppen, seiten, aktuell, tiefe, titel) {
  const w = tiefe ? '../' : ''
  const teile = []
  for (const g of gruppen) {
    teile.push(`<h2>${g.titel}</h2>`)
    for (const s of g.seiten) {
      const ziel = seiten.get(s.ziel)
      if (!ziel) continue
      teile.push(`<a href="${w}${ziel}"${ziel === aktuell ? ' class="hier"' : ''}>${s.text}</a>`)
    }
  }
  const vertiefung = [...seiten.entries()].filter(([k]) => k.startsWith('docs/'))
  if (vertiefung.length) {
    teile.push('<h2>Vertiefung</h2>')
    for (const [k, ziel] of vertiefung) {
      // Der Titel steht in der Datei. Aus dem Dateinamen abgeleitet hiesse
      // dieser Eintrag „adress anreicherung quellen" statt „Adress-Quellen".
      const text = titel.get(ziel) || k.slice(5).replace(/-/g, ' ')
      teile.push(`<a href="${w}${ziel}"${ziel === aktuell ? ' class="hier"' : ''}>${text}</a>`)
    }
  }
  return teile.join('\n')
}

export async function bauen({ still = false } = {}) {
  const log = still ? () => {} : (m) => console.log(`[handbuch] ${m}`)
  const { seiten, quellen } = await dokumenteSammeln()
  const gruppen = navLesen(await readFile(join(WURZEL, 'wiki', '_Sidebar.md'), 'utf8'))

  await rm(ZIEL, { recursive: true, force: true })
  await mkdir(join(ZIEL, 'docs'), { recursive: true })
  await writeFile(join(ZIEL, 'handbuch.css'), CSS, 'utf8')

  // Erst alle Titel einsammeln, dann rendern: Die Navigation jeder Seite nennt
  // die anderen, und die heissen so, wie ihre Überschrift lautet.
  const titel = new Map()
  for (const q of quellen) {
    const erste = /^#\s+(.+)$/m.exec(await readFile(q.quelle, 'utf8'))
    titel.set(q.aus, (erste ? erste[1].trim() : q.titel).replace(/[*`]/g, ''))
  }

  const stand = new Date().toISOString().slice(0, 10)
  for (const q of quellen) {
    const roh = await readFile(q.quelle, 'utf8')
    const inhalt = rendern(roh, seiten, q.basis, q.tiefe)
      + `\n<p class="fuss">Ajna-Handbuch · erzeugt am ${stand} aus `
      + `<code>${q.quelle.slice(WURZEL.length + 1).split('\\').join('/')}</code></p>`
    await writeFile(join(ZIEL, q.aus),
      SEITE(titel.get(q.aus), navBauen(gruppen, seiten, q.aus, q.tiefe, titel), inhalt, q.tiefe), 'utf8')
  }

  // Bilder mitnehmen, sonst zeigen die Verweise ins Leere.
  const bilder = join(WURZEL, 'wiki', 'img')
  if (existsSync(bilder)) {
    await mkdir(join(ZIEL, 'img'), { recursive: true })
    for (const b of await readdir(bilder)) await copyFile(join(bilder, b), join(ZIEL, 'img', b))
  }

  log(`${quellen.length} Seiten nach client/handbuch/`)
  return { seiten: quellen.length, ziel: ZIEL }
}

// Direkt aufgerufen? Dann bauen.
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  bauen().catch(err => { console.error('[handbuch]', err); process.exit(1) })
}
