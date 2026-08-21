// questMapping — zwischen Server-Auftrag und Auftragsfenster übersetzen.
//
// WARUM EINE EIGENE DATEI: Das Panel zeigt an, der Editor schreibt, der Client
// spricht mit dem Server — und dazwischen liegt eine Übersetzung, die weder
// Oberfläche noch Netzwerk ist. Sie hat eigene Regeln („wer darf das sehen",
// „wie heißt dieser Zustand für MICH"), die man prüfen können muss, ohne einen
// Browser und einen Server zu starten. Deshalb steht hier reines JavaScript
// ohne DOM und ohne Netzzugriff.
//
// DIE BEIDEN VOKABULARE
//
//   Server           Oberfläche        Warum verschieden
//   ───────────────────────────────────────────────────────────────────────
//   verify:"items"   Übergabe          Der Server prüft die Gegenstände.
//   verify:"issuer"  Stichprobe        Der Aussteller sieht selbst nach.
//   verify:"agent"   Stichprobe        Alter Name für dasselbe (s.u.).
//   verify:"group"   Prüfgruppe        Eine benannte Gruppe nimmt ab.
//   verify:"crowd"   Schwarm           Andere Spieler bestätigen.
//
// „agent" heißt so, weil Aufträge anfangs immer von einem Agent ausgeschrieben
// wurden. Gemeint war nie „ein Bot entscheidet", sondern „der Aussteller
// entscheidet" — und der kann ein Mensch sein. `issuer` ist der ehrliche Name;
// `agent` bleibt gültig, damit laufende Aufträge und Agents weiterarbeiten.
//
// ZUSTAND IST EINE FRAGE DER PERSON, NICHT DES DATENSATZES: Derselbe Auftrag
// heißt für den Bearbeiter „wird geprüft" und für den Prüfer „zu prüfen". Der
// Server liefert deshalb den rohen Stand plus die Auskunft, was ICH damit darf
// (`canAccept`, `canVerify`); die Einordnung passiert hier.

import { KARMA_WAHL } from './karma.js'

/** Editor-Verfahren → Server-Abnahmeweg. */
export const ABNAHME_ZU_VERIFY = {
  uebergabe: 'items',
  stichprobe: 'issuer',
  pruefgruppe: 'group',
  schwarm: 'crowd',
}

/** Server-Abnahmeweg → Editor-Verfahren. */
export const VERIFY_ZU_ABNAHME = {
  items: 'uebergabe',
  issuer: 'stichprobe',
  agent: 'stichprobe',
  group: 'pruefgruppe',
  crowd: 'schwarm',
}

/** Nachweis-Kennung → Klartext für die Detailansicht. */
export const NACHWEIS_LABEL = {
  foto: 'Vorher-/Nachher-Foto',
  vorOrt: 'Anwesenheit am Einsatzort',
  gegenstand: 'Geforderten Gegenstand dabeihaben',
}

/**
 * Wie wird abgenommen — als Satz für die Detailansicht.
 * Beim Schwarm steht der Stand dabei, sonst wäre „2 von 3" nirgends zu sehen.
 */
export function pruefungText(rec) {
  const v = rec?.verify || 'items'
  if (v === 'items') return 'Übergabe an die Figur'
  if (v === 'group') return 'Abnahme durch die Prüfgruppe'
  if (v === 'crowd') {
    const noetig = Number(rec?.votesNeeded) || 3
    const ja = Number(rec?.votes?.ja)
    return Number.isFinite(ja)
      ? `Schwarm — ${ja} von ${noetig} Bestätigungen`
      : `Schwarm — ${noetig} Bestätigungen nötig`
  }
  return 'Stichprobe durch den Auftraggeber'
}

/** Nachweis-Liste in Klartextzeilen. */
export function anforderungenAus(nachweis, anzahlGegenstaende = 0) {
  const liste = (Array.isArray(nachweis) ? nachweis : [])
    .map(k => NACHWEIS_LABEL[k])
    .filter(Boolean)
  // Geforderte Gegenstände stehen im Auftrag, auch wenn niemand den Haken
  // gesetzt hat — der Server prüft sie ohnehin beim Abschluss.
  if (anzahlGegenstaende > 0 && !liste.includes(NACHWEIS_LABEL.gegenstand)) {
    liste.push(NACHWEIS_LABEL.gegenstand)
  }
  return liste
}

/**
 * Wie heißt der Stand dieses Auftrags FÜR MICH?
 *
 * Reihenfolge ist Absicht: „zu prüfen" schlägt alles andere, weil dort etwas
 * von mir erwartet wird. Ein eigener Auftrag, den ich abnehmen soll, steht
 * damit unter „Prüfen" und nicht bloß unter „Meine".
 *
 * @param {object} rec  Eintrag aus GET /api/quests/near
 * @param {string} meineId
 * @returns {string} Schlüssel aus QUEST_STATES
 */
export function ansichtsStatus(rec, meineId) {
  const s = String(rec?.status || 'open')
  const ich = String(meineId || '')
  const meins = rec?.mine === true || String(rec?.owner || '') === ich
  const bearbeiter = String(rec?.claimedBy || '')

  if (s === 'done') return 'erledigt'
  if (s === 'expired') return 'abgelaufen'
  if (s === 'cancelled') return 'abgelaufen'
  if (s === 'pending') {
    if (rec?.canVerify) return 'pruefung'
    return bearbeiter === ich || meins ? 'eingereicht' : 'pruefung'
  }
  if (s === 'claimed') return 'angenommen'
  // „open": Entwurf ist ein eigener Auftrag, den noch niemand ausgeschrieben hat.
  if (meins && rec?.published === false) return 'entwurf'
  return rec?.angeboten === true ? 'angeboten' : 'offen'
}

/**
 * Geht mich dieser Auftrag etwas an?
 *
 * Der Server liefert alles, was ich SEHEN darf. Sichtbar ist aber nicht
 * dasselbe wie relevant: Ein Auftrag, den jemand anders angenommen hat, gehört
 * in keine meiner Listen — er stünde unter „Verfügbar" und ließe sich nicht
 * annehmen.
 */
export function istRelevant(rec, meineId) {
  const ich = String(meineId || '')
  if (rec?.mine === true || String(rec?.owner || '') === ich) return true
  if (String(rec?.claimedBy || '') === ich) return true
  if (rec?.canVerify === true) return true
  const s = String(rec?.status || 'open')
  return s === 'open'
}

/** Belohnungsteile („3× Diamant") in die Form bringen, die das Panel zeigt. */
function belohnungAus(rec) {
  const teile = Array.isArray(rec?.rewardParts) ? rec.rewardParts.filter(t => t && t.was) : []
  const erst = teile[0] || null
  return {
    anzahl: erst ? Number(erst.anzahl) || 0 : Number(rec?.rewards) || 0,
    was: erst ? erst.was : 'Belohnung',
    teile,
    steigt: Number(rec?.steigt) || 0,
  }
}

/**
 * Server-Eintrag → Anzeige-Auftrag für QuestPanel.
 *
 * Der Rohsatz bleibt unter `roh` erhalten: Die Aktionsschicht braucht ihn
 * (Abnahmeweg, Stimmen, Einreichung), und ihn zweimal zu übersetzen wäre eine
 * zweite Stelle, die falsch werden kann.
 */
export function zuAnsicht(rec, meineId) {
  if (!rec || !rec.id) return null
  const ich = String(meineId || '')
  const meins = rec.mine === true || String(rec.owner || '') === ich
  const frist = rec.deadline ? Date.parse(rec.deadline) : NaN
  return {
    id: rec.id,
    titel: rec.name || '(ohne Titel)',
    status: ansichtsStatus(rec, ich),
    quelle: rec.ownerName || (meins ? 'ich' : 'unbekannt'),
    kurz: rec.kurz || '',
    text: rec.task || '',
    ort: rec.ort || '',
    distanzM: Number.isFinite(rec.distanceM) ? rec.distanceM : null,
    frist: Number.isFinite(frist) ? frist : null,
    belohnung: belohnungAus(rec),
    pruefung: pruefungText(rec),
    anforderungen: anforderungenAus(rec.nachweis, Number(rec.requires) || 0),
    karma: Number(rec.karmaRequired) || 0,
    karmaOk: rec.karmaOk !== false,
    meine: meins,
    einreicher: rec.status === 'pending' ? (rec.pendingByName || null) : null,
    nachweisEingereicht: rec.submissionProof || null,
    roh: rec,
  }
}

/** Ganze Liste übersetzen, Unbrauchbares fällt weg. */
export function listeZuAnsicht(quests, meineId) {
  return (Array.isArray(quests) ? quests : [])
    .filter(r => istRelevant(r, meineId))
    .map(r => zuAnsicht(r, meineId))
    .filter(Boolean)
}

// =====================================================================
//  Editor → Server
// =====================================================================

/** Frist-Auswahl (Dauer ab jetzt) in einen Zeitpunkt. */
export function fristAus(fristMs, jetzt = Date.now()) {
  const ms = Number(fristMs) || 0
  return ms > 0 ? new Date(jetzt + ms).toISOString() : null
}

/**
 * Anzeige-Auftrag → Editor-Formular.
 * Die Frist wird als RESTDAUER angeboten: „noch 3 Tage" ist beim Nachbessern
 * die brauchbare Angabe, ein Datum von vorgestern nicht.
 */
export function zuFormular(v, { jetzt = Date.now(), sichtbarkeit = 'region', sichtbarGruppe = '' } = {}) {
  const roh = v?.roh || {}
  const restMs = v?.frist ? Math.max(0, v.frist - jetzt) : 0
  return {
    id: v?.id || null,
    status: v?.status || 'entwurf',
    meine: true,
    titel: v?.titel || '',
    kurz: v?.kurz || '',
    text: v?.text || '',
    ort: v?.ort || '',
    fristMs: restMs,
    frist: v?.frist || null,
    belohnung: {
      anzahl: Number(v?.belohnung?.anzahl) || 0,
      was: v?.belohnung?.was || '',
      steigt: Number(v?.belohnung?.steigt) || 0,
    },
    abnahme: VERIFY_ZU_ABNAHME[roh.verify] || 'stichprobe',
    pruefgruppe: roh.pruefgruppe || '',
    schwarmZahl: Number(roh.votesNeeded) || 3,
    nachweis: Array.isArray(roh.nachweis) ? [...roh.nachweis] : [],
    karma: Number(v?.karma) || 0,
    // Sichtbarkeit steht nicht im Auftrag, sondern in seinen Rechten — sie
    // kommt von aussen, weil dafür die ACEs gelesen werden müssen.
    sichtbarkeit,
    sichtbarGruppe,
    anbietenNachH: Number(roh.anbietenNachH) || 0,
  }
}

/**
 * Formular → `state.call`, so wie es der Server ablegt.
 *
 * Nur die beschreibenden Felder. Belohnung und Treuhand laufen über
 * `quest/publish`, weil dort geprüft wird, ob die Gegenstände dem Aussteller
 * gehören und frei sind — das darf kein Client selbst entscheiden.
 */
export function callZustandAus(formular, { jetzt = Date.now(), vorher = null } = {}) {
  const f = formular || {}
  const c = { ...(vorher && typeof vorher === 'object' ? vorher : {}) }
  c.task = String(f.text || '').trim()
  c.kurz = String(f.kurz || '').trim()
  c.ort = String(f.ort || '').trim()
  c.karma = Number(f.karma) || 0
  c.nachweis = Array.isArray(f.nachweis) ? [...f.nachweis] : []
  c.steigt = Number(f.belohnung?.steigt) || 0

  const frist = fristAus(f.fristMs, jetzt)
  if (frist) c.deadline = frist; else delete c.deadline

  if (f.abnahme === 'schwarm') c.schwarmZahl = Math.max(1, Math.min(9, Number(f.schwarmZahl) || 3))
  else delete c.schwarmZahl

  // Nur bei der Figur anbieten: erst nach der Wartezeit zusätzlich listen.
  const wartet = Number(f.anbietenNachH) || 0
  if (wartet > 0) { c.anbietenNachH = wartet; c.listed = false; delete c.angeboten }
  else { delete c.anbietenNachH; c.listed = true }

  return c
}

/** Formular → Rumpf für POST quest/publish. */
export function publishPayloadAus(formular, rewardItems) {
  const f = formular || {}
  const verify = ABNAHME_ZU_VERIFY[f.abnahme] || 'items'
  const body = { rewardItems: [...(rewardItems || [])], verify }
  if (verify === 'group' && f.pruefgruppe) body.pruefgruppe = String(f.pruefgruppe)
  return body
}

// =====================================================================
//  Inventar und Belohnung
// =====================================================================

/**
 * Getragene Gegenstände zu einer Auswahl bündeln.
 *
 * Der Editor lässt „3× Diamant" wählen, der Server will drei konkrete
 * Datensätze — Belohnungen werden nie erzeugt, sondern aus dem eigenen Bestand
 * gebunden. Gebündelt wird nach Name, weil das die Gattung ist, die ein Mensch
 * meint; bereits gebundene Stücke zählen nicht mit, sonst verspräche der Editor
 * einen Vorrat, den `quest/publish` zu Recht ablehnt.
 */
export function inventarAus(objekte, meineId, { callId = null } = {}) {
  const ich = String(meineId || '')
  const zaehler = new Map()
  for (const o of Array.isArray(objekte) ? objekte : []) {
    if (!o || o.type !== 'item') continue
    if (String(o.carried_by || '') !== ich) continue
    const gebunden = o.state?.escrow?.call
    if (gebunden && String(gebunden) !== String(callId || '')) continue
    const was = String(o.name || '').trim()
    if (!was) continue
    if (!zaehler.has(was)) zaehler.set(was, { was, vorrat: 0, ids: [] })
    const e = zaehler.get(was)
    e.vorrat++
    e.ids.push(o.id)
  }
  return [...zaehler.values()].sort((a, b) => a.was.localeCompare(b.was, 'de'))
}

/**
 * Konkrete Gegenstände für eine Belohnung aussuchen.
 * @returns {{ids: string[], fehlt: number}}
 */
export function waehleBelohnung(inventar, was, anzahl) {
  const n = Math.max(0, Number(anzahl) || 0)
  const eintrag = (Array.isArray(inventar) ? inventar : []).find(i => i.was === was)
  const ids = (eintrag?.ids || []).slice(0, n)
  return { ids, fehlt: Math.max(0, n - ids.length) }
}

/** Karma-Stufe als Text für Auswahllisten (aus core/karma.js gespiegelt). */
export const karmaWahl = () => KARMA_WAHL
