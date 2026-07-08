// Spawnt ein zufälliges Spielobjekt an der aktuellen Position des Spielers.
//
// Demo-Helfer: macht den Stand vorzeigbar (eigene Objekte erzeugen und damit
// interagieren). Das Objekt gehört dem eingeloggten User (volle Rechte) und
// wird für alle authentifizierten Spieler sichtbar + interaktiv freigegeben
// (Multiplayer-Demo). Die Modell-URL ist relativ (/models/X.glb) → der Client
// löst sie gegen den Herkunfts-Server auf bzw. lädt sie in der App aus dem
// Bundle (siehe Appearance.gltfUrlOf / GameObject.#modelCandidates).
//
// Archetyp/Modell/Aktionen spiegeln bewusst den World-Director
// (agents/world-director.mjs) — bleibt eine kleine, absichtliche Duplizierung,
// damit der Client keine Node-Agent-Module importieren muss.

import { animalNameFor } from './animalNames.js'
import { randomHexColor } from './randomColor.js'

const pick = arr => arr[Math.floor(Math.random() * arr.length)]

// Sprechende Typ-Labels (auch für TTS-Ansagen genutzt, siehe Announcer).
export const TYPE_LABEL = {
  npc: 'NPC', enemy: 'Monster', animal: 'Tier',
  dragon: 'Drache', item: 'Gegenstand', hint: 'Hinweis'
}

// Namens-Pools je Typ. Tiere sind hier NICHT gelistet — ihr Name wird aus dem
// gewählten Modell abgeleitet (animalNameFor), damit er immer dazu passt.
const NAMES = {
  npc:    ['Klaus', 'Sara', 'Ben', 'Lena', 'Ida', 'Mara', 'Tom', 'Nele'],
  enemy:  ['Grimmroth', 'Nebelbeißer', 'Aschkrieger', 'Schattenwächter', 'Düsterzahn'],
  dragon: ['Ngeth', 'Ngwyn', 'Fafnir', 'Smaug'],
  item:   ['Schwert', 'Schatztruhe', 'Talisman', 'Kompass'],
}

// Archetyp → Modelle + objekt-definierte Aktionen (state.actions).
export const SPAWN_ARCHETYPES = [
  { type: 'npc',    models: ['CesiumMan.glb', 'Soldier.glb', 'RobotExpressive.glb'],
    actions: [{ key: 'talk', label: 'Sprechen' }, { key: 'examine', label: 'Untersuchen' }] },
  { type: 'enemy',  models: ['MawGooey.glb', 'Slime.glb', 'Soldier.glb'],
    actions: [{ key: 'attack', label: 'Angreifen' }, { key: 'examine', label: 'Untersuchen' }] },
  { type: 'animal', models: ['Fox.glb', 'Horse.glb', 'Flamingo.glb', 'Stork.glb', 'Parrot.glb'],
    actions: [{ key: 'feed', label: 'Füttern' }, { key: 'examine', label: 'Untersuchen' }] },
  { type: 'dragon', models: ['Dragon.glb'],
    actions: [{ key: 'examine', label: 'Untersuchen' }], fly: true },
  { type: 'item',   models: ['Sword.glb', 'TreasureChest.glb'],
    actions: [{ key: 'collect', label: 'Einsammeln' }, { key: 'examine', label: 'Untersuchen' }] },
]

const FLYING_MODELS = new Set(['Flamingo.glb', 'Stork.glb', 'Parrot.glb'])

/** Baut den createObject-Datensatz für ein zufälliges Objekt an `position`. */
export function randomSpawnData(position) {
  const arch = pick(SPAWN_ARCHETYPES)
  const model = pick(arch.models)
  // Höhe ist ÜBER BODEN (AGL): Boden-Objekte 0 (am Boden), Vögel/Drache
  // schweben um ihre AGL-Höhe. NICHT die GPS-Höhe verwenden (das wäre AMSL).
  const altitude = arch.fly ? 30 + Math.random() * 40
                 : FLYING_MODELS.has(model) ? 8 + Math.random() * 12
                 : 0
  // Tier-Name aus dem Modell ableiten (+ ggf. größenwirksames Adjektiv), sonst
  // aus dem Namens-Pool.
  let name, sizeScale = 1
  if (arch.type === 'animal') {
    const a = animalNameFor(model)
    name = a.name
    sizeScale = a.scale
  } else {
    name = NAMES[arch.type] ? pick(NAMES[arch.type]) : arch.type
  }
  // Zufallsfarbe fürs Material: wirkt nur auf untexturierte Modelle (Blob/Slime),
  // texturierte behalten ihren Look (GameObject.#applyModelColor).
  const appearance = { gltf: '/models/' + model, color: randomHexColor() }
  if (sizeScale !== 1) appearance.scale = sizeScale
  return {
    name,
    type: arch.type,
    description: `Ein ${TYPE_LABEL[arch.type] || arch.type}.`,
    lat: position.lat,
    lon: position.lon,
    altitude,
    rotation: { x: 0, y: Math.random() * Math.PI * 2 - Math.PI, z: 0 },
    animation_state: 'idle',
    appearance,
    state: { actions: arch.actions, realtime: true, spawnedBy: 'player', altitude_ref: 'ground' },
  }
}

/**
 * Erzeugt ein zufälliges Objekt an `position`, gibt es für alle frei und
 * liefert den angelegten Record zurück.
 * @param {{ajna: object, position: {lat:number,lon:number,altitude?:number}}} opts
 */
export async function spawnRandomHere({ ajna, position }) {
  if (!position || !Number.isFinite(position.lat) || !Number.isFinite(position.lon)) {
    throw new Error('Keine Position — Spawn braucht deinen Standort')
  }
  if (!ajna?.isLoggedIn?.()) throw new Error('Zum Spawnen bitte einloggen')

  const data = randomSpawnData(position)
  const obj = await ajna.createObject(data)

  // Für alle authentifizierten Spieler sichtbar + interaktiv (Multiplayer-Demo).
  try {
    await ajna.addPermission(obj.id, {
      subject_type: 'authenticated',
      rights: ['view'],
      interact_actions: data.state.actions.map(a => a.key),
    })
  } catch (err) {
    console.warn('[spawn] Freigabe fehlgeschlagen:', err?.message || err)
  }
  return obj
}

/**
 * Erzeugt ein zufälliges Objekt an `position`, öffnet es zur Bearbeitung im
 * Editor und sagt es (optional) an. Für das "Zufälliges Objekt…"-Kontextmenü
 * in Karte/AR. Das Objekt existiert sofort; der Editor zeigt name/Position zum
 * Feinschliff (Speichern = partielles Update, behält appearance/state).
 * @param {{ajna:object, editorUI?:object, position:object, announcer?:object}} opts
 */
export async function spawnRandomAndEdit({ ajna, editorUI, position, announcer }) {
  const obj = await spawnRandomHere({ ajna, position })
  try { announcer?.created?.(obj) } catch {}
  try { editorUI?.fillEditor?.(obj) } catch (err) { console.warn('[spawn] fillEditor:', err?.message || err) }
  return obj
}
