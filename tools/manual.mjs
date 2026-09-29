#!/usr/bin/env node
//
// tools/manual.mjs — build a readable manual out of the Markdown files.
//
// WHY: the documentation is versioned in the repository and reads well on
// GitHub — but whoever runs an Ajna instance has the server in front of them,
// not necessarily the repository. This generator puts the same texts under
// `client/manual/` as static pages. Caddy serves `client/` anyway, so this
// needs no line of Caddy configuration at all.
//
// BUILT STATICALLY, NOT RENDERED AT REQUEST TIME. Three reasons:
//   * No Markdown parser in the browser bundle and none in the running server.
//   * The pages work without JavaScript — a manual that needs a program first
//     is a poor manual.
//   * They travel into the Android app, because Capacitor packs `client/`.
//
// `npm run build` calls it, and `scripts/deploy.sh` calls `npm run build` — on
// the server the manual is therefore always as fresh as the code.
//
// RAW HTML IS OFF (`html: false`), and here that is not merely the safe setting
// but the CORRECT one: the documentation carries placeholders like `<name>` or
// `<source>` in running text. Read as HTML they would vanish without trace;
// this way they show up as they were meant. The one exception is `<br/>` inside
// table cells — see `BREAK_MARK`.
//
// The texts the reader sees stay German, like every other surface in this
// project. Only the code around them is English (see CLAUDE.md).

import { mkdir, readdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import MarkdownIt from 'markdown-it'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..')
export const OUT = join(ROOT, 'client', 'manual')

/**
 * `<br/>` survives, nothing else does.
 *
 * A line break appears 33 times inside tables, and a table cell knows no other
 * way. The marker passes through the parser untouched (it holds no special
 * character) and is swapped back afterwards.
 */
const BREAK_MARK = 'zzbreakzz'

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false })

/**
 * Heading → anchor name, the way GitHub does it.
 *
 * It has to match GitHub, because the texts contain jump marks written over
 * there (`[Inhaltsverzeichnis](#inhalt)`). Lower case, spaces to hyphens,
 * punctuation gone — umlauts stay.
 */
export function slug(text) {
  return String(text)
    .trim().toLowerCase()
    .replace(/[`*_~\[\]()]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

// Headings get their jump mark. Without it every link with `#` points nowhere —
// and this documentation has plenty of those.
md.renderer.rules.heading_open = (tokens, i, opts, env, self) => {
  const id = slug(tokens[i + 1]?.content || '')
  if (id) tokens[i].attrSet('id', id)
  return self.renderToken(tokens, i, opts)
}

/** Where a link points that the manual does not contain itself. */
const REPO = 'https://github.com/blckwngd/Ajna/'

/**
 * Resolve a relative path against the folder of its source document.
 *
 * Without this step every link INSIDE `docs/` stays behind:
 * `[Gastkonten](gastkonten.md)` in `docs/betrieb.md` means `docs/gastkonten.md`,
 * not `gastkonten.md` at the top level. On the first run that was 18 dead
 * links, all of the same shape.
 */
export function resolvePath(path, base) {
  const parts = [...String(base || '').split('/').filter(Boolean)]
  for (const piece of String(path).split('/')) {
    if (piece === '' || piece === '.') continue
    if (piece === '..') parts.pop()
    else parts.push(piece)
  }
  return parts.join('/')
}

/** Repo path → key in the page list (`docs/uwb` or `Die-App`). */
export function pageKey(repoPath) {
  const parts = String(repoPath).split('/')
  const file = basename(parts.pop(), '.md')
  const folder = parts.pop() || ''
  return (folder === 'docs' ? 'docs/' : '') + file
}

/** A target from the page list, seen from a page at `depth`. */
export function relativeTo(target, depth) {
  if (!depth) return target
  return target.startsWith('docs/') ? target.slice('docs/'.length) : '../' + target
}

/**
 * Rewrite links: `.md` → `.html`, everything else into the repository.
 *
 * A manual whose cross references throw the reader out is only half a
 * translation. Two kinds of target, two answers:
 *
 *   * A document we generate → the page next door, at the right depth.
 *     `docs/betrieb.md` links to `gastkonten.md` and means the neighbouring
 *     file, not one at the top level.
 *   * A SOURCE FILE (`client/core/yaw.js`, `scripts/deploy.sh`) → the
 *     repository. The documentation links to code often; inside the manual
 *     that would be a dead click. Both were found only by the test over the
 *     real files: 44 links that pointed nowhere.
 */
export function rewriteLink(href, pages, base = 'wiki', depth = 0) {
  if (!href) return href
  const github = /^https?:\/\/github\.com\/[^/]+\/Ajna\/(?:blob|tree)\/[^/]+\/(.+)$/.exec(href)
  const raw = github ? github[1] : href
  if (!github && /^[a-z]+:/i.test(raw)) return href       // a real external address
  const [path, mark] = raw.split('#')
  if (!path) return href                                  // plain jump on the same page
  // Images sit copied next to the pages; they are the only thing we take along.
  if (!github && /^img\//.test(path)) return href
  const repoPath = github ? path : resolvePath(path, base)

  if (/\.md$/i.test(path)) {
    const key = pageKey(repoPath)
    if (pages.has(key)) return relativeTo(pages.get(key), depth) + (mark ? '#' + mark : '')
  }
  // Folders need `tree`, files need `blob` — otherwise GitHub shows an error page.
  const kind = /\.[a-z0-9]+$/i.test(repoPath) ? 'blob' : 'tree'
  return `${REPO}${kind}/main/${repoPath}${mark ? '#' + mark : ''}`
}

/** Navigation from `wiki/_Sidebar.md` — no second list that could go stale. */
export function readNav(text) {
  const groups = []
  let current = null
  for (const line of String(text).split('\n')) {
    const title = /^\*\*(.+?)\*\*\s*$/.exec(line.trim())
    if (title) { current = { title: title[1], pages: [] }; groups.push(current); continue }
    const link = /^[-*]\s*\[([^\]]+)\]\(([^)]+)\)/.exec(line.trim())
    if (link && current) current.pages.push({ text: link[1], target: pageKey(link[2]) })
  }
  return groups
}

/**
 * Whatever `wiki-nav.mjs` generated is dropped.
 *
 * Those blocks are the navigation FOR GITHUB. The manual has its own; both
 * side by side would be two signposts on one pole.
 */
export function stripGenerated(text) {
  return String(text)
    .replace(/<!--\s*nav\s*-->[\s\S]*?<!--\s*\/nav\s*-->/g, '')
    .replace(/<!--\s*navfuss\s*-->[\s\S]*?<!--\s*\/navfuss\s*-->/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function render(markdown, pages, base = 'wiki', depth = 0) {
  const prepared = stripGenerated(markdown).replace(/<br\s*\/?>/gi, BREAK_MARK)
  return md.render(prepared)
    .split(BREAK_MARK).join('<br>')
    // `| | |` as a header row is how this documentation writes a table WITHOUT
    // a head. Rendered, all that is left of it is an empty grey bar.
    .replace(/<thead>\s*<tr>(?:\s*<th[^>]*><\/th>)+\s*<\/tr>\s*<\/thead>/g, '')
    // Rewrite links afterwards: markdown-it has already escaped the targets, so
    // a second pass over the result is the shortest place for it — and the only
    // one that also catches linked images.
    .replace(/(<a [^>]*href=")([^"]+)(")/g, (_, a, href, z) => a + rewriteLink(href, pages, base, depth) + z)
}

const PAGE = (title, nav, content, depth) => {
  const up = depth ? '../' : ''
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Ajna-Handbuch</title>
<link rel="stylesheet" href="${up}manual.css">
</head>
<body>
<a class="skip" href="#content">Zum Inhalt</a>
<nav class="sidebar">
<a class="brand" href="${up}index.html">Ajna-Handbuch</a>
${nav}
</nav>
<main id="content">
${content}
</main>
</body>
</html>
`
}

const CSS = `/* Manual — generated by tools/manual.mjs, changes belong there. */
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --fg: #1b1b1a; --muted: #5c5c58; --line: #e2e0da;
  --border: #d8d5cc; --accent: #3a6b52; --box: #f2f0ea;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17181a; --fg: #e6e4df; --muted: #9a978f; --line: #2c2e31;
    --border: #33353a; --accent: #7db79a; --box: #1f2123;
  }
}
* { box-sizing: border-box }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  display: grid; grid-template-columns: 17rem 1fr;
}
.skip { position: absolute; left: -9999px }
.skip:focus { left: 0; top: 0; padding: .6rem 1rem; background: var(--accent); color: #fff; z-index: 9 }
.sidebar {
  border-right: 1px solid var(--line); padding: 1.6rem 1.2rem 3rem;
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
}
.brand { display: block; font-weight: 600; font-size: 1.05rem; margin-bottom: 1.4rem;
         color: var(--fg); text-decoration: none }
.sidebar h2 { font-size: .72rem; text-transform: uppercase; letter-spacing: .09em;
              color: var(--muted); margin: 1.5rem 0 .4rem; font-weight: 600 }
.sidebar a { display: block; padding: .22rem 0; color: var(--fg);
             text-decoration: none; border-radius: 3px }
.sidebar a:hover { color: var(--accent) }
.sidebar a.current { color: var(--accent); font-weight: 600 }
main { padding: 2.4rem clamp(1rem, 4vw, 3.5rem) 6rem; max-width: 62rem; min-width: 0 }
h1, h2, h3, h4 { line-height: 1.25; margin: 2.2rem 0 .7rem }
h1 { font-size: 1.9rem; margin-top: 0 }
h2 { font-size: 1.35rem; padding-bottom: .3rem; border-bottom: 1px solid var(--line) }
h3 { font-size: 1.1rem }
p, ul, ol, blockquote, table, pre { margin: .8rem 0 }
a { color: var(--accent) }
code { font: .89em/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
       background: var(--box); padding: .12em .34em; border-radius: 3px }
pre { background: var(--box); border: 1px solid var(--line); border-radius: 6px;
      padding: .85rem 1rem; overflow-x: auto }
pre code { background: none; padding: 0 }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto }
th, td { border: 1px solid var(--border); padding: .45rem .7rem; text-align: left; vertical-align: top }
th { background: var(--box); font-weight: 600 }
blockquote { border-left: 3px solid var(--accent); margin-left: 0; padding: .1rem 0 .1rem 1rem;
             color: var(--muted) }
hr { border: 0; border-top: 1px solid var(--line); margin: 2rem 0 }
img { max-width: 100%; height: auto; border-radius: 6px }
li > ul, li > ol { margin: .2rem 0 }
.source { margin-top: 4rem; padding-top: 1rem; border-top: 1px solid var(--line);
          color: var(--muted); font-size: .85rem }
@media (max-width: 720px) {
  body { grid-template-columns: 1fr }
  .sidebar { position: static; height: auto; border-right: 0;
             border-bottom: 1px solid var(--line) }
  main { padding-top: 1.4rem }
}
`

/** Collect every document: `wiki/` is the manual, `docs/` the deeper material. */
async function collectDocuments() {
  const pages = new Map()   // key → output path, relative to OUT
  const sources = []

  for (const file of (await readdir(join(ROOT, 'wiki'))).sort()) {
    if (extname(file) !== '.md' || file.startsWith('_')) continue
    const name = basename(file, '.md')
    const out = name === 'Home' ? 'index.html' : `${name}.html`
    pages.set(name, out)
    sources.push({ file: join(ROOT, 'wiki', file), out, title: name.replace(/-/g, ' '), depth: 0, base: 'wiki' })
  }
  if (existsSync(join(ROOT, 'docs'))) {
    for (const file of (await readdir(join(ROOT, 'docs'))).sort()) {
      if (extname(file) !== '.md') continue
      const name = basename(file, '.md')
      const out = `docs/${name}.html`
      pages.set('docs/' + name, out)
      sources.push({ file: join(ROOT, 'docs', file), out, title: name.replace(/-/g, ' '), depth: 1, base: 'docs' })
    }
  }
  return { pages, sources }
}

function buildNav(groups, pages, current, depth, titles) {
  const up = depth ? '../' : ''
  const out = []
  for (const g of groups) {
    out.push(`<h2>${g.title}</h2>`)
    for (const p of g.pages) {
      const target = pages.get(p.target)
      if (!target) continue
      out.push(`<a href="${up}${target}"${target === current ? ' class="current"' : ''}>${p.text}</a>`)
    }
  }
  const deeper = [...pages.entries()].filter(([k]) => k.startsWith('docs/'))
  if (deeper.length) {
    out.push('<h2>Vertiefung</h2>')
    for (const [k, target] of deeper) {
      // The title is in the file. Derived from the file name this entry would
      // read "adress anreicherung quellen" instead of "Adress-Anreicherung".
      const text = titles.get(target) || k.slice('docs/'.length).replace(/-/g, ' ')
      out.push(`<a href="${up}${target}"${target === current ? ' class="current"' : ''}>${text}</a>`)
    }
  }
  return out.join('\n')
}

export async function build({ quiet = false } = {}) {
  const log = quiet ? () => {} : (m) => console.log(`[manual] ${m}`)
  const { pages, sources } = await collectDocuments()
  const groups = readNav(await readFile(join(ROOT, 'wiki', '_Sidebar.md'), 'utf8'))

  await rm(OUT, { recursive: true, force: true })
  await mkdir(join(OUT, 'docs'), { recursive: true })
  await writeFile(join(OUT, 'manual.css'), CSS, 'utf8')

  // Collect every title first, then render: each page's navigation names the
  // others, and they are called whatever their heading says.
  const titles = new Map()
  for (const s of sources) {
    const first = /^#\s+(.+)$/m.exec(await readFile(s.file, 'utf8'))
    titles.set(s.out, (first ? first[1].trim() : s.title).replace(/[*`]/g, ''))
  }

  const date = new Date().toISOString().slice(0, 10)
  for (const s of sources) {
    const raw = await readFile(s.file, 'utf8')
    const content = render(raw, pages, s.base, s.depth)
      + `\n<p class="source">Ajna-Handbuch · erzeugt am ${date} aus `
      + `<code>${s.file.slice(ROOT.length + 1).split('\\').join('/')}</code></p>`
    await writeFile(join(OUT, s.out),
      PAGE(titles.get(s.out), buildNav(groups, pages, s.out, s.depth, titles), content, s.depth), 'utf8')
  }

  // Take the images along, or the links point nowhere.
  const images = join(ROOT, 'wiki', 'img')
  if (existsSync(images)) {
    await mkdir(join(OUT, 'img'), { recursive: true })
    for (const i of await readdir(images)) await copyFile(join(images, i), join(OUT, 'img', i))
  }

  log(`${sources.length} Seiten nach client/manual/`)
  return { pages: sources.length, out: OUT }
}

// Called directly? Then build.
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  build().catch(err => { console.error('[manual]', err); process.exit(1) })
}
