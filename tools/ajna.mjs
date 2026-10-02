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
  list-manifests [source]          Wem gehört welcher Quellname? Zeigt, wenn ZWEI
                                   Konten denselben beanspruchen — dann kann der
                                   Agent des jüngeren keine Objekte anlegen (403),
                                   obwohl sein Manifest angenommen wurde.
  prune-manifests <source> [--keep=<ownerId>] [--mit-objekten] [--loeschen]
                                   Vergebliche Ansprüche auf einen Quellnamen
                                   entfernen. Ohne --keep gilt der älteste
                                   Eintrag. OHNE --loeschen nur Trockenlauf.

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
    // AUCH NACH TYP GRUPPIEREN. Bei Altlasten hat oft alles dieselbe Quelle und
    // denselben Besitzer — dann sagt eine Zeile über 50 Objekte nichts. Der Typ
    // ist es, an dem man erkennt, ob die eigene Ausrüstung mit im Netz hängt.
    const k = `${q ?? '(ohne Quelle)'} · ${o.type || '(ohne Typ)'} · ${o.owner || '(ohne Besitzer)'}`
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

// ───────────────────────────────────────────────────────────────────────
//  Agent-Manifeste: wem gehört ein Quellname?
// ───────────────────────────────────────────────────────────────────────
//
// WOZU DAS DA IST. `agent_manifests` ist eindeutig über (source, owner), NICHT
// über source allein. Ein zweites Konto darf denselben Quellnamen also
// registrieren, und sein Upsert meldet Erfolg — es gilt aber der ältere
// Eintrag. Der Agent des jüngeren Kontos läuft danach scheinbar normal und
// scheitert an JEDEM Objekt mit 403 („Die Quelle … gehört einem anderen
// Konto"). Genau so stand die C-ITS-Brücke am 30.09.2026.
//
// Hier sieht man den Zustand, und hier räumt man ihn auf.

/** Die Objekte einer Quelle — mit Rückfallebene, falls der JSON-Filter streikt. */
async function objekteZurQuelle(pb, source) {
  try {
    return await pb.collection('objects').getFullList({
      filter: `state.source = "${String(source).replace(/"/g, '\\"')}"`, sort: '+created',
    })
  } catch {
    // Ältere PocketBase-Stände können nicht in JSON hineinfiltern. Dann eben
    // alles holen und selbst nachsehen — lieber langsam als falsch.
    const alle = await pb.collection('objects').getFullList({ sort: '+created' })
    return alle.filter(o => {
      try { return (typeof o.state === 'string' ? JSON.parse(o.state) : o.state)?.source === source }
      catch { return false }
    })
  }
}

async function cmdListManifests(pb, args) {
  const nurQuelle = args.find(a => !a.startsWith('-')) || null
  if (SU && SU_PASS) await loginSu(pb); else await login(pb)

  const alle = await pb.collection('agent_manifests').getFullList({ sort: '+created' })
  const liste = nurQuelle ? alle.filter(m => m.source === nurQuelle) : alle

  // Nach Quelle gruppieren: nur so fällt auf, dass zwei Konten dieselbe
  // beanspruchen. Eine flache Liste verbirgt genau den Fall, der weh tut.
  const nachQuelle = {}
  for (const m of liste) (nachQuelle[m.source] ||= []).push(m)

  const bericht = []
  for (const [source, ms] of Object.entries(nachQuelle).sort()) {
    const inhaber = ms[0]                       // ältester gewinnt
    const delegiert = Array.isArray(inhaber.delegates) ? inhaber.delegates : []
    console.error(`\n${source}`)
    for (const m of ms) {
      const rolle = m === inhaber ? 'INHABER '
        : delegiert.includes(m.owner) ? 'delegiert'
        : 'VERWORFEN'
      console.error(`  ${rolle}  ${m.owner}  ${m.owner_handle ? '@' + m.owner_handle : ''}`
        + `  seit ${m.created || '?'}`)
    }
    if (ms.length > 1) {
      const verworfen = ms.slice(1).filter(m => !delegiert.includes(m.owner))
      if (verworfen.length) {
        console.error(`  ⚠ ${verworfen.length} Konto/Konten beanspruchen den Namen vergeblich —`)
        console.error(`    deren Agents können KEINE Objekte anlegen (403).`)
        console.error(`    Aufräumen: node tools/ajna.mjs prune-manifests ${source} --keep=${inhaber.owner}`)
      }
    }
    bericht.push({ source, inhaber: inhaber.owner, ansprueche: ms.length, delegates: delegiert })
  }
  if (!bericht.length) console.error('Keine Manifeste gefunden.')
  console.log(JSON.stringify(bericht, null, 2))
}

async function cmdPruneManifests(pb, args) {
  const echt = args.includes('--loeschen')
  const mitObjekten = args.includes('--mit-objekten')
  const keepArg = args.find(a => a.startsWith('--keep='))
  const source = args.find(a => !a.startsWith('-'))
  if (!source) die('Args: prune-manifests <source> [--keep=<ownerId>] [--mit-objekten] [--loeschen]\n'
    + '  Ohne --keep gilt der älteste Eintrag als Inhaber.\n'
    + '  --mit-objekten entfernt AUCH die Objekte der verworfenen Konten.')

  // Fremde Manifeste und fremde Objekte sieht ein gewöhnliches Konto nicht,
  // und löschen darf es sie erst recht nicht.
  if (SU && SU_PASS) await loginSu(pb); else await login(pb)

  const alle = await pb.collection('agent_manifests').getFullList({ sort: '+created' })
  const ms = alle.filter(m => m.source === source)
  if (!ms.length) die(`Keine Manifeste für die Quelle "${source}".`)

  const keep = keepArg ? keepArg.slice('--keep='.length) : ms[0].owner
  if (!ms.some(m => m.owner === keep)) {
    die(`Kein Manifest von ${keep} für "${source}". Vorhanden: ${ms.map(m => m.owner).join(', ')}`)
  }
  const weg = ms.filter(m => m.owner !== keep)
  if (!weg.length) {
    console.error(`"${source}" gehört bereits allein ${keep} — nichts zu tun.`)
    console.log(JSON.stringify({ quelle: source, inhaber: keep, geloescht: 0 }, null, 2))
    return
  }

  // ZEIGEN, WAS GETROFFEN WIRD, bevor irgendetwas verschwindet.
  const objekte = mitObjekten ? await objekteZurQuelle(pb, source) : []
  const betroffen = objekte.filter(o => weg.some(m => m.owner === o.owner))
  console.error(`Quelle "${source}" — Inhaber bleibt ${keep}`)
  for (const m of weg) {
    const n = objekte.filter(o => o.owner === m.owner).length
    console.error(`  entfernen: Manifest ${m.id} von ${m.owner}`
      + `${m.owner_handle ? ' (@' + m.owner_handle + ')' : ''}`
      + (mitObjekten ? ` · ${n} Objekt(e)` : ''))
  }
  if (mitObjekten && betroffen.length) {
    console.error(`  → ${betroffen.length} Objekt(e) werden mitgelöscht.`)
    console.error('    Gespiegelte Agent-Objekte legt der Agent binnen Sekunden neu an;')
    console.error('    von Hand erstellte NICHT. Die Aufstellung oben zeigt, was betroffen ist.')
  }
  if (!echt) {
    console.error('\nProbelauf — nichts geändert. Mit --loeschen ausführen.')
    console.log(JSON.stringify({ quelle: source, inhaber: keep,
      manifeste: weg.length, objekte: betroffen.length, probelauf: true }, null, 2))
    return
  }

  let objWeg = 0, manWeg = 0, fehler = 0
  for (const o of betroffen) {
    try { await pb.collection('objects').delete(o.id); objWeg++ }
    catch (err) { fehler++; console.error(`  ✗ Objekt ${o.id}: ${describePbError(err)}`) }
  }
  // Manifeste ZULETZT: Solange das alte noch steht, weist der Server die
  // Objekte des anderen Kontos ab — was uns hier gerade recht ist. Erst wenn
  // die Altlast weg ist, soll der neue Anspruch greifen.
  for (const m of weg) {
    try { await pb.collection('agent_manifests').delete(m.id); manWeg++ }
    catch (err) { fehler++; console.error(`  ✗ Manifest ${m.id}: ${describePbError(err)}`) }
  }
  console.error(`\nGelöscht: ${manWeg} Manifest(e), ${objWeg} Objekt(e)`
    + (fehler ? `, ${fehler} fehlgeschlagen` : ''))
  console.log(JSON.stringify({ quelle: source, inhaber: keep,
    manifeste: manWeg, objekte: objWeg, fehler }, null, 2))
}

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
    case 'list-manifests': await cmdListManifests(pb, rest);  break
    case 'prune-manifests': await cmdPruneManifests(pb, rest); break
    default:
      console.error(`Unbekanntes Subcommand: ${cmd}\n`)
      usage()
  }
}

main().catch(err => die(err?.message || String(err)))
