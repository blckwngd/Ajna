// Sprachwahl — Inhalte in mehreren Sprachen, ohne dass es jemand muss.
//
// UNTERSCHIED ZU core/i18n.js: Dort geht es um die OBERFLÄCHE (Knöpfe, Hinweise
// — die kennt der Client). Hier geht es um INHALTE, die von außen kommen:
// Objektbeschreibungen, POI-Namen, NPC-Dialoge. Die kennt der Client nicht; sie
// stehen im Datensatz, und wer sie schreibt, ist ein Agent oder ein Mensch.
//
// DIE REGEL: EIN TEXT DARF EINFACH EIN TEXT SEIN.
//
//   description: "Ein alter Brunnen."                     ← völlig in Ordnung
//   description: { de: "Ein alter Brunnen.",              ← wer mag, kann mehr
//                  en: "An old well." }
//
// Kein Agent muss Sprachkarten schreiben. Ein Dialogpaket in einer Sprache ist
// kein Mangel — die meisten Figuren stehen in einer Gegend, in der eine Sprache
// gesprochen wird. Das Werkzeug ist da, die Pflicht nicht.
//
// AUSWAHL: gewünschte Sprache → `*` (sprachunabhängig, z. B. ein Eigenname) →
// die vom Autor als Original markierte (`_quelle`) → der erste Eintrag. Der
// letzte Schritt ist wichtig: Lieber ein Satz in einer fremden Sprache als ein
// leeres Feld. Wer nichts versteht, sieht wenigstens, DASS da etwas steht.
//
// INHALTE VON MENSCHEN werden nie übersetzt — Auftragstexte, Objektnamen,
// Nachrichten. Sie können trotzdem als Karte vorliegen, wenn ihr Autor sie so
// angelegt hat; dann gilt dieselbe Auswahl.

import { sprache } from './i18n.js'

/**
 * Ist das eine Sprachkarte? Ein Objekt, dessen Schlüssel wie Sprachcodes
 * aussehen — nicht jedes Objekt, sonst würde `{lat, lon}` mit übersetzt.
 */
export function istSprachkarte(wert) {
  if (!wert || typeof wert !== 'object' || Array.isArray(wert)) return false
  const schluessel = Object.keys(wert).filter(k => k !== '_quelle')
  if (!schluessel.length) return false
  return schluessel.every(k => k === '*' || /^[a-z]{2}(-[a-z0-9]{2,8})*$/i.test(k))
}

/**
 * Den passenden Text herausziehen.
 *
 * @param {string|object|null} wert   Text oder Sprachkarte
 * @param {string} [wunsch]           Sprachcode; sonst die aktive Sprache
 * @returns {string}
 */
export function inSprache(wert, wunsch = null) {
  if (wert === null || wert === undefined) return ''
  if (typeof wert === 'string') return wert
  if (!istSprachkarte(wert)) return ''

  const ziel = String(wunsch || sprache() || 'de').toLowerCase()
  const karte = wert

  // Genau, dann ohne Region (de-AT → de), dann sprachunabhängig.
  if (karte[ziel] != null) return String(karte[ziel])
  const kurz = ziel.slice(0, 2)
  for (const k of Object.keys(karte)) {
    if (k !== '_quelle' && k.toLowerCase().slice(0, 2) === kurz) return String(karte[k])
  }
  if (karte['*'] != null) return String(karte['*'])

  const quelle = karte._quelle
  if (quelle && karte[quelle] != null) return String(karte[quelle])

  for (const k of Object.keys(karte)) {
    if (k !== '_quelle' && karte[k] != null) return String(karte[k])
  }
  return ''
}

/**
 * Eine Liste von Texten (z. B. Dialogzeilen) in die passende Sprache bringen.
 * Einträge, die schon Zeichenketten sind, bleiben, wie sie sind.
 */
export function listeInSprache(liste, wunsch = null) {
  if (!Array.isArray(liste)) return []
  return liste.map(e => inSprache(e, wunsch)).filter(Boolean)
}

/**
 * Welche Sprachen bietet dieser Wert an? Für eine Anzeige „auch auf Englisch
 * verfügbar" und für Werkzeuge, die Lücken suchen.
 */
export function sprachenVon(wert) {
  if (!istSprachkarte(wert)) return []
  return Object.keys(wert).filter(k => k !== '_quelle' && k !== '*')
}

/**
 * Hilfe für Autoren: eine bestehende Zeichenkette zur Sprachkarte machen,
 * ohne die Herkunft zu verlieren.
 *
 *   zuSprachkarte('Ein alter Brunnen.', 'de')
 *   // → { de: 'Ein alter Brunnen.', _quelle: 'de' }
 */
export function zuSprachkarte(text, quelle = 'de') {
  if (istSprachkarte(text)) return text
  return { [quelle]: String(text ?? ''), _quelle: quelle }
}
