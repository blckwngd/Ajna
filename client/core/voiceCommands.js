// voiceCommands — the editable mapping from spoken phrases to action keys, plus
// a tolerant matcher. Engine-agnostic: it only turns a recognised transcript
// string into an action key for the LOCKED object.
//
// Easy to edit (two layers; the second needs NO rebuild):
//   1. DEFAULT_VOICE_COMMANDS below — synonyms / global aliases (shipped).
//   2. localStorage['ajna_voice_commands'] — a JSON array of the SAME shape that
//      extends/overrides the defaults at runtime (later: a settings-UI editor).
// On top of both, the matcher AUTO-derives phrases from the locked object's own
// action labels (record.state.actions[].label), so every object's actions are
// voice-callable out of the box — the lists above only add synonyms.
//
// Entry shape: { action: '<key>', phrases: ['…','…'] }
//   action  — the action key passed to interact() (e.g. 'examine', 'attack')
//   phrases — spoken variants; matched case/diacritic-insensitively + fuzzily

const STORAGE_KEY = 'ajna_voice_commands'
const LIGHT_STORAGE_KEY = 'ajna_voice_light'

// Button 3 (locked object) — spoken phrase → interact() action key.
export const DEFAULT_VOICE_COMMANDS = [
  { action: 'examine', phrases: ['untersuchen', 'was ist das', 'anschauen', 'inspizieren'] },
  { action: 'talk',    phrases: ['reden', 'sprechen', 'sprich', 'rede mit', 'hallo'] },
  { action: 'attack',  phrases: ['angriff', 'angreifen', 'attacke', 'kämpfen'] },
  { action: 'feed',    phrases: ['füttern', 'futter', 'essen geben'] },
  { action: 'collect', phrases: ['einsammeln', 'aufheben', 'nehmen', 'sammeln'] },
]

// Button 1 (wand light effect) — spoken phrase → CompLights effect id (see
// {"cmd":"light","id":N} in PROTOCOL.md). `action` is the numeric effect id.
export const DEFAULT_LIGHT_COMMANDS = [
  { action: 0,  phrases: ['aus', 'licht aus', 'dunkel', 'stopp'] },
  { action: 1,  phrases: ['rune', 'rune an'] },
  { action: 3,  phrases: ['grün'] },
  { action: 4,  phrases: ['blau'] },
  { action: 5,  phrases: ['regenbogen'] },
  { action: 6,  phrases: ['funkeln', 'sparkle', 'glitzern'] },
  { action: 7,  phrases: ['komet'] },
  { action: 8,  phrases: ['pulsieren', 'puls', 'warmes licht'] },
  { action: 10, phrases: ['stroboskop', 'strobo'] },
  { action: 11, phrases: ['scheinwerfer', 'volles licht', 'hell', 'taschenlampe'] },
  { action: 12, phrases: ['rune umschalten'] },
]

// Lowercase, fold diacritics + ß, strip punctuation, collapse whitespace. So
// "fÜttern!" ≈ "fuettern" ≈ "futtern".
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip combining accents
    .replace(/ß/g, 'ss')                            // ß → ss
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Merged command list: defaults + the localStorage override (phrases per action
// are concatenated; malformed JSON is ignored).
export function loadVoiceCommands() {
  let extra = []
  try {
    const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(STORAGE_KEY)
    if (raw) { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) extra = parsed }
  } catch {}
  const byAction = new Map()
  for (const c of [...DEFAULT_VOICE_COMMANDS, ...extra]) {
    if (!c || !c.action || !Array.isArray(c.phrases)) continue
    byAction.set(c.action, [...(byAction.get(c.action) || []), ...c.phrases])
  }
  return [...byAction.entries()].map(([action, phrases]) => ({ action, phrases }))
}

// Light-effect commands (Button 1). Same shape, but `action` is a numeric effect
// id (0 is valid = "off"), so the guard allows 0.
export function loadLightCommands() {
  let extra = []
  try {
    const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(LIGHT_STORAGE_KEY)
    if (raw) { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) extra = parsed }
  } catch {}
  const byAction = new Map()
  for (const c of [...DEFAULT_LIGHT_COMMANDS, ...extra]) {
    if (!c || c.action == null || !Array.isArray(c.phrases)) continue
    byAction.set(c.action, [...(byAction.get(c.action) || []), ...c.phrases])
  }
  return [...byAction.entries()].map(([action, phrases]) => ({ action, phrases }))
}

// Small Levenshtein (short tokens only) for fuzzy fallback so "untersuch"
// matches "untersuchen" despite STT word-ending wobble.
function lev(a, b) {
  const m = a.length, n = b.length
  if (!m) return n; if (!n) return m
  const d = new Array(n + 1)
  for (let j = 0; j <= n; j++) d[j] = j
  for (let i = 1; i <= m; i++) {
    let prev = d[0]; d[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = d[j]
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return d[n]
}

// Does the normalised transcript contain the normalised phrase (with a small
// per-token typo budget for single-word phrases)?
function phraseHit(transcriptNorm, phraseNorm) {
  if (!phraseNorm) return false
  if (transcriptNorm.includes(phraseNorm)) return true
  if (!phraseNorm.includes(' ')) {
    const budget = phraseNorm.length >= 6 ? 2 : 1
    for (const tok of transcriptNorm.split(' ')) {
      if (Math.abs(tok.length - phraseNorm.length) <= budget && lev(tok, phraseNorm) <= budget) return true
    }
  }
  return false
}

/**
 * Resolve a spoken transcript to an action key for the locked object.
 * @param {string} transcript     raw STT text
 * @param {Array}  commands       from loadVoiceCommands()
 * @param {Array}  objectActions  the locked object's actions [{key,label}] — used
 *                                for auto-vocab AND to restrict to supported actions
 * @returns {{action:string, phrase:string}|null}
 */
export function matchVoiceCommand(transcript, commands, objectActions = []) {
  const t = normalize(transcript)
  if (!t) return null
  // Only actions the object actually supports are eligible (empty set = allow all).
  const allowed = new Set((objectActions || []).map(a => a?.key).filter(Boolean))
  const candidates = []
  for (const a of (objectActions || [])) {                 // auto-vocab from labels
    if (a?.key && a?.label) candidates.push({ action: a.key, phrases: [a.label] })
  }
  for (const c of (commands || [])) {                      // configured synonyms
    if (allowed.size && !allowed.has(c.action)) continue
    candidates.push(c)
  }
  // Longest matching phrase wins (specific over generic).
  let best = null
  for (const c of candidates) {
    for (const p of (c.phrases || [])) {
      const pn = normalize(p)
      if (phraseHit(t, pn) && (!best || pn.length > best.phrase.length)) {
        best = { action: c.action, phrase: pn }
      }
    }
  }
  return best
}
