/// <reference path="../pb_data/types.d.ts" />

// =====================================================================
// Ajna — Karma (serverseitig)
//
// Dieselbe Rechnung wie client/core/karma.js: 20 Punkte je Stufe, Stufen 0–5.
// Bewusst zweimal geschrieben statt geteilt — der Client rechnet in einem
// Browser-Modul, der Server in der Goja-VM ohne Bundler. Die Zahlen stehen an
// beiden Stellen als Konstante ganz oben; laufen sie auseinander, schlägt der
// Test in tests/run-quests.mjs an.
//
// Gutgeschrieben wird NUR vom Server und nur an einer Stelle: wenn ein
// Auftrag tatsächlich ausgezahlt wurde. Alles andere (Beschwerden, Verstöße)
// ist eine Betreiber-Entscheidung und läuft über die Administration.
//
// Wird per require() IM Handler geladen — der Goja-VM-Pool teilt keinen
// Modul-Scope zwischen Boot und Hook-Aufruf.
// =====================================================================

const KARMA_PRO_STUFE = 20
const KARMA_MAX_STUFE = 5

// Was ein Abschluss einbringt — in zwei Teilen.
//
// WARUM GETEILT: Prüft nur der Server (Übergabe von Gegenständen), ist der
// Abschluss eine Rechenoperation. Sieht ein MENSCH nach — Stichprobe,
// Prüfgruppe, Schwarm — steckt Arbeit darin, und zwar auf beiden Seiten: Der
// Bearbeiter macht seine Erledigung überprüfbar, jemand anders schaut sie an.
//
// Der eigentliche Grund ist aber ein anderer: Eine Prüfung, die nur wehtun
// kann, wird gemieden — und was gemieden wird, wird auch nicht ehrlich
// gemeldet. Mit einem Bonus lohnt es sich, die Abnahme zu suchen statt ihr
// auszuweichen. Deshalb gibt es für eine ABGELEHNTE Abnahme auch keinen Abzug:
// Eine Ablehnung ist noch kein Verstoß, und eine Prüfgruppe soll kein
// Druckmittel in der Hand halten. Punkte kostet nur, was nachgewiesen ist —
// und das entscheidet die Administration, nicht diese Datei.
//
// In Summe bleibt der geprüfte Weg bei 5 Punkten, also beim bisherigen Wert.
// Niemand steht schlechter da als vorher; nur der automatische Weg wiegt
// weniger.
const PUNKTE_ABSCHLUSS = 2          // jeder erledigte Auftrag
const PUNKTE_ABNAHME_BONUS = 3      // zusätzlich, wenn ein Mensch abgenommen hat
const PUNKTE_PRUEFER = 1            // fürs Abnehmen für andere

/**
 * Stufe zu einem Punktestand.
 * @param {number} punkte
 * @returns {number} 0…5
 */
function karmaStufe(punkte) {
  const p = Number(punkte)
  if (!isFinite(p) || p <= 0) return 0
  return Math.min(KARMA_MAX_STUFE, Math.floor(p / KARMA_PRO_STUFE))
}

/**
 * Punktestand eines Kontos. Fehlt das Feld (Altbestand), zählt 0.
 * @param {object} app
 * @param {string} userId
 * @returns {number}
 */
function karmaPunkte(app, userId) {
  try {
    const u = app.findRecordById("users", userId)
    const p = Number(u.get("karma_points"))
    return isFinite(p) && p > 0 ? p : 0
  } catch (err) { return 0 }
}

/**
 * Punkte gutschreiben oder abziehen. Der Stand fällt nie unter 0.
 *
 * Fehler werden GESCHLUCKT und nur geloggt: Karma ist eine Nebenwirkung des
 * Auftragsabschlusses. Der Tausch ist da schon passiert — ihn wegen eines
 * misslungenen Zählerstands scheitern zu lassen, wäre die schlechtere Wahl.
 *
 * @param {object} app
 * @param {string} userId
 * @param {number} delta
 * @param {string} grund   nur fürs Log
 * @returns {number|null}  neuer Stand oder null bei Fehlschlag
 */
function karmaAendern(app, userId, delta, grund) {
  if (!userId || !delta) return null
  try {
    const u = app.findRecordById("users", userId)
    const alt = Number(u.get("karma_points"))
    const neu = Math.max(0, (isFinite(alt) && alt > 0 ? alt : 0) + Number(delta))
    u.set("karma_points", neu)
    app.save(u)
    console.log("[karma] " + userId + " " + (delta > 0 ? "+" : "") + delta
      + " → " + neu + " (" + grund + ")")
    return neu
  } catch (err) {
    console.log("[karma] " + userId + " " + delta + " fehlgeschlagen: "
      + (err && err.message ? err.message : err))
    return null
  }
}

/** Gutschrift für einen ausgezahlten Auftrag. */
function karmaFuerAbschluss(app, userId, callId, verify) {
  // `verify` sagt, WER entschieden hat. Fehlt die Angabe, gilt der sparsame
  // Fall — ein Aufrufer, der den Weg nicht kennt, soll keinen Bonus auslösen.
  const geprueft = menschlicheAbnahme(verify)
  const punkte = PUNKTE_ABSCHLUSS + (geprueft ? PUNKTE_ABNAHME_BONUS : 0)
  return karmaAendern(app, userId, punkte,
    "Auftrag " + callId + (geprueft ? " abgeschlossen und abgenommen" : " abgeschlossen"))
}

/** Hat ein Mensch über den Abschluss entschieden? */
function menschlicheAbnahme(verify) {
  const v = String(verify || "")
  return v === "issuer" || v === "agent" || v === "group" || v === "crowd"
}

/** Gutschrift fürs Abnehmen für andere. */
function karmaFuerPruefer(app, userId, callId) {
  return karmaAendern(app, userId, PUNKTE_PRUEFER, "Abnahme für Auftrag " + callId)
}

/**
 * Reicht das Karma dieses Kontos für den geforderten Stand?
 * @returns {{ok: boolean, stufe: number, noetig: number}}
 */
function karmaReicht(app, userId, noetigeStufe) {
  const noetig = Math.max(0, Math.min(KARMA_MAX_STUFE, Number(noetigeStufe) || 0))
  const stufe = karmaStufe(karmaPunkte(app, userId))
  return { ok: stufe >= noetig, stufe: stufe, noetig: noetig }
}

module.exports = {
  KARMA_PRO_STUFE, KARMA_MAX_STUFE,
  PUNKTE_ABSCHLUSS, PUNKTE_ABNAHME_BONUS, PUNKTE_PRUEFER,
  karmaStufe, karmaPunkte, karmaAendern, karmaReicht,
  karmaFuerAbschluss, karmaFuerPruefer, menschlicheAbnahme,
}
