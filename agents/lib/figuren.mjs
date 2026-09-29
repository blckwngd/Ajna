// figuren.mjs — fest entworfene Figuren aus `figuren/*.figur.json`.
//
// WOFÜR: Der World-Director bevölkert die Welt mit Zufall — Namen aus Listen,
// Wege aus dem Straßennetz, vier zufällige Dialogzeilen. Das belebt, aber es
// trägt nichts. Wer eine Figur mit eigenem Dialog, eigener Aufgabe und eigenem
// Ort bauen will, braucht das Gegenteil: etwas, das bleibt.
//
// DER UNTERSCHIED IST EIN MERKER, kein zweites System. Eine entworfene Figur
// ist ein ganz normales Director-Objekt mit `state.persistent = true` — sie
// wird beim Verlassen der Gegend nicht abgeräumt und ist beim Wiederkommen
// noch da. Alles andere (Dialoge über `state.dialog_set`, Aufträge, Bewegung)
// gab es schon; es war nur nie etwas da, das lange genug stehen blieb, um es
// zu nutzen.
//
// WARUM JSON UND NICHT CODE: Eine Figur zu entwerfen ist Schreibarbeit, keine
// Programmierarbeit. Eine Datei je Figur, damit zwei Leute gleichzeitig
// schreiben können, ohne sich in die Quere zu kommen.
//
// AUFBAU einer `*.figur.json`:
//
//     {
//       "id": "marktfrau-neuwied",        // PFLICHT, dauerhaft, nie ändern
//       "name": "Marktfrau Agnes",
//       "type": "npc",                    // npc | enemy | animal | hint | item
//       "lat": 50.4297, "lon": 7.4608,
//       "description": "Steht seit dreissig Jahren am selben Platz.",
//       "dialog": "marktfrau",            // Parley-Paket (dialogs/<name>.parley.json)
//       "dialog_vars": { "ware": "Äpfel" },
//       "movement": "still",              // still | free  (Vorgabe: still)
//       "appearance": { "emoji": "🧺", "gltf": "Soldier.glb" }
//     }
//
// Die alten deutschen Feldnamen (`typ`, `beschreibung`, `bewegung`, `aussehen`,
// `auftrag`) werden weiter gelesen — siehe docs/key-rename.md.
//
// `id` IST DER ANKER. Daran erkennt der Director seine Figur wieder; ändert man
// sie, entsteht eine zweite und die alte bleibt als Waise stehen. Alles andere
// darf sich ändern — Name, Ort, Dialog —, und beim nächsten Start zieht der
// Director es nach.

import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HIER = dirname(fileURLToPath(import.meta.url))
export const FIGUREN_ORDNER = join(HIER, '..', '..', 'figuren')

/** Erlaubte Typen — dieselben Archetypen, die der Director ohnehin kennt. */
const TYPEN = new Set(['npc', 'enemy', 'animal', 'dragon', 'hint', 'item', 'diamond'])

/** Nachweisarten, die der Ablauf wirklich auswertet (siehe QuestEditor.NACHWEIS). */
const NACHWEIS = new Set(['photo', 'onSite', 'item'])
/** Alte deutsche Schreibweisen in Figur-Dateien (docs/key-rename.md). */
const NACHWEIS_ALT = { foto: 'photo', vorOrt: 'onSite', gegenstand: 'item' }
/** Abnahmewege, die der Server kennt (siehe quest/publish). */
const VERIFY = new Set(['items', 'issuer', 'agent', 'group', 'crowd'])

/**
 * Den Auftrags-Abschnitt einer Figur prüfen.
 *
 * WARUM EINE BELOHNUNG PFLICHT IST: Der Server lehnt eine Ausschreibung ohne
 * hinterlegte Gegenstände ab — „rewards are never minted". Ein Auftrag ohne
 * Belohnung wäre also keine halbe Figur, sondern eine, die beim Veröffentlichen
 * mit 400 scheitert. Lieber hier sagen, warum.
 *
 * @returns {{auftrag?: object, fehler?: string}}
 */
export function pruefeAuftrag(roh, quelle = '') {
  const a = roh && typeof roh === 'object' ? roh : null
  if (!a) return {}                                   // kein Auftrag = kein Fehler

  const text = String(a.text ?? '').trim()
  if (!text) return { fehler: `${quelle}: "quest.text" fehlt — was soll getan werden?` }
  const summary = String(a.summary ?? a.kurz ?? '').trim() || text.slice(0, 118)

  const proof = (Array.isArray(a.proof ?? a.nachweis) ? (a.proof ?? a.nachweis) : [])
    .map(x => String(x).trim()).filter(Boolean)
    .map(x => NACHWEIS_ALT[x] || x)
  for (const n of proof) {
    if (!NACHWEIS.has(n)) return { fehler: `${quelle}: "${n}" ist keine Nachweisart (${[...NACHWEIS].join(', ')})` }
  }

  const verify = String(a.review ?? a.abnahme ?? a.verify ?? 'issuer').trim()
  if (!VERIFY.has(verify)) return { fehler: `${quelle}: "review" ist "${verify}", erlaubt: ${[...VERIFY].join(', ')}` }

  const b = (a.reward ?? a.belohnung)
  const r = (b && typeof b === 'object') ? b : {}
  const rewardName = String(r.name ?? '').trim()
  if (!rewardName) {
    return { fehler: `${quelle}: "quest.reward.name" fehlt — der Server verlangt echte Gegenstände, `
      + 'Belohnungen werden nie aus dem Nichts erzeugt' }
  }
  const count = Math.max(1, Math.min(20, Math.round(Number(r.count ?? r.anzahl) || 1)))

  // Wiederholbar: Der Vorrat begrenzt, wie oft. `perRun` Stücke gehen pro
  // Abschluss an den Spieler — mehr, als hinterlegt ist, lehnt der Server ab.
  const repeatable = (a.repeatable ?? a.wiederholbar) === true
  const perRun = repeatable
    ? Math.max(1, Math.min(count, Math.round(Number(r.perRun ?? r.jeDurchlauf) || 1)))
    : 0

  // Wann ein bei der Figur angebotener Auftrag ZUSÄTZLICH in der Regionsliste
  // erscheint: 0 = sofort, n Stunden = nach der Wartezeit, "nie" = nur im
  // Gespräch mit ihr. Siehe QuestEditor.ANBIETEN.
  const rohListAfter = a.listAfter ?? a.anbieten
  const listAfter = rohListAfter === 'nie' || rohListAfter === 'never'
    ? -1 : Math.max(0, Math.round(Number(rohListAfter) || 0))

  return {
    quest: {
      text, summary,
      place: String(a.place ?? a.ort ?? '').trim(),
      proof, verify,
      karma: Math.max(0, Math.round(Number(a.karma) || 0)),
      onSiteRadiusM: Math.max(10, Math.round(Number(a.onSiteRadiusM ?? a.vorOrtRadiusM) || 150)),
      acceptRadiusM: Math.max(0, Math.round(Number(a.acceptRadiusM ?? a.annahmeRadiusM) || 0)),
      listAfter, repeatable, perRun,
      reward: {
        name: rewardName.length > 32 ? `${rewardName.slice(0, 31)}…` : rewardName,
        count,
        emoji: String(r.emoji ?? '✨').trim(),
        description: String(r.description ?? r.beschreibung ?? '').trim(),
      },
    },
  }
}

/**
 * Eine Figur-Definition auf Brauchbarkeit prüfen.
 *
 * Gibt `{ figur }` oder `{ fehler }` zurück — nie eine halbe Figur. Eine Figur
 * ohne Ort oder ohne Kennung ist nicht „fast fertig", sondern unbrauchbar:
 * Ohne Kennung erkennt der Director sie beim nächsten Start nicht wieder und
 * legt sie ein zweites Mal an.
 */
export function pruefeFigur(roh, quelle = '') {
  const f = roh && typeof roh === 'object' ? roh : {}
  const id = String(f.id ?? '').trim()
  if (!id) return { fehler: `${quelle}: "id" fehlt` }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return { fehler: `${quelle}: "id" darf nur Buchstaben, Ziffern, - und _ enthalten` }

  const lat = Number(f.lat), lon = Number(f.lon)
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { fehler: `${quelle}: "lat" fehlt oder liegt daneben` }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return { fehler: `${quelle}: "lon" fehlt oder liegt daneben` }

  const type = String(f.type ?? f.typ ?? 'npc').trim().toLowerCase()
  if (!TYPEN.has(type)) return { fehler: `${quelle}: "type" ist "${type}", erlaubt: ${[...TYPEN].join(', ')}` }

  const { quest, fehler: questFehler } = pruefeAuftrag(f.quest ?? f.auftrag, quelle)
  if (questFehler) return { fehler: questFehler }

  const name = String(f.name ?? '').trim() || id
  // `objects.name` fasst 32 Zeichen.
  // `frei`/`steht` sind die alten Schreibweisen (docs/key-rename.md).
  const rohMovement = String(f.movement ?? f.bewegung ?? 'still').trim().toLowerCase()
  const movement = (rohMovement === 'free' || rohMovement === 'frei') ? 'free' : 'still'

  const appearance = (f.appearance ?? f.aussehen)
  return {
    figur: {
      id,
      name: name.length > 32 ? `${name.slice(0, 31)}…` : name,
      type,
      lat, lon,
      description: String(f.description ?? f.beschreibung ?? '').trim(),
      dialog: String(f.dialog ?? '').trim(),
      dialog_vars: (f.dialog_vars && typeof f.dialog_vars === 'object') ? f.dialog_vars : {},
      movement,
      appearance: (appearance && typeof appearance === 'object') ? appearance : {},
      ...(quest ? { quest } : {}),
    },
  }
}

/**
 * Alle Figuren des Ordners lesen.
 *
 * EIN FEHLER IN EINER DATEI KIPPT NICHT DEN REST: Wer an einer Figur schreibt
 * und ein Komma vergisst, soll nicht die anderen verlieren. Die kaputte wird
 * gemeldet und übersprungen.
 *
 * @returns {{figuren: object[], fehler: string[]}}
 */
export function ladeFiguren(ordner = FIGUREN_ORDNER) {
  let dateien = []
  try {
    dateien = readdirSync(ordner).filter(f => f.endsWith('.figur.json')).sort()
  } catch {
    return { figuren: [], fehler: [] }   // kein Ordner = keine Figuren, kein Fehler
  }

  const figuren = []
  const fehler = []
  const gesehen = new Set()
  for (const datei of dateien) {
    let roh
    try { roh = JSON.parse(readFileSync(join(ordner, datei), 'utf8')) }
    catch (err) { fehler.push(`${datei}: kein gültiges JSON (${err.message})`); continue }

    const { figur, fehler: f } = pruefeFigur(roh, datei)
    if (f) { fehler.push(f); continue }
    // ZWEI DATEIEN MIT DERSELBEN KENNUNG sind ein Tippfehler, kein Vorsatz —
    // stillschweigend die zweite gewinnen zu lassen, wäre die schlechtere Wahl.
    if (gesehen.has(figur.id)) { fehler.push(`${datei}: Kennung "${figur.id}" gibt es schon`); continue }
    gesehen.add(figur.id)
    figuren.push(figur)
  }
  return { figuren, fehler }
}

/**
 * Eine Figur in die Felder eines Ajna-Objekts übersetzen.
 *
 * @param {object} figur   geprüfte Figur aus `ladeFiguren`
 * @param {string} modellBasis  URL-Präfix für `aussehen.gltf`
 */
export function alsObjekt(figur, modellBasis = '/models/') {
  const appearance = { ...figur.appearance }
  if (appearance.gltf && !/^https?:|^\//.test(appearance.gltf)) {
    appearance.gltf = modellBasis + appearance.gltf
  }
  return {
    name: figur.name,
    type: figur.type,
    description: figur.description,
    lat: figur.lat, lon: figur.lon, altitude: 0,
    appearance,
    state: {
      source: 'world-director',
      director: true,            // damit die Profil-Heilung sie kennt
      archetype: figur.type,
      persistent: true,          // DER Unterschied: überlebt das Verlassen der Gegend
      figure_id: figur.id,
      movement: figur.movement,
      ...(figur.dialog ? { dialog_set: figur.dialog } : {}),
      ...(Object.keys(figur.dialog_vars).length ? { dialog_vars: figur.dialog_vars } : {}),
    },
  }
}

/**
 * Stabiler Vergleich zweier Werte — unabhängig von der Schlüsselreihenfolge.
 *
 * DIE FALLE: `JSON.stringify` hängt an der Reihenfolge. PocketBase gibt
 * `{"color":…,"emoji":…}` zurück, wo wir `{"emoji":…,"color":…}` geschickt
 * haben — inhaltlich dasselbe, als Zeichenkette verschieden. Ohne diese
 * Sortierung meldete jeder Start „geaendert" und schrieb dieselben Werte
 * erneut, samt Realtime-Nachricht an alle Clients.
 */
const stabil = (v) => {
  if (Array.isArray(v)) return `[${v.map(stabil).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stabil(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

/**
 * Was sich an einem bestehenden Objekt geändert hat.
 *
 * Nur die Felder, die aus der Datei stammen — ein Objekt, das der Director
 * gerade bewegt oder das ein Spieler beschädigt hat, soll nicht bei jedem Start
 * zurückgesetzt werden. Deshalb KEIN `state`-Rundumschlag, sondern gezielt.
 *
 * @returns {object|null}  Patch oder null, wenn alles passt
 */
export function unterschied(figur, objekt, modellBasis = '/models/') {
  const soll = alsObjekt(figur, modellBasis)
  const patch = {}
  for (const feld of ['name', 'type', 'description', 'lat', 'lon']) {
    if (objekt?.[feld] !== soll[feld]) patch[feld] = soll[feld]
  }
  if (stabil(objekt?.appearance ?? {}) !== stabil(soll.appearance)) {
    patch.appearance = soll.appearance
  }
  // State zusammenführen statt ersetzen: `motion`, `hp` und was der Betrieb
  // sonst anlegt, gehören nicht der Datei.
  const istState = objekt?.state ?? {}
  const sollState = soll.state
  const stateAnders = Object.keys(sollState).some(k => stabil(istState[k]) !== stabil(sollState[k]))
  if (stateAnders) patch.state = { ...istState, ...sollState }
  return Object.keys(patch).length ? patch : null
}

// ─── Aufträge an einer Figur ──────────────────────────────────────────────
//
// Ein Auftrag ist in Ajna ein EIGENES Objekt (`type: "call"`) — die Routen
// prüfen das ausdrücklich. Eine Figur kann also nicht selbst einer sein; sie
// bekommt einen daneben gestellt, gebunden über `state.figure_quest`.
//
// WARUM NICHT AUS DEM DIALOG HERAUS: `do:` kennt nur `anim:`, und das ist
// Absicht — ein Dialogsatz ist Text, den irgendwann jemand anders beisteuert,
// und darf kein Karma verteilen. Die Ausschreibung bleibt beim Agent.

/** Felder des Auftragsobjekts, so wie der Server sie ablegt (`state.call`). */
export function alsAuftragsObjekt(figur) {
  const a = figur.quest
  if (!a) return null
  const call = {
    task: a.text,
    summary: a.summary,
    place: a.place,
    karma: a.karma,
    proof: [...a.proof],
    rewardStep: 0,
  }
  // Melde-Nähe nur, wenn der Nachweis sie überhaupt verlangt — sonst stünde
  // eine Zahl im Auftrag, die niemand ausliest (wie in questMapping).
  if (a.proof.includes('onSite')) call.onSiteRadiusM = a.onSiteRadiusM
  if (a.acceptRadiusM > 0) call.acceptRadiusM = a.acceptRadiusM
  if (a.listAfter < 0) call.listed = false
  else if (a.listAfter > 0) { call.listed = false; call.listAfterHours = a.listAfter }
  else call.listed = true
  return {
    name: a.summary.length > 32 ? `${a.summary.slice(0, 31)}…` : a.summary,
    type: 'call',
    description: a.text,
    // Auf DIESELBE Stelle wie die Figur: Wer sie anspricht, steht beim Auftrag.
    lat: figur.lat, lon: figur.lon, altitude: 0,
    appearance: { emoji: '📜' },
    state: {
      source: 'world-director',
      figure_quest: figur.id,       // Bindung an die Figur
      persistent: true,             // überlebt das Verlassen der Gegend wie sie
      call,
    },
  }
}

/**
 * Fingerabdruck der Auftrags-Definition.
 *
 * WOZU: Veröffentlichen setzt den Lebenszyklus ZURÜCK — `status` auf „open",
 * `claimedBy` weg. Bei jedem Agenten-Start neu auszuschreiben würde also die
 * Arbeit wegwerfen, die jemand schon hineingesteckt hat. Am Fingerabdruck
 * erkennt der Director, ob sich überhaupt etwas geändert hat.
 */
export const auftragsAbdruck = (figur) => figur?.quest ? stabil(figur.quest) : ''

/**
 * Felder des Auftrags, die aus der DATEI stammen — alles andere gehört dem
 * Lebenszyklus (Status, gebundene Belohnung, wer ihn angenommen hat).
 */
const BESCHREIBEND = ['task', 'summary', 'place', 'karma', 'proof',
  'onSiteRadiusM', 'acceptRadiusM', 'listed', 'listAfterHours']

/**
 * Was sich am ausgeschriebenen Auftrag geändert hat — ohne ihn neu
 * auszuschreiben.
 *
 * WARUM NICHT EINFACH NEU VERÖFFENTLICHEN: `quest/publish` setzt den
 * Lebenszyklus zurück — `status` auf „open", `claimedBy` weg. Wer nur einen
 * Tippfehler im Auftragstext behebt, würde damit dem Spieler, der gerade
 * unterwegs ist, den Auftrag unter den Füßen wegziehen. Ein Patch auf die
 * beschreibenden Felder tut das nicht.
 *
 * @returns {object|null}
 */
export function auftragsUnterschied(figur, objekt) {
  const soll = alsAuftragsObjekt(figur)
  if (!soll) return null
  const patch = {}
  for (const feld of ['name', 'description', 'lat', 'lon']) {
    if (objekt?.[feld] !== soll[feld]) patch[feld] = soll[feld]
  }
  const istState = objekt?.state ?? {}
  const call = { ...(istState.call ?? {}) }
  for (const k of BESCHREIBEND) delete call[k]
  for (const k of BESCHREIBEND) if (k in soll.state.call) call[k] = soll.state.call[k]
  const sollState = { ...istState, ...soll.state, call }
  if (stabil(istState) !== stabil(sollState)) patch.state = sollState
  return Object.keys(patch).length ? patch : null
}

/**
 * Rumpf für `POST /api/objects/{id}/quest/publish`.
 *
 * Wiederholbarkeit und Abnahmeweg gehören hierhin und nicht in den Zustand:
 * Der Server prüft beim Ausschreiben, dass der Vorrat für die Durchläufe
 * reicht. Ein Client, der das selbst in `state.call` schriebe, ginge an der
 * Prüfung vorbei.
 */
export function auftragsBody(figur, belohnungsIds) {
  const a = figur.quest
  const body = { rewardItems: [...belohnungsIds], verify: a.verify }
  if (a.repeatable) { body.repeatable = true; body.rewardPerRun = a.perRun }
  return body
}

/** Belohnungs-Gegenstand, den der Aussteller besitzen und hinterlegen muss. */
export function alsBelohnungsObjekt(figur, nr = 1) {
  const b = figur?.quest?.reward
  if (!b) return null
  return {
    name: b.name,
    type: 'item',
    description: b.description || `Belohnung aus dem Auftrag von ${figur.name}.`,
    lat: figur.lat, lon: figur.lon, altitude: 0,
    appearance: { emoji: b.emoji || '✨' },
    state: {
      source: 'world-director',
      persistent: true,
      portable: true,
      figure_reward: `${figur.id}#${nr}`,
    },
  }
}
