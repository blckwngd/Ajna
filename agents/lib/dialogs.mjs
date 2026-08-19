// ─────────────────────────────────────────────────────────────────────────
//  Agent-Library · Dialoge — Standardsätze von Platte laden
// ─────────────────────────────────────────────────────────────────────────
// Der Node-Teil von Parley: die mitgelieferten Dialogsätze liegen als JSON in
// `/dialogs`. Alles Weitere (welcher Satz zu welchem Archetyp gehört, wie eine
// Sitzung heißt) steht in der Ajna-Library — siehe client/core/Parley.js.
//
//   import { npcParley } from './lib/dialogs.mjs'
//   import { dialogNameFor, dialogVarsFor, talkSessionId } from '../client/core/Parley.js'
//
//   const parley = npcParley()
//   const chat   = parley.open(dialogNameFor(obj), talkSessionId(userId, obj.id),
//                              { vars: dialogVarsFor(obj) })
//   const antwort = chat.say('hallo')

import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createParley } from '../../client/core/Parley.js'

const HIER = dirname(fileURLToPath(import.meta.url))
export const DIALOG_DIR = join(HIER, '..', '..', 'dialogs')

/**
 * Alle `*.parley.json` eines Ordners lesen.
 * Ein kaputtes Dokument bringt nicht den Agent zu Fall — es wird gemeldet und
 * übersprungen; die übrigen Figuren reden weiter.
 * @param {string} [dir]
 * @param {(msg: string) => void} [warn]
 * @returns {object[]} Parley-Dokumente
 */
export function loadDialogSets(dir = DIALOG_DIR, warn = console.warn) {
  let dateien = []
  try {
    dateien = readdirSync(dir).filter(f => f.endsWith('.parley.json')).sort()
  } catch (err) {
    warn(`[parley] Dialogordner nicht lesbar (${dir}): ${err?.message || err}`)
    return []
  }
  const docs = []
  for (const f of dateien) {
    try {
      docs.push(JSON.parse(readFileSync(join(dir, f), 'utf8')))
    } catch (err) {
      warn(`[parley] ${f} übersprungen: ${err?.message || err}`)
    }
  }
  return docs
}

/**
 * Fertige Dialogmaschine mit den Standardsätzen.
 * @param {{dir?: string, extra?: object[], rng?: () => number, maxChoices?: number, warn?: Function}} [opts]
 * @returns {import('../../client/core/Parley.js').Parley}
 */
export function npcParley(opts = {}) {
  const { dir, extra = [], warn, ...rest } = opts
  return createParley([...loadDialogSets(dir, warn), ...extra], rest)
}
