#!/usr/bin/env node
// migrations-check.mjs — compare the migration files on disk against what the
// database has recorded in `_migrations`.
//
// WHY THIS EXISTS. PocketBase applies every migration file whose name is not in
// `_migrations`, and it aborts the whole boot if one of them fails. A generated
// `created_*` migration fails the moment its collection is already there — so a
// single missing bookkeeping row takes the server down completely, and under
// pm2 it crash-loops about once a second while Caddy answers 502. The schema is
// fine in that case; only the ledger is wrong.
//
// A row goes missing whenever `pb_data` and `pb_migrations` drift apart: a
// database copied from another instance, a restored backup older than the
// files, collections built by hand in the admin UI. The damage only shows at
// the NEXT restart, which can be weeks later — that is what makes it so
// confusing when it finally happens.
//
// The tool reports and changes nothing. `--repair` writes the missing rows,
// after a backup.
//
//   node tools/migrations-check.mjs
//   node tools/migrations-check.mjs --repair
//   node tools/migrations-check.mjs --db=/pfad/data.db --dir=/pfad/pb_migrations

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ─── Database access ──────────────────────────────────────────────────────
//
// Two ways in, because the server and the workstation rarely agree.
// `node:sqlite` needs Node 22.5 and the VPS may still run 20; the `sqlite3`
// binary is the fallback and is one apt-get away.

let DatabaseSync = null
try {
  ;({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'))
} catch {
  // Older Node — the CLI path below takes over.
}

/** Quote a value for the sqlite3 CLI, which has no bound parameters. */
function quote(v) {
  return typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`
}

export function openDb(file) {
  if (DatabaseSync) {
    const db = new DatabaseSync(file)
    return {
      how: 'node:sqlite',
      all: (sql) => db.prepare(sql).all(),
      run: (sql, ...args) => db.prepare(sql).run(...args),
      close: () => db.close(),
    }
  }
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' })
  } catch {
    throw new Error(
      'Weder node:sqlite (ab Node 22.5) noch das Programm sqlite3 sind vorhanden.\n' +
      'Auf Debian/Ubuntu: sudo apt install sqlite3')
  }
  return {
    how: 'sqlite3',
    all: (sql) => {
      const out = execFileSync('sqlite3', ['-json', file, sql], { encoding: 'utf8' })
      return out.trim() ? JSON.parse(out) : []
    },
    run: (sql, ...args) => {
      const filled = sql.replace(/\?/g, () => quote(args.shift()))
      execFileSync('sqlite3', [file, filled], { stdio: 'ignore' })
    },
    close: () => {},
  }
}

// ─── Reading both sides ───────────────────────────────────────────────────

/** The migration files, sorted the way PocketBase sorts them: by file name. */
export function listFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
}

/** The leading unix timestamp of a migration file name, or 0. */
export function stampOf(file) {
  const m = /^(\d+)_/.exec(file)
  return m ? Number(m[1]) : 0
}

/**
 * The name of the collection a generated migration creates, or null.
 *
 * Only a corroborating signal — if that collection already exists, the file
 * cannot possibly run again. The object literal inside `new Collection({…})`
 * is plain JSON in generated migrations, so it is cut out by counting braces
 * and parsed; a regex for `"name"` would find the fields' names instead.
 */
export function createsCollection(source) {
  const at = source.indexOf('new Collection({')
  if (at < 0) return null
  const start = source.indexOf('{', at)
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1)).name || null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * Sort every file into one of three boxes.
 *
 * `gaps` is the interesting one: not recorded, yet OLDER than migrations the
 * database has already applied. The database is past that point, so re-running
 * the file is exactly the crash we are looking at. A file that is merely newer
 * than everything recorded is an ordinary pending migration and none of our
 * business.
 */
export function classify({ files, recorded, collections, sources }) {
  const known = new Set(recorded.map(r => r.file))
  const applied = recorded.map(r => stampOf(r.file)).filter(Boolean)
  const newestApplied = applied.length ? Math.max(...applied) : 0
  const have = new Set(collections)

  const gaps = []
  const pending = []
  for (const file of files) {
    if (known.has(file)) continue
    const creates = createsCollection(sources[file] || '')
    const collides = creates && have.has(creates)
    const entry = { file, stamp: stampOf(file), creates, collides }
    if (collides || (newestApplied && stampOf(file) < newestApplied)) gaps.push(entry)
    else pending.push(entry)
  }

  const onDisk = new Set(files)
  // `.go` rows are PocketBase's own built-in migrations and have no file here.
  const orphans = recorded.filter(r => r.file.endsWith('.js') && !onDisk.has(r.file))

  return { gaps, pending, orphans, newestApplied }
}

// ─── Report ───────────────────────────────────────────────────────────────

const green = (s) => `\u001b[32m${s}\u001b[0m`
const red = (s) => `\u001b[31m${s}\u001b[0m`
const dim = (s) => `\u001b[90m${s}\u001b[0m`

export function report(r, files, recorded, out = console.log) {
  out(`Dateien in pb_migrations: ${files.length}`)
  out(`Verbucht in _migrations:  ${recorded.length}`)
  out('')

  if (r.gaps.length) {
    out(red(`${r.gaps.length} Migration(en) sind NICHT verbucht, obwohl die Datenbank weiter ist:`))
    for (const g of r.gaps) {
      const grund = g.collides
        ? `Sammlung "${g.creates}" existiert bereits`
        : 'älter als die jüngste verbuchte Migration'
      out(`  ${red('x')} ${g.file}  ${dim('— ' + grund)}`)
    }
    out('')
    out('  Daran scheitert der Start: PocketBase wendet sie erneut an und bricht ab.')
    out('  Nachtragen (legt vorher eine Sicherung an):')
    out('      node tools/migrations-check.mjs --repair')
    out('')
  } else {
    out(green('Keine Löcher in der Historie.'))
    out('')
  }

  if (r.pending.length) {
    out(`${r.pending.length} neue Migration(en) warten auf den nächsten Start ${dim('(normal)')}:`)
    for (const p of r.pending) out(`  . ${p.file}`)
    out('')
  }
  if (r.orphans.length) {
    out(`${r.orphans.length} verbuchte Migration(en) ohne Datei ${dim('(harmlos)')}:`)
    for (const o of r.orphans) out(`  . ${o.file}`)
    out('')
  }
}

// ─── Repair ───────────────────────────────────────────────────────────────

/** A copy beside the original, including the WAL — PocketBase writes in WAL mode. */
export function backup(dbFile) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const to = `${dbFile}.${stamp}.bak`
  fs.copyFileSync(dbFile, to)
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(dbFile + suffix)) fs.copyFileSync(dbFile + suffix, to + suffix)
  }
  return to
}

export function repair(db, gaps, out = console.log) {
  // `applied` is microseconds since the epoch — the unit PocketBase uses.
  let now = Date.now() * 1000
  for (const g of gaps) {
    db.run('INSERT OR IGNORE INTO _migrations (file, applied) VALUES (?, ?)', g.file, now++)
    out(`  ${green('+')} ${g.file}`)
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────

export function main(argv) {
  const arg = (name, fallback) => {
    const hit = argv.find(a => a.startsWith(`--${name}=`))
    return hit ? hit.slice(name.length + 3) : fallback
  }
  const dbFile = path.resolve(arg('db', path.join(ROOT, 'pocketbase/pb_data/data.db')))
  const dir = path.resolve(arg('dir', path.join(ROOT, 'pocketbase/pb_migrations')))
  const doRepair = argv.includes('--repair')

  if (!fs.existsSync(dbFile)) {
    console.error(`Keine Datenbank unter ${dbFile}`)
    return 2
  }

  const files = listFiles(dir)
  const sources = {}
  for (const f of files) sources[f] = fs.readFileSync(path.join(dir, f), 'utf8')

  const db = openDb(dbFile)
  const recorded = db.all('SELECT file, applied FROM _migrations')
  const collections = db.all('SELECT name FROM _collections').map(r => r.name)
  const r = classify({ files, recorded, collections, sources })

  report(r, files, recorded)

  if (!doRepair) {
    db.close()
    return r.gaps.length ? 1 : 0
  }
  if (!r.gaps.length) {
    console.log('Nichts nachzutragen.')
    db.close()
    return 0
  }
  console.log(`Sicherung: ${backup(dbFile)}`)
  console.log('Trage nach:')
  repair(db, r.gaps)
  db.close()
  console.log('')
  console.log(green('Fertig. PocketBase neu starten: pm2 restart pocketbase'))
  return 0
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) process.exit(main(process.argv.slice(2)))
