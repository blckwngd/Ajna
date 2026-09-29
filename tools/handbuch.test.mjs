// Tests für tools/handbuch.mjs.
//
// Zwei Teile: die reinen Funktionen einzeln, und danach ein Lauf über die
// ECHTEN Dateien in `wiki/` und `docs/`. Der zweite Teil ist der wichtigere —
// ein Handbuch-Generator, der nur an erfundenem Markdown geprüft wird, bricht
// beim ersten Dokument, das jemand wirklich geschrieben hat.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { anker, zielName, aufloesen, relativ, verweisUmbiegen, navLesen, generiertesEntfernen, rendern, bauen, WURZEL, ZIEL } from './handbuch.mjs'

// ─── Die Teile ────────────────────────────────────────────────────────────

test('Sprungmarken heissen wie auf GitHub', () => {
  // Muss passen, weil die Texte Verweise enthalten, die dort geschrieben
  // wurden — `[Inhaltsverzeichnis](#inhalt)` muss ankommen.
  assert.equal(anker('Inhalt'), 'inhalt')
  assert.equal(anker('Erste Schritte'), 'erste-schritte')
  assert.equal(anker('Rechte und Privatsphäre'), 'rechte-und-privatsphäre')
  assert.equal(anker('`code` im Titel!'), 'code-im-titel')
})

test('relative Pfade werden gegen den Ordner der Quelle aufgelöst', () => {
  // Der Fehler, den der erste Lauf zeigte: 18 tote Verweise, alle davon
  // Verweise INNERHALB von docs/ ohne Ordner-Angabe.
  assert.equal(aufloesen('gastkonten.md', 'docs'), 'docs/gastkonten.md')
  assert.equal(aufloesen('../parley/README.md', 'wiki'), 'parley/README.md')
  assert.equal(aufloesen('docs/uwb.md', 'wiki'), 'wiki/docs/uwb.md')
  assert.equal(aufloesen('./Die-App.md', 'wiki'), 'wiki/Die-App.md')
})

test('aus einem Repo-Pfad wird der Schlüssel der Seite', () => {
  assert.equal(zielName('wiki/Die-App.md'), 'Die-App')
  assert.equal(zielName('docs/uwb.md'), 'docs/uwb')
})

const SEITEN = new Map([['Die-App', 'Die-App.html'], ['docs/uwb', 'docs/uwb.html'], ['Home', 'index.html']])

test('Verweise zeigen ins Handbuch, nicht hinaus', () => {
  assert.equal(verweisUmbiegen('Die-App.md', SEITEN, 'wiki'), 'Die-App.html')
  assert.equal(verweisUmbiegen('Die-App.md#karte', SEITEN, 'wiki'), 'Die-App.html#karte')
  assert.equal(verweisUmbiegen('uwb.md', SEITEN, 'docs'), 'docs/uwb.html')
  // Auch der GitHub-Umweg, den die Wiki-Seiten heute nehmen.
  assert.equal(verweisUmbiegen('https://github.com/blckwngd/Ajna/blob/main/docs/uwb.md', SEITEN, 'wiki'),
    'docs/uwb.html')
})

test('was das Handbuch nicht hat, zeigt ehrlich ins Repo statt in einen 404', () => {
  const z = verweisUmbiegen('../parley/README.md', SEITEN, 'wiki')
  assert.match(z, /^https:\/\/github\.com\/.*\/blob\/main\/parley\/README\.md$/)
})

test('Verweise auf Quelldateien gehen ins Repo, nicht ins Leere', () => {
  // Die Doku verweist oft auf Code. Im Handbuch waere das sonst ein toter Klick.
  assert.match(verweisUmbiegen('../client/core/yaw.js', SEITEN, 'docs'), /blob\/main\/client\/core\/yaw\.js$/)
  assert.match(verweisUmbiegen('../integrations/homeassistant/', SEITEN, 'docs'), /tree\/main\/integrations\/homeassistant$/)
})

test('die Tiefe der Seite bestimmt den Weg zum Ziel', () => {
  // `docs/betrieb.md` → `gastkonten.md` meint die Nachbardatei.
  assert.equal(relativ('docs/uwb.html', 1), 'uwb.html')
  assert.equal(relativ('index.html', 1), '../index.html')
  assert.equal(relativ('docs/uwb.html', 0), 'docs/uwb.html')
  assert.equal(verweisUmbiegen('uwb.md', SEITEN, 'docs', 1), 'uwb.html')
  assert.equal(verweisUmbiegen('../wiki/Die-App.md', SEITEN, 'docs', 1), '../Die-App.html')
})

test('echte externe Adressen und reine Sprungmarken bleiben unberührt', () => {
  assert.equal(verweisUmbiegen('https://opentrafficmap.org/', SEITEN), 'https://opentrafficmap.org/')
  assert.equal(verweisUmbiegen('#inhalt', SEITEN), '#inhalt')
  assert.equal(verweisUmbiegen('img/karte.png', SEITEN), 'img/karte.png')
})

test('die Navigation kommt aus _Sidebar.md', () => {
  const g = navLesen('### [Ajna](Home.md)\n\n**Benutzen**\n- [Die App](Die-App.md)\n\n**Betreiben**\n- [Server](Server-betreiben.md)\n')
  assert.equal(g.length, 2)
  assert.equal(g[0].titel, 'Benutzen')
  assert.deepEqual(g[0].seiten, [{ text: 'Die App', ziel: 'Die-App' }])
})

test('die für GitHub erzeugte Navigation fliegt raus', () => {
  // Sonst stünden zwei Wegweiser am selben Pfosten.
  const roh = '# Titel\n\n<!-- nav -->\n[zurück](Home.md)\n<!-- /nav -->\n\nText.\n<!-- navfuss -->\nunten\n<!-- /navfuss -->'
  const sauber = generiertesEntfernen(roh)
  assert.ok(!sauber.includes('zurück'))
  assert.ok(!sauber.includes('unten'))
  assert.ok(sauber.includes('Text.'))
})

test('Platzhalter im Fließtext überleben, HTML wird nicht ausgeführt', () => {
  // `<name>` ist in der Doku ein Platzhalter, kein Tag. Als HTML gedeutet
  // verschwände er spurlos — deshalb `html: false`.
  const h = rendern('Ein `<name>` und ein <name> und <script>alert(1)</script>.', SEITEN)
  assert.ok(h.includes('&lt;name&gt;'), h)
  assert.ok(!h.includes('<script>'), 'kein durchgereichtes HTML')
})

test('der Zeilenumbruch in Tabellenzellen überlebt', () => {
  const h = rendern('| a |\n|---|\n| eins<br/>zwei |', SEITEN)
  assert.ok(h.includes('eins<br>zwei'), h)
})

test('Tabellen, Code und Überschriften kommen als solche an', () => {
  const h = rendern('## Titel\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1\n```\n', SEITEN)
  assert.match(h, /<h2 id="titel">/)
  assert.match(h, /<table>/)
  assert.match(h, /<code class="language-js">/)
})

// ─── Der Lauf über die echten Dateien ─────────────────────────────────────

test('das Handbuch baut aus den echten Dokumenten', async (t) => {
  const ergebnis = await bauen({ still: true })
  assert.ok(ergebnis.seiten >= 12, `nur ${ergebnis.seiten} Seiten`)

  const seiten = [
    ...readdirSync(ZIEL).filter(f => f.endsWith('.html')).map(f => join(ZIEL, f)),
    ...(existsSync(join(ZIEL, 'docs')) ? readdirSync(join(ZIEL, 'docs')).map(f => join(ZIEL, 'docs', f)) : []),
  ]

  // 1. Kein Verweis darf ins Leere zeigen.
  const tot = []
  for (const f of seiten) {
    for (const m of readFileSync(f, 'utf8').matchAll(/href="([^"]+)"/g)) {
      const ziel = m[1]
      if (/^(https?:|mailto:|#)/.test(ziel)) continue
      if (/\.md(#|$)/i.test(ziel)) { tot.push(`${f} → ${ziel}`); continue }
      const pfad = join(f.includes('docs') && !ziel.startsWith('../') ? join(ZIEL, 'docs') : ZIEL,
                        ziel.replace(/^\.\.\//, '').split('#')[0])
      if (!existsSync(pfad)) tot.push(`${f} → ${ziel}`)
    }
  }
  assert.deepEqual(tot, [], 'tote Verweise')

  // 2. Jede Seite hat Gerüst, Navigation und Titel.
  for (const f of seiten) {
    const h = readFileSync(f, 'utf8')
    assert.match(h, /<html lang="de">/, f)
    assert.match(h, /<nav class="seitenleiste">/, f)
    assert.match(h, /<title>.+ — Ajna-Handbuch<\/title>/, f)
    assert.ok(!h.includes('<!-- nav -->'), `${f}: erzeugte Navigation nicht entfernt`)
  }

  // 3. Die Startseite ist Home.md und ihr Inhaltsverzeichnis findet sein Ziel.
  const start = readFileSync(join(ZIEL, 'index.html'), 'utf8')
  assert.match(start, /id="inhalt"/)

  // 4. Das Stilblatt liegt daneben, sonst sieht alles nackt aus.
  assert.ok(existsSync(join(ZIEL, 'handbuch.css')))
})

test('die Quelle jeder Seite steht darunter', () => {
  // Wer etwas ändern will, soll die Datei finden, ohne zu suchen.
  const h = readFileSync(join(ZIEL, 'Die-App.html'), 'utf8')
  assert.match(h, /wiki\/Die-App\.md/)
})

test('das Handbuch liegt im Client-Ordner — ohne Caddy-Änderung erreichbar', () => {
  assert.ok(ZIEL.replace(/\\/g, '/').endsWith('client/handbuch'))
  assert.ok(existsSync(join(WURZEL, 'client', 'index.html')), 'derselbe Ordner, den Caddy ausliefert')
})
