// Quellcache — Zwischenspeicher und Budget für fremde APIs.
//
// ANLASS: Die WiGLE-Brücke lieferte nichts mehr. Der Verdacht fiel aufs
// Tageslimit, und tatsächlich fehlte genau das Gegenmittel: Es gab keine Ablage
// auf Platte und keinen Zähler, der einen Neustart überlebt. Nicht der
// Dauerbetrieb verbrennt so ein Kontingent — die Neustarts tun es.
//
// Geprüft wird deshalb vor allem, was ÜBER EINEN NEUSTART HINWEG gilt: eine
// zweite Instanz auf demselben Ordner darf weder erneut abfragen noch den
// Zähler zurücksetzen.

import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Quellcache, istAbgeriegelt } from './quellcache.mjs'

let failures = 0
const t = {
  check(msg, cond, info = '') {
    if (cond) console.log(`  ✓ ${msg}${info ? ` (${info})` : ''}`)
    else { console.error(`  ✗ ${msg}${info ? ` (${info})` : ''}`); failures++ }
  },
}

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'ajna-quellcache-'))
  const neu = (opts = {}) => new Quellcache('test', { dir, log: () => {}, ...opts })

  try {
    // ── Zwischenspeicher ─────────────────────────────────────────────────
    {
      let rufe = 0
      const c = neu({ ttlMs: 60_000 })
      const quelle = async () => { rufe++; return { wert: rufe } }

      const a = await c.hole('k1', quelle)
      t.check('erste Frage geht an die Quelle', a.herkunft === 'frisch' && a.daten.wert === 1)
      const b = await c.hole('k1', quelle)
      t.check('die zweite nicht mehr', b.herkunft === 'cache' && rufe === 1)
      t.check('und liefert dasselbe', b.daten.wert === 1)

      const anderer = await c.hole('k2', quelle)
      t.check('ein anderer Schlüssel fragt neu', anderer.herkunft === 'frisch' && rufe === 2)

      const erzwungen = await c.hole('k1', quelle, { frisch: true })
      t.check('„frisch" umgeht die Ablage', erzwungen.herkunft === 'frisch' && rufe === 3)
    }

    // ── Über den Neustart hinweg ─────────────────────────────────────────
    {
      let rufe = 0
      const quelle = async () => { rufe++; return { wert: 'x' } }
      const zweite = neu({ ttlMs: 60_000 })
      const r = await zweite.hole('k1', quelle)
      t.check('eine neue Instanz findet die Ablage wieder',
        r.herkunft === 'cache' && rufe === 0)
    }

    // ── Haltbarkeit ──────────────────────────────────────────────────────
    {
      let rufe = 0
      const quelle = async () => { rufe++; return { wert: 'neu' } }
      const c = neu({ ttlMs: 0 })   // alles gilt sofort als abgelaufen
      const r = await c.hole('k1', quelle)
      t.check('abgelaufenes wird neu geholt', r.herkunft === 'frisch' && rufe === 1)
    }

    // ── Budget: Mindestabstand ───────────────────────────────────────────
    // EIGENER Ordner: Der Zähler liegt auf Platte und überdauert absichtlich —
    // in einem geteilten Ordner hätten die vorherigen Blöcke schon eine
    // „letzte Abfrage" hinterlassen und der Mindestabstand griffe sofort.
    {
      const dirT = await mkdtemp(join(tmpdir(), 'ajna-quellcache-'))
      try {
        let rufe = 0
        const quelle = async () => { rufe++; return { n: rufe } }
        const c = new Quellcache('test', { dir: dirT, log: () => {}, ttlMs: 0, minAbstandMs: 60_000 })
        await c.hole('takt', quelle)
        const zweit = await c.hole('takt', quelle)
        t.check('zu früh: keine zweite Abfrage', rufe === 1, 'rufe=' + rufe)
        t.check('stattdessen die alte Antwort', zweit.herkunft === 'cache-alt',
          'herkunft=' + zweit.herkunft)
        t.check('mit Begründung', zweit.grund === 'zu-frueh', 'grund=' + zweit.grund)
      } finally { await rm(dirT, { recursive: true, force: true }) }
    }

    // ── Budget: Tageslimit, und es überlebt den Neustart ─────────────────
    {
      const dir2 = await mkdtemp(join(tmpdir(), 'ajna-quellcache-'))
      try {
        let rufe = 0
        const quelle = async () => { rufe++; return { n: rufe } }
        const c = new Quellcache('test', { dir: dir2, log: () => {}, ttlMs: 0, proTag: 2 })
        await c.hole('a', quelle)
        await c.hole('b', quelle)
        t.check('bis zum Limit wird gefragt', rufe === 2)

        const drittes = await c.hole('c', quelle)
        t.check('darüber hinaus nicht mehr', rufe === 2)
        t.check('und ohne Ablage kommt nichts', drittes.daten === null && drittes.herkunft === null)
        t.check('mit Begründung', drittes.grund === 'tageslimit')

        // Der entscheidende Punkt: ein Neustart darf den Zähler NICHT leeren.
        const nachNeustart = new Quellcache('test', { dir: dir2, log: () => {}, ttlMs: 0, proTag: 2 })
        const r = await nachNeustart.hole('d', quelle)
        t.check('ein Neustart setzt den Zähler nicht zurück', rufe === 2,
          'Abfragen nach Neustart: ' + rufe)
        t.check('auch dort mit Begründung', r.grund === 'tageslimit')

        const stand = await nachNeustart.stand()
        t.check('der Stand ist auskunftsfähig', stand.benutzt === 2 && stand.uebrig === 0,
          JSON.stringify(stand))
      } finally { await rm(dir2, { recursive: true, force: true }) }
    }

    // ── Sperre nach Abriegelung ──────────────────────────────────────────
    {
      const dir3 = await mkdtemp(join(tmpdir(), 'ajna-quellcache-'))
      try {
        let rufe = 0
        const c = new Quellcache('test', { dir: dir3, log: () => {}, ttlMs: 0 })
        await c.sperre(3600_000)
        const r = await c.hole('x', async () => { rufe++; return 1 })
        t.check('nach der Sperre wird nicht gefragt', rufe === 0)
        t.check('und das steht auch dran', r.grund === 'gesperrt')
        const stand = await c.stand()
        t.check('die Sperre ist ablesbar', !!stand.gesperrt)
      } finally { await rm(dir3, { recursive: true, force: true }) }
    }

    // ── Fehler der Quelle: altes ausliefern ──────────────────────────────
    {
      const dir4 = await mkdtemp(join(tmpdir(), 'ajna-quellcache-'))
      try {
        const c = new Quellcache('test', { dir: dir4, log: () => {}, ttlMs: 0 })
        await c.hole('e', async () => ({ wert: 'gut' }))
        const r = await c.hole('e', async () => { throw new Error('Netz weg') })
        t.check('bei einem Fehler kommt die alte Antwort', r.daten.wert === 'gut')
        t.check('als alt gekennzeichnet', r.herkunft === 'cache-alt')
        t.check('samt Grund', /Netz weg/.test(r.grund))

        // Ohne etwas Abgelegtes muss der Fehler durchschlagen — sonst sähe ein
        // kaputter Zugang wie „keine Daten in der Gegend" aus.
        let geworfen = false
        try { await c.hole('leer', async () => { throw new Error('kaputt') }) }
        catch { geworfen = true }
        t.check('ohne Ablage schlägt der Fehler durch', geworfen)
      } finally { await rm(dir4, { recursive: true, force: true }) }
    }

    // ── Gleichzeitige Aufrufer teilen eine Abfrage ───────────────────────
    {
      const dir5 = await mkdtemp(join(tmpdir(), 'ajna-quellcache-'))
      try {
        let rufe = 0
        const c = new Quellcache('test', { dir: dir5, log: () => {}, ttlMs: 60_000 })
        const quelle = async () => { rufe++; await new Promise(r => setTimeout(r, 20)); return rufe }
        const [a, b, d] = await Promise.all([
          c.hole('gleich', quelle), c.hole('gleich', quelle), c.hole('gleich', quelle),
        ])
        t.check('drei gleichzeitige Fragen sind EINE Abfrage', rufe === 1, 'rufe=' + rufe)
        t.check('alle bekommen dieselbe Antwort',
          a.daten === 1 && b.daten === 1 && d.daten === 1)
      } finally { await rm(dir5, { recursive: true, force: true }) }
    }

    // ── Aufräumen ────────────────────────────────────────────────────────
    {
      const dir6 = await mkdtemp(join(tmpdir(), 'ajna-quellcache-'))
      try {
        const c = new Quellcache('test', { dir: dir6, log: () => {}, ttlMs: 60_000, maxDateien: 3 })
        for (let i = 0; i < 8; i++) await c.hole('n' + i, async () => i)
        await c.aufraeumen()
        const uebrig = (await readdir(dir6)).filter(f => f !== '_budget.json')
        t.check('zu viele Antworten werden ausgedünnt', uebrig.length <= 3,
          'Dateien: ' + uebrig.length)
      } finally { await rm(dir6, { recursive: true, force: true }) }
    }

    // ── Abriegelung erkennen ─────────────────────────────────────────────
    // WiGLE meldet das Kontingent NICHT immer als 429, sondern auch als 200 mit
    // einem Vermerk im Rumpf. Wer nur auf den Statuscode hört, fragt weiter.
    t.check('429 wird erkannt', istAbgeriegelt(new Error('WiGLE 429 — Limit')))
    t.check('„too many" ebenfalls', istAbgeriegelt('Too Many Queries'))
    t.check('„rate limit" ebenfalls', istAbgeriegelt('rate limit exceeded'))
    t.check('deutscher Text ebenfalls', istAbgeriegelt('tägliches Limit erreicht'))
    t.check('ein gewöhnlicher Fehler nicht', !istAbgeriegelt(new Error('ECONNRESET')))
    t.check('401 ist keine Abriegelung', !istAbgeriegelt(new Error('WiGLE 401 — Token prüfen')))

  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

console.log('Quellcache:')
await run()
console.log(failures === 0
  ? '\nAll quellcache tests passed.'
  : `\n${failures} test(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
