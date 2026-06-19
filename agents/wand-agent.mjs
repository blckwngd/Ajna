#!/usr/bin/env node
//
// agents/wand-agent.mjs — Zauberstab-Agent für Ajna (vertikaler Slice)
//
// Beweist die Online-Kette: Stab-Knopf → BLE → App → ajna.interact() → DIESER
// Agent → sichtbare Objekt-Änderung (animation_state) → Realtime an alle Clients.
//
// Der Agent ist die autoritative "Zauber"-Logik im Backend (siehe Projektnotiz
// "wand-logic-split"). Lokale Sofort-Effekte am Stab (LED) laufen unabhängig in
// der Firmware und funktionieren offline — dieser Agent ist nur der Online-Teil.
//
// Was er tut:
//   1. Login als dedizierter Agent-User.
//   2. Sorgt für ein Demo-Zielobjekt ("Zauberstab-Ziel"), das jeder
//      eingeloggte User per Stab triggern darf (ACE: authenticated, interact).
//   3. Abonniert interact-Events auf diesem Objekt.
//   4. Auf wand_*-Aktionen: schaltet animation_state um und loggt.
//
// Konfiguration (ENV oder .env im CWD):
//   AJNA_URL   PocketBase-URL  (Default: http://127.0.0.1:8090)
//   AJNA_USER  Pflicht — Agent-User
//   AJNA_PASS  Pflicht
//   WAND_LAT   Ziel-Latitude   (Default: 50.3569 — Koblenz)
//   WAND_LON   Ziel-Longitude  (Default: 7.5890)
//
// Start:  node agents/wand-agent.mjs   bzw.   npm run wand-agent

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { EventSource } from 'eventsource'
if (typeof globalThis.EventSource !== 'function') globalThis.EventSource = EventSource

import { AjnaManager } from '../client/core/AjnaManager.js'

// ─── .env laden (gleiches Schema wie poi-bridge.mjs) ─────────────────────
function loadDotenv() {
  const path = resolve(process.cwd(), '.env')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const stripped = line.replace(/^\s*#.*$/, '').trim()
    if (!stripped) continue
    const m = stripped.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i)
    if (!m) continue
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}
loadDotenv()

const AJNA_URL  = process.env.AJNA_URL  || 'http://127.0.0.1:8090'
const AJNA_USER = process.env.AJNA_USER
const AJNA_PASS = process.env.AJNA_PASS
const WAND_LAT  = parseFloat(process.env.WAND_LAT || '50.3569')
const WAND_LON  = parseFloat(process.env.WAND_LON || '7.5890')

// Re-exec mit --use-system-ca bei HTTPS (Caddy-interne CA).
if (AJNA_URL.startsWith('https://') && !process.execArgv.includes('--use-system-ca')) {
  const r = spawnSync(process.execPath,
    ['--use-system-ca', process.argv[1], ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

function die(msg) { console.error(`✗ ${msg}`); process.exit(1) }
if (!AJNA_USER || !AJNA_PASS) die('AJNA_USER und AJNA_PASS fehlen')

const WAND_ACTIONS = ['wand_press', 'wand_long', 'wand_gesture', 'wand_effect']

const ajna = new AjnaManager(AJNA_URL)
try { await ajna.login(AJNA_USER, AJNA_PASS) }
catch (err) { die(`Ajna-Login fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`) }
console.log(`[wand-agent] eingeloggt als ${ajna.currentUser()?.email || AJNA_USER}`)

await ajna.connect()

// ─── Demo-Zielobjekt sicherstellen (idempotent über state.wand_demo) ─────
function findDemoTarget() {
  for (const o of ajna.getObjects()) {
    if (o?.state?.wand_demo === true) return o
  }
  return null
}

let target = findDemoTarget()
if (!target) {
  console.log('[wand-agent] lege Demo-Zielobjekt an …')
  target = await ajna.createObject({
    name: 'Zauberstab-Ziel',
    type: 'npc',
    lat: WAND_LAT,
    lon: WAND_LON,
    altitude: 0,
    animation_state: 'idle',
    state: { wand_demo: true }
  })
  // Jeder eingeloggte User darf sehen + die Wand-Aktionen auslösen.
  try {
    await ajna.addPermission(target.id, {
      subject_type: 'authenticated',
      rights: ['view'],
      interact_actions: WAND_ACTIONS
    })
  } catch (err) {
    console.warn('[wand-agent] ACE setzen fehlgeschlagen:', err?.message || err)
  }
}
console.log(`[wand-agent] Zielobjekt: ${target.id} @ ${WAND_LAT.toFixed(4)}, ${WAND_LON.toFixed(4)}`)

// ─── interact-Events abonnieren und reagieren ────────────────────────────
let activeState = 'idle'
await ajna.subscribeInteract(target.id, async (evt) => {
  const action = evt?.action || '?'
  if (!WAND_ACTIONS.includes(action)) {
    console.log(`[wand-agent] ignoriere Aktion "${action}"`); return
  }
  // Sichtbare Reaktion: zwischen idle/active umschalten.
  activeState = activeState === 'idle' ? 'active' : 'idle'
  console.log(`[wand-agent] ⚡ ${action}`, evt?.payload ?? '', `→ animation_state=${activeState}`)
  try { await ajna.setAnimation(target.id, activeState) }
  catch (err) { console.warn('[wand-agent] setAnimation fehlgeschlagen:', err?.message || err) }
})

console.log('[wand-agent] bereit — warte auf Stab-Interaktionen. (Strg+C zum Beenden)')
process.on('SIGINT', () => { console.log('\n[wand-agent] beende.'); process.exit(0) })
