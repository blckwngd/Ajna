// ─────────────────────────────────────────────────────────────────────────
//  Parley · Text — Normalisierung, Personentausch, Platzhalter
// ─────────────────────────────────────────────────────────────────────────
// Alles, was mit rohem Text passiert, bevor oder nachdem gematcht wurde.
// Bewusst ohne Abhängigkeiten und ohne Sprachmodell: Dialoge sollen auf einem
// Raspberry Pi genauso laufen wie im Browser.

/**
 * Kleinschreiben und Diakritika auf den Grundbuchstaben falten.
 * "Schön!" → "schoen!", "Straße" → "strasse". Deutsche Umlaute gehen auf ihre
 * Umschrift, alles andere auf den Grundbuchstaben (é → e) — so trifft ein
 * Muster "schoen" die Eingabe "schön" und umgekehrt.
 * Satzzeichen bleiben stehen — die Muster-Sonderzeichen brauchen sie noch.
 */
export const fold = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/ß/g, 'ss')
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')

/**
 * Eingabetext in Vergleichsform: gefaltet, ohne Satzzeichen, einfache Blanks.
 * @returns {string} z. B. "Hallo, wie geht's?" → "hallo wie geht s"
 */
export const normalize = (s) => fold(s)
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()

/** Eingabe in Tokens (Wörter). Leerer Text → leeres Array. */
export const tokenize = (s) => {
  const n = normalize(s)
  return n ? n.split(' ') : []
}

/**
 * Wie `tokenize`, liefert aber zusätzlich die Wörter in ORIGINALSCHREIBWEISE.
 * Beide Reihen sind gleich lang: die Faltung (ä → ae, ß → ss) ändert keine
 * Wortgrenzen, und getrennt wird auf beiden Seiten an denselben Stellen.
 *
 * Gebraucht für Wildcard-Funde: „Ich heiße Ada" soll `{1}` = „Ada" liefern,
 * nicht „ada" — verglichen wird trotzdem kleingeschrieben.
 *
 * @param {string} s
 * @returns {{norm: string[], roh: string[]}}
 */
export function tokenizePair(s) {
  const norm = tokenize(s)
  const roh = String(s ?? '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const rohArr = roh ? roh.split(' ') : []
  // Sicherheitsnetz: sollten die Reihen wider Erwarten auseinanderlaufen,
  // lieber normalisiert antworten als falsch zuordnen.
  return { norm, roh: rohArr.length === norm.length ? rohArr : norm }
}

/**
 * Musterform: wie `normalize`, aber die Steuerzeichen `* ? # [ ] ( ) | @`
 * überleben. Ohne das würde `hallo *` zu `hallo` zusammenfallen.
 */
export const normalizePattern = (s) => fold(s)
  .replace(/[^\p{L}\p{N}\s*?#[\]()|@]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()

// ── Personentausch ───────────────────────────────────────────────────────
// "ich mag dich" → "du magst mich". Wortweise und in EINEM Durchgang, sonst
// tauscht man ich→du und anschließend dasselbe du wieder zurück.
const SWAP_PAARE = [
  ['ich', 'du'], ['mich', 'dich'], ['mir', 'dir'],
  ['mein', 'dein'], ['meine', 'deine'], ['meinen', 'deinen'],
  ['meinem', 'deinem'], ['meiner', 'deiner'], ['meines', 'deines'],
  ['wir', 'ihr'], ['uns', 'euch'], ['unser', 'euer'], ['unsere', 'eure'],
  ['bin', 'bist'], ['habe', 'hast'], ['hab', 'hast'], ['war', 'warst'],
  ['werde', 'wirst'], ['kann', 'kannst'], ['will', 'willst'], ['mag', 'magst'],
  ['muss', 'musst'], ['soll', 'sollst'], ['weiss', 'weisst'],
]
const SWAP = new Map()
for (const [a, b] of SWAP_PAARE) { SWAP.set(a, b); if (!SWAP.has(b)) SWAP.set(b, a) }

/** Perspektive drehen: aus der Aussage des Gegenübers die eigene machen. */
export const swapPerson = (s) => String(s ?? '')
  .split(/(\s+)/)
  .map(t => SWAP.get(fold(t)) ?? t)
  .join('')

// ── Platzhalter ──────────────────────────────────────────────────────────
// {1}..{9}   Wildcard-Fund aus dem Muster
// {swap:1}   derselbe Fund, Perspektive gedreht
// {name}     Variable aus der Sitzung
// {input}    die rohe Eingabe
// {rnd:a|b}  eine der Varianten
const PLATZHALTER = /\{([a-z0-9_.]+)(?::([^}]*))?\}/gi

/**
 * Platzhalter in einem Text ersetzen.
 * @param {string} text
 * @param {{caps?: string[], vars?: object, input?: string, rng?: () => number}} ctx
 */
export function fillIn(text, ctx = {}) {
  if (typeof text !== 'string' || !text.includes('{')) return text
  const { caps = [], vars = {}, input = '', rng = Math.random } = ctx
  return text.replace(PLATZHALTER, (ganz, schluessel, arg) => {
    const k = schluessel.toLowerCase()
    if (k === 'input') return input
    if (k === 'rnd' || k === 'random') {
      const opt = String(arg ?? '').split('|')
      return opt[Math.floor(rng() * opt.length)] ?? ''
    }
    if (k === 'swap') {
      const idx = Number(arg)
      const roh = Number.isFinite(idx) ? caps[idx - 1] : lookup(vars, String(arg || ''))
      return swapPerson(roh ?? '')
    }
    if (k === 'upper') return String(lookupOrCap(caps, vars, String(arg || ''))).toUpperCase()
    if (/^[1-9]$/.test(k)) return caps[Number(k) - 1] ?? ''
    const v = lookup(vars, schluessel)
    return v === undefined || v === null ? '' : String(v)
  })
}

const lookupOrCap = (caps, vars, key) =>
  /^[1-9]$/.test(key) ? (caps[Number(key) - 1] ?? '') : (lookup(vars, key) ?? '')

/** Punktpfad in einem Objekt lesen: "a.b" → obj.a.b. */
export function lookup(obj, pfad) {
  if (!obj || !pfad) return undefined
  if (!pfad.includes('.')) return obj[pfad]
  let cur = obj
  for (const teil of pfad.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[teil]
  }
  return cur
}

/** Punktpfad in einem Objekt schreiben (Zwischenebenen werden angelegt). */
export function assign(obj, pfad, wert) {
  if (!pfad.includes('.')) { obj[pfad] = wert; return }
  const teile = pfad.split('.')
  let cur = obj
  for (const t of teile.slice(0, -1)) {
    if (cur[t] === null || typeof cur[t] !== 'object') cur[t] = {}
    cur = cur[t]
  }
  cur[teile.at(-1)] = wert
}
