// Provenance — „stammt dieses Objekt wirklich von dem Agenten, als der es sich
// ausgibt?" und wie man die Antwort anzeigt.
//
// HINTERGRUND: `state.source` ist eine SELBSTAUSKUNFT. Der Server schreibt das
// Feld nicht; jedes angemeldete Konto kann ein Objekt als „von poi-bridge" oder
// „von wikipedia" ausgeben. Wer darauf vertraut, vertraut am Ende auf frei
// erfundene Ortsinformationen im Gewand einer vertrauten Quelle.
//
// Belastbar ist ausschließlich `owner` — den setzt PocketBase serverseitig
// (`onRecordCreateRequest`). Die Zuordnung Source → rechtmäßiger Owner führt
// `AgentFilters` je Server (siehe dort `refreshManifests`/`ownerFor`).
//
// Diese Datei macht daraus Anzeige. Bewusst KEIN Blockieren und kein
// Ausblenden: was echt aussieht und es nicht ist, soll sichtbar werden — ein
// stilles Wegfiltern nähme dem Nutzer die Möglichkeit, es selbst zu beurteilen.
//
// Zugeschrieben wird immer über die unveränderliche `owner`-ID. Der Handle
// (`users.username`) ist nur das Etikett zum Nachschlagen, und das
// Vertrauenszeichen hängt am Betreiber-Siegel (`users.agent_seal`), NICHT am
// Namen — ein freigewordener und neu gegriffener Name trägt so kein Siegel.
//
// Die fünf Zustände:
//   user          — kein `state.source`; ein gewöhnliches Nutzerobjekt. Keine
//                   Behauptung, also auch keine Anzeige.
//   agent         — Owner ist der Namensinhaber UND vom Betreiber bestätigt.
//   unsealed      — Owner ist der Namensinhaber, aber ohne Siegel. Kein
//                   Verdacht, nur keine Bestätigung: so sieht jeder Agent aus,
//                   den der Betreiber (noch) nicht als offiziell markiert hat.
//   unregistered  — Source auf diesem Server nicht registriert. KEIN Alarm:
//                   der Agent kann schlicht nie gelaufen sein, oder das Objekt
//                   stammt aus der Zeit vor seiner Anmeldung.
//   mismatch      — Source registriert, aber ein ANDERES Konto hat das Objekt
//                   angelegt. Das ist der Fall, der auffallen muss.

import { escapeHtml } from './ServerBadge.js'

const STYLE_ID = 'ajnaProvenanceStyles'

const beschriftung = (p) => p.handle ? `@${p.handle}` : p.agentName

const DARSTELLUNG = {
  agent: (p) => ({
    text: `✓ ${beschriftung(p)}`,
    color: '#6fae7a',
    title: `Bestätigter Agent dieser Instanz: ${beschriftung(p)}`
      + ` — „${p.agentName}", Quelle ${p.source}`,
  }),
  unsealed: (p) => ({
    text: beschriftung(p),
    color: '#8a8f99',
    title: `Angelegt von ${beschriftung(p)}, dem Inhaber der Quelle „${p.source}"`
      + ` — vom Betreiber aber nicht als offizieller Agent bestätigt.`,
  }),
  unregistered: (p) => ({
    text: `? ${p.source}`,
    color: '#8a8f99',
    title: `Die Quelle „${p.source}" ist auf diesem Server nicht registriert —`
      + ` die Herkunft lässt sich nicht bestätigen.`,
  }),
  mismatch: (p) => ({
    text: `⚠ angeblich ${beschriftung(p)}`,
    color: '#e0533b',
    title: `Dieses Objekt gibt sich als „${p.agentName}" aus, wurde aber von einem`
      + ` anderen Konto angelegt. Behandle den Inhalt als unbelegt.`,
  }),
}

/**
 * Anzeige-Angaben zur Herkunft oder null (Nutzerobjekt / keine Filter da).
 * @param {object} filters  AgentFilters-Instanz
 * @param {object} record   Objekt-Datensatz
 * @returns {{status:string, text:string, color:string, title:string}|null}
 */
export function provenanceInfo(filters, record) {
  if (!filters?.provenanceOf) return null
  const p = filters.provenanceOf(record)
  const bau = DARSTELLUNG[p.status]
  return bau ? { status: p.status, ...bau(p) } : null
}

/** True, wenn die Herkunft aktiv Aufmerksamkeit verdient. */
export const isProvenanceWarning = (info) => info?.status === 'mismatch'

/**
 * Badge als HTML — für Listen, die ihre Zeilen per innerHTML bauen.
 * @param {object} opts
 * @param {boolean} [opts.onlyWarnings=false]  nur `mismatch` zeigen (Listen mit
 *   vielen Agent-Objekten würden sonst in grünen Haken ertrinken)
 */
export function renderProvenanceBadge(filters, record, { onlyWarnings = false } = {}) {
  const info = provenanceInfo(filters, record)
  if (!info) return ''
  if (onlyWarnings && !isProvenanceWarning(info)) return ''
  const t = escapeHtml(info.text), h = escapeHtml(info.title)
  return `<span class="ajna-prov-badge" style="color:${info.color}" title="${h}">${t}</span>`
}

/** Klartext-Zusatz für Kopfzeilen, die per textContent gerendert werden. */
export function provenanceText(filters, record, { onlyWarnings = true } = {}) {
  const info = provenanceInfo(filters, record)
  if (!info) return ''
  if (onlyWarnings && !isProvenanceWarning(info)) return ''
  return info.text
}

export function injectProvenanceStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const s = document.createElement('style')
  s.id = STYLE_ID
  s.textContent = `.ajna-prov-badge{font-size:11px;padding:1px 6px;border-radius:999px;
    background:rgba(255,255,255,.08);white-space:nowrap;margin-left:6px}`
  document.head.appendChild(s)
}
