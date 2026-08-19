// ─────────────────────────────────────────────────────────────────────────
//  Parley · Dokument — ein Dialogsatz, geprüft und vorkompiliert
// ─────────────────────────────────────────────────────────────────────────
// Ein Parley-Dokument ist reines JSON (oder ein JS-Objekt gleicher Form):
//
//   {
//     "name": "mensch",
//     "extends": "basis",          // greift, wenn hier keine Regel passt
//     "input": "auto",             // Vorgabe für Auswahlantworten
//     "vars":  { "kennt_mich": false },
//     "lists": { "gruss": ["hallo", "moin", "guten tag"] },
//     "rules": [ … ],
//     "fallback": [ … ]            // nur, wenn KEINE Regel gegriffen hat
//   }
//
// `_note` darf überall stehen und wird ignoriert — JSON kennt keine
// Kommentare, Dialoge brauchen aber welche.
//
// Zwei Schritte, weil Listen vererbbar sind: `compileDoc` prüft die Struktur,
// `prepareDoc` übersetzt die Muster — Letzteres erst, wenn die Erbkette und
// damit der vollständige Listenbestand feststeht.

import { compilePattern } from './pattern.mjs'

const ALS_ARRAY = (v) => (v === undefined || v === null) ? [] : (Array.isArray(v) ? v : [v])

/**
 * Rohdokument prüfen und in die interne Form bringen.
 * @param {object} roh
 * @returns {object} Dokument (Muster noch uncompiliert — siehe `prepareDoc`)
 */
export function compileDoc(roh) {
  if (!roh || typeof roh !== 'object') throw new TypeError('Parley: Dokument muss ein Objekt sein')
  const name = String(roh.name || '').trim()
  if (!name) throw new TypeError('Parley: Dokument braucht ein "name"-Feld')

  const listen = {}
  for (const [k, v] of Object.entries(roh.lists || {})) {
    if (k === '_note') continue
    if (!Array.isArray(v)) throw new TypeError(`Parley[${name}]: Liste "${k}" muss ein Array sein`)
    listen[k] = v.map(String)
  }

  const doc = {
    name,
    extends: ALS_ARRAY(roh.extends).map(String),
    input: roh.input || null,
    vars: { ...(roh.vars || {}) },
    lists: listen,
    rules: ALS_ARRAY(roh.rules).map((r, i) => leseRegel(r, i, name, 'rules')),
    fallback: ALS_ARRAY(roh.fallback).map((r, i) => leseRegel(r, i, name, 'fallback')),
    _bereit: false,
  }
  delete doc.vars._note

  // `same_as` erst auflösen, wenn alle Etiketten des Dokuments bekannt sind.
  const nachEtikett = new Map()
  for (const r of [...doc.rules, ...doc.fallback]) if (r.label) nachEtikett.set(r.label, r)
  for (const r of [...doc.rules, ...doc.fallback]) {
    if (!r.same_as) continue
    const quelle = nachEtikett.get(r.same_as)
    if (!quelle) throw new TypeError(`Parley[${name}]: same_as "${r.same_as}" gibt es in diesem Dokument nicht`)
    if (quelle.same_as) throw new TypeError(`Parley[${name}]: same_as darf nicht auf same_as zeigen ("${r.same_as}")`)
    if (!r.then.length) r.then = quelle.then
    if (!r.do.length) r.do = quelle.do
    if (!Object.keys(r.set).length) r.set = quelle.set
    if (!r.choices) r.choices = quelle.choices
    if (!r.input) r.input = quelle.input
  }
  return doc
}

/**
 * Muster übersetzen. Idempotent — der zweite Aufruf tut nichts.
 * @param {object} doc     Ergebnis von `compileDoc`
 * @param {Record<string, string[]>} listen  Listen des Dokuments UND seiner Vorfahren
 */
export function prepareDoc(doc, listen) {
  if (doc._bereit) return doc
  for (const [wo, regeln] of [['rules', doc.rules], ['fallback', doc.fallback]]) {
    regeln.forEach((r, i) => {
      r.patterns = r.when.map(w => {
        try { return { quelle: w, nodes: compilePattern(w, listen) } }
        catch (err) { throw new SyntaxError(`Parley[${doc.name}]: ${wo}[${i}] — ${err.message}`) }
      })
      // Ohne "when" gilt die Regel für jede Eingabe (typisch im Fallback).
      if (!r.patterns.length) r.patterns.push({ quelle: '*', nodes: compilePattern('*', listen) })
    })
  }
  doc._bereit = true
  return doc
}

function leseRegel(roh, idx, docName, wo) {
  if (!roh || typeof roh !== 'object') {
    throw new TypeError(`Parley[${docName}]: ${wo}[${idx}] muss ein Objekt sein`)
  }
  const antworten = ALS_ARRAY(roh.then).map(t =>
    typeof t === 'string' ? { text: t, weight: 1 }
      : { text: String(t?.text ?? ''), weight: Number(t?.weight) > 0 ? Number(t.weight) : 1 })

  if (!antworten.length && !roh.same_as && !roh.do && !roh.set) {
    throw new TypeError(`Parley[${docName}]: ${wo}[${idx}] hat weder "then" noch "do"/"set"`)
  }

  return {
    label: roh.label ? String(roh.label) : null,
    when: ALS_ARRAY(roh.when).map(String),
    patterns: null,                     // füllt prepareDoc
    if: ALS_ARRAY(roh.if).filter(x => x && typeof x === 'object'),
    after: roh.after === undefined ? null : ALS_ARRAY(roh.after).map(String),
    topic: roh.topic === undefined ? null : String(roh.topic),
    once: roh.once === true,
    then: antworten,
    set: { ...(roh.set || {}) },
    do: leseAktionen(roh.do),
    choices: leseAuswahl(roh.choices),
    input: roh.input || null,
    suggest: roh.suggest === undefined ? null : roh.suggest,
    same_as: roh.same_as ? String(roh.same_as) : null,
  }
}

// "anim:winken" | {anim:"winken"} | {action:"goto", to:"turm"} → einheitliche Form
function leseAktionen(v) {
  return ALS_ARRAY(v).map(a => {
    if (typeof a === 'string') {
      const i = a.indexOf(':')
      return i < 0 ? { action: a } : { action: a.slice(0, i), value: a.slice(i + 1) }
    }
    if (a && typeof a === 'object') {
      if (a.action) return { ...a }
      const paar = Object.entries(a).find(([k]) => k !== '_note')
      if (paar) return { action: paar[0], value: paar[1] }
    }
    return null
  }).filter(Boolean)
}

function leseAuswahl(v) {
  if (v === undefined || v === null) return null
  const liste = ALS_ARRAY(v).map(c => typeof c === 'string'
    ? { label: c, send: c }
    : { label: String(c?.label ?? c?.send ?? ''), send: String(c?.send ?? c?.label ?? '') })
    .filter(c => c.label && c.send)
  return liste.length ? liste : null
}
