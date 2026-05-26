#!/usr/bin/env node
//
// tools/ajna.mjs — CLI-Helper für Ajna / PocketBase
//
// Liest Credentials aus Umgebungsvariablen oder `.env` im aktuellen
// Arbeitsverzeichnis (Repo-Root). Spricht den PB-Server direkt an
// (Loopback :8090 by default) — bewusst an Caddy vorbei, damit kein
// TLS-Setup nötig ist. Wer durch Caddy will, setzt `AJNA_URL` auf die
// HTTPS-URL; Node ≥ 22 vertraut der Caddy-Root-CA nach deren System-
// Installation automatisch.
//
// Subcommands:
//   login                            Credentials testen
//   list-objects [filter]            Objekte listen (optionaler PB-Filter)
//   create-object <json>             Objekt anlegen
//   update-object <id> <json>        Objekt patchen
//   delete-object <id>               Objekt löschen
//   add-permission <objectId> <ace>  ACE auf Objekt setzen
//
// Beispiele:
//   node tools/ajna.mjs login
//   node tools/ajna.mjs list-objects 'name ~ "Fox"'
//   node tools/ajna.mjs create-object '{"name":"Test","lat":52.5,"lon":13.4,"altitude":0}'
//   node tools/ajna.mjs update-object abc123def456ghi '{"lat":52.51}'
//   node tools/ajna.mjs delete-object abc123def456ghi
//   node tools/ajna.mjs add-permission abc123 '{"subject_type":"authenticated","rights":["read"]}'
//
// Env (oder `.env` im CWD):
//   AJNA_URL    Default: http://127.0.0.1:8090
//   AJNA_USER   Pflicht — Mail-Adresse eines dedizierten PB-Users (NICHT der Admin-Account)
//   AJNA_PASS   Pflicht
//
// Output-Konvention: JSON-Daten gehen nach stdout, Status/Hinweise nach
// stderr → pipe-freundlich: `node tools/ajna.mjs list-objects | jq '.[].name'`.

import PocketBase from 'pocketbase'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// ───────────────────────────────────────────────────────────────────────
//  .env laden (simpler KEY=VALUE-Parser, keine extra Dependency)
// ───────────────────────────────────────────────────────────────────────

function loadDotenv() {
  const path = resolve(process.cwd(), '.env')
  if (!existsSync(path)) return
  const raw = readFileSync(path, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const stripped = line.replace(/^\s*#.*$/, '').trim()
    if (!stripped) continue
    const m = stripped.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i)
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    // simple "..." / '...' quoting
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadDotenv()

const URL  = process.env.AJNA_URL  || 'http://127.0.0.1:8090'
const USER = process.env.AJNA_USER
const PASS = process.env.AJNA_PASS

// Wenn die AJNA_URL auf HTTPS zeigt (z. B. https://localhost durch Caddy):
// Node trust standardmäßig nur die Mozilla-CA-Liste und kennt Caddys
// lokale Root-CA NICHT, obwohl die im System-Keystore liegt. Wir re-execen
// uns deshalb selbst mit --use-system-ca (Node 23+), sobald HTTPS im Spiel
// ist — spart dem Anwender, das Flag jedes Mal mitzutippen.
if (URL.startsWith('https://') && !process.execArgv.includes('--use-system-ca')) {
  const r = spawnSync(
    process.execPath,
    ['--use-system-ca', process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit' }
  )
  process.exit(r.status ?? 1)
}

// ───────────────────────────────────────────────────────────────────────
//  Helpers
// ───────────────────────────────────────────────────────────────────────

function die(msg, code = 1) {
  console.error(`✗ ${msg}`)
  process.exit(code)
}

function usage() {
  console.error(`Usage: node tools/ajna.mjs <command> [args]

Commands:
  login                            Credentials testen, aktuellen User ausgeben.
  list-objects [filter]            Objekte listen. Optionaler PB-Filter (z. B. 'name ~ "Fox"').
  create-object <json>             Objekt aus JSON-Body anlegen.
  update-object <id> <json>        Objekt patchen.
  delete-object <id>               Objekt löschen.
  add-permission <objectId> <ace>  ACE auf Objekt setzen. ACE-JSON:
                                     subject_type: user|group|authenticated|anonymous|everyone
                                     subject:      ID des Users/der Gruppe (bei implizit leer)
                                     rights:       Array, z. B. ["read","write","delete"]
                                     interact_actions: Array von Aktion-Keys (optional)

Env (oder .env im CWD):
  AJNA_URL   Default: http://127.0.0.1:8090
  AJNA_USER  Pflicht — dedizierter PB-User (NICHT der Admin).
  AJNA_PASS  Pflicht.

Beispiele:
  node tools/ajna.mjs login
  node tools/ajna.mjs list-objects 'name ~ "Fox"'
  node tools/ajna.mjs create-object '{"name":"Test","lat":52.5,"lon":13.4,"altitude":0}'
  node tools/ajna.mjs update-object abc123def456ghi '{"lat":52.51}'
  node tools/ajna.mjs delete-object abc123def456ghi
  node tools/ajna.mjs add-permission abc123 '{"subject_type":"authenticated","rights":["read"]}'`)
  process.exit(2)
}

async function login(pb) {
  if (!USER || !PASS) die('AJNA_USER und AJNA_PASS setzen (env oder .env).')
  try {
    await pb.collection('users').authWithPassword(USER, PASS)
  } catch (err) {
    const detail = err?.response?.data?.message || err?.message || String(err)
    die(`Login fehlgeschlagen: ${detail}`)
  }
  return pb.authStore.record || pb.authStore.model
}

function parseJsonArg(arg, what) {
  try { return JSON.parse(arg) }
  catch (e) { die(`Ungültiges JSON für ${what}: ${e.message}`); return null }
}

function describePbError(err) {
  const data = err?.response?.data
  if (!data) return err?.message || String(err)
  if (data.message) {
    const fieldErrors = data.data && Object.keys(data.data).length
      ? '  Felder: ' + JSON.stringify(data.data)
      : ''
    return `${data.message}${fieldErrors}`
  }
  return JSON.stringify(data)
}

// ───────────────────────────────────────────────────────────────────────
//  Subcommands
// ───────────────────────────────────────────────────────────────────────

async function cmdLogin(pb) {
  const me = await login(pb)
  console.log(JSON.stringify({
    ok: true,
    url: URL,
    user: { id: me.id, email: me.email, name: me.name || null }
  }, null, 2))
  console.error('✓ Login ok')
}

async function cmdListObjects(pb, [filter]) {
  await login(pb)
  const opts = { sort: '+created' }
  if (filter) opts.filter = filter
  let list
  try {
    list = await pb.collection('objects').getFullList(opts)
  } catch (err) {
    die(`list fehlgeschlagen: ${describePbError(err)}`)
  }
  console.log(JSON.stringify(list, null, 2))
  console.error(`✓ ${list.length} Objekt(e)`)
}

async function cmdCreateObject(pb, [body]) {
  if (!body) die("Body fehlt. Bsp: create-object '{\"name\":\"Foo\",\"lat\":52.5,\"lon\":13.4}'")
  const data = parseJsonArg(body, 'create-Body')
  await login(pb)
  let created
  try {
    created = await pb.collection('objects').create(data)
  } catch (err) {
    die(`create fehlgeschlagen: ${describePbError(err)}`)
  }
  console.log(JSON.stringify(created, null, 2))
  console.error(`✓ angelegt: ${created.id}`)
}

async function cmdUpdateObject(pb, [id, patch]) {
  if (!id || !patch) die("Args: update-object <id> '<json-patch>'")
  const data = parseJsonArg(patch, 'update-Patch')
  await login(pb)
  let updated
  try {
    updated = await pb.collection('objects').update(id, data)
  } catch (err) {
    die(`update fehlgeschlagen: ${describePbError(err)}`)
  }
  console.log(JSON.stringify(updated, null, 2))
  console.error(`✓ aktualisiert: ${updated.id}`)
}

async function cmdDeleteObject(pb, [id]) {
  if (!id) die('Args: delete-object <id>')
  await login(pb)
  try {
    await pb.collection('objects').delete(id)
  } catch (err) {
    die(`delete fehlgeschlagen: ${describePbError(err)}`)
  }
  console.log(JSON.stringify({ ok: true, id }, null, 2))
  console.error(`✓ gelöscht: ${id}`)
}

const VALID_SUBJECT_TYPES = new Set([
  'user', 'group', 'authenticated', 'anonymous', 'everyone'
])
const IMPLICIT_AUDIENCES = new Set(['authenticated', 'anonymous', 'everyone'])

async function cmdAddPermission(pb, [objectId, aceRaw]) {
  if (!objectId || !aceRaw) {
    die("Args: add-permission <objectId> '<json-ace>'\n" +
        "       ACE-Felder: subject_type, subject, rights[], interact_actions[]")
  }
  const ace = parseJsonArg(aceRaw, 'ACE')

  if (!VALID_SUBJECT_TYPES.has(ace.subject_type)) {
    die(`subject_type "${ace.subject_type}" ungültig — erlaubt: ${[...VALID_SUBJECT_TYPES].join(', ')}`)
  }
  if (!IMPLICIT_AUDIENCES.has(ace.subject_type) && !ace.subject) {
    die(`subject_type "${ace.subject_type}" braucht eine subject-ID`)
  }
  if (!Array.isArray(ace.rights) || ace.rights.length === 0) {
    die('rights muss ein nicht-leeres Array sein, z. B. ["read"]')
  }

  await login(pb)
  let created
  try {
    created = await pb.collection('object_permissions').create({
      object: objectId,
      subject_type: ace.subject_type,
      subject: IMPLICIT_AUDIENCES.has(ace.subject_type) ? '' : ace.subject,
      rights: ace.rights,
      interact_actions: ace.interact_actions || []
    })
  } catch (err) {
    die(`ACE-Anlegen fehlgeschlagen: ${describePbError(err)}`)
  }
  console.log(JSON.stringify(created, null, 2))
  console.error(`✓ ACE angelegt: ${created.id}`)
}

// ───────────────────────────────────────────────────────────────────────
//  Entry
// ───────────────────────────────────────────────────────────────────────

async function main() {
  const [, , cmd, ...rest] = process.argv
  if (!cmd || cmd === '-h' || cmd === '--help') usage()

  const pb = new PocketBase(URL)

  switch (cmd) {
    case 'login':          await cmdLogin(pb);                break
    case 'list-objects':   await cmdListObjects(pb, rest);    break
    case 'create-object':  await cmdCreateObject(pb, rest);   break
    case 'update-object':  await cmdUpdateObject(pb, rest);   break
    case 'delete-object':  await cmdDeleteObject(pb, rest);   break
    case 'add-permission': await cmdAddPermission(pb, rest);  break
    default:
      console.error(`Unbekanntes Subcommand: ${cmd}\n`)
      usage()
  }
}

main().catch(err => die(err?.message || String(err)))
