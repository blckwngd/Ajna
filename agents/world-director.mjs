#!/usr/bin/env node
//
// agents/world-director.mjs — World-Director für Ajna (P0-Skelett)
//
// Bevölkert die Welt vollautomatisch mit Figuren (NPCs, Gegner, Tiere,
// Drachen), Hinweisen und Items. Gebaut nach demselben Muster wie
// ais-bridge.mjs / wand-agent.mjs: ein dedizierter Agent-User, der über die
// AjnaManager-Bibliothek Welt-Objekte anlegt/pflegt.
//
// Stand P0 — bewusst NUR:
//   1. Login als Agent-User.
//   2. Manifest publishen (ein Filter-Layer pro Archetyp).
//   3. Adopt-on-Boot: vorhandene Director-Objekte (state.director === true)
//      einlesen und pro Archetyp zählen.
//   4. Fehlende Objekte als STATISCHE Platzhalter rund um ein Zentrum
//      anlegen — mit generiertem Namen, ACE (authenticated/view + archetyp-
//      spezifische interact_actions), Dialog/Hinweis im state.
//   5. Heartbeat (Manifest-Refresh) hält den Prozess am Leben.
//
// NOCH NICHT (kommt in späteren Phasen, siehe docs/world-objects.md):
//   • P2 Bewegung/Autonomie auf dem Straßennetz (geo.waysNear + Routing)
//   • P3 Drachen-Freiflug + Tiere auf Freiflächen (geo.areasNear)
//   • Echte Interaktions-Effekte / Belohnungen / GLB-Modelle
//
// Konfiguration (ENV oder .env im CWD):
//   AJNA_URL    PocketBase/Caddy-URL (Default: http://127.0.0.1:8090)
//   AJNA_USER   Pflicht — Agent-User
//   AJNA_PASS   Pflicht
//   WD_CENTER_LAT / WD_CENTER_LON   Spawn-Zentrum (Default: 50.3569, 7.5890 — Koblenz)
//   WD_RADIUS_M Streuradius um das Zentrum in m (Default: 150)
//   WD_COUNT_NPC / _ENEMY / _ANIMAL / _DRAGON / _ITEM / _HINT
//               Soll-Bestand pro Archetyp (Defaults siehe ARCHETYPES)
//   WD_HEARTBEAT_S  Manifest-Heartbeat-Intervall in s (Default: 60)
//
// Start:  node agents/world-director.mjs   bzw.   npm run director

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { maybeReexecWithSystemCa } from './lib/system-ca.mjs'
import { randomUUID } from 'node:crypto'
import { EventSource } from 'eventsource'
if (typeof globalThis.EventSource !== 'function') globalThis.EventSource = EventSource

import { AjnaManager } from '../client/core/AjnaManager.js'
import { AjnaGeo } from '../client/core/AjnaGeo.js'
import { stepAlongPath, buildWayGraph, nearestNodeKey, randomReachableTarget, shortestPath, haversine } from '../client/core/StreetNav.js'
import { animalNameFor } from '../client/core/animalNames.js'

// ─── .env laden (gleiches Schema wie ais-bridge.mjs) ─────────────────────
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

const AJNA_URL    = process.env.AJNA_URL  || 'http://127.0.0.1:8090'
const AJNA_USER   = process.env.AJNA_USER
const AJNA_PASS   = process.env.AJNA_PASS
const CENTER_LAT  = parseFloat(process.env.WD_CENTER_LAT || '50.3569')
const CENTER_LON  = parseFloat(process.env.WD_CENTER_LON || '7.5890')
const RADIUS_M    = parseFloat(process.env.WD_RADIUS_M   || '150')
const HEARTBEAT_MS = parseFloat(process.env.WD_HEARTBEAT_S || '60') * 1000

// Autonomie (P2): NPCs/Gegner laufen auf dem Straßennetz.
const AUTONOMY      = (process.env.WD_AUTONOMY || 'on').toLowerCase() !== 'off'
const TICK_MS       = parseFloat(process.env.WD_TICK_MS       || '500')
const PAUSE_MS      = parseFloat(process.env.WD_PAUSE_S       || '10') * 1000
const WAY_RADIUS_M  = parseFloat(process.env.WD_WAY_RADIUS_M  || '200')
const NPC_SPEED     = parseFloat(process.env.WD_NPC_SPEED     || '1.4')   // m/s (~5 km/h)
const ENEMY_SPEED   = parseFloat(process.env.WD_ENEMY_SPEED   || '1.8')   // m/s (Patrouille)
const PLAN_RETRY_MS = 15000
// Geteilter Wegegraph-Cache: EINE Overpass-Abfrage pro Areal/TTL für alle
// Figuren (statt pro Figur/Replan) — drückt die Overpass-Last drastisch.
const GRAPH_TTL_MS   = parseFloat(process.env.WD_GRAPH_TTL_S || '3600') * 1000
const GRAPH_RADIUS_M = Math.min(2000, RADIUS_M + WAY_RADIUS_M)
// Welche Archetypen laufen in P2 auf Straßen? (animal=Fläche, dragon=Flug → P3)
const STREET_ARCHETYPES = new Set(['npc', 'enemy'])
// Modell-Yaw vs. Bewegungsrichtung — wie in client/agent.js (Modell zeigt +Z).
const HEADING_TO_YAW = h => h - Math.PI / 2

// Bei HTTPS ggf. mit --use-system-ca neu starten (Caddys interne CA). Robust
// gegen altes Node & öffentliche Zerts — siehe agents/lib/system-ca.mjs.
maybeReexecWithSystemCa(AJNA_URL)

function die(msg) { console.error(`✗ ${msg}`); process.exit(1) }
if (!AJNA_USER || !AJNA_PASS) die('AJNA_USER und AJNA_PASS fehlen (.env oder env var)')
if (!Number.isFinite(CENTER_LAT) || !Number.isFinite(CENTER_LON)) die('Ungültige Center-Koords')

// ─────────────────────────────────────────────────────────────────────────
//  Zufalls-Helfer (Math.random genügt — kein deterministischer Seed in P0)
// ─────────────────────────────────────────────────────────────────────────
const pick = arr => arr[Math.floor(Math.random() * arr.length)]
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1))

// Gleichverteilter Zufallspunkt in einem Kreis (Radius in m) um lat/lon.
function randomPointNear(lat, lon, radiusM) {
  const r = radiusM * Math.sqrt(Math.random())
  const theta = 2 * Math.PI * Math.random()
  const dLat = (r * Math.cos(theta)) / 111000
  const dLon = (r * Math.sin(theta)) / (111000 * Math.cos(lat * Math.PI / 180))
  return { lat: lat + dLat, lon: lon + dLon }
}

// ─────────────────────────────────────────────────────────────────────────
//  Prozedurale Namen & Texte (P0: Pools/Templates, kein LLM)
// ─────────────────────────────────────────────────────────────────────────
const NAME_POOLS = {
  npcFirst: ['Mara', 'Tom', 'Lena', 'Jonas', 'Ada', 'Nik', 'Sara', 'Ben', 'Ida', 'Paul'],
  npcLast:  ['Berger', 'Falk', 'Kraus', 'Roth', 'Stein', 'Vogt', 'Wendt', 'Sommer'],
  enemyAdj: ['Schatten', 'Dorn', 'Nebel', 'Rost', 'Grimm', 'Blut', 'Frost', 'Sturm', 'Dunkel'],
  enemyN:   ['krieger', 'läufer', 'wächter', 'schleicher', 'beißer', 'jäger'],
  animal:   ['Fuchs', 'Reh', 'Hase', 'Katze', 'Specht', 'Dachs', 'Igel', 'Eichhörnchen'],
  dragonA:  ['Vyr', 'Az', 'Mor', 'Syl', 'Drak', 'Ng', 'Tha'],
  dragonB:  ['thax', 'mir', 'gorn', 'wyn', 'ros', 'dûr', 'eth'],
  itemAdj:  ['Rostiger', 'Glänzender', 'Uralter', 'Verzierter', 'Schlichter', 'Glühender'],
  itemN:    ['Schlüssel', 'Kelch', 'Anhänger', 'Ring', 'Splitter', 'Kompass', 'Talisman']
}

const DIALOG_LINES = [
  'Tag auch. Schönes Wetter heute, nicht?',
  'Pass auf dich auf da draußen.',
  'Hast du die Drachen am Himmel gesehen?',
  'Ich hätte schwören können, hier war mehr los.',
  'Wenn du etwas Glänzendes findest — behalt es im Auge.'
]

const HINT_LINES = [
  'Tiere halten sich lieber auf Freiflächen auf.',
  'Drachen folgen keinen Straßen — sie ziehen ihre eigenen Bahnen.',
  'Manche Gestalten wandern feste Routen. Beobachte sie eine Weile.',
  'Items haben noch keine Wirkung — aber das könnte sich ändern.',
  'Sieh dich um: Die Welt füllt sich von selbst.'
]

const NAME_GEN = {
  npc:    () => `${pick(NAME_POOLS.npcFirst)} ${pick(NAME_POOLS.npcLast)}`,
  enemy:  () => `${pick(NAME_POOLS.enemyAdj)}${pick(NAME_POOLS.enemyN)}`,
  animal: () => pick(NAME_POOLS.animal),
  dragon: () => `${pick(NAME_POOLS.dragonA)}${pick(NAME_POOLS.dragonB)}`,
  item:   () => `${pick(NAME_POOLS.itemAdj)} ${pick(NAME_POOLS.itemN)}`,
  hint:   () => 'Hinweis'
}

// Beschreibung (Top-Level-Feld), die "examine" ausgibt. Prozedural wie Namen.
const DESCR_NPC = [
  'Ein Passant auf dem Weg durch die Stadt.',
  'Jemand, der hier offenbar öfter unterwegs ist.',
  'Eine freundliche Gestalt mit eigener Route.'
]
const DESCR_ENEMY = [
  'Eine zwielichtige Gestalt — besser auf Abstand bleiben.',
  'Wirkt nicht eben freundlich gesinnt.'
]
const DESCRIPTION_GEN = {
  npc:    () => pick(DESCR_NPC),
  enemy:  () => pick(DESCR_ENEMY),
  animal: (name) => `Ein wildlebendes Tier${name ? ` — ${name}` : ''}, das sich am liebsten auf Freiflächen aufhält.`,
  dragon: () => 'Ein fliegendes Wesen, das hoch über den Dächern seine Bahnen zieht.',
  item:   () => 'Ein Gegenstand. Aktuell ohne Funktion — vielleicht später aufsammelbar.',
  hint:   () => pick(HINT_LINES)
}

// ─────────────────────────────────────────────────────────────────────────
//  Archetyp-Registry — der zentrale Contract (siehe docs/world-objects.md)
// ─────────────────────────────────────────────────────────────────────────
// `actions` = {key,label}: key landet in der ACE (Autorisierung) UND in
// state.actions (Menü-Beschriftung im Client). Ein "talk" auf einem NPC
// löst die Dialog-Antwort aus (Client zeigt state.dialog).
const ARCHETYPES = {
  npc:    { count: 2, actions: [{ key: 'talk', label: 'Sprechen' }, { key: 'examine', label: 'Untersuchen' }], initialAnim: 'idle', flying: false },
  enemy:  { count: 1, actions: [{ key: 'attack', label: 'Angreifen' }, { key: 'examine', label: 'Untersuchen' }], initialAnim: 'idle', flying: false },
  animal: { count: 2, actions: [{ key: 'feed', label: 'Füttern' }, { key: 'examine', label: 'Untersuchen' }], initialAnim: 'idle', flying: false },
  dragon: { count: 1, actions: [{ key: 'examine', label: 'Untersuchen' }], initialAnim: 'idle', flying: true  },
  item:   { count: 2, actions: [],                                         initialAnim: 'idle', flying: false },
  hint:   { count: 1, actions: [{ key: 'examine', label: 'Lesen' }],       initialAnim: 'idle', flying: false }
}
const actionKeys = a => ARCHETYPES[a].actions.map(x => x.key)

// ── 3D-Modelle pro Archetyp ──────────────────────────────────────────────
// Dateien liegen unter client/models/ und werden von Caddy als /models/<x>.glb
// (mit CORS) ausgeliefert. Wir schreiben den Pfad RELATIV in appearance.gltf —
// der Client (AjnaClient._serverUrl + gltfUrlOf) löst ihn gegen den Server auf,
// von dem das Objekt stammt. So funktioniert es für jeden Client-Hostnamen
// (localhost / LAN-Alias / Public-Domain) ohne Agent-seitige Konfiguration.
// Map zeigt unverändert das Typ-Emoji (kein gltf nötig); gltf greift nur in AR.
const MODEL_BASE = '/models/'
const MODEL_POOL = {
  npc:    ['CesiumMan.glb', 'Soldier.glb', 'RobotExpressive.glb'],
  enemy:  ['MawGooey.glb', 'Slime.glb', 'Soldier.glb'],
  animal: ['Fox.glb', 'Horse.glb', 'Flamingo.glb', 'Stork.glb', 'Parrot.glb'],
  dragon: ['Dragon.glb'],
  item:   ['Sword.glb', 'TreasureChest.glb'],
  hint:   []   // kein Modell → Viewer nutzt den appearance-/Typ-Platzhalter
}
// Vögel wirken in der Luft natürlicher → leichte Flughöhe, auch wenn der
// Archetyp (animal) sonst am Boden ist.
const FLYING_MODELS = new Set(['Flamingo.glb', 'Stork.glb', 'Parrot.glb'])

function targetCount(archetype) {
  const env = process.env[`WD_COUNT_${archetype.toUpperCase()}`]
  const n = env !== undefined ? parseInt(env, 10) : ARCHETYPES[archetype].count
  return Number.isFinite(n) && n >= 0 ? n : ARCHETYPES[archetype].count
}

// Baut den Spawn-Datensatz für einen Archetyp (statisch, P0).
function buildSpawn(archetype) {
  const arch = ARCHETYPES[archetype]
  const { lat, lon } = randomPointNear(CENTER_LAT, CENTER_LON, RADIUS_M)
  const pool = MODEL_POOL[archetype] || []
  const model = pool.length ? pick(pool) : null
  // Flughöhe: echter Flieger (Drache) hoch, Vogel-Modelle niedrig, sonst Boden.
  const altitude = arch.flying ? randInt(30, 80)
                 : (model && FLYING_MODELS.has(model)) ? randInt(8, 25)
                 : 0
  // Tier-Name IMMER passend zum gewählten Modell (+ optionales Adjektiv, das die
  // Größe beeinflussen kann). Übrige Archetypen behalten ihre Namensgeneratoren.
  let name, sizeScale = 1
  if (archetype === 'animal' && model) {
    const a = animalNameFor(model)
    name = a.name
    sizeScale = a.scale
  } else {
    name = NAME_GEN[archetype]()
  }

  const state = {
    director: true,
    archetype,
    spawn_id: randomUUID(),
    actions: arch.actions          // Menü-Aktionen (Client liest state.actions)
  }
  if (archetype === 'npc')  state.dialog = pick(DIALOG_LINES)
  if (archetype === 'hint') state.hint   = pick(HINT_LINES)

  const spawn = {
    name,
    type: archetype,
    description: DESCRIPTION_GEN[archetype](name),
    lat, lon, altitude,
    rotation: { x: 0, y: Math.random() * Math.PI * 2 - Math.PI, z: 0 },
    animation_state: arch.initialAnim,
    state
  }
  // appearance.gltf nur setzen, wenn der Archetyp ein Modell hat — sonst
  // bleibt das Feld leer und der Viewer fällt auf den Typ-Platzhalter zurück.
  // sizeScale (Größen-Adjektiv) als appearance.scale mitgeben.
  if (model) {
    spawn.appearance = { gltf: MODEL_BASE + model }
    if (sizeScale !== 1) spawn.appearance.scale = sizeScale
  }
  return spawn
}

// ─────────────────────────────────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────────────────────────────────
const ajna = new AjnaManager(AJNA_URL)
try { await ajna.login(AJNA_USER, AJNA_PASS) }
catch (err) { die(`Ajna-Login fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`) }
console.log(`[director] eingeloggt als ${ajna.currentUser()?.email || AJNA_USER}`)
console.log(`[director] Zentrum: ${CENTER_LAT.toFixed(4)}, ${CENTER_LON.toFixed(4)} · Radius ${RADIUS_M} m`)

async function publishManifest() {
  try {
    await ajna.upsertAgentManifest({
      source: 'world-director',
      agent_name: 'World-Director',
      description: `Automatische Welt-Bevölkerung (Figuren, Hinweise, Items) im Radius ${RADIUS_M} m um ${CENTER_LAT.toFixed(3)}, ${CENTER_LON.toFixed(3)}`,
      layers: Object.keys(ARCHETYPES).map(a => ({ key: a, label: a, predicate: null }))
    })
  } catch (err) {
    console.warn('[director] manifest-upsert fehlgeschlagen:', err?.message || err)
  }
}
await publishManifest()
console.log('[director] manifest publiziert')

// Stellt die archetyp-spezifischen interact_actions auf der authenticated-ACE
// sicher (idempotent). Der afterCreate-Hook materialisiert aus den
// default_permissions des Agent-Users bereits eine (authenticated, view,
// interact:[])-ACE — wir UPDATEN sie auf die richtige Aktions-Liste, statt
// eine zweite anzulegen (würde am Unique-Index object+subject_type+subject
// scheitern). Existiert sie wider Erwarten nicht, legen wir sie an.
async function ensureAce(objId, interact) {
  try {
    const existing = await ajna.listPermissions(objId)
    const ace = existing.find(a => a.subject_type === 'authenticated' && !a.subject)
    if (ace) {
      const sameActions = JSON.stringify(ace.interact_actions || []) === JSON.stringify(interact)
      const hasView = (ace.rights || []).includes('view')
      if (!sameActions || !hasView) {
        await ajna.updatePermission(ace.id, { rights: ['view'], interact_actions: interact })
      }
    } else {
      await ajna.addPermission(objId, {
        subject_type: 'authenticated', rights: ['view'], interact_actions: interact
      })
    }
  } catch (err) {
    console.warn(`[director] ACE für ${objId} fehlgeschlagen: ${err?.message || err}`)
  }
}

// Stellt sicher, dass state.actions (Menü-Beschriftung im Client) am Objekt
// liegt — patcht Bestandsobjekte, die noch ohne angelegt wurden. Spiegelt die
// Änderung lokal, damit makeController/baseState sie übernimmt.
async function ensureActions(obj) {
  const arch = ARCHETYPES[obj.state?.archetype]
  if (!arch) return
  if (JSON.stringify(obj.state?.actions ?? null) === JSON.stringify(arch.actions)) return
  try {
    const next = { ...obj.state, actions: arch.actions }
    const updated = await ajna.updateObject(obj.id, { state: next })
    obj.state = updated?.state || next
  } catch (err) {
    console.warn(`[director] state.actions für ${obj.id} fehlgeschlagen: ${err?.message || err}`)
  }
}

// Setzt das description-Feld (für examine) bei Bestandsobjekten, die noch
// keins haben. Top-Level-Feld → von Teil-Updates (Bewegung) unberührt.
async function ensureDescription(obj) {
  const a = obj.state?.archetype
  if (!ARCHETYPES[a]) return
  if (typeof obj.description === 'string' && obj.description.trim()) return
  try {
    const desc = DESCRIPTION_GEN[a](obj.name)
    const updated = await ajna.updateObject(obj.id, { description: desc })
    obj.description = updated?.description || desc
  } catch (err) {
    console.warn(`[director] description für ${obj.id} fehlgeschlagen: ${err?.message || err}`)
  }
}

// ─── Adopt-on-Boot: vorhandene Director-Objekte sammeln + pro Archetyp zählen
// Objekte, die deutlich AUSSERHALB des bespielbaren Bereichs liegen (typisch
// nach einem Center-Wechsel), werden aufgeräumt statt adoptiert — sonst zählt
// der alte Bestand mit und am neuen Zentrum spawnt nichts. Großzügiger Puffer
// (Radius + Lauf-Radius + 300 m), damit normal umherlaufende Figuren NICHT
// getroffen werden. Opt-out via WD_KEEP_OUTSIDE=1.
const DESPAWN_RADIUS_M = RADIUS_M + WAY_RADIUS_M + 300
const KEEP_OUTSIDE     = process.env.WD_KEEP_OUTSIDE === '1'
const existingByArch = {}
for (const a of Object.keys(ARCHETYPES)) existingByArch[a] = 0
const managed = []   // alle vom Director verwalteten Objekte (adoptiert + neu)
let despawned = 0
try {
  await ajna.refreshObjects()
  for (const obj of ajna.getObjects()) {
    if (obj?.state?.director !== true) continue
    const a = obj.state.archetype
    if (!(a in existingByArch)) continue
    const dist = haversine(CENTER_LAT, CENTER_LON, obj.lat, obj.lon)
    if (!KEEP_OUTSIDE && Number.isFinite(dist) && dist > DESPAWN_RADIUS_M) {
      try { await ajna.deleteObject(obj.id); despawned++; continue }
      catch (err) { console.warn(`[director] despawn ${obj.id} fehlgeschlagen: ${err?.message || err}`) }
    }
    existingByArch[a]++; managed.push(obj)
  }
  const summary = Object.entries(existingByArch).map(([a, n]) => `${a}:${n}`).join(' ')
  console.log(`[director] vorhanden — ${summary}${despawned ? ` · ${despawned} außerhalb despawnt` : ''}`)
} catch (err) {
  console.warn(`[director] initiales Objekt-Listing fehlgeschlagen: ${err?.message || err}`)
}

// ─── Fehlende Objekte bis zum Soll-Bestand anlegen ───────────────────────
async function spawnOne(archetype) {
  const data = buildSpawn(archetype)
  const obj = await ajna.createObject(data)
  console.log(`[director] + ${archetype.padEnd(6)} "${data.name}" @ ${data.lat.toFixed(5)}, ${data.lon.toFixed(5)} → ${obj.id}`)
  return obj
}

let spawned = 0
for (const archetype of Object.keys(ARCHETYPES)) {
  const need = targetCount(archetype) - existingByArch[archetype]
  for (let i = 0; i < need; i++) {
    try { managed.push(await spawnOne(archetype)); spawned++ }
    catch (err) { console.warn(`[director] spawn ${archetype} fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`) }
  }
}
console.log(`[director] ${spawned} neue Objekte angelegt.`)

// ─── ACEs + Menü-Aktionen reconcilen für ALLE verwalteten Objekte ────────
let reconciled = 0
for (const obj of managed) {
  const a = obj.state?.archetype
  if (!ARCHETYPES[a]) continue
  await ensureAce(obj.id, actionKeys(a))
  await ensureActions(obj)
  await ensureDescription(obj)
  reconciled++
}
console.log(`[director] ${reconciled} Objekte reconciled (ACE + Aktionen). Welt steht.`)

// ─────────────────────────────────────────────────────────────────────────
//  Autonomie-Engine (P2) — Straßennetz-Figuren: plan → walk → pause → repeat
//
//  Pro Figur eine kleine State-Machine. Der Tick rückt laufende Figuren um
//  speed·dt entlang ihrer Route vor (Client-Smoother glätten die Lücke). Am
//  Pfadende: idle, ~10 s Pause, dann neues Ziel im lokalen Netz. Geo kommt
//  über AjnaGeo (Caddy-URL nötig) — fällt es aus, bleiben Figuren stehen und
//  ein Retry läuft, statt dass der Director kippt.
// ─────────────────────────────────────────────────────────────────────────
const geo = new AjnaGeo(ajna)
const speedFor = a => (a === 'enemy' ? ENEMY_SPEED : NPC_SPEED)

// Wegegraph UM DIE FIGUR (nicht um ein festes Zentrum) — pro grober Zelle
// (~300 m) gecacht und per TTL erneuert. So funktioniert die Routenplanung
// auch, wenn Figuren über mehrere Areale verteilt sind (kein Teleport an ein
// fixes Zentrum). Zusätzlich zum Server-Cache in server/geo.js (1 h).
const GRAPH_CELL_M = 300
const graphCache = new Map()          // cellKey → { graph, at }
const graphInflight = new Map()       // cellKey → Promise (dedupe parallele Fetches)
function graphCellKey(lat, lon) {
  const g = GRAPH_CELL_M / 111000
  return `${Math.round(lat / g)}|${Math.round(lon / g)}`
}
async function getGraphNear(lat, lon) {
  const key = graphCellKey(lat, lon)
  const hit = graphCache.get(key)
  if (hit && (Date.now() - hit.at) < GRAPH_TTL_MS) return hit.graph
  if (graphInflight.has(key)) return graphInflight.get(key)
  const p = (async () => {
    try {
      const res = await geo.waysNear(lat, lon, GRAPH_RADIUS_M, 'walkable')
      const graph = buildWayGraph(res.features || [])
      if (graph.nodes.size >= 2) {
        graphCache.set(key, { graph, at: Date.now() })
        console.log(`[director] Wegegraph @${lat.toFixed(4)},${lon.toFixed(4)}: ${graph.nodes.size} Knoten`)
        return graph
      }
      return null
    } finally { graphInflight.delete(key) }
  })()
  graphInflight.set(key, p)
  return p
}

function makeController(obj) {
  return {
    id: obj.id,
    archetype: obj.state.archetype,
    baseState: { ...obj.state },          // Identitätsfelder (ohne walk_path)
    lat: obj.lat, lon: obj.lon,
    speed: speedFor(obj.state.archetype),
    fsm: 'idle',                          // 'idle' | 'planning' | 'walking'
    path: null,
    cursor: { segIdx: 0, segT: 0 },
    nextPlanAt: 0,
    lastTickAt: Date.now(),
    busy: false
  }
}

let geoWarned = false
function geoWarnOnce(err) {
  if (geoWarned) return
  geoWarned = true
  console.warn(`[director] Geo/Routing nicht verfügbar — Figuren warten, Retry läuft${err ? ` (${err.message || err})` : ''}.`)
  console.warn(`[director] Tipp: Geo-API (npm run start) + Caddy nötig; AJNA_URL muss die Caddy-URL sein.`)
}

async function planFor(c) {
  c.busy = true; c.fsm = 'planning'
  try {
    const graph = await getGraphNear(c.lat, c.lon)
    if (!graph) { geoWarnOnce(); c.fsm = 'idle'; c.nextPlanAt = Date.now() + PLAN_RETRY_MS; return }
    const startKey = nearestNodeKey(graph, c.lat, c.lon)
    const targetKey = startKey && randomReachableTarget(graph, startKey, { minDistM: 40, maxDistM: WAY_RADIUS_M })
    const path = targetKey ? shortestPath(graph, startKey, targetKey) : null
    if (!path || path.length < 2) { c.fsm = 'idle'; c.nextPlanAt = Date.now() + PLAN_RETRY_MS; return }

    let lengthM = 0
    for (let i = 1; i < path.length; i++) lengthM += haversine(path[i-1][0], path[i-1][1], path[i][0], path[i][1])
    c.path = path
    c.cursor = { segIdx: 0, segT: 0 }
    c.lastTickAt = Date.now()
    c.fsm = 'walking'
    await ajna.setAnimation(c.id, 'walk')
    // walk_path für die grüne AR-Debug-Linie (wie client/agent.js).
    await ajna.updateObject(c.id, { state: { ...c.baseState, walk_path: path } })
    console.log(`[director] ▶ ${c.archetype} "${c.id}" läuft ${lengthM.toFixed(0)} m (${path.length} Pkt.)`)
  } catch (err) {
    geoWarnOnce(err); c.fsm = 'idle'; c.nextPlanAt = Date.now() + PLAN_RETRY_MS
  } finally { c.busy = false }
}

async function advanceFor(c) {
  c.busy = true
  try {
    const now = Date.now()
    const dt = Math.min(2, (now - c.lastTickAt) / 1000)   // dt-Cap gegen Sprünge
    c.lastTickAt = now
    const step = stepAlongPath(c.path, c.cursor, c.speed * dt)
    c.lat = step.lat; c.lon = step.lon
    c.cursor = { segIdx: step.segIdx, segT: step.segT }
    await ajna.updateObject(c.id, {
      lat: c.lat, lon: c.lon,
      rotation: { x: 0, y: HEADING_TO_YAW(step.headingRad), z: 0 }
    })
    if (step.done) {
      c.fsm = 'idle'; c.path = null; c.nextPlanAt = now + PAUSE_MS
      await ajna.setAnimation(c.id, 'idle')
      await ajna.updateObject(c.id, { state: { ...c.baseState } })   // walk_path entfernen
      console.log(`[director] ⏸ ${c.archetype} "${c.id}" angekommen — Pause ${(PAUSE_MS / 1000) | 0} s`)
    }
  } catch (err) {
    console.warn(`[director] tick "${c.id}" fehlgeschlagen: ${err?.message || err}`)
    c.fsm = 'idle'; c.nextPlanAt = Date.now() + PLAN_RETRY_MS
  } finally { c.busy = false }
}

function tick() {
  const now = Date.now()
  for (const c of controllers) {
    if (c.busy) continue
    if (c.fsm === 'walking') advanceFor(c)
    else if (c.fsm === 'idle' && now >= c.nextPlanAt) planFor(c)
  }
}

const controllers = AUTONOMY
  ? managed.filter(o => STREET_ARCHETYPES.has(o.state?.archetype)).map(makeController)
  : []
// Initiale Planung staffeln, damit nicht alle gleichzeitig Overpass treffen.
controllers.forEach((c, i) => { c.nextPlanAt = Date.now() + i * 800 })

if (controllers.length) {
  console.log(`[director] Autonomie aktiv für ${controllers.length} Figur(en) (Tick ${TICK_MS} ms, Pause ${(PAUSE_MS / 1000) | 0} s)`)
  setInterval(tick, TICK_MS)
} else {
  console.log(`[director] keine autonomen Figuren (AUTONOMY=${AUTONOMY ? 'on' : 'off'})`)
}

// ─── Heartbeat hält den Prozess am Leben (+ späterer Online-Status-Anker) ─
setInterval(() => { publishManifest() }, HEARTBEAT_MS)
console.log('[director] bereit. (Strg+C zum Beenden)')

process.on('SIGINT',  () => { console.log('\n[director] SIGINT — exit'); process.exit(0) })
process.on('SIGTERM', () => { console.log('[director] SIGTERM — exit'); process.exit(0) })
