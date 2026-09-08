/// <reference path="../pb_data/types.d.ts" />
//
// gastkonten.js — Helfer für die Gastkonten-Hooks in main.pb.js.
//
// Als eigenes Modul, weil Hook-Handler im JSVM in einem gepoolten VM laufen:
// Was sie brauchen, holen sie per require() — nicht aus dem Datei-Scope.
//
// WAS EIN GASTKONTO IST: ein Konto ohne Passwort, das sein Besitzer kennt —
// angelegt ohne angemeldeten Aufrufer, damit jemand sofort etwas eintragen
// kann. Es wird zum echten Konto, sobald `verified` auf true geht (Passwort-
// vergabe per Konten-Mail oder klassische Verifizierung). Siehe Migration
// 1788100000 und docs/gastkonten.md.
//
// EINSTELLUNGEN (settings-Collection; fehlt der Datensatz, gilt die Vorgabe):
//   signup.guests          true   Konten ohne angemeldeten Aufrufer erlaubt
//   signup.require_email   true   Gast ohne Adresse wird abgewiesen
//   signup.guest_ttl_days  30     Gäste ohne Objekt und ohne verified aufräumen
//                                 (0 = nie)

const HANDLE_MUSTER = /^[a-z0-9][a-z0-9_-]{1,31}$/   // wie users.username

/**
 * Instanz-Einstellung lesen. Der Wert ist ein JSON-Feld und kommt je nach Weg
 * als Primitiv, Objekt, String oder Byte-Array an — utf8.js kennt die Fälle.
 * @param {object} app
 * @param {string} schluessel  z. B. "signup.guests"
 * @param {any} vorgabe        gilt, wenn nichts gesetzt oder unlesbar ist
 */
function einstellung(app, schluessel, vorgabe) {
  try {
    const r = app.findFirstRecordByFilter("settings", "key = {:k}", { k: schluessel })
    const roh = r.get("value")
    if (typeof roh === "boolean" || typeof roh === "number") return roh
    if (roh && typeof roh === "object" && !Array.isArray(roh)) return roh
    const { jsonText } = require(`${__hooks}/utf8.js`)
    const text = jsonText(roh)
    if (!text) return vorgabe
    const v = JSON.parse(text)
    return (v === null || v === undefined) ? vorgabe : v
  } catch (err) {
    return vorgabe   // nicht gesetzt → Vorgabe
  }
}

/**
 * Erzeugter Handle `gast-<6 Zeichen base36>`, frei in name UND username.
 *
 * Bewusst NICHT animalNames.js: Das sind Tiernamen für Weltobjekte — ein
 * Mensch, der als „Fuchs" auftaucht, wäre eine Verwechslung mit dem
 * Wildtier-Agenten. Das Muster passt auf users.username, der Handle kann also
 * beide Felder füllen und taugt als Login-Kennung für Gäste ohne Adresse.
 */
function handle(app) {
  for (let versuch = 0; versuch < 8; versuch++) {
    const h = "gast-" + (Math.random().toString(36).slice(2, 8) + "000000").slice(0, 6)
    let frei = true
    try {
      app.findFirstRecordByFilter("users", "name = {:h} || username = {:h}", { h: h })
      frei = false
    } catch (err) { frei = true }   // 404 = niemand hat ihn
    if (frei) return h
  }
  return "gast-" + Date.now().toString(36).slice(-6)
}

/** Passt der Name als Login-Kennung? (leer → nein) */
function alsUsername(name) {
  const n = String(name || "")
  return HANDLE_MUSTER.test(n) ? n : ""
}

/**
 * Ablehnung mit stabilem Code — der Client übersetzt (docs/mehrsprachigkeit.md).
 * Antwortform: 403, `data.signup.code` = guest_signup_disabled | guest_email_required.
 */
function abweisen(code, text) {
  return new ForbiddenError(text, { signup: new ValidationError(code, text) })
}

/** Fehlende Adresse bei einem Nicht-Gast — dieselbe Form wie PocketBases eigene Pflichtfeld-Meldung. */
function adressePflicht() {
  return new BadRequestError("Ein Konto ohne Gaststatus braucht eine E-Mail-Adresse.",
    { email: new ValidationError("validation_required", "Cannot be blank.") })
}

module.exports = { einstellung, handle, alsUsername, abweisen, adressePflicht }
