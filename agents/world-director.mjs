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
// UMGESETZT:
//   • P2 Bewegung/Autonomie auf dem Straßennetz (geo.waysNear + Routing)
//   • P3 Drachen-/Vogel-Freiflug: sanftes Umherfliegen im Areal (makeFlyer)
//   • „Rufen": der Spieler ruft einen Drachen zu sich (Aktion `call`). Der
//     Client schickt seine Position im interact-Payload — wie GENAU, entscheidet
//     dort die Privatsphäre-Stufe (exakt oder aufs Raster vergröbert). Ablauf:
//     anfliegen → tief kreisen → landen (Boden bevorzugt, Dach als Kür aus den
//     OSM-Gebäuden) → 2 min warten → abheben → Routine. Siehe advanceSummon()
//     und agents/lib/landing-spots.mjs (dort die Geometrie, isoliert testbar:
//     npm run test:landing).
//     BEWUSST hier und nicht in einem eigenen Agent: advanceRoamer schreibt dem
//     Wesen jeden Tick die Position — ein zweiter Schreiber würde sich mit ihm
//     um dasselbe Objekt prügeln (sichtbares Zittern). Ein Ruf ist deshalb ein
//     temporärer Zustands-Override DESSELBEN Controllers.
// NOCH NICHT (kommt in späteren Phasen, siehe docs/world-objects.md):
//   • Boden-Tiere auf Freiflächen (geo.areasNear)
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
//   „Rufen" (Drache kommt zum Spieler):
//     WD_CALL_CIRCLE_ALT  Kreishöhe über Grund in m       (Default: 10)
//     WD_CALL_CIRCLE_R    Kreisradius über dem Spieler in m (Default: 15)
//     WD_CALL_CIRCLE_S    Kreisen vor der Landung in s     (Default: 12)
//     WD_CALL_STAY_S      Verweildauer am Boden in s       (Default: 120)
//     WD_CALL_LAND_MIN_M / _MAX_M  Landeplatz-Ring um den Spieler (8 / 20)
//     WD_CALL_RANGE_M     max. Entfernung, ab der ein Ruf ignoriert wird (1500)
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
import { findLandingSpot } from './lib/landing-spots.mjs'
import { stepAlongPath, buildWayGraph, nearestNodeKey, randomReachableTarget, shortestPath, haversine, bearingRad } from '../client/core/StreetNav.js'
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
// Welche Archetypen laufen auf Straßen? (npc/enemy). Fliegende Wesen (dragon +
// Vogel-Modelle) bekommen stattdessen freien Flug (siehe makeFlyer/advanceFlyer).
const STREET_ARCHETYPES = new Set(['npc', 'enemy'])
// Modell-Yaw = Bewegungsrichtung als Babylon-Root-Yaw. Wegen invertNorthSouth
// (Nord=-Z) ist das π − heading (die alte Formel heading − π/2 war falsch-händig
// → Figuren drehten in Kurven falsch herum, vgl. Flieger-Fix). Gilt für
// Boden-Roamer (advanceRoamer) UND Straßen-NPCs (advanceFor).
const HEADING_TO_YAW = h => Math.PI - h

// ── Freiflug (Drachen/Vögel): sanftes Umherfliegen in einem Areal ──────────
const FLY_AREA_M    = parseFloat(process.env.WD_FLY_AREA_M    || '150')  // Radius Flug-Areal um Spawn (m)
const FLY_SPEED     = parseFloat(process.env.WD_FLY_SPEED     || '7')    // m/s
const FLY_TURN_RATE = parseFloat(process.env.WD_FLY_TURN_RATE || '0.7')  // rad/s max. Drehrate → weiche Kurven
const FLY_WANDER    = parseFloat(process.env.WD_FLY_WANDER    || '0.6')  // rad/s Wander-Amplitude
// Boden-Tiere (Fox/Horse …) streifen frei umher (kein Overpass nötig) — langsamer
// und in kleinerem Areal als Flieger.
const ROAM_SPEED    = parseFloat(process.env.WD_ROAM_SPEED    || '1.0')  // m/s
const ROAM_AREA_M   = parseFloat(process.env.WD_ROAM_AREA_M   || '80')   // Radius Streif-Areal
// Streif-/Rast-Rhythmus (nur Boden-Tiere mit Idle-Animation): abwechselnd
// umherstreifen und stehen bleiben → ruhigere Szene. Zufällige Dauern (s).
// Reaktion auf Interaktionen: spricht ein Spieler eine Figur an, hält sie inne,
// statt mitten im Gespräch weiterzulaufen — der störendste Bruch der Illusion.
// Bewusst ORTSFREI: wo der Spieler steht, weiß der Server nicht (Privacy-Modell,
// die exakte Position bleibt on-device). Also kein „dreht sich zum Spieler",
// sondern Stehenbleiben + idle für ein paar Sekunden.
const ATTEND_MS = parseFloat(process.env.WD_ATTEND_S || '6') * 1000

// ─── „Rufen" (Drache kommt zum Spieler) ──────────────────────────────────
// Ablauf: anfliegen → tief kreisen → landen → warten → abheben → Routine.
// Der Spieler schickt seine Position im interact-Payload; WIE genau sie ist,
// hat der Client anhand seiner Privatsphäre-Stufe entschieden (exakt oder aufs
// Raster vergröbert) — der Director nimmt sie, wie sie kommt.
const CALL_CIRCLE_ALT   = parseFloat(process.env.WD_CALL_CIRCLE_ALT || '10')   // m über Grund beim Kreisen
const CALL_CIRCLE_R     = parseFloat(process.env.WD_CALL_CIRCLE_R   || '15')   // m Kreisradius über dem Spieler
const CALL_CIRCLE_S     = parseFloat(process.env.WD_CALL_CIRCLE_S   || '12')   // s kreisen, bevor er landet
const CALL_STAY_S       = parseFloat(process.env.WD_CALL_STAY_S     || '120')  // s am Boden bleiben (2 min)
const CALL_LAND_MIN_M   = parseFloat(process.env.WD_CALL_LAND_MIN_M || '8')    // nicht näher an den Spieler
const CALL_LAND_MAX_M   = parseFloat(process.env.WD_CALL_LAND_MAX_M || '20')
const CALL_APPROACH_SPEED = parseFloat(process.env.WD_CALL_SPEED    || '14')   // m/s Anflug (zügiger als Streifen)
const CALL_DESCENT_SPEED  = parseFloat(process.env.WD_CALL_DESCENT  || '4')    // m/s Sinken/Steigen
const CALL_MAX_RANGE_M  = parseFloat(process.env.WD_CALL_RANGE_M    || '1500') // weiter weg → Ruf ignorieren
const CALL_BUILDING_R   = parseFloat(process.env.WD_CALL_BUILDING_R || '60')   // m Umkreis für die Gebäudeabfrage

const ROAM_MOVE_MIN = parseFloat(process.env.WD_ROAM_MOVE_MIN || '8')
const ROAM_MOVE_MAX = parseFloat(process.env.WD_ROAM_MOVE_MAX || '22')
const ROAM_REST_MIN = parseFloat(process.env.WD_ROAM_REST_MIN || '4')
const ROAM_REST_MAX = parseFloat(process.env.WD_ROAM_REST_MAX || '14')
// Flieger-Ausrichtung: Wegen invertNorthSouth (Nord=-Z) zeigt der Körper mit der
// bisherigen Yaw-Formel bei Kurven falsch herum (rückwärts). Flieger nutzen daher
// die gespiegelte Yaw (π/2 − heading). WD_FLY_YAW_OFFSET = π addieren, falls ein
// Modell dann rückwärts zeigt. WD_FLY_BANK_MAX = Roll-Amplitude in Kurven (rad;
// Vorzeichen umkehren, falls es in die falsche Richtung kippt).
const FLY_YAW_OFFSET = parseFloat(process.env.WD_FLY_YAW_OFFSET || '0')
const FLY_BANK_MAX   = parseFloat(process.env.WD_FLY_BANK_MAX   || '0.5')  // ~30° max. Schräglage

// ── Interest-Areas: Welt dort bevölkern, wo Spieler sind (folgt echtem GPS) ──
// Der Director fragt periodisch die (anonymisierten) Interessensbereiche ab und
// hält an jedem Zentrum den Soll-Bestand; weit entfernte Figuren werden
// abgeräumt. Ohne aktive Area fällt er auf WD_CENTER_LAT/LON zurück.
const FOLLOW_AREAS  = (process.env.WD_FOLLOW_AREAS || 'on').toLowerCase() !== 'off'
const RECONCILE_MS  = parseFloat(process.env.WD_RECONCILE_S || '45') * 1000
// Quelle-Filter: nur Spieler, die den World-Director eingeblendet haben. Leer
// (WD_SOURCE="") = alle Areas berücksichtigen.
const WD_SOURCE     = process.env.WD_SOURCE ?? 'world-director'

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
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
// Winkel auf (-π, π] normalisieren; kleinste vorzeichenbehaftete Differenz.
const wrapPi = a => { let x = (a + Math.PI) % (2 * Math.PI); if (x < 0) x += 2 * Math.PI; return x - Math.PI }
const angleDiff = (a, b) => wrapPi(a - b)
// Zielpunkt distM Meter entlang Kompass-Bearing (0=Nord, +=Ost) — passt zu bearingRad.
function destPoint(lat, lon, heading, distM) {
  const dLat = (distM * Math.cos(heading)) / 111320
  const dLon = (distM * Math.sin(heading)) / (111320 * Math.cos(lat * Math.PI / 180))
  return { lat: lat + dLat, lon: lon + dLon }
}
// n zufällige, verschiedene Elemente aus arr (für NPC-Dialog-Reihen).
const sample = (arr, n) => {
  const copy = arr.slice()
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, Math.min(n, copy.length))
}

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
  'Wenn du etwas Glänzendes findest — behalt es im Auge.',
  'Bleib nicht zu lange stehen, es wird bald dunkel.',
  'Man erzählt sich Geschichten über diese Gegend …',
  'Kennst du den Weg zum alten Turm? Ich leider auch nicht.',
  'Hast du schon etwas zu essen dabei? Ich habe Hunger.',
  'Sei vorsichtig, hier treiben sich Gestalten herum.',
  'Ein Gruß aus der Ferne, Reisender.',
  'Ich warte hier schon eine Weile. Auf was, weiß ich nicht mehr.'
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
  hint:   () => 'Hinweis',
  diamond: () => 'Diamant'
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
  hint:   () => pick(HINT_LINES),
  diamond: () => 'Ein funkelnder Diamant. Einsammeln und stapeln — später wertvoll.'
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
  dragon: { count: 1, actions: [{ key: 'call', label: 'Rufen' }, { key: 'examine', label: 'Untersuchen' }], initialAnim: 'idle', flying: true  },
  item:   { count: 2, actions: [],                                         initialAnim: 'idle', flying: false },
  hint:   { count: 1, actions: [{ key: 'examine', label: 'Lesen' }],       initialAnim: 'idle', flying: false },
  // Diamanten: bewusst SELTEN (kleiner count), einsammelbar + stapelbar. Später
  // Zahlungsmittel / Loot / NPC-Belohnung. Kein explizites collect in actions —
  // portable=true blendet „🎒 Einsammeln" ohnehin ein.
  diamond: { count: 3, actions: [],                                        initialAnim: null,  flying: false }
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
  hint:   [],  // kein Modell → Viewer nutzt den appearance-/Typ-Platzhalter
  diamond: ['Diamond.glb']
}
// Vögel wirken in der Luft natürlicher → leichte Flughöhe, auch wenn der
// Archetyp (animal) sonst am Boden ist.
const FLYING_MODELS = new Set(['Flamingo.glb', 'Stork.glb', 'Parrot.glb'])
// Modelle mit brauchbarer Idle-/Ruhe-Animation → dürfen beim Streifen Pausen
// einlegen (sonst wirkt die Szene unruhig). Horse/Vögel/CesiumMan haben keine.
const IDLE_MODELS = new Set(['Soldier.glb', 'RobotExpressive.glb', 'MawGooey.glb', 'Slime.glb', 'Fox.glb', 'AIMonster.glb', 'Dragon.glb'])

function targetCount(archetype) {
  const env = process.env[`WD_COUNT_${archetype.toUpperCase()}`]
  const n = env !== undefined ? parseInt(env, 10) : ARCHETYPES[archetype].count
  return Number.isFinite(n) && n >= 0 ? n : ARCHETYPES[archetype].count
}

// Baut den Spawn-Datensatz für einen Archetyp um ein Zentrum (Interest-Area
// oder das konfigurierte Fallback-Zentrum).
// `opts.spreadM = 0` → exakt auf `center` setzen (Spawn auf Zuruf: der Spieler
// hat eine Stelle angeklickt, die soll nicht verwürfelt werden).
// `opts.onDemand` markiert solche Objekte: sie zählen NICHT zur Soll-Population
// und werden nicht wegen Entfernung despawnt (siehe Adopt-on-Boot).
function buildSpawn(archetype, center = { lat: CENTER_LAT, lon: CENTER_LON }, opts = {}) {
  const arch = ARCHETYPES[archetype]
  const spreadM = Number.isFinite(opts.spreadM) ? opts.spreadM : RADIUS_M
  const { lat, lon } = spreadM > 0
    ? randomPointNear(center.lat, center.lon, spreadM)
    : { lat: center.lat, lon: center.lon }
  const pool = MODEL_POOL[archetype] || []
  const model = pool.length ? pick(pool) : null
  // Flughöhe: echter Flieger (Drache) hoch, Vogel-Modelle niedrig, sonst Boden.
  const altitude = arch.flying ? randInt(30, 80)
                 : (model && FLYING_MODELS.has(model)) ? randInt(8, 25)
                 : archetype === 'diamond' ? 0.6        // leicht schwebend, gut sichtbar
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
  if (opts.onDemand) state.on_demand = true   // vom Spieler angefordert, nicht Teil der Soll-Population
  if (archetype === 'npc')  state.dialogs = sample(DIALOG_LINES, 4)   // Reihe zufälliger Antworten
  if (archetype === 'hint') state.hint   = pick(HINT_LINES)
  if (archetype === 'diamond') { state.stackable = true; state.portable = true }   // einsammel-/stapelbar

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
    if (archetype === 'diamond') {
      spawn.appearance.color = '#8fe3ff'   // Diamant-Cyan (untexturiert → gefärbt)
      spawn.appearance.emoji = '💎'         // 2D-Karten-Symbol
      spawn.appearance.opacity = 0.7        // leicht transparent (3D)
      spawn.appearance.spin = 45            // langsame Y-Rotation (Grad/s, rein kosmetisch)
    }
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
      description: FOLLOW_AREAS
        ? `Automatische Welt-Bevölkerung (Figuren, Hinweise, Items) — folgt deiner Position (Interest-Area), Fallback-Zentrum ${CENTER_LAT.toFixed(3)}, ${CENTER_LON.toFixed(3)}`
        : `Automatische Welt-Bevölkerung (Figuren, Hinweise, Items) im Radius ${RADIUS_M} m um ${CENTER_LAT.toFixed(3)}, ${CENTER_LON.toFixed(3)}`,
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

// Rüstet NPCs eine Antwort-Reihe (state.dialogs) nach, falls sie noch keine
// haben (Altbestand mit nur state.dialog oder ganz ohne) — der Client wählt
// beim „sprechen" zufällig daraus.
async function ensureDialogs(obj) {
  if (obj.state?.archetype !== 'npc') return
  if (Array.isArray(obj.state?.dialogs) && obj.state.dialogs.length) return
  try {
    const next = { ...obj.state, dialogs: sample(DIALOG_LINES, 4) }
    const updated = await ajna.updateObject(obj.id, { state: next })
    obj.state = updated?.state || next
  } catch (err) {
    console.warn(`[director] dialogs für ${obj.id} fehlgeschlagen: ${err?.message || err}`)
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
    // Auf Zuruf erzeugte Objekte stehen bewusst dort, wo jemand hingeklickt hat:
    // NICHT wegen Entfernung despawnen und NICHT zur Soll-Population zählen —
    // sonst spawnt der Director seine eigene Bevölkerung nicht mehr, sobald ein
    // Spieler ein paar Monster gesetzt hat.
    if (obj.state.on_demand === true) { managed.push(obj); continue }
    const dist = haversine(CENTER_LAT, CENTER_LON, obj.lat, obj.lon)
    // Im Interest-Area-Modus NICHT am fixen Zentrum despawnen — das macht
    // reconcile() später relativ zu den aktiven Zentren (Spieler-Positionen).
    if (!KEEP_OUTSIDE && !FOLLOW_AREAS && Number.isFinite(dist) && dist > DESPAWN_RADIUS_M) {
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
async function spawnOne(archetype, center, opts = {}) {
  const data = buildSpawn(archetype, center, opts)
  const obj = await ajna.createObject(data)
  console.log(`[director] + ${archetype.padEnd(6)} "${data.name}" @ ${data.lat.toFixed(5)}, ${data.lon.toFixed(5)} → ${obj.id}`)
  return obj
}

// Boot-Fill nur ohne Interest-Area-Modus — sonst übernimmt reconcile() das
// Auffüllen an den aktiven Zentren (Spieler-Positionen bzw. Fallback-Zentrum).
let spawned = 0
if (!FOLLOW_AREAS) for (const archetype of Object.keys(ARCHETYPES)) {
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
  await ensureDialogs(obj)
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
    busy: false,
    anim: null,
    attendUntil: 0,                       // bis wann die Figur einem Spieler zuhört
    unsubInteract: null
  }
}

// Fliegt das Objekt? Drachen (flying-Archetyp) oder ein Vogel-Modell (FLYING_MODELS).
function isFlyer(obj) {
  if (ARCHETYPES[obj.state?.archetype]?.flying) return true
  const model = (obj.appearance?.gltf || '').split('/').pop()
  return !!(model && FLYING_MODELS.has(model))
}

// Hat das Objekt-Modell eine Idle-Animation (→ darf pausieren)?
function hasIdle(obj) {
  const model = (obj.appearance?.gltf || '').split('/').pop()
  return !!(model && IDLE_MODELS.has(model))
}

// Controller für freies Umherstreifen (Position + Richtung), als Kreis-Areal um
// den Spawn. `flying`=true → Flieger (hoch, Höhenwelle, fly/glide-Animation);
// false → Boden-Tier (Bodenhöhe, walk-Animation). Kein Overpass nötig.
function makeRoamer(obj, flying) {
  const alt = flying
    ? (Number.isFinite(obj.altitude) && obj.altitude > 3 ? obj.altitude : randInt(30, 70))
    : (Number.isFinite(obj.altitude) ? obj.altitude : 0)
  return {
    id: obj.id,
    archetype: obj.state?.archetype,
    kind: 'roam',
    flying,
    lat: obj.lat, lon: obj.lon,
    homeLat: obj.lat, homeLon: obj.lon,
    areaR: flying ? FLY_AREA_M : ROAM_AREA_M,
    heading: Math.random() * Math.PI * 2,
    speed: flying ? FLY_SPEED : ROAM_SPEED,
    altBase: alt,
    altPhase: Math.random() * Math.PI * 2,
    anim: null,
    // Pausen nur für Boden-Tiere mit Idle-Animation.
    canPause: !flying && hasIdle(obj),
    paused: false,
    phaseUntil: Date.now() + randInt(ROAM_MOVE_MIN, ROAM_MOVE_MAX) * 1000,
    lastTickAt: Date.now(),
    busy: false,
    attendUntil: 0,                       // bis wann die Figur einem Spieler zuhört
    unsubInteract: null,
    // „Rufen": solange gesetzt, steuert advanceSummon() das Wesen allein.
    summon: null,
    altCruise: alt                        // Reiseflughöhe, auf die er nach dem Ruf zurückkehrt
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

    // Angesprochen? Stehenbleiben — der Weg bleibt erhalten und wird danach
    // fortgesetzt (kein Neuplanen, die Figur läuft einfach weiter).
    if (now < (c.attendUntil || 0)) {
      if (c.anim !== 'idle') { c.anim = 'idle'; await ajna.setAnimation(c.id, 'idle') }
      return
    }
    if (c.anim === 'idle' && c.fsm === 'walking') { c.anim = 'walk'; await ajna.setAnimation(c.id, 'walk') }

    const step = stepAlongPath(c.path, c.cursor, c.speed * dt)
    c.lat = step.lat; c.lon = step.lon
    c.cursor = { segIdx: step.segIdx, segT: step.segT }
    await ajna.updateObject(c.id, {
      lat: c.lat, lon: c.lon,
      rotation: { x: 0, y: HEADING_TO_YAW(step.headingRad), z: 0 }
    })
    if (step.done) {
      const pauseMs = PAUSE_MS + randInt(0, 15) * 1000   // 10–25 s, gestreut (nicht im Gleichschritt)
      c.fsm = 'idle'; c.path = null; c.nextPlanAt = now + pauseMs
      await ajna.setAnimation(c.id, 'idle')
      await ajna.updateObject(c.id, { state: { ...c.baseState } })   // walk_path entfernen
      console.log(`[director] ⏸ ${c.archetype} "${c.id}" angekommen — Pause ${(pauseMs / 1000) | 0} s`)
    }
  } catch (err) {
    console.warn(`[director] tick "${c.id}" fehlgeschlagen: ${err?.message || err}`)
    c.fsm = 'idle'; c.nextPlanAt = Date.now() + PLAN_RETRY_MS
  } finally { c.busy = false }
}

// Ein Tick freien Flugs: Wander + Randlenkung Richtung Zentrum (mit der Distanz
// stärker), begrenzte Drehrate → weiche Kurven statt 180°-Sprung am Rand.
// Landeplatz suchen: Gebäude in der Nähe holen (für „nicht im Haus landen" und
// die Dach-Kür). Fällt die Geo-Abfrage aus, landet er eben ohne Gebäudewissen —
// besser ein Landeplatz auf freiem Feld als gar keine Landung.
async function pickLandingSpot(c, s) {
  let buildings = []
  try {
    const res = await geo.buildingsNear(s.lat, s.lon, CALL_BUILDING_R, 'all')
    buildings = Array.isArray(res?.features) ? res.features : []
  } catch (err) {
    console.warn(`[director] Gebäude-Abfrage für Landung fehlgeschlagen: ${err?.message || err}`)
  }
  const spot = findLandingSpot({
    lat: s.lat, lon: s.lon, buildings,
    minM: CALL_LAND_MIN_M, maxM: CALL_LAND_MAX_M
  })
  if (spot) {
    console.log(`[director] 🐉 "${c.id}" landet ${spot.kind === 'roof' ? 'auf einem Dach' : 'am Boden'} — ${Math.round(spot.distance)} m vom Spieler, Höhe ${Math.round(spot.altitude)} m`)
  }
  return spot
}

// Ruf-Sequenz. Übernimmt die Steuerung vollständig, solange c.summon gesetzt ist
// — DESHALB gehört das in den Director und nicht in einen zweiten Agent: es gibt
// genau einen Schreiber pro Wesen, sonst zappelt das Objekt zwischen beiden.
async function advanceSummon(c, dt, now) {
  const s = c.summon
  const dist = haversine(c.lat, c.lon, s.lat, s.lon)

  // Gemeinsam: Kurs aufs Ziel mit begrenzter Drehrate (weiche Kurven wie sonst).
  const steerTo = (tLat, tLon, speed) => {
    const desired = bearingRad(c.lat, c.lon, tLat, tLon)
    const maxTurn = FLY_TURN_RATE * dt
    const turn = clamp(angleDiff(desired, c.heading), -maxTurn, maxTurn)
    c.heading = wrapPi(c.heading + turn)
    const p = destPoint(c.lat, c.lon, c.heading, speed * dt)
    c.lat = p.lat; c.lon = p.lon
    return turn / (maxTurn || 1)
  }
  // Höhe sanft auf einen Zielwert ziehen (kein Teleport).
  const approachAlt = (target) => {
    const step = CALL_DESCENT_SPEED * dt
    if (c.altBase < target) c.altBase = Math.min(target, c.altBase + step)
    else c.altBase = Math.max(target, c.altBase - step)
    return Math.abs(c.altBase - target) < 0.5
  }

  let turnRatio = 0, anim = 'fly'

  switch (s.phase) {
    case 'inbound': {
      turnRatio = steerTo(s.lat, s.lon, CALL_APPROACH_SPEED)
      approachAlt(CALL_CIRCLE_ALT)          // schon im Anflug sinken
      anim = 'fly'
      if (dist <= CALL_CIRCLE_R * 1.4) {
        s.phase = 'circling'
        s.until = now + CALL_CIRCLE_S * 1000
        console.log(`[director] 🐉 "${c.id}" kreist über dem Spieler`)
      }
      break
    }
    case 'circling': {
      // Auf einer Kreisbahn um den Spieler fliegen: Zielpunkt wandert über den
      // Kreis, der Drache jagt ihm hinterher → saubere Kurve statt Zickzack.
      s.circleAngle = wrapPi(s.circleAngle + (CALL_APPROACH_SPEED / CALL_CIRCLE_R) * dt * 0.6)
      const t = destPoint(s.lat, s.lon, s.circleAngle, CALL_CIRCLE_R)
      turnRatio = steerTo(t.lat, t.lon, CALL_APPROACH_SPEED * 0.8)
      approachAlt(CALL_CIRCLE_ALT)
      anim = 'fly'
      if (now >= s.until) {
        s.spot = await pickLandingSpot(c, s)
        if (!s.spot) {                       // nirgends Platz → Ruf abbrechen
          console.warn(`[director] 🐉 "${c.id}" findet keinen Landeplatz → zurück zur Routine`)
          c.summon = null
          return
        }
        s.phase = 'landing'
      }
      break
    }
    case 'landing': {
      const dSpot = haversine(c.lat, c.lon, s.spot.lat, s.spot.lon)
      turnRatio = steerTo(s.spot.lat, s.spot.lon, Math.max(2.5, CALL_APPROACH_SPEED * 0.4))
      // Gleitpfad: Zielhöhe proportional zur Restdistanz. Ohne das sinkt er mit
      // fester Rate — und ist auf Bodenhöhe, während er noch Dutzende Meter
      // entfernt ist, sodass er flach über den Boden zum Spieler schrammt (was
      // wie tiefes Gleiten aussieht). So sinkt er STETIG auf den Platz zu.
      approachAlt(s.spot.altitude + Math.min(CALL_CIRCLE_ALT, dSpot * 0.5))
      anim = 'fly'
      if (dSpot < 2.5) {
        // Aufsetzen — der einzige Tick, in dem der Endzustand geschrieben wird,
        // darum EXPLIZIT und in EINEM atomaren Update:
        //   • exakt auf den Platz (nicht 2 m daneben schweben),
        //   • Blick ZUM SPIELER (nicht in die Anflugrichtung),
        //   • animation_state 'idle' (der Drache hat einen echten Idle-Clip;
        //     ohne diese Zeile behielt er den letzten Flug-Clip),
        //   • z:0 — keine Flug-Schräglage mehr am Boden.
        // Ab hier schreibt der 'landed'-Zustand NICHTS mehr → der Spieler kann
        // um ihn herumlaufen, ohne dass er sich mitdreht.
        c.lat = s.spot.lat; c.lon = s.spot.lon; c.altBase = s.spot.altitude
        c.heading = bearingRad(s.spot.lat, s.spot.lon, s.lat, s.lon)
        c.anim = 'idle'
        await ajna.updateObject(c.id, {
          lat: c.lat, lon: c.lon, altitude: c.altBase,
          animation_state: 'idle',
          rotation: { x: 0, y: wrapPi(Math.PI - c.heading + FLY_YAW_OFFSET), z: 0 }
        })
        s.phase = 'landed'
        s.until = now + CALL_STAY_S * 1000
        console.log(`[director] 🐉 "${c.id}" gelandet, zum Spieler gewandt — bleibt ${CALL_STAY_S} s`)
        return
      }
      break
    }
    case 'landed': {
      // Steht still — bewusst NICHTS schreiben: 2 min lang jeden Tick dieselbe
      // Position zu senden wäre Last, und ein Rotations-Update ließe ihn dem
      // umherlaufenden Spieler nachdrehen. Idle + Ausrichtung stehen aus dem
      // Aufsetz-Tick. Nur nachziehen, falls ein fremdes Update dazwischenkam.
      if (c.anim !== 'idle') { c.anim = 'idle'; await ajna.setAnimation(c.id, 'idle') }
      if (now >= s.until) {
        s.phase = 'takeoff'
        console.log(`[director] 🐉 "${c.id}" hebt wieder ab`)
      }
      return
    }
    case 'takeoff': {
      // Steigen und dabei schon wieder Fahrt aufnehmen.
      const p = destPoint(c.lat, c.lon, c.heading, CALL_APPROACH_SPEED * 0.5 * dt)
      c.lat = p.lat; c.lon = p.lon
      const cruise = c.altCruise || 40
      anim = 'fly'
      if (approachAlt(cruise)) {
        // Zurück zur Routine — und zwar HIER als neues Revier, sonst zieht ihn
        // die Randlenkung sofort quer über die Karte zum alten Spawn zurück.
        c.homeLat = c.lat; c.homeLon = c.lon
        c.summon = null
        c.anim = null                        // nächster Roam-Tick setzt die Animation neu
        console.log(`[director] 🐉 "${c.id}" nimmt die Routine wieder auf`)
        return
      }
      break
    }
  }

  if (anim !== c.anim) { c.anim = anim; await ajna.setAnimation(c.id, anim) }
  await ajna.updateObject(c.id, {
    lat: c.lat, lon: c.lon, altitude: c.altBase,
    rotation: { x: 0, y: wrapPi(Math.PI - c.heading + FLY_YAW_OFFSET), z: clamp(turnRatio, -1, 1) * FLY_BANK_MAX }
  })
}

async function advanceRoamer(c) {
  c.busy = true
  try {
    const now = Date.now()
    const dt = Math.min(1, (now - c.lastTickAt) / 1000)
    c.lastTickAt = now

    // Gerufen? Dann hat die Ruf-Sequenz die alleinige Kontrolle.
    if (c.summon) { await advanceSummon(c, dt, now); return }

    // Angesprochen? Dann stehenbleiben und zuhören — Vorrang vor allem anderen.
    // Nur Bodenfiguren: ein Flieger würde sonst mitten in der Luft einfrieren
    // (und hat gar keine Idle-Animation).
    if (!c.flying && now < (c.attendUntil || 0)) {
      if (c.anim !== 'idle') { c.anim = 'idle'; await ajna.setAnimation(c.id, 'idle') }
      c.phaseUntil = c.attendUntil          // danach frisch entscheiden
      return
    }

    // Streif-/Rast-Rhythmus (nur idle-fähige Boden-Tiere): Phase abwechseln.
    if (c.canPause && now >= c.phaseUntil) {
      c.paused = !c.paused
      const [lo, hi] = c.paused ? [ROAM_REST_MIN, ROAM_REST_MAX] : [ROAM_MOVE_MIN, ROAM_MOVE_MAX]
      c.phaseUntil = now + randInt(lo, hi) * 1000
      const wantAnim = c.paused ? 'idle' : 'walk'
      if (wantAnim !== c.anim) { c.anim = wantAnim; await ajna.setAnimation(c.id, wantAnim) }
      if (c.paused) console.log(`[director] ⏸ ${c.archetype} "${c.id}" rastet`)
    }
    if (c.paused) return   // steht still (idle) — keine Positions-/Rotations-Updates (spart Last)

    // Wunschrichtung: aktuelle Richtung + sanftes zufälliges Wandern.
    let desired = c.heading + (Math.random() - 0.5) * FLY_WANDER * dt * 2

    // Randlenkung: ab halbem Radius Richtung Zentrum blenden, am Rand voll.
    const dHome = haversine(c.lat, c.lon, c.homeLat, c.homeLon)
    const edge = clamp((dHome - c.areaR * 0.5) / (c.areaR * 0.5), 0, 1)
    if (edge > 0) {
      const toHome = bearingRad(c.lat, c.lon, c.homeLat, c.homeLon)
      desired = c.heading + angleDiff(toHome, c.heading) * edge
    }

    // Drehrate begrenzen → immer weiche Kurve (Wenderadius = speed / turnRate).
    const maxTurn = FLY_TURN_RATE * dt
    const turn = clamp(angleDiff(desired, c.heading), -maxTurn, maxTurn)
    c.heading = wrapPi(c.heading + turn)

    // Vorwärts.
    const p = destPoint(c.lat, c.lon, c.heading, c.speed * dt)
    c.lat = p.lat; c.lon = p.lon

    let altitude, wantAnim, yaw, roll = 0
    if (c.flying) {
      c.altPhase = wrapPi(c.altPhase + dt * 0.3)
      altitude = Math.max(6, c.altBase + Math.sin(c.altPhase) * 6)   // sanfte Höhenwelle
      // Kräftige Kurve/nah am Rand → flap (FlapFlight), sonst gleiten (GlideFlight).
      wantAnim = (Math.abs(turn) > maxTurn * 0.5 || edge > 0.5) ? 'fly' : 'glide'
      // Yaw = echte Bewegungsrichtung als Babylon-Root-Yaw. Wegen invertNorthSouth
      // (Nord=-Z) ist das π − heading (fixt die Kurven-Handedness; die alte Formel
      // h−π/2 lief mit falscher Drehrichtung). Banking: proportional zur Drehrate
      // in die Kurve rollen.
      yaw = wrapPi(Math.PI - c.heading + FLY_YAW_OFFSET)
      roll = clamp(turn / maxTurn, -1, 1) * FLY_BANK_MAX
    } else {
      altitude = c.altBase                // Boden-Tier bleibt auf seiner Höhe
      wantAnim = 'walk'
      yaw = HEADING_TO_YAW(c.heading)     // Boden/NPC-Konvention unverändert
    }
    if (wantAnim !== c.anim) { c.anim = wantAnim; await ajna.setAnimation(c.id, wantAnim) }

    await ajna.updateObject(c.id, {
      lat: c.lat, lon: c.lon, altitude,
      rotation: { x: 0, y: yaw, z: roll }
    })
  } catch (err) {
    console.warn(`[director] Roam "${c.id}" fehlgeschlagen: ${err?.message || err}`)
  } finally { c.busy = false }
}

function tick() {
  const now = Date.now()
  for (const c of controllers) {
    if (c.busy) continue
    if (c.kind === 'roam') { advanceRoamer(c); continue }
    if (c.fsm === 'walking') advanceFor(c)
    else if (c.fsm === 'idle' && now >= c.nextPlanAt) planFor(c)
  }
}

// Passenden Controller für ein Objekt: Flieger → Freiflug, Boden-Tier → freies
// Umherstreifen, Straßen-Archetyp (npc/enemy) → Wegenetz, sonst keiner (statisch:
// item/hint/diamond). `mode` nur fürs Logging.
function controllerFor(obj) {
  if (isFlyer(obj)) return makeRoamer(obj, true)
  if (obj.state?.archetype === 'animal') return makeRoamer(obj, false)   // Fox/Horse: freies Streifen
  if (STREET_ARCHETYPES.has(obj.state?.archetype)) return makeController(obj)
  return null
}
function controllerMode(c) {
  return c.kind === 'roam' ? (c.flying ? 'flug' : 'streift') : 'straße'
}

// Controller-Liste an `managed` angleichen: bestehende behalten (Zustand!),
// neue anlegen, entfernte fallen weg. Idempotent — von reconcile() gerufen.
let controllers = []
// Auf Interaktionen mit DIESER Figur hören. Der interact-Hook broadcastet
// ephemer ({action, source, ts}) — der Kanal lag bisher brach. Fire-and-forget:
// scheitert das Abo, läuft die Figur einfach ohne Reaktion weiter.
function attachInteractListener(c) {
  ajna.onInteract(c.id, (evt) => {
    const action = evt?.action
    if (!action || action === 'examine') return   // Untersuchen ist passiv — keine Reaktion

    // „Rufen": der Spieler hat eine Position mitgeschickt → Anflug starten.
    if (action === 'call' && c.flying) { startSummon(c, evt); return }

    c.attendUntil = Date.now() + ATTEND_MS
    console.log(`[director] 👂 "${c.id}" hält inne (${action})`)
  }).then(unsub => { c.unsubInteract = unsub })
    .catch(err => console.warn(`[director] interact-Abo (${c.id}): ${err?.message || err}`))
}

// Ruf annehmen: Ziel merken, FSM auf Anflug stellen. Ohne brauchbare Position
// passiert NICHTS — lieber ignorieren als planlos irgendwohin fliegen.
function startSummon(c, evt) {
  const at = evt?.payload?.at
  const lat = Number(at?.lat), lon = Number(at?.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.warn(`[director] 📣 Ruf an "${c.id}" ohne Position — ignoriert`)
    return
  }
  const d = haversine(c.lat, c.lon, lat, lon)
  if (d > CALL_MAX_RANGE_M) {
    console.log(`[director] 📣 Ruf an "${c.id}" ignoriert — ${Math.round(d)} m entfernt (max ${CALL_MAX_RANGE_M})`)
    return
  }
  c.summon = {
    phase: 'inbound',
    lat, lon,
    precise: at?.precise === true,
    until: 0,
    spot: null,
    circleAngle: Math.random() * Math.PI * 2
  }
  c.attendUntil = 0            // Ruf hat Vorrang vor „innehalten"
  console.log(`[director] 📣 "${c.id}" wurde gerufen — ${Math.round(d)} m entfernt, ${at?.precise ? 'exakte' : 'ungefähre'} Position`)
}

function syncControllers() {
  if (!AUTONOMY) { controllers = []; return }
  const keep = new Map(controllers.map(c => [c.id, c]))
  const next = []
  const added = []
  managed.forEach((obj, i) => {
    if (keep.has(obj.id)) { next.push(keep.get(obj.id)); return }
    const c = controllerFor(obj)
    if (c) { c.nextPlanAt = Date.now() + i * 200; next.push(c); added.push(c) }   // Planung staffeln
  })
  // Abos der entfallenen Figuren lösen, sonst sammeln sich Realtime-Subscriptions an.
  for (const c of keep.values()) {
    if (!next.includes(c) && c.unsubInteract) {
      try { c.unsubInteract() } catch { /* schon weg */ }
      c.unsubInteract = null
    }
  }
  controllers = next
  for (const c of added) attachInteractListener(c)
  if (added.length) {
    const byMode = {}
    for (const c of added) { const m = controllerMode(c); byMode[m] = (byMode[m] || 0) + 1 }
    const summary = Object.entries(byMode).map(([m, n]) => `${n}× ${m}`).join(', ')
    const statisch = managed.length - controllers.length
    console.log(`[director] → +${added.length} angesteuert (${summary})${statisch ? `, ${statisch} statisch` : ''} · ${controllers.length} aktiv`)
  }
}
syncControllers()

if (AUTONOMY) {
  console.log(`[director] Autonomie aktiv für ${controllers.length} Figur(en) (Tick ${TICK_MS} ms, Pause ${(PAUSE_MS / 1000) | 0} s)`)
  setInterval(tick, TICK_MS)
} else {
  console.log(`[director] keine autonomen Figuren (AUTONOMY off)`)
}

// ─────────────────────────────────────────────────────────────────────────
//  Interest-Area-Reconcile: Welt an aktiven Zentren (Spieler / Fallback) halten
// ─────────────────────────────────────────────────────────────────────────
const bboxCenter = b => ({ lat: (b.latMin + b.latMax) / 2, lon: (b.lonMin + b.lonMax) / 2 })
const nearAny = (lat, lon, centers, r) => centers.some(c => haversine(c.lat, c.lon, lat, lon) <= r)

// Aktive Zentren: gemergte Interessensbereiche (folgt echtem GPS der Spieler),
// sonst das konfigurierte Fallback-Zentrum.
async function fetchCenters() {
  try {
    const areas = await ajna.fetchInterestAreas(WD_SOURCE || undefined)   // liefert das Array direkt
    const centers = (Array.isArray(areas) ? areas : []).map(bboxCenter)
    if (centers.length) return centers
  } catch (err) {
    console.warn(`[director] interest-areas nicht abrufbar: ${err?.message || err}`)
  }
  return [{ lat: CENTER_LAT, lon: CENTER_LON }]
}

let reconcileBusy = false
let _lastCentersKey = null
async function reconcile() {
  if (reconcileBusy) return
  reconcileBusy = true
  try {
    const centers = await fetchCenters()
    // Bereichs-Übergang protokollieren (nur bei Änderung — kein Spam).
    const centersKey = centers.map(c => `${c.lat.toFixed(4)},${c.lon.toFixed(4)}`).sort().join(' | ')
    if (centersKey !== _lastCentersKey) {
      const isFallback = centers.length === 1 &&
        Math.abs(centers[0].lat - CENTER_LAT) < 1e-4 && Math.abs(centers[0].lon - CENTER_LON) < 1e-4
      console.log(`[director] ⇄ Interessensbereich${centers.length > 1 ? 'e' : ''}: ${centers.length} @ [${centersKey}]${isFallback ? ' (Fallback-Zentrum — keine aktiven Spieler)' : ''}`)
      _lastCentersKey = centersKey
    }
    // 1) Despawn: verwaltete Objekte weit von ALLEN aktiven Zentren.
    let removed = 0
    if (!KEEP_OUTSIDE) {
      for (const obj of [...managed]) {
        // Auf Zuruf gesetzte Objekte NICHT despawnen: sie stehen genau dort, wo
        // ein Spieler hingeklickt hat — auch wenn das weit außerhalb der gerade
        // aktiven Interessensbereiche liegt. (Ohne diese Ausnahme löschte der
        // nächste Reconcile sie Sekunden nach dem Erzeugen wieder.)
        if (obj.state?.on_demand === true) continue
        if (nearAny(obj.lat, obj.lon, centers, DESPAWN_RADIUS_M)) continue
        try {
          await ajna.deleteObject(obj.id)
          const i = managed.indexOf(obj); if (i >= 0) managed.splice(i, 1)
          removed++
        } catch (err) {
          // Schon serverseitig weg (404) → nur lokal aus managed entfernen, kein
          // Fehler (sonst würde derselbe Zombie jeden Reconcile erneut scheitern).
          const i = managed.indexOf(obj); if (i >= 0) managed.splice(i, 1)
          if (!/(not|wasn.?t)\s*found|404/i.test(err?.message || '')) {
            console.warn(`[director] despawn ${obj.id}: ${err?.message || err}`)
          } else { removed++ }
        }
      }
    }
    // 2) Spawn: pro Zentrum bis zum Soll-Bestand auffüllen.
    let added = 0
    for (const center of centers) {
      for (const archetype of Object.keys(ARCHETYPES)) {
        // Auf Zuruf gesetzte Objekte zählen NICHT zum Soll-Bestand — sonst hört
        // der Director auf, seine eigene Bevölkerung zu spawnen, sobald ein
        // Spieler ein paar Monster gesetzt hat.
        const have = managed.filter(o => o.state?.archetype === archetype &&
          o.state?.on_demand !== true &&
          haversine(center.lat, center.lon, o.lat, o.lon) <= RADIUS_M).length
        for (let i = have; i < targetCount(archetype); i++) {
          try {
            const obj = await spawnOne(archetype, center)
            managed.push(obj); added++
            await ensureAce(obj.id, actionKeys(archetype))
            await ensureActions(obj); await ensureDescription(obj); await ensureDialogs(obj)
          } catch (err) { console.warn(`[director] spawn ${archetype}: ${err?.message || err}`) }
        }
      }
    }
    if (added || removed) {
      syncControllers()
      console.log(`[director] reconcile @ ${centers.length} Zentrum/Zentren: +${added} / -${removed} (Bestand ${managed.length})`)
    }
  } finally { reconcileBusy = false }
}

if (FOLLOW_AREAS && AUTONOMY) {
  console.log(`[director] folgt Interest-Areas (Quelle "${WD_SOURCE || '*'}", alle ${(RECONCILE_MS / 1000) | 0} s; Fallback-Zentrum ${CENTER_LAT.toFixed(4)}, ${CENTER_LON.toFixed(4)})`)
  reconcile()
  setInterval(() => { reconcile() }, RECONCILE_MS)
}

// ─── Spawn auf Zuruf ─────────────────────────────────────────────────────
// Der Spieler klickt auf eine Stelle am Boden und wählt „Monster hier erzeugen".
// Der Client schickt Archetyp + geklickte Position über den objektlosen
// Agent-Kanal; der Director legt das Objekt SELBST an.
//
// WARUM der Umweg über den Agent: legte der Client das Objekt an, gehörte es dem
// Spieler — und der Director dürfte es gar nicht bewegen (updateRule verlangt
// owner oder edit) und würde es mangels `state.director` auch nie adoptieren.
// So gehört es ihm, trägt die richtigen Flags und bekommt seine ACE.
//
// Der Kanal ist reiner Transport: JEDER angemeldete Nutzer kann senden. Also
// wird HIER validiert und gedrosselt.
const CMD_COOLDOWN_MS = parseFloat(process.env.WD_CMD_COOLDOWN_S || '3') * 1000
const CMD_MAX_ON_DEMAND = parseInt(process.env.WD_CMD_MAX || '40', 10)
const SPAWNABLE = new Set(Object.keys(ARCHETYPES))
const lastCommandAt = new Map()   // userId → ts (Cooldown pro Nutzer)

function countOnDemand() {
  return managed.filter(o => o?.state?.on_demand === true).length
}

// ─── Wer darf auf Zuruf spawnen? ─────────────────────────────────────────
// EINE Stelle für diese Entscheidung. Heute nur Drosselung: jeder Angemeldete
// darf, aber nicht beliebig oft. Später soll die Fähigkeit an ein Spieler-Level
// oder ein legitimierendes Item gebunden werden — beides gehört HIER hinein,
// damit der Aufrufer unverändert bleibt und keine zweite Prüfstelle entsteht.
//
// VORBEREITET, BEWUSST NICHT GEBAUT (noch nicht benötigt) — was jeweils fehlt:
//
//   • LEVEL: `users` hat heute KEIN Level-/XP-Feld (id, email, name,
//     default_permissions, …). Ein Level-Gate braucht also zuerst ein Feld im
//     Schema und eine Stelle, die es hochzählt. Danach hier ein Vergleich gegen
//     einen Schwellwert (z. B. WD_SPAWN_MIN_LEVEL) → reason: 'level'.
//
//   • ITEM: Besitz läuft über `carried_by` am Objekt. ACHTUNG, der eigentliche
//     Knackpunkt: beim Einsammeln geht das EIGENTUM an den Sammler über, und die
//     listRule zeigt einem Nutzer nur, was ihm gehört oder wofür er `view` hat.
//     Der Director kann das getragene Item eines Spielers also gar nicht sehen —
//     eine Agent-seitige Abfrage liefe ins Leere. Ein Item-Gate braucht darum
//     eine SERVERSEITIGE Prüfung (PB-Hook-Route, die mit Admin-Sicht bzw. im
//     Namen des Spielers prüft, ob er ein Objekt mit einem Marker wie
//     state.grants ~ "spawn" trägt) — analog zu resolveEffective im
//     interact-Hook. → reason: 'item'.
//
// `reason` ist schon vorgesehen, damit eine Ablehnung dem Spieler später
// gemeldet werden kann, statt still zu verpuffen (heute: nur Log).
async function maySpawnOnDemand(userId) {
  const now = Date.now()
  const last = lastCommandAt.get(userId) || 0
  if (now - last < CMD_COOLDOWN_MS) return { ok: false, reason: 'cooldown' }
  if (countOnDemand() >= CMD_MAX_ON_DEMAND) return { ok: false, reason: 'limit' }
  return { ok: true }
}

const SPAWN_DENIED_TEXT = {
  cooldown: 'zu schnell hintereinander',
  limit: `Obergrenze von ${CMD_MAX_ON_DEMAND} Objekten auf Zuruf erreicht`,
  level: 'Spieler-Level zu niedrig',
  item: 'kein legitimierendes Item im Inventar',
}

async function handleSpawnCommand(evt) {
  const p = evt?.payload || {}
  const who = evt?.source || '?'

  let archetype = String(p.archetype || '').toLowerCase()
  if (archetype === 'random' || !archetype) archetype = pick(Array.from(SPAWNABLE))
  if (!SPAWNABLE.has(archetype)) {
    console.warn(`[director] Spawn-Kommando: unbekannter Archetyp "${p.archetype}"`)
    return
  }
  const lat = Number(p.at?.lat), lon = Number(p.at?.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.warn('[director] Spawn-Kommando ohne gültige Position — ignoriert')
    return
  }

  const allowed = await maySpawnOnDemand(who)
  if (!allowed.ok) {
    console.log(`[director] Spawn-Kommando von ${who} abgelehnt — ${SPAWN_DENIED_TEXT[allowed.reason] || allowed.reason}`)
    return
  }
  lastCommandAt.set(who, Date.now())

  try {
    const obj = await spawnOne(archetype, { lat, lon }, { spreadM: 0, onDemand: true })
    await ensureAce(obj.id, actionKeys(archetype))
    managed.push(obj)
    syncControllers()          // bewegliche Archetypen bekommen sofort einen Controller
    console.log(`[director] 🎲 "${archetype}" auf Zuruf erzeugt (${who}) @ ${lat.toFixed(5)}, ${lon.toFixed(5)}`)
  } catch (err) {
    console.warn(`[director] Spawn auf Zuruf fehlgeschlagen: ${err?.message || err}`)
  }
}

ajna.onAgentCommand(WD_SOURCE || 'world-director', (evt) => {
  if (evt?.command === 'spawn') handleSpawnCommand(evt)
  else console.log(`[director] unbekanntes Kommando "${evt?.command}" — ignoriert`)
}).then(() => console.log(`[director] hört auf Kommandos (agent:${WD_SOURCE || 'world-director'}) · Cooldown ${CMD_COOLDOWN_MS / 1000} s, max ${CMD_MAX_ON_DEMAND} Objekte auf Zuruf`))
  .catch(err => console.warn(`[director] Kommando-Abo fehlgeschlagen: ${err?.message || err}`))

// ─── Heartbeat hält den Prozess am Leben (+ späterer Online-Status-Anker) ─
setInterval(() => { publishManifest() }, HEARTBEAT_MS)
console.log('[director] bereit. (Strg+C zum Beenden)')

process.on('SIGINT',  () => { console.log('\n[director] SIGINT — exit'); process.exit(0) })
process.on('SIGTERM', () => { console.log('[director] SIGTERM — exit'); process.exit(0) })
