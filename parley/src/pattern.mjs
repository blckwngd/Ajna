// ─────────────────────────────────────────────────────────────────────────
//  Parley · Muster — kompilieren und vergleichen
// ─────────────────────────────────────────────────────────────────────────
// Die Mustersprache ist absichtlich klein. Sie soll von jemandem gelesen und
// geschrieben werden können, der keine regulären Ausdrücke mag:
//
//   hallo                      wörtlich
//   *                          beliebig viele Wörter (auch keine) → {1}, {2}, …
//   ?                          genau ein Wort                     → {1}, {2}, …
//   #                          eine Zahl                          → {1}, {2}, …
//   (guten tag|moin)           Alternativen, auch mehrwortig
//   [bitte]                    darf fehlen
//   @gruss                     Alternativen aus einer benannten Liste
//
// Groß-/Kleinschreibung, Umlaute und Satzzeichen sind egal — beide Seiten
// laufen vorher durch `normalize`.

import { normalizePattern } from './text.mjs'

/**
 * Muster-Text in einen Knotenbaum übersetzen.
 * @param {string} muster
 * @param {Record<string, string[]>} listen  benannte Listen für `@name`
 * @returns {object[]} Knotenfolge
 */
export function compilePattern(muster, listen = {}) {
  const text = normalizePattern(muster)
  const { nodes, rest } = parseFolge(text, 0, listen)
  if (rest < text.length) {
    throw new SyntaxError(`Parley: Muster nicht lesbar ab Position ${rest}: "${muster}"`)
  }
  return nodes
}

// Folge von Knoten bis zum Ende oder bis zu einem schließenden Zeichen.
function parseFolge(text, i, listen, stopper = '') {
  const nodes = []
  while (i < text.length) {
    const c = text[i]
    if (stopper.includes(c)) break
    if (c === ' ') { i++; continue }
    if (c === '*') { nodes.push({ t: 'star' }); i++; continue }
    if (c === '?') { nodes.push({ t: 'one' }); i++; continue }
    if (c === '#') { nodes.push({ t: 'num' }); i++; continue }
    if (c === '(') {
      const { options, rest } = parseAlternativen(text, i + 1, listen, ')')
      nodes.push({ t: 'alt', options }); i = rest; continue
    }
    if (c === '[') {
      const { nodes: inner, rest } = parseFolge(text, i + 1, listen, ']')
      if (text[rest] !== ']') throw new SyntaxError('Parley: "[" ohne "]"')
      nodes.push({ t: 'opt', nodes: inner }); i = rest + 1; continue
    }
    if (c === '@') {
      let j = i + 1
      while (j < text.length && /[\p{L}\p{N}_]/u.test(text[j])) j++
      const name = text.slice(i + 1, j)
      const werte = listen[name]
      if (!Array.isArray(werte)) throw new SyntaxError(`Parley: unbekannte Liste "@${name}"`)
      nodes.push({ t: 'alt', options: werte.map(w => parseFolge(normalizePattern(w), 0, listen).nodes) })
      i = j; continue
    }
    // Wörtliches Wort
    let j = i
    while (j < text.length && !' *?#()[]|@'.includes(text[j])) j++
    if (j === i) j++          // unbekanntes Zeichen überspringen statt hängen
    nodes.push({ t: 'word', w: text.slice(i, j) })
    i = j
  }
  return { nodes, rest: i }
}

function parseAlternativen(text, i, listen, schluss) {
  const options = []
  let cur = []
  while (i < text.length) {
    if (text[i] === schluss) { options.push(cur); return { options, rest: i + 1 } }
    if (text[i] === '|') { options.push(cur); cur = []; i++; continue }
    const { nodes, rest } = parseFolge(text, i, listen, '|' + schluss)
    cur = cur.concat(nodes)
    if (rest === i) i++       // Fortschrittsgarantie
    else i = rest
  }
  throw new SyntaxError(`Parley: "(" ohne "${schluss}"`)
}

/**
 * Tokens gegen ein kompiliertes Muster prüfen.
 * @param {object[]} nodes  aus `compilePattern`
 * @param {string[]} tokens aus `tokenize` (kleingeschrieben, gefaltet)
 * @param {string[]} [roh]  dieselben Wörter in Originalschreibweise; daraus
 *                          entstehen die Funde. Fehlt sie, gilt `tokens`.
 * @returns {string[]|null} die Wildcard-Funde ({1}, {2}, …) oder null
 */
export function matchPattern(nodes, tokens, roh = tokens) {
  const caps = []
  return lauf(nodes, 0, tokens, 0, caps, roh) ? caps : null
}

// Rekursiver Vergleich mit Backtracking. Eingaben sind kurz (ein Chat-Satz),
// deshalb reicht das — kein Automat nötig.
function lauf(nodes, ni, tokens, ti, caps, roh) {
  if (ni >= nodes.length) return ti === tokens.length
  const n = nodes[ni]

  switch (n.t) {
    case 'word':
      if (tokens[ti] !== n.w) return false
      return lauf(nodes, ni + 1, tokens, ti + 1, caps, roh)

    case 'one':
      if (ti >= tokens.length) return false
      caps.push(roh[ti])
      if (lauf(nodes, ni + 1, tokens, ti + 1, caps, roh)) return true
      caps.pop(); return false

    case 'num':
      if (ti >= tokens.length || !/^\d+$/.test(tokens[ti])) return false
      caps.push(roh[ti])
      if (lauf(nodes, ni + 1, tokens, ti + 1, caps, roh)) return true
      caps.pop(); return false

    case 'star': {
      // Kürzest zuerst — "* hallo *" soll bei "sag mal hallo du" das erste
      // Sternchen auf "sag mal" setzen, nicht gierig alles schlucken.
      for (let len = 0; ti + len <= tokens.length; len++) {
        caps.push(roh.slice(ti, ti + len).join(' '))
        if (lauf(nodes, ni + 1, tokens, ti + len, caps, roh)) return true
        caps.pop()
      }
      return false
    }

    case 'alt':
      for (const opt of n.options) {
        const tiefe = caps.length
        if (lauf(opt.concat(nodes.slice(ni + 1)), 0, tokens, ti, caps, roh)) return true
        caps.length = tiefe
      }
      return false

    case 'opt': {
      const tiefe = caps.length
      if (lauf(n.nodes.concat(nodes.slice(ni + 1)), 0, tokens, ti, caps, roh)) return true
      caps.length = tiefe
      return lauf(nodes, ni + 1, tokens, ti, caps, roh)
    }

    default:
      return false
  }
}

/**
 * Wörtlicher Vorschlagstext eines Musters — für abgeleitete Auswahlantworten.
 * Liefert null, sobald etwas Freies (Wildcard) drinsteckt: daraus lässt sich
 * kein sinnvoller Knopf bauen.
 * @param {object[]} nodes
 * @returns {string|null}
 */
export function literalOf(nodes) {
  const teile = []
  for (const n of nodes) {
    if (n.t === 'word') { teile.push(n.w); continue }
    if (n.t === 'alt') {
      const erste = n.options[0]
      if (!erste) return null
      const s = literalOf(erste)
      if (s === null) return null
      if (s) teile.push(s)
      continue
    }
    if (n.t === 'opt') continue      // Weglassbares weglassen
    return null                      // star/one/num → kein Vorschlag
  }
  const s = teile.join(' ').trim()
  return s ? s : null
}
