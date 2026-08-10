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
// Konfiguration (Env > agents/.env.wand-agent > Root-.env — siehe lib/env.mjs):
//   AJNA_URL   PocketBase-URL  (Default: http://127.0.0.1:8090)
//   AJNA_USER  Pflicht — Agent-User
//   AJNA_PASS  Pflicht
//   WAND_LAT   Ziel-Latitude   (Default: 50.3569 — Koblenz)
//   WAND_LON   Ziel-Longitude  (Default: 7.5890)
//
// Start:  node agents/wand-agent.mjs   bzw.   npm run wand-agent

import { bootAgent, envNum } from './lib/agent-base.mjs'
import { simpleSetup } from './lib/setup-wizard.mjs'
import { ensureObject } from '../client/core/ensureObject.js'

const { ajna } = await bootAgent('wand-agent', {
  connect: true,
  setup: simpleSetup('wand-agent', { required: ['AJNA_USER', 'AJNA_PASS'], optional: ['AJNA_URL', 'WAND_LAT', 'WAND_LON'] }),
})
const WAND_LAT = envNum('WAND_LAT', 50.3569)
const WAND_LON = envNum('WAND_LON', 7.5890)

const WAND_ACTIONS = ['wand_press', 'wand_long', 'wand_gesture', 'wand_effect']

// ─── Demo-Zielobjekt sicherstellen (idempotent über state.wand_demo) ─────
// ensureObject garantiert die authenticated-ACE per Union-Merge — kollidiert
// damit nicht mehr mit einer aus default_permissions materialisierten ACE.
const { obj: target, created } = await ensureObject(ajna, {
  match: o => o?.state?.wand_demo === true,
  fields: {
    name: 'Zauberstab-Ziel',
    type: 'npc',
    lat: WAND_LAT,
    lon: WAND_LON,
    altitude: 0,
    animation_state: 'idle',
    state: { wand_demo: true }
  },
  // Jeder eingeloggte User darf sehen + die Wand-Aktionen auslösen.
  ace: { subject_type: 'authenticated', rights: ['view'], interact_actions: WAND_ACTIONS },
  warn: (...a) => console.warn('[wand-agent]', ...a),
})
if (created) console.log('[wand-agent] Demo-Zielobjekt angelegt')
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
