#!/usr/bin/env node
//
// tools/ajna.mjs — CLI-Helper für Ajna / PocketBase
//
// Liest Credentials geschichtet: Umgebungsvariablen > agents/.env.cli >
// Root-`.env` des Repos (siehe agents/lib/env.mjs). Spricht den PB-Server direkt an
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
//   debug-view <id>                  View-Rule klauselweise auswerten
//
// Beispiele:
//   node tools/ajna.mjs login
//   node tools/ajna.mjs list-objects 'name ~ "Fox"'
//   node tools/ajna.mjs create-object '{"name":"Test","lat":52.5,"lon":13.4,"altitude":0}'
//   node tools/ajna.mjs update-object abc123def456ghi '{"lat":52.51}'
//   node tools/ajna.mjs delete-object abc123def456ghi
//   node tools/ajna.mjs add-permission abc123 '{"subject_type":"authenticated","rights":["view"]}'
//   node tools/ajna.mjs debug-view abc123def456ghi
//
// Env (oder `.env` im CWD):
//   AJNA_URL    Default: http://127.0.0.1:8090
//   AJNA_USER   Pflicht — Mail-Adresse eines dedizierten PB-Users (NICHT der Admin-Account)
//   AJNA_PASS   Pflicht
//
// Output-Konvention: JSON-Daten gehen nach stdout, Status/Hinweise nach
// stderr → pipe-freundlich: `node tools/ajna.mjs list-objects | jq '.[].name'`.

import PocketBase from 'pocketbase'
import { loadAgentEnv } from '../agents/lib/env.mjs'
import { maybeReexecWithSystemCa } from '../agents/lib/system-ca.mjs'

// Geschichtete .env: Prozess-Env > agents/.env.cli > Root-.env (Repo-verankert,
// funktioniert damit aus jedem Arbeitsverzeichnis).
loadAgentEnv('cli')

const URL  = process.env.AJNA_URL  || 'http://127.0.0.1:8090'
const USER = process.env.AJNA_USER
const PASS = process.env.AJNA_PASS
// Nur für `prune-objects`: Aufräumen betrifft in der Regel Objekte FREMDER
// Konten (ein stillgelegter Agent), und dorthin reicht ein gewöhnlicher Login
// nicht. Bleibt leer, solange niemand aufräumt.
const SU   = process.env.AJNA_SU
const SU_PASS = process.env.AJNA_SU_PASS

// HTTPS (z. B. https://localhost durch Caddy): einmaliger Re-Exec mit
// --use-system-ca, damit Node Caddys lokaler Root-CA vertraut.
maybeReexecWithSystemCa(URL)

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
  prune-objects <filter> [--loeschen]
                                   Viele Objekte auf einmal wegräumen. OHNE
                                   --loeschen nur zählen und zeigen (Trockenlauf).
                                   Der Filter ist PFLICHT — es gibt bewusst kein
                                   „Lösche alles". Braucht meist AJNA_SU/AJNA_SU_PASS,
                                   weil Altlasten fremden Konten gehören.
  debug-view <id>                  PB-View-Rule für ein Objekt klauselweise
                                   auswerten (Owner / Cache / implicit audiences).
                                   Listet außerdem alle ACEs des Objekts roh auf —
                                   ideal um Whitespace/Case-Probleme in
                                   subject_type oder rights zu erkennen.
  add-permission <objectId> <ace>  ACE auf Objekt setzen. ACE-JSON:
                                     subject_type: user|group|authenticated|anonymous|everyone
                                     subject:      ID des Users/der Gruppe (bei implizit leer)
                                     rights:       Array, view | edit | move | owner, z. B. ["view"]
                                     interact_actions: Array von Aktion-Keys (optional)
  list-permissions <objectId>      ACEs eines Objekts listen (braucht Besitz oder owner-Recht)

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
  node tools/ajna.mjs add-permission abc123 '{"subject_type":"authenticated","rights":["view"]}'`)
  process.exit(2)
}

/** Anmeldung als Superuser — nur für Aufräumarbeiten an fremden Objekten. */
async function loginSu(pb) {
  if (!SU || !SU_PASS) die('AJNA_SU und AJNA_SU_PASS setzen (Superuser der Instanz).')
  try {
    await pb.collection('_superusers').authWithPassword(SU, SU_PASS)
  } catch (err) {
    const detail = err?.response?.data?.message || err?.message || String(err)
    die(`Superuser-Login fehlgeschlagen: ${detail}`)
  }
  return pb.authStore.record || pb.authStore.model
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

async function cmdListPermissions(pb, [objectId]) {
  if (!objectId) die('Args: list-permissions <objectId>')
  await login(pb)
  let list
  try {
    list = await pb.collection('object_permissions').getFullList({ filter: `object = "${objectId}"`, sort: '+created' })
  } catch (err) {
    die(`list-permissions fehlgeschlagen: ${describePbError(err)}`)
  }
  console.log(JSON.stringify(list, null, 2))
  console.error(`✓ ${list.length} ACE(s) — Liste erfordert Besitz ODER owner-Recht (kanonische Regeln)`)
}

async function cmdDebugView(pb, [id]) {
  if (!id) die('Args: debug-view <id>')
  await login(pb)
  let res
  try {
    res = await pb.send(`/api/objects/${id}/debug-view`, { method: 'GET' })
  } catch (err) {
    die(`debug-view fehlgeschlagen: ${describePbError(err)}`)
  }
  console.log(JSON.stringify(res, null, 2))
  if (res.shouldSee) {
    console.error('✓ shouldSee=true (Owner / Cache / Implicit-Audience-Treffer)')
  } else {
    console.error('✗ shouldSee=false — keine Klausel matcht')
    if (res.objectAces?.length === 0) {
      console.error('  Hinweis: keine ACEs auf dem Objekt — applyOwnerDefaults hat nichts angelegt')
    } else {
      console.error('  Inspiziere `objectAces` oben: subject_type-Werte vergleichen, rights_isArray, rights_contains_view')
    }
  }
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
    die('rights muss ein nicht-leeres Array sein, z. B. ["view"]')
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

/**
 * Viele Objekte auf einmal wegräumen — mit Trockenlauf als Vorgabe.
 *
 * WOFÜR: Ein stillgelegter Agent hinterlässt seine Welt. Auf der Produktiv-
 * instanz waren das 187 Objekte eines Kontos, das zuletzt im Juli geschrieben
 * hatte. Einzeln über `delete-object` sind das 187 Aufrufe von Hand.
 *
 * ZWEI SICHERUNGEN, weil Löschen nicht zurückzunehmen ist:
 *   • Der Filter ist PFLICHT. Es gibt kein „lösche alles" — wer alles will,
 *     schreibt einen Filter, der alles trifft, und sieht ihn dabei an.
 *   • Ohne `--loeschen` wird nur gezählt und gezeigt. Erst der zweite Aufruf
 *     räumt weg.
 *
 * ACEs UND CACHE GEHEN MIT: `object_permissions.object` und
 * `effective_permissions.object` stehen auf cascadeDelete — es bleiben keine
 * Waisen zurück. Nachgeprüft am Schema, nicht angenommen.
 */
async function cmdPruneObjects(pb, args) {
  const echt = args.includes('--loeschen')
  const filter = args.filter(a => a !== '--loeschen')[0]
  if (!filter) die('Args: prune-objects <filter> [--loeschen]\n'
    + '  z. B. \'owner = "ghpmtuglp3hyboc" && updated < "2026-09-01"\'')

  // Erst als gewöhnlicher Nutzer; nur wenn Superuser-Daten da sind, damit.
  // Fremde Objekte sieht und löscht ein gewöhnliches Konto nicht.
  if (SU && SU_PASS) await loginSu(pb)
  else await login(pb)

  let liste
  try {
    liste = await pb.collection('objects').getFullList({ filter, sort: '+created' })
  } catch (err) {
    die(`Listen fehlgeschlagen: ${describePbError(err)}`)
  }

  if (!liste.length) {
    console.error('Kein Objekt passt auf diesen Filter — nichts zu tun.')
    console.log(JSON.stringify({ gefunden: 0, geloescht: 0 }, null, 2))
    return
  }

  // ZEIGEN, WAS GETROFFEN WIRD. Eine nackte Zahl lädt dazu ein, sie zu
  // glauben; die Aufschlüsselung nach Quelle und Besitzer zeigt sofort, wenn
  // der Filter zu weit greift.
  const gruppen = {}
  for (const o of liste) {
    let q = null
    try { q = (typeof o.state === 'string' ? JSON.parse(o.state) : o.state)?.source } catch {}
    const k = `${q ?? '(ohne Quelle)'} · ${o.owner || '(ohne Besitzer)'}`
    if (!gruppen[k]) gruppen[k] = { n: 0, juengste: '' }
    gruppen[k].n++
    if ((o.updated || '') > gruppen[k].juengste) gruppen[k].juengste = o.updated || ''
  }
  console.error(`${liste.length} Objekt(e) treffen auf den Filter:`)
  for (const [k, v] of Object.entries(gruppen).sort((a, b) => b[1].n - a[1].n)) {
    console.error(`  ${String(v.n).padStart(5)}  ${k}   zuletzt geändert ${String(v.juengste).slice(0, 16) || '?'}`)
  }
  console.error('  Beispiele: ' + liste.slice(0, 3).map(o => `„${o.name}"`).join(', ')
    + (liste.length > 3 ? ' …' : ''))

  if (!echt) {
    console.error('\nTrockenlauf — mit --loeschen wird gelöscht.')
    console.log(JSON.stringify({ gefunden: liste.length, geloescht: 0, trockenlauf: true }, null, 2))
    return
  }

  let weg = 0
  const fehler = []
  for (const o of liste) {
    try { await pb.collection('objects').delete(o.id); weg++ }
    catch (err) { fehler.push({ id: o.id, name: o.name, grund: describePbError(err) }) }
    if (weg % 25 === 0 && weg) console.error(`  … ${weg}/${liste.length}`)
  }
  for (const f of fehler.slice(0, 5)) console.error(`  ✗ ${f.id} („${f.name}"): ${f.grund}`)
  if (fehler.length > 5) console.error(`  ✗ … und ${fehler.length - 5} weitere`)

  console.log(JSON.stringify({ gefunden: liste.length, geloescht: weg, fehler: fehler.length }, null, 2))
  console.error(`✓ ${weg} gelöscht, ${fehler.length} fehlgeschlagen`)
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
    case 'prune-objects':  await cmdPruneObjects(pb, rest);   break
    case 'add-permission': await cmdAddPermission(pb, rest);  break
    case 'list-permissions': await cmdListPermissions(pb, rest); break
    case 'debug-view':     await cmdDebugView(pb, rest);      break
    default:
      console.error(`Unbekanntes Subcommand: ${cmd}\n`)
      usage()
  }
}

main().catch(err => die(err?.message || String(err)))
