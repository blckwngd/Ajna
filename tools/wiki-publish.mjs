#!/usr/bin/env node
// tools/wiki-publish.mjs — überträgt den Ordner `wiki/` ins GitHub-Wiki.
//
// HINTERGRUND: Das GitHub-Wiki ist ein EIGENES Repository neben dem Code —
// `<repo>.wiki.git`. Dateien im Ordner `wiki/` des Haupt-Repositorys tauchen
// dort nicht von selbst auf. Dieses Skript spiegelt sie hinüber.
//
// EINMALIG VORHER: GitHub legt das Wiki-Repository erst an, wenn über die
// Weboberfläche die erste Seite gespeichert wurde (Reiter „Wiki" → „Create the
// first page" → irgendetwas eintragen → speichern). Vorher schlägt jeder Klon
// mit „Repository not found" fehl. Der Inhalt dieser Seite wird gleich
// überschrieben, es genügt also ein Wort.
//
// NUTZUNG
//   node tools/wiki-publish.mjs                 veröffentlichen
//   node tools/wiki-publish.mjs --dry-run       nur zeigen, was passieren würde
//   node tools/wiki-publish.mjs -m "Nachricht"  eigene Commit-Nachricht
//
// SEITENNAMEN ergeben sich aus den Dateinamen: `Erste-Schritte.md` wird zur
// Seite „Erste Schritte". `Home.md` ist die Startseite, `_Sidebar.md` und
// `_Footer.md` rendert GitHub auf jeder Seite mit.
//
// BILDER liegen in `wiki/img/` und werden mitkopiert; die Seiten verweisen
// relativ (`img/datei.png`). Sollte GitHub sie im Wiki wider Erwarten nicht
// auflösen, ist die Ausweichform ein absoluter Link auf das Haupt-Repository:
// `https://raw.githubusercontent.com/<owner>/<repo>/main/wiki/img/datei.png`.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const QUELLE = join(ROOT, 'wiki')
const args = process.argv.slice(2)
const trocken = args.includes('--dry-run')
const nachricht = (() => {
  const i = args.findIndex(a => a === '-m' || a === '--message')
  return i >= 0 && args[i + 1] ? args[i + 1] : 'Wiki aus wiki/ aktualisiert'
})()

const sh = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()

const fehler = (...zeilen) => { for (const z of zeilen) console.error(z); process.exit(1) }

if (!existsSync(QUELLE)) fehler(`✗ Ordner nicht gefunden: ${QUELLE}`)

// ── Wiki-Adresse aus origin ableiten ──────────────────────────────────────
let origin
try { origin = sh('git', ['remote', 'get-url', 'origin'], { cwd: ROOT }) }
catch { fehler('✗ Kein git-Remote „origin" — läuft das Skript im Repository?') }

const wikiUrl = origin.replace(/\.git$/, '') + '.wiki.git'
console.log(`Quelle : ${relative(process.cwd(), QUELLE) || 'wiki'}`)
console.log(`Ziel   : ${wikiUrl}`)

// ── Existiert das Wiki-Repository schon? ──────────────────────────────────
try {
  sh('git', ['ls-remote', wikiUrl], { cwd: ROOT, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
} catch (err) {
  const text = `${err.stdout || ''}${err.stderr || ''}`
  if (/not found/i.test(text)) {
    const web = origin.replace(/\.git$/, '') + '/wiki'
    fehler(
      '',
      '✗ Das Wiki-Repository existiert noch nicht.',
      '',
      '  GitHub legt es erst an, wenn EINE Seite über die Weboberfläche gespeichert wurde:',
      `    1. ${web} öffnen`,
      '    2. „Create the first page" — irgendetwas eintragen',
      '    3. „Save page"',
      '',
      '  Danach dieses Skript erneut ausführen; der Platzhalter wird überschrieben.',
      '')
  }
  fehler('✗ Wiki-Repository nicht erreichbar:', text.trim())
}

// ── Klonen ────────────────────────────────────────────────────────────────
const arbeit = join(tmpdir(), 'ajna-wiki-publish')
if (existsSync(arbeit)) rmSync(arbeit, { recursive: true, force: true })
mkdirSync(arbeit, { recursive: true })

console.log('\nKlone Wiki …')
try { sh('git', ['clone', '--depth', '1', wikiUrl, arbeit]) }
catch (err) { fehler('✗ Klonen fehlgeschlagen:', `${err.stdout || ''}${err.stderr || ''}`.trim()) }

// ── Spiegeln: altes Wiki leeren (ohne .git), dann kopieren ────────────────
for (const e of readdirSync(arbeit)) {
  if (e === '.git') continue
  rmSync(join(arbeit, e), { recursive: true, force: true })
}

let anzahl = 0
const kopiere = (von, nach) => {
  mkdirSync(nach, { recursive: true })
  for (const e of readdirSync(von)) {
    const q = join(von, e), z = join(nach, e)
    if (statSync(q).isDirectory()) kopiere(q, z)
    else { copyFileSync(q, z); anzahl++ }
  }
}
kopiere(QUELLE, arbeit)
console.log(`${anzahl} Datei(en) übertragen`)

// ── Übertragen ────────────────────────────────────────────────────────────
sh('git', ['add', '-A'], { cwd: arbeit })
const offen = sh('git', ['status', '--porcelain'], { cwd: arbeit })
if (!offen) { console.log('\n✓ Wiki ist bereits aktuell — nichts zu tun.'); process.exit(0) }

console.log('\nÄnderungen:')
for (const z of offen.split('\n')) console.log('  ' + z)

if (trocken) { console.log('\n(--dry-run: nichts übertragen)'); process.exit(0) }

sh('git', ['commit', '-m', nachricht], { cwd: arbeit })
try { sh('git', ['push'], { cwd: arbeit, stdio: ['ignore', 'inherit', 'inherit'] }) }
catch (err) { fehler('✗ Push fehlgeschlagen:', `${err.stdout || ''}${err.stderr || ''}`.trim()) }

console.log(`\n✓ Veröffentlicht: ${origin.replace(/\.git$/, '')}/wiki`)
