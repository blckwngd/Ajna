#!/usr/bin/env node
// tools/acl-selftest.mjs — prüft die Berechtigungs-Pipeline einer Instanz E2E:
// legt einen Wegwerf-User B + Testobjekt + User-ACE an und testet dann als B
// jeden Regel-Pfad einzeln (Cache-Read, view, edit, ACE-Liste, ACE-Create,
// delete). Räumt hinter sich auf (Objekt; der Wegwerf-User bleibt inert).
//
// Nutzung:  node tools/acl-selftest.mjs
//   AJNA_URL bestimmt die Instanz (geschichtete .env wie tools/ajna.mjs);
//   AJNA_USER/AJNA_PASS = User A (Besitzer der Testobjekte).
//   Direkt-Test am Caddy vorbei:  AJNA_URL=http://127.0.0.1:8090 node tools/acl-selftest.mjs

import PocketBase from 'pocketbase'
import { loadAgentEnv } from '../agents/lib/env.mjs'
import { maybeReexecWithSystemCa } from '../agents/lib/system-ca.mjs'

loadAgentEnv('cli')
const URL = process.env.AJNA_URL || 'http://127.0.0.1:8090'
maybeReexecWithSystemCa(URL)

let failed = 0
const step = async (name, fn) => {
  try { const r = await fn(); console.log(`✓ ${name}${r !== undefined ? ` → ${r}` : ''}`); return true }
  catch (e) {
    failed++
    const detail = e?.response && Object.keys(e.response).length ? JSON.stringify(e.response) : (e?.message || String(e))
    console.log(`✗ ${name} → HTTP ${e?.status ?? '?'} ${detail}`)
    return false
  }
}

console.log(`Instanz: ${URL}`)
const suffix = Math.random().toString(36).slice(2, 8)

// Wegwerf-User B
const pbNew = new PocketBase(URL)
const email = `acl-selftest-${suffix}@ajna.local`, pass = 'acl-selftest-123456'
const userB = await pbNew.collection('users').create({ email, name: `ACL-Selftest-${suffix}`, password: pass, passwordConfirm: pass })
console.log(`User B: ${userB.id}`)

// User A: Objekt + ACE
const pbA = new PocketBase(URL)
await pbA.collection('users').authWithPassword(process.env.AJNA_USER, process.env.AJNA_PASS)
const obj = await pbA.collection('objects').create({ name: `acl-selftest-${suffix}`, lat: 0, lon: 0, altitude: 0 })
console.log(`Objekt: ${obj.id} (Besitzer ${obj.owner})`)
await pbA.collection('object_permissions').create({
  object: obj.id, subject_type: 'user', subject: userB.id,
  rights: ['view', 'edit', 'move', 'owner'], interact_actions: ['*'],
})
console.log('User-ACE für B angelegt (view/edit/move/owner)')

// User B: Regel-Pfade
const pbB = new PocketBase(URL)
await pbB.collection('users').authWithPassword(email, pass)

await step('Cache-Zeile lesbar (myRights-Pfad)', async () => {
  const rows = await pbB.collection('effective_permissions').getFullList({ filter: `object = "${obj.id}" && user = "${userB.id}"` })
  return rows.length ? JSON.stringify(rows[0].rights) : 'KEINE ZEILE (recompute-Hook?)'
})
await step('Objekt sehen (viewRule via Cache)', async () => (await pbB.collection('objects').getOne(obj.id)).id)
await step('Objekt bearbeiten (updateRule via edit)', async () => (await pbB.collection('objects').update(obj.id, { name: `acl-selftest-${suffix}-edited` })).name)
await step('ACEs listen (owner-Recht)', async () =>
  `${(await pbB.collection('object_permissions').getFullList({ filter: `object = "${obj.id}"` })).length} ACE(s)`)
await step('ACE anlegen (owner-Recht)', async () => (await pbB.collection('object_permissions').create({
  object: obj.id, subject_type: 'anonymous', subject: '', rights: ['view'], interact_actions: [],
})).id)
await step('Objekt löschen (deleteRule via owner-Recht)', () => pbB.collection('objects').delete(obj.id))

try { await pbA.collection('objects').delete(obj.id); console.log('(Aufräumen durch A)') } catch {}
console.log(failed ? `\n✗ ${failed} Pfad(e) fehlgeschlagen` : '\n✓ Alle Regel-Pfade in Ordnung')
process.exit(failed ? 1 : 0)
