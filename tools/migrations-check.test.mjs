// Tests für tools/migrations-check.mjs.
//
// Der Anlass war echt: am 29.09.2026 stand der VPS, weil drei Zeilen in
// `_migrations` fehlten. Die Fälle unten sind genau die, die dabei auftraten —
// und die Abgrenzung, auf die es ankommt: eine neue Migration darf NICHT als
// Loch gelten, sonst trägt das Werkzeug sie nach, ohne dass sie je lief.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classify, createsCollection, stampOf, listFiles, openDb, repair, backup,
} from './migrations-check.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS = path.join(ROOT, 'pocketbase/pb_migrations')

// ─── Namen lesen ──────────────────────────────────────────────────────────

test('der Zeitstempel steht vorn im Dateinamen', () => {
  assert.equal(stampOf('1779439512_created_groups.js'), 1779439512)
  assert.equal(stampOf('irgendwas.js'), 0)
})

test('eine echte erzeugte Migration verrät ihre Sammlung', () => {
  const src = fs.readFileSync(path.join(MIGRATIONS, '1779439512_created_groups.js'), 'utf8')
  assert.equal(createsCollection(src), 'groups')
})

test('die Felder der Sammlung werden nicht für die Sammlung gehalten', () => {
  // Der Fallstrick: erzeugte Migrationen schreiben die Schlüssel alphabetisch,
  // also steht `fields` VOR `name` — ein Regex auf "name" fände den ersten
  // Feldnamen. Deshalb wird der Block geklammert ausgeschnitten und geparst.
  const src = `migrate((app) => {
  const collection = new Collection({
    "fields": [ { "name": "users", "type": "text" }, { "name": "titel", "type": "text" } ],
    "id": "pbc_123",
    "name": "groups",
    "type": "base"
  })
  app.save(collection)
})`
  assert.equal(createsCollection(src), 'groups')
})

test('eine Migration, die nichts anlegt, meldet nichts', () => {
  assert.equal(createsCollection('migrate((app) => { app.db().newQuery("…").execute() })'), null)
  assert.equal(createsCollection('new Collection({ kaputt '), null)
})

test('nur .js-Dateien zählen als unsere Migrationen', () => {
  const files = listFiles(MIGRATIONS)
  assert.ok(files.length > 40, `${files.length} Dateien`)
  assert.ok(files.every(f => f.endsWith('.js')))
  assert.deepEqual(files, [...files].sort(), 'PocketBase geht nach Dateinamen vor')
})

// ─── Einordnen ────────────────────────────────────────────────────────────

const quelle = (name) => `migrate((app) => { app.save(new Collection({"id":"pbc_1","name":"${name}","type":"base"})) })`

test('der echte VPS-Ausfall wird als Loch erkannt', () => {
  const r = classify({
    files: ['1779439512_created_groups.js', '1779439537_updated_groups.js', '1788400000_spaeter.js'],
    recorded: [{ file: '1779439537_updated_groups.js' }, { file: '1788400000_spaeter.js' }],
    collections: ['groups', 'users'],
    sources: { '1779439512_created_groups.js': quelle('groups') },
  })
  assert.equal(r.gaps.length, 1)
  assert.equal(r.gaps[0].file, '1779439512_created_groups.js')
  assert.equal(r.gaps[0].collides, true)
  assert.equal(r.pending.length, 0)
})

test('eine wirklich neue Migration bleibt in Ruhe', () => {
  // Das ist der gefährliche Fehlgriff: würde sie als Loch gelten, trüge
  // --repair sie nach und die Änderung liefe NIE.
  const r = classify({
    files: ['1780000000_alt.js', '1799999999_ganz_neu.js'],
    recorded: [{ file: '1780000000_alt.js' }],
    collections: ['objects'],
    sources: { '1799999999_ganz_neu.js': 'migrate((app) => {})' },
  })
  assert.equal(r.gaps.length, 0)
  assert.deepEqual(r.pending.map(p => p.file), ['1799999999_ganz_neu.js'])
})

test('auch ohne Sammlungs-Kollision gilt „älter als verbucht" als Loch', () => {
  const r = classify({
    files: ['1780000000_mittendrin.js', '1790000000_neuer.js'],
    recorded: [{ file: '1790000000_neuer.js' }],
    collections: [],
    sources: { '1780000000_mittendrin.js': 'migrate((app) => {})' },
  })
  assert.deepEqual(r.gaps.map(g => g.file), ['1780000000_mittendrin.js'])
})

test('eine leere Datenbank ist kein Loch, sondern ein erster Start', () => {
  // Auf einer frischen Instanz ist nichts verbucht und alles wartet. Würde das
  // als Loch gelten, bräche der Deploy bei jeder Neuinstallation ab.
  const r = classify({
    files: ['1779439512_created_groups.js', '1788400000_spaeter.js'],
    recorded: [],
    collections: [],
    sources: { '1779439512_created_groups.js': quelle('groups') },
  })
  assert.equal(r.gaps.length, 0)
  assert.equal(r.pending.length, 2)
})

test('verbuchte Migrationen ohne Datei sind harmlos und getrennt aufgeführt', () => {
  // Kam auf dem VPS wirklich vor: 1780045447_updated_users.js steht in der
  // Datenbank, im Verzeichnis liegt sie nicht mehr.
  const r = classify({
    files: ['1780000000_da.js'],
    recorded: [{ file: '1780000000_da.js' }, { file: '1780045447_weg.js' }, { file: '1640988000_init.go' }],
    collections: [],
    sources: {},
  })
  assert.equal(r.gaps.length, 0)
  assert.deepEqual(r.orphans.map(o => o.file), ['1780045447_weg.js'], 'die .go-Zeile gehört PocketBase')
})

// ─── Schreiben ────────────────────────────────────────────────────────────

test('nachtragen schreibt genau die fehlenden Zeilen und nichts sonst', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajna-mig-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'data.db')

  let db
  try {
    db = openDb(file)
  } catch {
    t.skip('weder node:sqlite noch sqlite3 vorhanden')
    return
  }
  db.run('CREATE TABLE _migrations (file VARCHAR(255) PRIMARY KEY NOT NULL, applied INTEGER NOT NULL)')
  db.run("INSERT INTO _migrations (file, applied) VALUES ('1780000000_da.js', 1)")

  repair(db, [{ file: '1779439512_created_groups.js' }, { file: '1779440794_created_object_permissions.js' }], () => {})

  const rows = db.all('SELECT file, applied FROM _migrations ORDER BY file')
  assert.deepEqual(rows.map(r => r.file), [
    '1779439512_created_groups.js', '1779440794_created_object_permissions.js', '1780000000_da.js',
  ])
  // Mikrosekunden wie bei PocketBase, nicht Millisekunden — sonst steht die
  // nachgetragene Zeile in der Sortierung im Jahr 1970.
  const neu = rows.find(r => r.file.startsWith('1779439512'))
  assert.ok(neu.applied > 1.7e15, `applied=${neu.applied} sieht nicht nach Mikrosekunden aus`)

  // Zweimal nachtragen darf nicht wehtun.
  repair(db, [{ file: '1779439512_created_groups.js' }], () => {})
  assert.equal(db.all('SELECT COUNT(*) AS n FROM _migrations')[0].n, 3)
  db.close()
})

test('die Sicherung nimmt das WAL mit', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajna-bak-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'data.db')
  fs.writeFileSync(file, 'x')
  fs.writeFileSync(file + '-wal', 'y')

  const to = backup(file)
  assert.ok(fs.existsSync(to))
  // Ohne das WAL wäre die Sicherung ein Stand von vor den letzten Schreibvorgängen.
  assert.ok(fs.existsSync(to + '-wal'), 'WAL fehlt in der Sicherung')
})
