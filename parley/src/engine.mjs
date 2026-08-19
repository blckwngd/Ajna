// ─────────────────────────────────────────────────────────────────────────
//  Parley · Maschine — Dokumente, Sitzungen, Antworten
// ─────────────────────────────────────────────────────────────────────────
// Ablauf einer Antwort:
//
//   Eingabe → normalisieren → erste passende Regel im eigenen Dokument,
//   dann in den geerbten, dann Fallback (eigen, dann geerbt)
//   → `set` anwenden → `then` wählen → Platzhalter füllen
//   → Auswahlantworten bestimmen → Antwort
//
// Zustand lebt in der Sitzung, nicht im Dokument: ein Dokument kann tausend
// Gespräche gleichzeitig tragen.

import { compileDoc, prepareDoc } from './doc.mjs'
import { matchPattern, literalOf } from './pattern.mjs'
import { tokenizePair, fillIn, lookup, assign } from './text.mjs'

const MAX_CHOICES = 4

export class Parley {
  /**
   * @param {object|object[]} docs  ein oder mehrere Dialogsätze
   * @param {{rng?: () => number, maxChoices?: number}} [opts]
   */
  constructor(docs = [], opts = {}) {
    this.docs = new Map()
    this.rng = opts.rng || Math.random
    this.maxChoices = opts.maxChoices ?? MAX_CHOICES
    this._sessions = new Map()
    for (const d of (Array.isArray(docs) ? docs : [docs])) this.add(d)
  }

  /** Dialogsatz aufnehmen (überschreibt einen gleichnamigen). */
  add(doc) {
    const c = compileDoc(doc)
    this.docs.set(c.name, c)
    return c
  }

  /** Namen aller bekannten Dialogsätze. */
  get names() { return [...this.docs.keys()] }

  /**
   * Erbkette auflösen: eigenes Dokument zuerst, dann die Vorfahren.
   * @param {string} name
   * @returns {object[]}
   */
  chain(name) {
    const kette = this._kette(name)
    // Muster erst jetzt übersetzen: `@liste` darf aus einem Vorfahren kommen,
    // und den kennt man vor dem Auflösen der Kette nicht. Jedes Dokument wird
    // mit den Listen SEINER eigenen Kette übersetzt — dann ist das Ergebnis
    // unabhängig davon, über welchen Nachfahren man hier hereinkommt.
    for (const d of kette) {
      if (d._bereit) continue
      const listen = {}
      for (const v of [...this._kette(d.name)].reverse()) Object.assign(listen, v.lists)
      prepareDoc(d, listen)
    }
    return kette
  }

  /** Reine Kettenauflösung ohne Nebenwirkung. */
  _kette(name) {
    const kette = []
    const gesehen = new Set()
    const gehe = (n) => {
      if (gesehen.has(n)) return          // Zyklus: einmal reicht
      gesehen.add(n)
      const d = this.docs.get(n)
      if (!d) throw new Error(`Parley: Dialogsatz "${n}" ist nicht geladen`)
      kette.push(d)
      for (const e of d.extends) gehe(e)
    }
    gehe(name)
    return kette
  }

  /**
   * Gespräch beginnen (oder ein bestehendes zurückgeben).
   * @param {string} name      Dialogsatz
   * @param {string} sessionId frei wählbar, z. B. "spieler:figur"
   * @param {{vars?: object, restore?: object}} [init]
   * @returns {Conversation}
   */
  open(name, sessionId, init = {}) {
    const da = this._sessions.get(sessionId)
    if (da && da.doc === name && !init.restore) return da.conversation
    const kette = this.chain(name)
    const vars = {}
    for (const d of [...kette].reverse()) Object.assign(vars, d.vars)   // Vorfahren zuerst
    Object.assign(vars, init.vars || {})
    const conv = new Conversation(this, name, kette, { vars, ...(init.restore || {}) })
    this._sessions.set(sessionId, { doc: name, conversation: conv })
    return conv
  }

  /** Bestehendes Gespräch oder null. */
  session(sessionId) { return this._sessions.get(sessionId)?.conversation || null }

  /** Gespräch vergessen. */
  close(sessionId) { return this._sessions.delete(sessionId) }

  /** Anzahl offener Gespräche — für Aufräum-Heuristiken. */
  get openCount() { return this._sessions.size }

  /** Gespräche, deren letzte Aktivität länger als `msAlt` her ist, schließen. */
  sweep(msAlt, jetzt = Date.now()) {
    let weg = 0
    for (const [id, s] of this._sessions) {
      if (jetzt - s.conversation.lastActivity > msAlt) { this._sessions.delete(id); weg++ }
    }
    return weg
  }

  /**
   * Kurzform ohne eigenes Sitzungsobjekt.
   * @returns {ParleyReply}
   */
  reply(name, sessionId, text) { return this.open(name, sessionId).say(text) }
}

/**
 * @typedef {object} ParleyReply
 * @property {string|null} text      Antworttext (null = keine Regel gegriffen)
 * @property {boolean} matched       ob eine Regel gegriffen hat
 * @property {string|null} label     Etikett der Regel
 * @property {Array<{label:string,send:string}>|null} choices  Auswahlantworten
 * @property {'text'|'choice'|'auto'} input  wie der Client eingeben lassen soll
 * @property {object[]} do           auszuführende Aktionen
 */

export class Conversation {
  constructor(parley, docName, kette, state = {}) {
    this.parley = parley
    this.docName = docName
    this.kette = kette
    this.vars = state.vars || {}
    this.hits = state.hits || {}
    this.last = state.last ?? null
    this.turn = state.turn ?? 0
    this.lastActivity = state.lastActivity ?? Date.now()
  }

  /** Alle Regeln der Kette, eigenes Dokument zuerst. */
  get _regeln() { return this.kette.flatMap(d => d.rules) }
  get _fallback() { return this.kette.flatMap(d => d.fallback) }

  /** Eingabemodus: Regel schlägt Dokument schlägt Vorgabe. */
  _inputMode(regel) {
    return regel?.input || this.kette.find(d => d.input)?.input || 'text'
  }

  /**
   * Eine Eingabe beantworten.
   * @param {string} text
   * @returns {ParleyReply}
   */
  say(text) {
    const { norm, roh } = tokenizePair(text)
    this.turn++
    this.lastActivity = Date.now()

    let treffer = this._suche(this._regeln, norm, roh)
    if (!treffer) treffer = this._suche(this._fallback, norm, roh)

    if (!treffer) {
      this.last = null
      return { text: null, matched: false, label: null, choices: null, input: this._inputMode(null), do: [] }
    }

    const { regel, caps } = treffer
    const ctx = { caps, vars: this.vars, input: String(text ?? ''), rng: this.parley.rng }

    this._anwendenSet(regel.set, ctx)
    if (regel.label) this.hits[regel.label] = (this.hits[regel.label] || 0) + 1
    this.last = regel.label

    const gewaehlt = this._waehle(regel.then)
    const antwortText = gewaehlt === null ? null : fillIn(gewaehlt, ctx)
    const aktionen = regel.do.map(a => {
      const kopie = { ...a }
      for (const [k, v] of Object.entries(kopie)) if (typeof v === 'string') kopie[k] = fillIn(v, ctx)
      return kopie
    })

    const modus = this._inputMode(regel)
    const choices = regel.choices
      ? regel.choices.map(c => ({ label: fillIn(c.label, ctx), send: fillIn(c.send, ctx) }))
      : (modus === 'auto' || modus === 'choice') ? this._ableiten(regel) : null

    return {
      text: antwortText,
      matched: true,
      label: regel.label,
      choices: choices && choices.length ? choices : null,
      input: modus,
      do: aktionen,
    }
  }

  // ── Regelsuche ─────────────────────────────────────────────────────────
  _suche(regeln, tokens, roh) {
    for (const regel of regeln) {
      if (!this._vorbedingungen(regel)) continue
      for (const p of regel.patterns) {
        const caps = matchPattern(p.nodes, tokens, roh)
        if (caps) return { regel, caps }
      }
    }
    return null
  }

  /** Alles außer dem Muster: once, topic, after, if. */
  _vorbedingungen(regel, last = this.last) {
    if (regel.once && regel.label && this.hits[regel.label]) return false
    if (regel.topic !== null && String(this.vars.topic ?? '') !== regel.topic) return false
    if (regel.after && !regel.after.includes(String(last ?? ''))) return false
    if (regel.if.length && !regel.if.some(b => this._bedingung(b))) return false
    return true
  }

  /** Sicht auf die Variablen inklusive der von der Maschine geführten. */
  get _sicht() {
    return { ...this.vars, _last: this.last, _turn: this.turn, _hits: this.hits }
  }

  // Ein Bedingungsblock ist UND-verknüpft; mehrere Blöcke sind ODER-verknüpft.
  _bedingung(block) {
    const sicht = this._sicht
    for (const [pfad, erwartet] of Object.entries(block)) {
      if (pfad === '_note') continue
      if (!vergleiche(lookup(sicht, pfad), erwartet)) return false
    }
    return true
  }

  // ── Wirkung ────────────────────────────────────────────────────────────
  _anwendenSet(set, ctx) {
    for (const [pfad, wert] of Object.entries(set || {})) {
      if (pfad === '_note') continue
      if (wert && typeof wert === 'object' && !Array.isArray(wert)) {
        const alt = lookup(this.vars, pfad)
        if ('+' in wert) { assign(this.vars, pfad, (Number(alt) || 0) + Number(wert['+'])); continue }
        if ('-' in wert) { assign(this.vars, pfad, (Number(alt) || 0) - Number(wert['-'])); continue }
        if ('push' in wert) {
          const arr = Array.isArray(alt) ? alt.slice() : []
          arr.push(typeof wert.push === 'string' ? fillIn(wert.push, ctx) : wert.push)
          assign(this.vars, pfad, arr); continue
        }
        if ('toggle' in wert) { assign(this.vars, pfad, !alt); continue }
        if ('clear' in wert) { assign(this.vars, pfad, undefined); continue }
      }
      assign(this.vars, pfad, typeof wert === 'string' ? fillIn(wert, ctx) : wert)
    }
  }

  /** Gewichtete Zufallswahl aus den `then`-Varianten. */
  _waehle(varianten) {
    if (!varianten.length) return null
    const summe = varianten.reduce((s, v) => s + v.weight, 0)
    let r = this.parley.rng() * summe
    for (const v of varianten) { r -= v.weight; if (r <= 0) return v.text }
    return varianten.at(-1).text
  }

  // ── Abgeleitete Auswahlantworten ───────────────────────────────────────
  // Was könnte der Spieler als Nächstes sagen? Alle Regeln, die JETZT
  // greifen würden und ein wörtliches Muster haben. Anschlussregeln
  // (`after` passt zur eben gefeuerten) stehen vorn — sie sind der Faden.
  _ableiten(gefeuert) {
    const vorne = []
    const hinten = []
    for (const regel of this._regeln) {
      if (regel === gefeuert && !regel.after) continue
      if (regel.suggest === false) continue
      if (!this._vorbedingungen(regel, gefeuert.label)) continue
      const beschriftung = typeof regel.suggest === 'string'
        ? regel.suggest
        : erstesLiteral(regel.patterns)
      if (!beschriftung) continue
      const eintrag = {
        label: grossschreiben(beschriftung),
        send: beschriftung,
        _hits: regel.label ? (this.hits[regel.label] || 0) : 0,
      }
      if (regel.after) vorne.push(eintrag)
      else hinten.push(eintrag)
    }
    // Innerhalb beider Gruppen: was noch nie gefragt wurde, steht vorn. Sonst
    // böte die Figur bei jedem Zug dieselben vier Knöpfe an, und alles, was
    // weiter unten im Dialogsatz steht, entdeckte nie jemand. Stabile
    // Sortierung, also bleibt bei Gleichstand die Reihenfolge des Dokuments.
    const nachNeugier = (a, b) => a._hits - b._hits
    vorne.sort(nachNeugier)
    hinten.sort(nachNeugier)

    const raus = []
    const gesehen = new Set()
    for (const e of [...vorne, ...hinten]) {
      const k = e.send.toLowerCase()
      if (gesehen.has(k)) continue
      gesehen.add(k)
      raus.push({ label: e.label, send: e.send })
      if (raus.length >= this.parley.maxChoices) break
    }
    return raus
  }

  // ── Zustand sichern / laden ────────────────────────────────────────────
  toJSON() {
    return {
      doc: this.docName, vars: this.vars, hits: this.hits,
      last: this.last, turn: this.turn, lastActivity: this.lastActivity,
    }
  }

  /** Auf den Anfangszustand zurück (Variablen der Dokumente wieder herstellen). */
  reset() {
    const vars = {}
    for (const d of [...this.kette].reverse()) Object.assign(vars, d.vars)
    this.vars = vars
    this.hits = {}
    this.last = null
    this.turn = 0
  }
}

// ── Vergleich einer Bedingung ─────────────────────────────────────────────
function vergleiche(ist, erwartet) {
  if (erwartet && typeof erwartet === 'object' && !Array.isArray(erwartet)) {
    for (const [op, arg] of Object.entries(erwartet)) {
      switch (op) {
        case '=': case 'eq': if (!gleich(ist, arg)) return false; break
        case '!=': case 'ne': if (gleich(ist, arg)) return false; break
        case '>':  if (!(Number(ist) >  Number(arg))) return false; break
        case '>=': if (!(Number(ist) >= Number(arg))) return false; break
        case '<':  if (!(Number(ist) <  Number(arg))) return false; break
        case '<=': if (!(Number(ist) <= Number(arg))) return false; break
        case 'in':     if (!Array.isArray(arg) || !arg.some(a => gleich(ist, a))) return false; break
        case 'not_in': if (Array.isArray(arg) && arg.some(a => gleich(ist, a))) return false; break
        case 'has':    if (!(Array.isArray(ist) ? ist.some(x => gleich(x, arg)) : String(ist ?? '').includes(String(arg)))) return false; break
        case 'set':    if ((ist !== undefined && ist !== null) !== !!arg) return false; break
        case '_note':  break
        default: return false
      }
    }
    return true
  }
  return gleich(ist, erwartet)
}

// Lose gleich: "3" == 3, aber true != "true" (das verwirrt mehr, als es hilft).
const gleich = (a, b) => {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b
  if (typeof a === 'string' && typeof b === 'number') return a === String(b)
  return false
}

const erstesLiteral = (patterns) => {
  for (const p of patterns) {
    const s = literalOf(p.nodes)
    if (s) return s
  }
  return null
}
const grossschreiben = (s) => s.charAt(0).toUpperCase() + s.slice(1)
