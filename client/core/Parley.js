// ─────────────────────────────────────────────────────────────────────────
//  Ajna · Parley — Dialoge für Figuren
// ─────────────────────────────────────────────────────────────────────────
// Dünne Schicht über dem eigenständigen Parley-Paket (`/parley`). Parley
// selbst weiß nichts von Ajna: es bekommt Text, liefert Text, Auswahlantworten
// und Aktionen. Hier steht, was Ajna daraus macht — welcher Dialogsatz zu
// welchem Archetyp gehört, welche Variablen eine Figur mitbringt und wie eine
// Sitzung heißt.
//
// Aufrufer:
//   • Agents  — `agents/lib/dialogs.mjs` lädt die Standardsätze von Platte und
//               baut damit eine Maschine (siehe World-Director).
//   • Client  — vorbereitet für objekt-eigene Dialoge aus `state.parley`
//               (`objectDialog`); die Oberfläche wertet sie noch nicht aus.
//
// Aktionen (`do`) sind bewusst NICHT hier verdrahtet: Was „anim" bedeutet,
// weiß der Aufrufer. Ein Agent ruft setAnimation, der Client spielt es lokal.

import { Parley, Conversation } from '../../parley/index.mjs'

export { Parley, Conversation }

/** Archetyp → Dialogsatz. `state.dialog_set` überschreibt das pro Objekt. */
export const ARCHETYPE_DIALOG = {
  npc: 'mensch',
  enemy: 'gestalt',
  animal: 'tier',
  dragon: 'drache',
}

/** Dialogsätze, die ein Ajna-Server standardmäßig mitbringt (Ordner `/dialogs`). */
export const STANDARD_DIALOGS = ['basis', 'mensch', 'gestalt', 'tier', 'drache']

/**
 * Welcher Dialogsatz gehört zu diesem Objekt?
 * @param {object} record  PocketBase-Objekt
 * @returns {string}
 */
export function dialogNameFor(record) {
  const s = record?.state || {}
  const eigen = typeof s.dialog_set === 'string' ? s.dialog_set.trim() : ''
  if (eigen) return eigen
  return ARCHETYPE_DIALOG[s.archetype] || ARCHETYPE_DIALOG[record?.type] || 'basis'
}

/**
 * Startvariablen für ein Gespräch mit dieser Figur.
 * `name` und `art` benutzen die mitgelieferten Dialogsätze in ihren Texten.
 * @param {object} record
 * @returns {object}
 */
export function dialogVarsFor(record) {
  const s = record?.state || {}
  return {
    name: record?.name || 'Jemand',
    art: s.archetype || record?.type || 'Gestalt',
    objekt: record?.id || null,
    ...(s.dialog_vars && typeof s.dialog_vars === 'object' ? s.dialog_vars : {}),
  }
}

/**
 * Sitzungsschlüssel: ein Gespräch je Spieler UND Figur. Zwei Spieler reden
 * unabhängig mit derselben Figur, derselbe Spieler führt mit zwei Figuren
 * zwei Gespräche.
 * @param {string} userId
 * @param {string} objectId
 * @returns {string}
 */
export const talkSessionId = (userId, objectId) => `${userId || 'anon'}@${objectId || '?'}`

// ── Objekt-eigene Dialoge ────────────────────────────────────────────────
// `state.parley` darf jeder Objekt-Besitzer schreiben. Deshalb kommt hier
// eine Obergrenze davor: ein Muster mit vielen Wildcards kann den Vergleich
// exponentiell teuer machen, und das liefe im Browser des BESUCHERS.
const GRENZEN = { rules: 120, patterns: 20, wildcards: 6, textlen: 2000 }

/**
 * Objekt-eigenen Dialogsatz aus `state.parley` lesen und entschärfen.
 * @param {object} record
 * @returns {object|null} Parley-Dokument oder null
 */
export function objectDialog(record) {
  const roh = record?.state?.parley
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return null
  try {
    const doc = {
      ...roh,
      name: String(roh.name || `objekt:${record?.id || 'x'}`),
      rules: begrenzeRegeln(roh.rules),
      fallback: begrenzeRegeln(roh.fallback),
    }
    return doc
  } catch (err) {
    console.warn('[parley] Objekt-Dialog verworfen:', err?.message || err)
    return null
  }
}

function begrenzeRegeln(regeln) {
  if (!Array.isArray(regeln)) return []
  return regeln.slice(0, GRENZEN.rules).map(r => {
    const when = (Array.isArray(r?.when) ? r.when : r?.when ? [r.when] : [])
      .slice(0, GRENZEN.patterns)
      .map(String)
      .filter(w => w.length <= 200 && (w.match(/[*?#]/g) || []).length <= GRENZEN.wildcards)
    const then = (Array.isArray(r?.then) ? r.then : r?.then ? [r.then] : [])
      .slice(0, 20)
      .map(t => typeof t === 'string' ? t.slice(0, GRENZEN.textlen) : t)
    return { ...r, when, then }
  })
}

/**
 * Maschine mit einem Satz Dokumente bauen.
 * @param {object[]} docs
 * @param {{rng?: () => number, maxChoices?: number}} [opts]
 * @returns {Parley}
 */
export function createParley(docs = [], opts = {}) {
  return new Parley(docs, opts)
}
