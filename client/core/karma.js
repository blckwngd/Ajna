// Karma — wie verlässlich hat sich jemand bei Aufträgen gezeigt.
//
// WARUM EINE ZAHL UND KEINE NAMEN: Stufen wie „erfahren" oder „geprüft" klingen
// nach Rang und lassen sich nicht auseinanderhalten — niemand weiß, ob
// „geprüft" über oder unter „erfahren" steht. Karma 1 bis 5 ist auf einen Blick
// vergleichbar, und die Punkte dahinter sind nachrechenbar.
//
// WARUM AUFBAUEND UND NICHT ABZIEHEND: Wer neu ist, hat Karma 0 — nicht, weil
// er etwas falsch gemacht hat, sondern weil er noch nichts gezeigt hat. Karma
// wird VERDIENT. Abgezogen wird nur bei nachgewiesenen Verstößen oder wenn sich
// Beschwerden wiederholen; ein einzelner abgelehnter Abschluss kostet nichts —
// er kann auf einem Missverständnis beruhen, und eine Fehlentscheidung träfe
// jemanden, der umsonst gearbeitet hat.
//
// WO ES GEFÜHRT WIRD: serverseitig und PRO SERVER. Ein Wert, den der Client
// schreiben darf, wäre wertlos; ein serverübergreifender wäre genau die
// zentrale Instanz, die Ajna nicht sein will.
//
// STAND: Vokabular und Rechnung. Punktevergabe und Speicherung sind noch nicht
// angeschlossen.

/** Punkte je Stufe. Bewusst rund, damit der Fortschritt im Kopf ausrechenbar ist. */
export const KARMA_PRO_STUFE = 20

/** Höchste erreichbare Stufe. */
export const KARMA_MAX_STUFE = 5

/**
 * Was Punkte einbringt.
 *
 * Diese Tabelle muss zu `pb_hooks/karma.js` passen — SIE zahlt nicht aus, sie
 * erklärt nur. Eine Beschriftung, die etwas verspricht, das der Server nicht
 * gutschreibt, ist schlimmer als gar keine; ein Test vergleicht die Zahlen.
 *
 * Der geteilte Abschluss ist Absicht: Prüft nur der Server, ist die Erledigung
 * eine Rechenoperation. Sieht ein Mensch nach, steckt auf beiden Seiten Arbeit
 * darin — und vor allem soll sich die Abnahme LOHNEN statt zu drohen. Deshalb
 * kostet eine abgelehnte Abnahme auch nichts.
 */
export const KARMA_GUTSCHRIFT = [
  { grund: t('Auftrag erledigt'), punkte: +2 },
  { grund: t('Erledigung von jemandem abgenommen'), punkte: +3 },
  { grund: t('Abnahme für andere übernommen'), punkte: +1 },
]

/** Was Punkte kostet — bewusst kurz und auf Nachweise beschränkt. */
export const KARMA_ABZUG = [
  { grund: 'nachgewiesener Verstoß', punkte: -10 },
  { grund: 'wiederholte begründete Beschwerden', punkte: -5 },
]

/**
 * Stufe zu einem Punktestand.
 * @param {number} punkte
 * @returns {number} 0…KARMA_MAX_STUFE
 */
export function karmaStufe(punkte) {
  const p = Number(punkte)
  if (!Number.isFinite(p) || p <= 0) return 0
  return Math.min(KARMA_MAX_STUFE, Math.floor(p / KARMA_PRO_STUFE))
}

/**
 * Stufe plus Fortschritt darin — für eine Anzeige, die erklärt statt zu urteilen.
 * @param {number} punkte
 * @returns {{stufe:number, punkte:number, inStufe:number, bisNaechste:number, prozent:number, max:boolean}}
 */
export function karmaFortschritt(punkte) {
  const p = Math.max(0, Number(punkte) || 0)
  const stufe = karmaStufe(p)
  const max = stufe >= KARMA_MAX_STUFE
  const inStufe = max ? KARMA_PRO_STUFE : p - stufe * KARMA_PRO_STUFE
  return {
    stufe, punkte: p, inStufe,
    bisNaechste: max ? 0 : KARMA_PRO_STUFE - inStufe,
    prozent: Math.round(inStufe / KARMA_PRO_STUFE * 100),
    max,
  }
}

/**
 * Beschriftung einer Stufe.
 * @param {number} stufe
 * @param {{alsBedingung?: boolean}} [opts]  „ab Karma 3" statt „Karma 3"
 */
export function karmaLabel(stufe, { alsBedingung = false } = {}) {
  const s = Number(stufe) || 0
  if (alsBedingung && s <= 0) return 'egal — auch ohne Karma'
  return `${alsBedingung ? 'ab ' : ''}Karma ${Math.max(0, Math.min(KARMA_MAX_STUFE, s))}`
}

/** Auswahlliste für Formulare: 0 = keine Bedingung. */
export const KARMA_WAHL = Array.from({ length: KARMA_MAX_STUFE + 1 }, (_, i) => ({
  stufe: i,
  label: karmaLabel(i, { alsBedingung: true }),
}))

// ── Anzeige ──────────────────────────────────────────────────────────────
// Sterne statt Text: eine Stufe liest sich auf einen Blick, ohne dass man
// Begriffe vergleichen muss. Darunter der Fortschritt zur nächsten Stufe mit
// beiden Zahlen — damit ist die Rechnung offen einsehbar und nicht nur ein
// Gefühl. Bewusst ★/☆ statt Emoji: 🌟 und ⭐ sehen je nach Gerät fast gleich
// aus, gefüllt gegen leer ist überall eindeutig.

import { t } from './i18n.js'

const KARMA_STYLE_ID = 'ajna-karma-style'

/**
 * Sternzeile als Text — auch ohne DOM nutzbar (Tests, Tooltips).
 * @param {number} stufe
 * @returns {string} z. B. „★★★☆☆"
 */
export function karmaSterne(stufe) {
  const s = Math.max(0, Math.min(KARMA_MAX_STUFE, Number(stufe) || 0))
  return '★'.repeat(s) + '☆'.repeat(KARMA_MAX_STUFE - s)
}

export function injectKarmaStyles() {
  if (typeof document === 'undefined' || document.getElementById(KARMA_STYLE_ID)) return
  const el = document.createElement('style')
  el.id = KARMA_STYLE_ID
  el.textContent = `
  .ajna-karma{display:block;font:12px system-ui,sans-serif}
  .ajna-karma .ak-sterne{font-size:17px;line-height:1.2;letter-spacing:2px;color:#f1c40f}
  .ajna-karma .ak-sterne .ak-leer{color:#4a4a55}
  .ajna-karma .ak-balken{position:relative;height:7px;margin:5px 0 3px;border-radius:4px;
    background:#2b2b33;overflow:hidden}
  .ajna-karma .ak-ist{position:absolute;inset:0 auto 0 0;border-radius:4px;
    background:linear-gradient(90deg,#c9a227,#f1c40f)}
  .ajna-karma .ak-zahlen{display:flex;justify-content:space-between;
    font:11px ui-monospace,Menlo,Consolas,monospace;color:#8b8b96}
  .ajna-karma .ak-satz{margin-top:5px;font:11px/1.45 system-ui,sans-serif;color:#7f8796}`
  document.head.appendChild(el)
}

/**
 * Karma in einen Container zeichnen.
 *
 * @param {HTMLElement} el
 * @param {number} punkte
 * @param {{satz?: boolean}} [opts]  `satz: false` lässt die Erklärzeile weg
 */
export function renderKarma(el, punkte, { satz = true } = {}) {
  if (!el) return
  injectKarmaStyles()
  const f = karmaFortschritt(punkte)
  const bisher = f.stufe * KARMA_PRO_STUFE
  const ziel = f.max ? f.punkte : bisher + KARMA_PRO_STUFE
  el.className = 'ajna-karma'
  el.innerHTML = `
    <div class="ak-sterne" title="${karmaLabel(f.stufe)} von ${KARMA_MAX_STUFE}">
      ${'★'.repeat(f.stufe)}<span class="ak-leer">${'☆'.repeat(KARMA_MAX_STUFE - f.stufe)}</span>
    </div>
    <div class="ak-balken"><span class="ak-ist" style="width:${f.max ? 100 : f.prozent}%"></span></div>
    <div class="ak-zahlen"><span>${f.punkte}</span><span>${ziel}</span></div>
    ${satz ? `<div class="ak-satz">${f.max
      ? t('Höchste Stufe erreicht.')
      : `${f.bisNaechste} Punkte bis ${karmaLabel(f.stufe + 1)}.`}
      Karma erhöht sich durch das Erledigen von Aufträgen auf diesem Server.</div>` : ''}`
}
