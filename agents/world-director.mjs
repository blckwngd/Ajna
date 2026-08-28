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

import { randomUUID } from 'node:crypto'
import { bootAgent, die, envNum, envStr, commandAllowed, mitDelegierten } from './lib/agent-base.mjs'
import { MODEL_PROFILES, profileFor, modelOf, profileAppearance } from './world-director.profiles.mjs'
import { AjnaGeo } from '../client/core/AjnaGeo.js'
import { findLandingSpot } from './lib/landing-spots.mjs'
import { stepAlongPath, buildWayGraph, nearestNodeKey, randomReachableTarget, shortestPath, haversine, bearingRad } from '../client/core/StreetNav.js'
import { animalNameFor } from '../client/core/animalNames.js'

import { simpleSetup } from './lib/setup-wizard.mjs'
import { Bewegungsplan, bewegungsUpdate } from './lib/bewegung.mjs'
import { yawFuerKurs } from '../client/core/yaw.js'
import { Kampf, hpVon, beuteObjekt } from './lib/kampf.mjs'
import { npcParley } from './lib/dialogs.mjs'
import { dialogNameFor, dialogVarsFor, talkSessionId } from '../client/core/Parley.js'

// Login + geschichtete .env (Env > agents/.env.director > Root-.env) + System-CA.
// Die WD_*-Konstanten unten lesen process.env erst NACH diesem await — die
// Schichten sind dann geladen.
const { ajna } = await bootAgent('director', {
  tag: 'director',
  setup: simpleSetup('director', { required: ['AJNA_USER', 'AJNA_PASS'], optional: ['AJNA_URL'] }),
})

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
// ACHTUNG — UNGEKLÄRTER WIDERSPRUCH (gefunden 2026-08-14, nicht behoben):
// Eingang ist ein Kompass-Bearing (0 = Nord, im Uhrzeigersinn) aus
// StreetNav.bearingRad. Die Fahrzeug-Bridges rechnen aus DEMSELBEN
// Eingangsformat aber `bearing - π/2` (adsb-bridge, ais-bridge, jeweils
// `degToYaw`) — das sind 90° Unterschied auf demselben Feld `rotation.y`.
// Ein Schiff und eine Figur auf gleichem Kurs zeigen also unterschiedlich.
// Benign wäre das nur, wenn die GLB-Modelle verschiedene Vorderachsen haben;
// das ist NICHT geprüft. Auflösen heißt: beide Fälle nebeneinander in der
// Szene ansehen, die richtige Konvention festlegen, dann vereinheitlichen
// und in docs/world-objects.md dokumentieren.
// Kompasskurs → Babylon-Yaw. Die Umrechnung liegt in client/core/yaw.js, weil
// sie eine RENDER-Konvention ist: Der Client legt fest, wie er zeichnet. Hier
// stand sie früher zweimal (Boden und Flug) und in den Fahrzeug-Brücken ein
// drittes Mal — 90 Grad daneben. Siehe dort für die Herleitung.
const HEADING_TO_YAW = h => yawFuerKurs(h)

// Kompass-Kurs in Grad, wie ihn `state.motion` erwartet. `c.heading` liegt im
// Bogenmaß vor (bearingRad: 0 = Nord, im Uhrzeigersinn) — dieselbe Konvention,
// nur andere Einheit.
const KURS_GRAD = h => ((h * 180 / Math.PI) % 360 + 360) % 360

// Plan je Figur. Statt bei JEDEM Tick eine Position zu schreiben, wird der
// Bewegungsplan veröffentlicht (`state.motion`) und der Betrachter rechnet
// frameweise voraus. Geschrieben wird nur noch an Knicken, bei Tempowechsel,
// beim Anhalten/Losgehen, bei Abweichung und als Lebenszeichen.
// Siehe agents/lib/bewegung.mjs — dort steht auch, warum der Knick der
// entscheidende Auslöser ist.
/**
 * Animationswechsel melden, OHNE auf die Antwort zu warten.
 *
 * `await ajna.setAnimation(...)` steckte mitten in der Bewegungsschleife. Ein
 * Netzaufruf pro Zustandswechsel, und solange er lief, stand der Tick DIESER
 * Figur still (`busy`). Beim Ruf an einen Wyvern fallen mehrere Wechsel kurz
 * hintereinander an — sichtbar als sekundenlang eingefrorene Figur.
 *
 * Ein verlorener Animationswechsel ist verschmerzbar: Der nächste Wechsel holt
 * ihn ein. Eine stehende Figur ist es nicht.
 */
function setzeAnim(c, wert) {
  if (c.anim === wert) return
  c.anim = wert
  c.animOffen = true      // wird mit dem nächsten Schreibvorgang mitgeschickt
}

/**
 * Offenen Animationswechsel schreiben, wenn sonst nichts zu schreiben war.
 *
 * Für Figuren, die gerade stehen (Pause, Gespräch): Dort blockiert das Warten
 * niemanden, weil sie sich ohnehin nicht bewegen.
 */
async function schreibeAnimFalls(c) {
  if (!c.animOffen) return
  c.animOffen = false
  try { await ajna.setAnimation(c.id, c.anim) }
  catch (err) { console.warn(`[director] Animation "${c.id}": ${err?.message || err}`) }
}

const planFuer = (c) => {
  if (c._plan) return c._plan
  // FLIEGER BEKOMMEN GRÖSSEREN SPIELRAUM. Sie drehen laufend (Randlenkung,
  // Höhenwelle, Kreisen), und jede dieser Drehungen ist für sich winzig — mit
  // der Fußgänger-Schwelle schrieben sie fast im Tick-Takt.
  //
  // Der Unterschied ist nicht Bequemlichkeit, sondern Sache: Eine Figur auf der
  // Straße MUSS die Polylinie genau treffen, sonst läuft sie durch ein Haus.
  // Ein Vogel im freien Luftraum darf eine Kurve etwas abkürzen — dort steht
  // nichts im Weg, und aus der Entfernung, in der man ihn sieht, ist es
  // ohnehin nicht zu erkennen.
  const flieger = !!c.flying
  c._plan = new Bewegungsplan(flieger
    ? { kursSchwelleGrad: 18, driftM: 15 }
    : { kursSchwelleGrad: 8, driftM: 4 })
  return c._plan
}

/**
 * Bewegungs-Update schreiben — oder eben nicht.
 *
 * Rotation gehört mit ins Update und nicht separat: Zwischen zwei Knicken
 * ändert sich der Blickwinkel nicht, und ein eigener Schreibvorgang dafür
 * würde die Ersparnis gerade wieder auffressen.
 */
async function schreibeBewegung(c, { lat, lon, altitude, v, trk, vrate = 0, rotation, state }) {
  // `state` NUR mitschreiben, wenn eine Grundlage da ist. Ein leeres Objekt
  // als Rückfall ersetzt den kompletten Zustand des Objekts — genau so gingen
  // die Aktionen der Drachen verloren. Ohne Grundlage lieber nur die Position
  // schreiben und den Plan diesmal auslassen; der nächste Durchgang mit
  // Grundlage holt ihn nach.
  const grund = state || c.baseState || null
  const u = bewegungsUpdate(planFuer(c), { lat, lon, altitude, v, trk, vrate }, grund || {})
  // Ein Animationswechsel muss RAUS, auch wenn der Bewegungsplan schweigt.
  if (!u && !c.animOffen) return false

  const patch = u
    ? { lat: u.lat, lon: u.lon, altitude: u.altitude, rotation }
    : { lat, lon, altitude, rotation }
  if (u && grund) patch.state = u.state

  // ANIMATION IN DENSELBEN SCHREIBVORGANG. Sie als eigene Anfrage zu schicken
  // war ein Fehler mit Folgen: Beides geht auf denselben Datensatz, und das
  // PocketBase-SDK bricht bei zwei gleichzeitigen Anfragen an dieselbe Adresse
  // eine davon ab („autocancelled"). Getroffen hat es oft die POSITION — die
  // Figuren blieben stehen. Ein Request trägt ohnehin beides.
  if (c.animOffen) { patch.animation_state = c.anim; c.animOffen = false }

  await ajna.updateObject(c.id, patch)
  return true
}

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
// Wer angegriffen wird, laeuft nicht weiter seine Runde. Deutlich laenger als
// ATTEND_MS: Ein Kampf ist kein kurzes Innehalten, und eine Figur, die dem
// Angreifer nach zwei Sekunden davonspaziert, wirkt kaputt.
const KAMPF_HALT_MS = parseFloat(process.env.WD_KAMPF_HALT_S || '30') * 1000
// „Getroffen" ist eine GESTE, kein Zustand. Bliebe sie stehen, liefe der
// Getroffene beim Betrachter seine Geh-Animation auf der Stelle weiter — der
// Client kehrt nach der Geste nicht von selbst zu „steht" zurück.
const ZUCK_MS = 1200

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
// Radius der Gebäude-Abfrage für die Landung. Deutlich größer als der
// Landeplatz-Ring — er ist so gewählt, dass er den Schlüssel mit der
// Kulissen-Abfrage teilt und damit deren Zwischenspeicher mitbenutzt.
const CALL_BUILDING_CACHE_R = parseFloat(process.env.WD_CALL_BUILDING_CACHE_R || '200')
const CALL_SPOT_TIMEOUT_MS = parseFloat(process.env.WD_CALL_SPOT_TIMEOUT_S || '6') * 1000
const CALL_APPROACH_SPEED = parseFloat(process.env.WD_CALL_SPEED    || '14')   // m/s Anflug (zügiger als Streifen)
const CALL_DESCENT_SPEED  = parseFloat(process.env.WD_CALL_DESCENT  || '4')    // m/s Sinken/Steigen
const CALL_MAX_RANGE_M  = parseFloat(process.env.WD_CALL_RANGE_M    || '1500') // weiter weg → Ruf ignorieren
const CALL_BUILDING_R   = parseFloat(process.env.WD_CALL_BUILDING_R || '60')   // m Umkreis für die Gebäudeabfrage

const ROAM_MOVE_MIN = parseFloat(process.env.WD_ROAM_MOVE_MIN || '8')
const ROAM_MOVE_MAX = parseFloat(process.env.WD_ROAM_MOVE_MAX || '22')
const ROAM_REST_MIN = parseFloat(process.env.WD_ROAM_REST_MIN || '4')
const ROAM_REST_MAX = parseFloat(process.env.WD_ROAM_REST_MAX || '14')
// Flieger nutzen DIESELBE Ausrichtung wie alles andere (HEADING_TO_YAW, siehe
// client/core/yaw.js). Hier stand einmal, Flieger bräuchten eine gespiegelte
// Formel — der Code tat das schon länger nicht mehr, der Kommentar blieb stehen.
//
// Der frühere Notnagel WD_FLY_YAW_OFFSET ist WEG. Er war ein globaler Regler
// für die Eigenheit EINES Modells — und dafür der falsche Ort: Der Agent kennt
// die GLB-Datei gar nicht. Modell-Eigenheiten korrigiert der Client je Datei
// (MODEL_YAW_RAD in engine/GameObject.js); ein Agent mit einem Modell, das der
// Client nicht kennt, gibt `appearance.yaw` mit. Gesetzt war der Regler nie.
//
// WD_FLY_BANK_MAX = Roll-Amplitude in Kurven (rad; Vorzeichen umkehren, falls
// es in die falsche Richtung kippt).
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
// Reichweite des Angriffs (m). Unter 500 m verlangt das die Standort-Freigabe
// „Nähe" oder „Genau" — siehe client/core/aktionsReichweite.js. Der Tausch ist
// bewusst: Wer kämpfen will, lässt für den Kampf die Deckung fallen.
const KAMPF_REICHWEITE_M = parseFloat(process.env.WD_ATTACK_RANGE_M || '30')

const ARCHETYPES = {
  npc:    { count: 2, actions: [{ key: 'talk', label: 'Sprechen' }, { key: 'examine', label: 'Untersuchen' }], initialAnim: 'idle', flying: false },
  enemy:  { count: 1, actions: [{ key: 'attack', label: 'Angreifen', max_distance: KAMPF_REICHWEITE_M }, { key: 'talk', label: 'Sprechen' }, { key: 'examine', label: 'Untersuchen' }], initialAnim: 'idle', flying: false },
  animal: { count: 2, actions: [{ key: 'feed', label: 'Füttern' }, { key: 'talk', label: 'Ansprechen' }, { key: 'examine', label: 'Untersuchen' }], initialAnim: 'idle', flying: false },
  dragon: { count: 1, actions: [{ key: 'call', label: 'Rufen' }, { key: 'talk', label: 'Sprechen' }, { key: 'examine', label: 'Untersuchen' }], initialAnim: 'idle', flying: true  },
  item:   { count: 2, actions: [{ key: 'examine', label: 'Untersuchen' }], initialAnim: 'idle', flying: false },
  hint:   { count: 1, actions: [{ key: 'examine', label: 'Lesen' }],       initialAnim: 'idle', flying: false },
  // Diamanten: bewusst SELTEN (kleiner count), einsammelbar + stapelbar. Später
  // Zahlungsmittel / Loot / NPC-Belohnung. Kein explizites collect in actions —
  // portable=true blendet „🎒 Einsammeln" ohnehin ein.
  diamond: { count: 3, actions: [{ key: 'examine', label: 'Untersuchen' }], initialAnim: null,  flying: false }
}
const actionKeys = a => ARCHETYPES[a].actions.map(x => x.key)
// Zustand OHNE die Felder eines einzelnen Laufs. `walk_path` und `motion`
// beschreiben, wo die Figur gerade hinwill — nicht, wer sie ist. Wandern sie in
// den baseState, schreibt sie jeder spätere Patch wieder mit, und ein
// Gefallener zeigt noch seine Route.
const ohneLauf = (state) => {
  const { walk_path, motion, ...rest } = state || {}
  return rest
}
// Archetypen, die ein Spieler aufheben kann. `portable` allein blendet
// „🎒 Einsammeln" ein UND ist die Bedingung der Pickup-Route — ohne das Flag
// bleibt ein Fundstück für immer liegen.
const TRAGBAR = new Set(['item', 'diamond'])

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
  dragon: ['Dragon.glb', 'wyvern.glb'],   // wyvern: Animationen „metarig|idol|flaping|flying|walk"
  item:   ['Sword.glb', 'TreasureChest.glb'],
  hint:   [],  // kein Modell → Viewer nutzt den appearance-/Typ-Platzhalter
  diamond: ['Diamond.glb']
}
// Aus den Modell-Profilen abgeleitet (world-director.profiles.mjs — dort ist
// die eine Quelle der Wahrheit für Physis-Eigenschaften pro Modell):
// Vögel = leichte Flughöhe/Freiflug trotz Boden-Archetyp; Idle-fähige Modelle
// dürfen beim Streifen Pausen einlegen.
const FLYING_MODELS = new Set(Object.keys(MODEL_PROFILES).filter(m => MODEL_PROFILES[m].flying))
const IDLE_MODELS   = new Set(Object.keys(MODEL_PROFILES).filter(m => MODEL_PROFILES[m].idle))

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
    // Agent-Filter im Client matcht Objekte über state.source gegen das
    // Manifest (source "world-director") — ohne das Feld sind die Figuren
    // nie ausblendbar ("Objekte ohne Quelle = immer sichtbar").
    source: 'world-director',
    archetype,
    spawn_id: randomUUID(),
    actions: arch.actions          // Menü-Aktionen (Client liest state.actions)
  }
  if (opts.onDemand) state.on_demand = true   // vom Spieler angefordert, nicht Teil der Soll-Population
  if (archetype === 'npc')  state.dialogs = sample(DIALOG_LINES, 4)   // Reihe zufälliger Antworten
  if (archetype === 'hint') state.hint   = pick(HINT_LINES)
  if (TRAGBAR.has(archetype)) state.portable = true            // einsammelbar
  if (archetype === 'diamond') state.stackable = true           // und stapelbar

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
    // Darstellungs-Felder aus dem Modell-Profil (yaw/animSpeed/anim) wandern
    // MIT in die appearance — der Client interpretiert nur diese Daten
    // (kein Director-Wissen im Viewer, siehe world-director.profiles.mjs).
    spawn.appearance = { gltf: MODEL_BASE + model, ...profileAppearance(model, state.spawn_id) }
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
//  Boot (Login lief bereits in bootAgent)
// ─────────────────────────────────────────────────────────────────────────
console.log(`[director] Zentrum: ${CENTER_LAT.toFixed(4)}, ${CENTER_LON.toFixed(4)} · Radius ${RADIUS_M} m`)

async function publishManifest() {
  try {
    await ajna.upsertAgentManifest(mitDelegierten({
      source: 'world-director',
      agent_name: 'World-Director',
      description: FOLLOW_AREAS
        ? `Automatische Welt-Bevölkerung (Figuren, Hinweise, Items) — folgt deiner Position (Interest-Area), Fallback-Zentrum ${CENTER_LAT.toFixed(3)}, ${CENTER_LON.toFixed(3)}`
        : `Automatische Welt-Bevölkerung (Figuren, Hinweise, Items) im Radius ${RADIUS_M} m um ${CENTER_LAT.toFixed(3)}, ${CENTER_LON.toFixed(3)}`,
      // Predicates PRO Archetyp — mit predicate:null wäre jeder gewählte Layer
      // "all"-artig und Abwählen einzelner Archetypen bliebe wirkungslos.
      layers: Object.keys(ARCHETYPES).map(a => ({
        key: a,
        label: ({ npc: 'NPCs', enemy: 'Gegner', animal: 'Tiere', dragon: 'Drachen', item: 'Items', hint: 'Hinweise', diamond: 'Diamanten' })[a] || a,
        predicate: { field: 'state.archetype', equals: a },
      }))
    }))
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
    // PocketBase verpackt Feldfehler in response.data — ohne die steht hier nur
    // "Failed to create record" und man raet, welches Feld gemeint war.
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : ''
    console.warn(`[director] ACE für ${objId} fehlgeschlagen: ${err?.message || err}${detail ? ' · ' + detail : ''}`)
  }
}

// Stellt sicher, dass state.actions (Menü-Beschriftung im Client) am Objekt
// liegt — patcht Bestandsobjekte, die noch ohne angelegt wurden. Spiegelt die
// Änderung lokal, damit makeController/baseState sie übernimmt.
async function ensureActions(obj) {
  const arch = ARCHETYPES[obj.state?.archetype]
  if (!arch) return
  const tragbar = TRAGBAR.has(obj.state.archetype)
  const actionsGleich = JSON.stringify(obj.state?.actions ?? null) === JSON.stringify(arch.actions)
  if (actionsGleich && (!tragbar || obj.state?.portable === true)) return
  try {
    const next = { ...obj.state, actions: arch.actions }
    if (tragbar) next.portable = true
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
    // Bestand ans Soll angleichen: fehlendes state.source (Agent-Filter) und
    // die profilverwalteten appearance-Felder (yaw/animSpeed/anim) — Profil-
    // Korrekturen wirken so beim nächsten Boot auch auf bestehende Figuren.
    // Merge, kein Ersatz: fremde appearance-Schlüssel (z. B. glow) bleiben.
    {
      const patch = {}
      if (obj.state.source !== 'world-director') {
        patch.state = { ...obj.state, source: 'world-director' }
      }
      const model = modelOf(obj)
      if (model) {
        const cur = (obj.appearance && typeof obj.appearance === 'object') ? obj.appearance : {}
        const merged = { ...cur, ...profileAppearance(model, obj.state?.spawn_id || obj.id) }
        if (JSON.stringify(merged) !== JSON.stringify(cur)) patch.appearance = merged
      }
      if (Object.keys(patch).length) {
        try {
          await ajna.updateObject(obj.id, patch)
          if (patch.state) obj.state.source = 'world-director'
          if (patch.appearance) obj.appearance = patch.appearance
        } catch (err) { console.warn(`[director] Profil-Heilung ${obj.id}: ${err?.message || err}`) }
      }
    }
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
// Geschwindigkeit pro FIGUR: Modell-Profil zuerst, sonst globale Env-Regler.
const speedFor = (obj) => {
  const p = profileFor(modelOf(obj))
  if (Number.isFinite(p.speed)) return p.speed
  return obj?.state?.archetype === 'enemy' ? ENEMY_SPEED : NPC_SPEED
}

// Wegegraph UM DIE FIGUR (nicht um ein festes Zentrum) — pro grober Zelle
// (~300 m) gecacht und per TTL erneuert. So funktioniert die Routenplanung
// auch, wenn Figuren über mehrere Areale verteilt sind (kein Teleport an ein
// fixes Zentrum). Zusätzlich zum Server-Cache in server/geo.js (1 h).
const GRAPH_CELL_M = 300
// Frist der Wegenetz-Abfrage (ms) und Abstand wiederholter Warnungen.
const GRAPH_TIMEOUT_MS = parseFloat(process.env.WD_GRAPH_TIMEOUT_S || '10') * 1000
const GEO_WARN_INTERVALL_MS = 5 * 60_000
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
      // MIT FRIST. Gemessen: Fällt Overpass aus, antwortet die Geo-API erst
      // nach über 70 Sekunden mit 502 — und solange steckt der Tick DIESER
      // Figur fest. Bei einem Dutzend NPCs blockiert das den halben Director.
      // Auf die Raster-Zelle des Servers runden (3 Nachkommastellen ≈ 110 m).
      // Sonst bekommt jede Figur ihren eigenen Cache-Eintrag, und der
      // gemeinsame Vorrat wird nie genutzt.
      const rLat = Math.round(lat * 1000) / 1000
      const rLon = Math.round(lon * 1000) / 1000
      const res = await mitFrist(
        geo.waysNear(rLat, rLon, GRAPH_RADIUS_M, 'walkable'),
        GRAPH_TIMEOUT_MS, 'Wegegraph')
      if (res?.source && res.source !== 'overpass') {
        console.log(`[director] Wegegraph aus dem Zwischenspeicher (${res.source})`)
      }
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
    baseState: ohneLauf(obj.state),       // Identitätsfelder (ohne Weg/Bewegung)
    lat: obj.lat, lon: obj.lon,
    speed: speedFor(obj),
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
    // OHNE DAS ging beim Schreiben der ganze `state` verloren: Aktionen
    // („Rufen" beim Drachen), Quelle, Archetyp, Dialoge. Der Straßen-Controller
    // führte ihn längst mit, der Roamer nicht — was nicht auffiel, solange
    // dieser Weg nur lat/lon/rotation schrieb.
    baseState: ohneLauf(obj.state),
    kind: 'roam',
    flying,
    lat: obj.lat, lon: obj.lon,
    homeLat: obj.lat, homeLon: obj.lon,
    areaR: flying ? FLY_AREA_M : ROAM_AREA_M,
    heading: Math.random() * Math.PI * 2,
    // Modell-Profil zuerst (z. B. Fuchs flink, Storch gemächlich), sonst
    // die globalen Env-Regler je Bewegungsmodus.
    speed: (() => { const s = profileFor(modelOf(obj)).speed; return Number.isFinite(s) ? s : (flying ? FLY_SPEED : ROAM_SPEED) })(),
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

let geoWarned = 0   // Zeitpunkt der letzten Warnung
/**
 * Auf fehlendes Routing hinweisen — einmal ausführlich, danach in Abständen.
 *
 * „Nur einmal warnen" klang sparsam, verbarg aber einen DAUERZUSTAND: Als
 * Overpass stundenlang ausfiel, stand im Protokoll nichts, während 25 Figuren
 * reglos herumstanden. Ein Fehler, der sich wiederholt, muss sich auch
 * wiederholt melden — sonst sucht man ihn an der falschen Stelle.
 */
function geoWarnOnce(err) {
  const jetzt = Date.now()
  if (geoWarned && (jetzt - geoWarned) < GEO_WARN_INTERVALL_MS) return
  const ersteMal = !geoWarned
  geoWarned = jetzt
  console.warn(`[director] Geo/Routing nicht verfügbar${err ? ` (${err.message || err})` : ''}`
    + ` — Figuren streifen frei statt Straßen zu folgen.`)
  if (ersteMal) {
    console.warn(`[director] Tipp: Geo-API (npm run start) + Caddy nötig; AJNA_URL muss die Caddy-URL sein.`)
  }
}

/** Versprechen mit Frist — nach `ms` wird abgebrochen statt zu warten. */
function mitFrist(versprechen, ms, was) {
  let t
  return Promise.race([
    versprechen.finally(() => clearTimeout(t)),
    new Promise((_, ab) => { t = setTimeout(() => ab(new Error(`${was}: Frist ${ms} ms überschritten`)), ms) }),
  ])
}

/**
 * Ersatzweg ohne Wegenetz: ein paar Stützpunkte über eine kurze Strecke.
 *
 * Bewusst mehrere Punkte statt einer einzigen Geraden — so bekommt die Figur
 * einen leichten Knick im Weg und wirkt nicht wie auf Schienen. Die Länge
 * bleibt bescheiden: Wer blind läuft, soll nicht quer durch die Stadt marschieren.
 */
function ersatzWeg(c) {
  const richtung = Math.random() * Math.PI * 2
  const gesamt = 25 + Math.random() * 45
  const punkte = [[c.lat, c.lon]]
  let lat = c.lat, lon = c.lon, kurs = richtung
  for (let i = 0; i < 3; i++) {
    kurs += (Math.random() - 0.5) * 0.8      // leichter Schlenker je Abschnitt
    const p = destPoint(lat, lon, kurs, gesamt / 3)
    lat = p.lat; lon = p.lon
    punkte.push([lat, lon])
  }
  return punkte
}

async function planFor(c) {
  c.busy = true; c.fsm = 'planning'
  try {
    // Der Wegegraph darf nicht darüber entscheiden, OB sich die Figur bewegt —
    // nur WORAUF. Ein Fehler (Zeitüberschreitung, 502) wurde bisher vom
    // äußeren catch gefangen, und dort gab es keinen Rückfall: Die Figur ging
    // auf idle und versuchte es 15 s später erneut. Bei einem dauerhaften
    // Ausfall hieß das „steht für immer" — und genau so sah es aus.
    let graph = null
    try { graph = await getGraphNear(c.lat, c.lon) }
    catch (err) { geoWarnOnce(err) }

    let path = null
    if (graph) {
      const startKey = nearestNodeKey(graph, c.lat, c.lon)
      const targetKey = startKey && randomReachableTarget(graph, startKey, { minDistM: 40, maxDistM: WAY_RADIUS_M })
      path = targetKey ? shortestPath(graph, startKey, targetKey) : null
    }

    // OHNE WEGENETZ WIRD GESTREIFT, NICHT GEWARTET.
    //
    // Das Wegenetz kommt von Overpass — einem fremden Dienst, der heute
    // stundenlang ausgefallen ist. Bisher hieß das: 25 Figuren stehen reglos
    // herum, ohne Meldung, bis er zurückkommt. Eine Welt, deren Leben an der
    // Verfügbarkeit eines Dritten hängt, ist zu spröde.
    //
    // Der Ersatzweg ist eine gerade Strecke zu einem Punkt in der Nähe. Sie
    // kann durch ein Haus führen — dafür bewegt sich die Figur überhaupt.
    // Sobald das Wegenetz wieder da ist, plant der nächste Durchgang normal.
    if (!path || path.length < 2) {
      geoWarnOnce()
      path = ersatzWeg(c)
    }
    if (!path || path.length < 2) { c.fsm = 'idle'; c.nextPlanAt = Date.now() + PLAN_RETRY_MS; return }

    let lengthM = 0
    for (let i = 1; i < path.length; i++) lengthM += haversine(path[i-1][0], path[i-1][1], path[i][0], path[i][1])
    c.path = path
    c.cursor = { segIdx: 0, segT: 0 }
    c.lastTickAt = Date.now()
    c.fsm = 'walking'
    setzeAnim(c, 'walk')
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
      if (now < (c.gestureUntil || 0)) return   // Geste aus einem Gespraech laeuft
      setzeAnim(c, 'idle')
      await schreibeAnimFalls(c)
      return
    }
    if (c.anim === 'idle' && c.fsm === 'walking') setzeAnim(c, 'walk')

    const step = stepAlongPath(c.path, c.cursor, c.speed * dt)
    c.lat = step.lat; c.lon = step.lon
    c.cursor = { segIdx: step.segIdx, segT: step.segT }
    // Plan statt Position: geschrieben wird nur an Knicken der Route, bei
    // Tempowechsel oder als Lebenszeichen. `walk_path` bleibt im state, damit
    // Betrachter den geplanten Weg weiterhin zeichnen können.
    await schreibeBewegung(c, {
      lat: c.lat, lon: c.lon, altitude: c.altBase ?? 0,
      v: c.speed, trk: KURS_GRAD(step.headingRad),
      rotation: { x: 0, y: HEADING_TO_YAW(step.headingRad), z: 0 },
      state: { ...c.baseState, walk_path: c.path },
    })
    if (step.done) {
      const pauseMs = PAUSE_MS + randInt(0, 15) * 1000   // 10–25 s, gestreut (nicht im Gleichschritt)
      c.fsm = 'idle'; c.path = null; c.nextPlanAt = now + pauseMs
      setzeAnim(c, 'idle')
      // Stillstand MUSS raus: Ohne diesen Plan liefe die Figur beim Betrachter
      // endlos geradeaus weiter — die Vorausrechnung kennt kein Ziel.
      const halt = planFuer(c).haltAn({ lat: c.lat, lon: c.lon, altitude: c.altBase ?? 0, trk: 0 })
      const schluss = { state: { ...c.baseState, motion: halt } }   // walk_path entfernen
      if (c.animOffen) { schluss.animation_state = c.anim; c.animOffen = false }
      await ajna.updateObject(c.id, schluss)
      console.log(`[director] ⏸ ${c.archetype} "${c.id}" angekommen — Pause ${(pauseMs / 1000) | 0} s`)
    }
  } catch (err) {
    if (istWeg(err)) { c.tot = true; return }   // Objekt gelöscht — nicht weiter ansteuern
    console.warn(`[director] tick "${c.id}" fehlgeschlagen: ${err?.message || err}`)
    c.fsm = 'idle'; c.nextPlanAt = Date.now() + PLAN_RETRY_MS
  } finally { c.busy = false }
}

// Ein Tick freien Flugs: Wander + Randlenkung Richtung Zentrum (mit der Distanz
// stärker), begrenzte Drehrate → weiche Kurven statt 180°-Sprung am Rand.
// Landeplatz suchen: Gebäude in der Nähe holen (für „nicht im Haus landen" und
// die Dach-Kür). Fällt die Geo-Abfrage aus, landet er eben ohne Gebäudewissen —
// besser ein Landeplatz auf freiem Feld als gar keine Landung.
/**
 * Landeplatz ohne Gebäudewissen: ein Punkt im Ring um den Spieler.
 *
 * Bewusst dieselben Abstände wie die richtige Suche — er soll nicht IM Spieler
 * landen und nicht am Horizont. Dass dabei ein Haus getroffen werden kann, ist
 * der Preis dafür, überhaupt zu landen.
 */
function notLandeplatz(s) {
  const winkel = Math.random() * Math.PI * 2
  const r = CALL_LAND_MIN_M + Math.random() * Math.max(1, CALL_LAND_MAX_M - CALL_LAND_MIN_M)
  const p = destPoint(s.lat, s.lon, winkel, r)
  return { lat: p.lat, lon: p.lon, altitude: 0, kind: 'ground', distance: r }
}

async function pickLandingSpot(c, s) {
  let buildings = []
  try {
    // AUF DEN CACHE ZIELEN, nicht daran vorbei.
    //
    // Der Server bündelt Geo-Antworten auf ein ~110-m-Raster, und Radius sowie
    // Filter gehören mit zum Schlüssel (server/geo.js). Mit der EXAKTEN
    // Spielerposition und einem eigenen kleinen Radius traf die Abfrage deshalb
    // praktisch nie einen vorhandenen Eintrag — jeder Ruf ging live an Overpass,
    // und wenn das gerade nicht antwortete, kreiste der Drache minutenlang.
    //
    // Auf dieselbe Auflösung gerundet und mit dem Radius, den die Kulisse
    // ohnehin abfragt, reitet die Landung auf Daten, die meist schon da sind.
    // Der Umkreis ist großzügiger als nötig — ein Landeplatz liegt 8–20 m vom
    // Spieler, die Gebäude drumherum stecken alle darin.
    const rLat = Math.round(s.lat * 1000) / 1000
    const rLon = Math.round(s.lon * 1000) / 1000
    const res = await geo.buildingsNear(rLat, rLon, CALL_BUILDING_CACHE_R, 'all')
    buildings = Array.isArray(res?.features) ? res.features : []
    if (res?.source && res.source !== 'overpass') {
      console.log(`[director] 🐉 Landeplatz-Gebäude aus dem Zwischenspeicher (${res.source})`)
    }
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
        // Landeplatz JETZT im Hintergrund suchen — die Geo-Abfrage (Overpass)
        // dauert oft Sekunden. Während der Drache kreist, ist Zeit dafür. Würde
        // man erst beim Übergang zum Landen await-en, hinge er solange bewegungs-
        // los in der Luft (die await-Pause blockiert den ganzen Tick).
        // undefined = Suche läuft noch; wird zu Spot-Objekt oder null.
        s.spot = undefined
        // MIT FRIST. Die Gebäudeabfrage geht über Overpass, und das ist ein
        // fremder Dienst, der regelmäßig minutenlang nicht antwortet. Ohne
        // Frist kreiste der Drache genau so lange — beobachtet: rund eine
        // Minute. Ein Landeplatz auf freiem Feld ist allemal besser als ein
        // Drache, der am Himmel Runden dreht, bis jemand die Geduld verliert.
        pickLandingSpot(c, s).then(spot => { if (s.spot === undefined) s.spot = spot || null })
                             .catch(() => { if (s.spot === undefined) s.spot = null })
        setTimeout(() => {
          if (s.spot !== undefined) return
          s.spot = notLandeplatz(s)
          console.warn(`[director] 🐉 "${c.id}" Landeplatz-Suche zu langsam → Notlandeplatz`)
        }, CALL_SPOT_TIMEOUT_MS)
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
      // Landen erst, wenn die Kreiszeit UM ist UND die Suche fertig (nicht mehr
      // undefined). Ist die Geo-Abfrage noch unterwegs, kreist er einfach weiter
      // — eine natürliche Warteschleife statt Einfrieren.
      if (now >= s.until && s.spot !== undefined) {
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
        // Aufsetzen ist ein Zustandswechsel — hier wird bewusst IMMER
        // geschrieben, und der Plan ausdrücklich auf Stillstand gesetzt.
        // Sonst flöge der Drache beim Betrachter über den Landeplatz hinaus.
        const gelandet = planFuer(c).haltAn({ lat: c.lat, lon: c.lon, altitude: c.altBase, trk: KURS_GRAD(c.heading) })
        await ajna.updateObject(c.id, {
          lat: c.lat, lon: c.lon, altitude: c.altBase,
          animation_state: 'idle',
          rotation: { x: 0, y: HEADING_TO_YAW(c.heading), z: 0 },
          state: { ...c.baseState, motion: gelandet }
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
      setzeAnim(c, 'idle')
      await schreibeAnimFalls(c)
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
      // Abheben-Animation (wyvern: „take off"); Modelle ohne Takeoff-Clip fallen
      // im Resolver auf ihre Flap-Animation zurück (siehe ANIM_ALIASES.takeoff).
      anim = 'takeoff'
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

  setzeAnim(c, anim)
  await schreibeBewegung(c, {
    lat: c.lat, lon: c.lon, altitude: c.altBase,
    v: c.speed, trk: KURS_GRAD(c.heading),
    rotation: { x: 0, y: HEADING_TO_YAW(c.heading), z: clamp(turnRatio, -1, 1) * FLY_BANK_MAX }
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
      if (now >= (c.gestureUntil || 0)) setzeAnim(c, 'idle')
      c.phaseUntil = c.attendUntil          // danach frisch entscheiden
      return
    }

    // Streif-/Rast-Rhythmus (nur idle-fähige Boden-Tiere): Phase abwechseln.
    if (c.canPause && now >= c.phaseUntil) {
      c.paused = !c.paused
      const [lo, hi] = c.paused ? [ROAM_REST_MIN, ROAM_REST_MAX] : [ROAM_MOVE_MIN, ROAM_MOVE_MAX]
      c.phaseUntil = now + randInt(lo, hi) * 1000
      const wantAnim = c.paused ? 'idle' : 'walk'
      setzeAnim(c, wantAnim)
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
      yaw = HEADING_TO_YAW(c.heading)
      roll = clamp(turn / maxTurn, -1, 1) * FLY_BANK_MAX
    } else {
      altitude = c.altBase                // Boden-Tier bleibt auf seiner Höhe
      wantAnim = 'walk'
      yaw = HEADING_TO_YAW(c.heading)     // Boden/NPC-Konvention unverändert
    }
    setzeAnim(c, wantAnim)

    // Flieger drehen laufend — der Knick-Auslöser greift hier also öfter als
    // bei einer Figur auf der Straße. Das ist richtig so: Eine kreisende Möwe
    // ändert ihren Kurs wirklich ständig, und wer das verschweigt, lässt sie
    // beim Betrachter geradeaus davonfliegen.
    await schreibeBewegung(c, {
      lat: c.lat, lon: c.lon, altitude,
      v: c.speed, trk: KURS_GRAD(c.heading),
      vrate: Number.isFinite(c._vrate) ? c._vrate : 0,
      rotation: { x: 0, y: yaw, z: roll },
    })
  } catch (err) {
    // 404 heißt: das Objekt gibt es nicht mehr (gelöscht, aufgeräumt, Bereinigung
    // während der Entwicklung). Ohne diese Unterscheidung steuerte der Director
    // die Leiche bei jedem Tick weiter an und schrieb bei jedem Start ein
    // Dutzend Fehlerzeilen ins Protokoll — Rauschen, das echte Fehler verdeckt.
    if (istWeg(err)) { c.tot = true; return }
    console.warn(`[director] Roam "${c.id}" fehlgeschlagen: ${err?.message || err}`)
  } finally { c.busy = false }
}

function tick() {
  const now = Date.now()
  // Als weg erkannte Figuren aussortieren, bevor irgendetwas sie ansteuert.
  // Der nächste reconcile() legt sie ohnehin nicht neu an — sie existieren
  // serverseitig nicht mehr.
  if (controllers.some(c => c.tot)) {
    const weg = controllers.filter(c => c.tot)
    for (const c of weg) { try { c.unsubInteract?.() } catch {} }
    controllers = controllers.filter(c => !c.tot)
    console.log(`[director] ${weg.length} gelöschte Figur(en) aus der Führung genommen`)
  }
  for (const c of controllers) {
    if (c.busy || c.tot || c.gefallen) continue
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
/**
 * War das ein „gibt es nicht mehr"?
 *
 * PocketBase meldet es als 404 mit wechselndem Wortlaut; geprüft wird deshalb
 * beides. Ein Netzfehler darf NICHT darunterfallen — sonst würfe der Director
 * bei einem kurzen Aussetzer seine halbe Besetzung weg.
 */
function istWeg(err) {
  if (err?.status === 404) return true
  return /404|requested resource wasn't found|not found/i.test(String(err?.message || ''))
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
const kampf = new Kampf({ log: (m) => console.log(`[director] ${m}`) })

/**
 * Angriff auswerten und die Folgen schreiben.
 *
 * Die Rechnung macht `agents/lib/kampf.mjs`, das Schreiben passiert hier — so
 * lässt sich die Regel prüfen, ohne einen Server zu starten, und ein anderer
 * Agent kann dieselbe Regel anders umsetzen.
 */
/**
 * Stehenbleiben — und den Betrachtern den Stillstand auch mitteilen.
 *
 * Ohne Halt-Plan liefe die Figur beim Betrachter geradeaus weiter: Die
 * Vorausrechnung im Client kennt kein Ziel, nur Kurs und Tempo. Genau das
 * ließ einen getroffenen Gegner davonspazieren, während seine Beute an der
 * zuletzt geschriebenen Position landete.
 *
 * @param {object}  c
 * @param {number}  o.bis       bis wann die Figur nichts Eigenes plant (Zeitstempel)
 * @param {object?} o.blickAuf  {lat, lon} — dorthin drehen (der Angreifer)
 * @param {object?} o.zusatz    Felder, die dauerhaft in den state gehören (z. B. hp)
 * @param {string?} o.anim      Animationszustand, der mitgeschrieben wird
 */
async function halteAn(c, { bis = 0, blickAuf = null, zusatz = null, anim = 'idle', wegBehalten = false } = {}) {
  // Nicht gleichzeitig mit dem Bewegungs-Tick auf denselben Datensatz
  // schreiben: PocketBase bricht dann eine der beiden Anfragen ab
  // („autocancelled") — und ausgerechnet der Halt darf nicht die verlorene
  // sein, sonst läuft die Figur beim Betrachter einfach weiter.
  for (let i = 0; c.busy && i < 30; i++) await new Promise(r => setTimeout(r, 50))
  c.busy = true
  if (!wegBehalten) {
    c.path = null
    c.fsm = 'idle'
    c.paused = true
    c.summon = null                        // ein laufender Ruf ist damit erledigt
  }
  c.attendUntil = Math.max(c.attendUntil || 0, bis)
  c.phaseUntil = Math.max(c.phaseUntil || 0, bis)
  c.nextPlanAt = Math.max(c.nextPlanAt || 0, bis)
  // hp & Co. gehören in baseState: Jeder folgende Bewegungs-Schreibvorgang baut
  // den state daraus neu auf und würde sie sonst wieder wegwerfen.
  if (zusatz) c.baseState = { ...c.baseState, ...zusatz }

  const stelle = { lat: c.lat, lon: c.lon, altitude: c.altBase ?? 0 }
  const patch = { ...stelle }
  let trk = 0
  const zLat = Number(blickAuf?.lat), zLon = Number(blickAuf?.lon)
  if (Number.isFinite(zLat) && Number.isFinite(zLon)) {
    const b = bearingRad(c.lat, c.lon, zLat, zLon)
    c.heading = b
    trk = KURS_GRAD(b)
    patch.rotation = { x: 0, y: HEADING_TO_YAW(b), z: 0 }
  }
  // Beim Innehalten bleibt walk_path stehen (die Figur läuft danach weiter),
  // beim Abbrechen fällt er weg — sonst zeichnete der Client eine Route, die
  // niemand mehr geht.
  patch.state = { ...c.baseState, motion: planFuer(c).haltAn({ ...stelle, trk }) }
  if (wegBehalten && c.path) patch.state.walk_path = c.path
  else delete patch.state.walk_path
  if (anim) { c.anim = anim; c.animOffen = false; patch.animation_state = anim }
  try { await ajna.updateObject(c.id, patch) }
  catch (err) {
    if (istWeg(err)) c.tot = true
    else console.warn(`[director] Halt "${c.id}": ${err?.message || err}`)
  } finally { c.busy = false }
}

async function verarbeiteAngriff(c, evt) {
  const obj = ajna.getObjectById(c.id)
  if (!obj) return
  const at = evt?.payload?.at || null
  // Gegen die LIVE-Position prüfen, nicht gegen die zuletzt geschriebene:
  // dazwischen liegen bis zu ein paar Sekunden Weg (Bewegungsplan statt
  // Positions-Ticker). Eine Reichweitenprüfung gegen einen veralteten Standort
  // lehnt Treffer ab, die aus Spielersicht sitzen.
  const ziel = { ...obj, lat: c.lat ?? obj.lat, lon: c.lon ?? obj.lon }
  const r = kampf.schlag({ ziel, angreifer: evt?.source, absender: at })
  if (!r.ok) {
    if (r.grund !== 'zu-schnell') console.log(`[director] ⚔ Angriff auf "${c.id}" abgelehnt: ${r.grund}`)
    return
  }

  if (!r.tot) {
    // Getroffen: Route abbrechen, den Angreifer ansehen, stehenbleiben. Wer
    // angegriffen wird, setzt seine Runde nicht einfach fort.
    await halteAn(c, { bis: Date.now() + KAMPF_HALT_MS, blickAuf: at, zusatz: { hp: r.hp }, anim: 'hit' })
    console.log(`[director] ⚔ "${c.id}" getroffen — ${r.hp.ist}/${r.hp.max}, bleibt stehen`)
    setTimeout(() => {
      if (c.gefallen || c.tot) return
      setzeAnim(c, 'idle')
      schreibeAnimFalls(c)
    }, ZUCK_MS)
    return
  }

  // Gefallen: liegen bleiben, nichts mehr planen, Beute AUF DEN BODEN.
  c.gefallen = true
  await halteAn(c, {
    bis: Number.MAX_SAFE_INTEGER, blickAuf: at,
    zusatz: { hp: r.hp, tot: true }, anim: 'death',
  })
  console.log(`[director] ☠ "${c.id}" gefallen — Beute: ${r.beute.join(', ') || 'nichts'}`)

  for (const name of r.beute) {
    // Leicht gestreut, damit mehrere Stücke nicht ineinander liegen — und um die
    // LIVE-Position herum, nicht um die zuletzt geschriebene: Sonst liegt die
    // Beute meterweit neben der Leiche.
    const winkel = Math.random() * Math.PI * 2
    const p = destPoint(c.lat ?? obj.lat, c.lon ?? obj.lon, winkel, 0.6 + Math.random() * 1.4)
    try {
      const rec = await ajna.createObject(beuteObjekt(name, {
        lat: p.lat, lon: p.lon, altitude: c.altBase ?? obj.altitude ?? 0, quelle: 'world-director',
      }))
      // Sichtbar für alle — sonst könnte sie niemand aufheben. ensureAce statt
      // addPermission: Der afterCreate-Hook legt bereits eine
      // (authenticated, view)-ACE an; ein zweites Anlegen scheitert.
      await ensureAce(rec.id, ['collect', 'examine'])
    } catch (err) {
      console.warn(`[director] Beute "${name}": ${err?.message || err}`)
    }
  }
}

/** Leichen abräumen, deren Liegezeit um ist. Der Reconcile spawnt danach nach. */
async function raeumeGefallene() {
  for (const id of kampf.abgelaufen()) {
    kampf.vergiss(id)
    try {
      await ajna.deleteObject(id)
      console.log(`[director] ☠ "${id}" verblasst`)
    } catch (err) { /* schon weg */ }
    const c = controllers.find(x => x.id === id)
    if (c) c.tot = true
  }
}

function attachInteractListener(c) {
  ajna.onInteract(c.id, (evt) => {
    const action = evt?.action
    if (!action || action === 'examine') return   // Untersuchen ist passiv — keine Reaktion

    // „Rufen": der Spieler hat eine Position mitgeschickt → Anflug starten.
    if (action === 'call' && c.flying) { startSummon(c, evt); return }

    // „Angreifen": Trefferpunkte, Tod, Beute — die Mechanik steht in
    // agents/lib/kampf.mjs und ist bewusst NICHT Director-eigen. Wer eigene
    // Gegner in die Welt stellt, importiert dieselben Funktionen.
    if (action === 'attack') { verarbeiteAngriff(c, evt); return }

    // „Sprechen": der Client hat gerade den Privatchat geoeffnet. Die Figur
    // ergreift das Wort — sonst saehe der Spieler ein leeres Fenster.
    if (action === 'talk' && evt?.source) eroeffneGespraech(evt.source, c.id)

    // Nicht nur intern innehalten: Ohne Halt-Plan liefe die Figur beim
    // Betrachter geradeaus weiter, während sie hier in Wahrheit steht.
    halteAn(c, { bis: Date.now() + ATTEND_MS, blickAuf: evt?.payload?.at, wegBehalten: true })
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
  // Gefallene verblassen lassen (Liegezeit aus agents/lib/kampf.mjs).
  setInterval(() => { raeumeGefallene().catch(() => {}) }, 2000)
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
let _letzteZentren = null      // für den Sprung-Wächter (siehe unten)
async function reconcile() {
  if (reconcileBusy) return
  reconcileBusy = true
  try {
    const centers = await fetchCenters()
    _letzteZentren = centers
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

// Sprung-Wächter: Der volle Reconcile ist teuer (Wegegraph, Spawns, Despawns)
// und läuft deshalb gemächlich. Ein ORTSWECHSEL soll aber nicht bis zu einer
// dreiviertel Minute warten — typisch beim App-Start, wenn der letzte bekannte
// Standort durch den ersten echten GPS-Fix ersetzt wird und der Spieler
// plötzlich woanders steht.
//
// Der Wächter fragt nur die Interessensbereiche ab (ein günstiger GET) und
// stößt den Reconcile an, sobald sich ein Zentrum deutlich verschoben hat.
// Bewegt sich niemand, kostet er nichts weiter.
const AREA_WATCH_MS = envNum('WD_AREA_WATCH_S', 8) * 1000
const AREA_JUMP_M   = envNum('WD_AREA_JUMP_M', 400)

/** Hat sich mindestens ein Zentrum weiter als `grenze` bewegt (oder deren Zahl geändert)? */
function zentrenWeitBewegt(alt, neu, grenze) {
  if (!alt || !neu) return false
  if (alt.length !== neu.length) return true
  // Für jedes NEUE Zentrum: gibt es ein altes in der Nähe? Wenn nicht, ist es
  // ein Ortswechsel und kein Schlendern.
  return neu.some(n => !alt.some(a => haversine(a.lat, a.lon, n.lat, n.lon) <= grenze))
}

if (FOLLOW_AREAS && AUTONOMY) {
  console.log(`[director] folgt Interest-Areas (Quelle "${WD_SOURCE || '*'}", alle ${(RECONCILE_MS / 1000) | 0} s`
    + `, Sprung-Wächter alle ${(AREA_WATCH_MS / 1000) | 0} s ab ${AREA_JUMP_M} m`
    + `; Fallback-Zentrum ${CENTER_LAT.toFixed(4)}, ${CENTER_LON.toFixed(4)})`)
  reconcile()
  setInterval(() => { reconcile() }, RECONCILE_MS)
  setInterval(async () => {
    if (reconcileBusy || !_letzteZentren) return
    try {
      const jetzt = await fetchCenters()
      if (!zentrenWeitBewegt(_letzteZentren, jetzt, AREA_JUMP_M)) return
      console.log('[director] ⇢ Ortswechsel erkannt — Reconcile sofort statt beim nächsten Takt')
      await reconcile()
    } catch (err) {
      console.warn(`[director] Sprung-Wächter: ${err?.message || err}`)
    }
  }, AREA_WATCH_MS)
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

// Wer darf dem Director Kommandos geben? Leer = jeder Angemeldete (Abklingzeit
// und Obergrenze begrenzen den Schaden ohnehin); WD_COMMAND_USERS grenzt es auf
// bestimmte Konto-IDs ein. Der Absender steht serverseitig in `evt.source` und
// ist damit nicht fälschbar — bislang hat ihn nur niemand gelesen.
const CMD_ALLOW = envStr('WD_COMMAND_USERS', '')
if (CMD_ALLOW) console.log(`[director] Kommandos nur von: ${CMD_ALLOW}`)

ajna.onAgentCommand(WD_SOURCE || 'world-director', (evt) => {
  if (!commandAllowed(evt, CMD_ALLOW)) {
    console.warn(`[director] Kommando "${evt?.command}" von ${evt?.source} abgelehnt (nicht in WD_COMMAND_USERS)`)
    return
  }
  if (evt?.command === 'spawn') handleSpawnCommand(evt)
  else console.log(`[director] unbekanntes Kommando "${evt?.command}" — ignoriert`)
}).then(() => console.log(`[director] hört auf Kommandos (agent:${WD_SOURCE || 'world-director'}) · Cooldown ${CMD_COOLDOWN_MS / 1000} s, max ${CMD_MAX_ON_DEMAND} Objekte auf Zuruf`))
  .catch(err => console.warn(`[director] Kommando-Abo fehlgeschlagen: ${err?.message || err}`))

// ─────────────────────────────────────────────────────────────────────────
//  Gespräche (Parley)
// ─────────────────────────────────────────────────────────────────────────
// Der Client öffnet mit „Sprechen" einen Privatchat mit dem KONTO, dem die
// Figur gehört — das ist dieser Agent. Welche Figur gemeint war, steht in
// `object`. Deshalb eine Sitzung je Spieler UND Figur: zwei Spieler reden
// unabhängig voneinander mit derselben Person, und derselbe Spieler führt mit
// zwei Figuren zwei getrennte Gespräche.
//
// Welcher Dialogsatz greift, entscheidet der Archetyp (npc → mensch, enemy →
// gestalt, animal → tier, dragon → drache); die Sätze liegen als JSON in
// /dialogs und erben untereinander. Eine einzelne Figur kann über
// `state.dialog_set` einen eigenen Satz verlangen.
//
// Ephemer wie der Rest des Chats: läuft der Director nicht, antwortet niemand.
// Es gibt keine Ablage und keinen Nachversand.
const TALK_ON      = envStr('WD_TALK', 'on').toLowerCase() !== 'off'
const TALK_IDLE_MS = envNum('WD_TALK_IDLE_S', 900) * 1000   // Gespräch vergessen
const TALK_MIN_MS  = envNum('WD_TALK_MIN_MS', 400)          // Mindestabstand je Spieler
const TALK_GESTE_MS = envNum('WD_TALK_GESTURE_S', 4) * 1000 // Dauer einer Geste

const parley = TALK_ON ? npcParley() : null
const letzterSatz = new Map()   // userId → Zeitstempel der letzten Antwort

const objektVon = (id) => managed.find(o => o.id === id) || null
const controllerVon = (id) => controllers.find(c => c.id === id) || null

// Eine Eingabe beantworten. `text` kommt vom Spieler; beim Gesprächsbeginn
// setzt der Director selbst ein „hallo" ein, damit die Figur anfängt.
async function sprich(userId, obj, text) {
  const chat = parley.open(dialogNameFor(obj), talkSessionId(userId, obj.id), { vars: dialogVarsFor(obj) })
  const antwort = chat.say(text)
  if (!antwort.text) return

  await ajna.sendChat(userId, {
    text: antwort.text,
    object: obj.id,
    // Auswahlantworten reist der Client als Knöpfe an; `input` sagt ihm, ob
    // daneben noch ein Eingabefeld stehen soll.
    meta: antwort.choices ? { choices: antwort.choices, input: antwort.input } : null,
  })

  for (const a of antwort.do) await fuehreAus(a, obj)
}

// Was eine Dialog-Aktion in Ajna bedeutet, weiß nur der Agent. Bewusst eine
// kurze Liste: alles, was die Welt verändert, gehört nicht in einen Dialogsatz,
// den irgendwann jemand anders schreibt.
async function fuehreAus(aktion, obj) {
  if (aktion?.action !== 'anim' || !aktion.value) return
  const c = controllerVon(obj.id)
  try {
    await ajna.setAnimation(obj.id, String(aktion.value))
    if (c) {
      const jetzt = Date.now()
      c.anim = String(aktion.value)
      c.gestureUntil = jetzt + TALK_GESTE_MS
      c.attendUntil = Math.max(c.attendUntil || 0, jetzt + TALK_GESTE_MS + 1000)
    }
  } catch (err) {
    console.warn(`[director] Geste "${aktion.value}" fehlgeschlagen: ${err?.message || err}`)
  }
}

// Vom interact-Listener gerufen: der Spieler hat „Sprechen" gewählt.
function eroeffneGespraech(userId, objId) {
  if (!parley) return
  const obj = objektVon(objId)
  if (!obj) return
  sprich(userId, obj, 'hallo')
    .catch(err => console.warn(`[director] Gesprächsbeginn "${objId}": ${err?.message || err}`))
}

if (parley) {
  ajna.onChat(async (msg) => {
    try {
      const von = msg?.from
      const text = String(msg?.text || '').trim()
      if (!von || !text) return

      // Bremse: eine Antwort je Spieler und TALK_MIN_MS. Reicht gegen
      // versehentliche Schleifen; gegen gezielten Missbrauch muss der Server
      // ran (offener Punkt am Chat-Transport).
      const jetzt = Date.now()
      if (jetzt - (letzterSatz.get(von) || 0) < TALK_MIN_MS) return
      letzterSatz.set(von, jetzt)

      const obj = msg.object ? objektVon(msg.object) : null
      if (!obj) {
        // Direktnachricht an den Agent ohne Figur — oder eine Figur, die
        // inzwischen weg ist. Beides ist kein Fehler.
        await ajna.sendChat(von, { text: 'Hier spricht niemand Bestimmtes. Sprich eine Figur an.', serverId: msg._origin })
        return
      }

      const c = controllerVon(obj.id)
      if (c) c.attendUntil = Math.max(c.attendUntil || 0, jetzt + ATTEND_MS)

      await sprich(von, obj, text)
    } catch (err) {
      console.warn(`[director] Chat fehlgeschlagen: ${err?.message || err}`)
    }
  }).then(() => console.log(`[director] hört auf Gespräche (${parley.names.length} Dialogsätze: ${parley.names.join(', ')})`))
    .catch(err => console.warn(`[director] Chat-Abo fehlgeschlagen: ${err?.message || err}`))

  // Alte Gespräche vergessen — sonst wächst die Sitzungstabelle mit jedem
  // Spieler, der einmal „hallo" gesagt hat.
  setInterval(() => {
    const weg = parley.sweep(TALK_IDLE_MS)
    if (weg) console.log(`[director] ${weg} altes Gespräch(e) vergessen · ${parley.openCount} offen`)
  }, 60_000)
} else {
  console.log('[director] Gespräche aus (WD_TALK=off)')
}

// ─── Heartbeat hält den Prozess am Leben (+ späterer Online-Status-Anker) ─
setInterval(() => { publishManifest() }, HEARTBEAT_MS)
console.log('[director] bereit. (Strg+C zum Beenden)')

// SIGINT übernimmt bootAgent.
// SIGINT/SIGTERM übernimmt bootAgent.
