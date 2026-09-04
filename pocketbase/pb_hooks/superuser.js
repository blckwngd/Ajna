/// <reference path="../pb_data/types.d.ts" />
//
// superuser.js — wer darf, was sonst niemand darf.
//
// Es gibt genau ZWEI Wege, und beide laufen durch `istSuperuser()`:
//
//   1. MITGLIEDSCHAFT in der Gruppe „Superusers" (Name, nicht ID — eine
//      Instanz legt die Gruppe selbst an, eine feste ID gäbe es nicht).
//   2. EIN GETRAGENER GEGENSTAND, dessen Objekt-ID in der Instanz-Einstellung
//      `superuser.items` steht.
//
// WARUM DER ZWEITE WEG
//
// Ein Recht, das an einem Gegenstand hängt, ist ÜBERTRAGBAR: Wer den
// Prüferstab weitergibt, gibt das Recht mit; wer ihn einsammelt, nimmt es
// zurück. Das ist im Spiel eine Handlung statt eines Verwaltungsvorgangs, und
// es passt zum Inventarsystem, das Gegenstände ohnehin als Schlüssel vorsieht.
//
// KONKRETE OBJEKT-IDs, NICHT GATTUNGEN. „Wer einen Prüferstab trägt" wäre
// fälschbar: Jeder darf Objekte anlegen und benennen. Eine Objekt-ID vergibt
// der Server, sie lässt sich nicht erfinden und nicht vervielfältigen —
// `carried_by` ist ein einzelnes Feld, es gibt zu jedem Zeitpunkt genau einen
// Träger.
//
// Was der Besitzer eines Schlüssels SEHR WOHL kann: ihn direkt weiterreichen,
// ohne dass er den Ort wechselt (`objects.updateRule` erlaubt dem Besitzer,
// seine Objekte zu ändern). Das ist gewollt — freie Weitergabe. Wer die
// Übergabe an einen echten Ort binden will, braucht einen zweiten Faktor
// (NFC-Marke, UWB-Anker); dafür ist dies hier vorbereitet, nicht mehr.
//
// EFFIZIENZ: Ein Datensatz-Zugriff je Schlüssel, über die Primärschlüssel-ID.
// Kein Filter, kein Scan über das Inventar. Die Schlüsselliste ist ein
// einzelner `settings`-Datensatz.

const GRUPPE = "Superusers"
const EINSTELLUNG = "superuser.items"

/** Trägt dieses Konto GENAU dieses Objekt? Ein Zugriff über die ID. */
function traegt(app, userId, objectId) {
  if (!userId || !objectId) return false
  try {
    const o = app.findRecordById("objects", String(objectId))
    return String(o.get("carried_by") || "") === String(userId)
  } catch (err) {
    return false   // gelöschter Schlüssel ist kein Schlüssel
  }
}

/**
 * Objekt-IDs, die zum Superuser machen.
 *
 * Aus `settings.superuser.items` — erlaubt sind eine Liste oder ein einzelner
 * Text. JSON-Felder kommen in PocketBase je nach Fassung als Objekt, als Text
 * oder als Byte-Feld an; `jsonObject` in utf8.js kennt alle drei.
 */
function schluessel(app) {
  try {
    const r = app.findFirstRecordByFilter("settings", "key = {:k}", { k: EINSTELLUNG })
    const { jsonObject } = require(`${__hooks}/utf8.js`)
    const v = jsonObject(r.get("value"), null)
    if (Array.isArray(v)) return v.map(x => String(x || "")).filter(Boolean)
    if (typeof v === "string" && v) return [v]
    return []
  } catch (err) {
    return []   // nicht gesetzt → es gibt keine Schlüssel
  }
}

/**
 * Darf dieses Konto mehr als andere?
 *
 * @param {object} app
 * @param {string} userId
 * @param {function} [gruppenVon]  transitiveGroupsOf aus permissions.js. Wird
 *        von AUSSEN übergeben — sie hier per require() zu holen ging bei der
 *        Prüfgruppe schon einmal schief, und der Fehler verschwand in einem
 *        catch (siehe darfAbnehmen in quests.js).
 * @returns {{ok: boolean, grund: string}}
 */
function istSuperuser(app, userId, gruppenVon) {
  if (!userId) return { ok: false, grund: "kein Konto" }

  if (typeof gruppenVon === "function") {
    try {
      const g = app.findFirstRecordByFilter("groups", "name = {:n}", { n: GRUPPE })
      if (g) {
        const meine = gruppenVon(userId) || []
        for (let i = 0; i < meine.length; i++) {
          if (String(meine[i]) === String(g.id)) return { ok: true, grund: "gruppe" }
        }
      }
    } catch (err) { /* keine solche Gruppe → nächster Weg */ }
  }

  const ids = schluessel(app)
  for (let i = 0; i < ids.length; i++) {
    if (traegt(app, userId, ids[i])) return { ok: true, grund: "gegenstand " + ids[i] }
  }

  return { ok: false, grund: "weder in der Gruppe noch mit Schlüssel" }
}

module.exports = { GRUPPE, EINSTELLUNG, istSuperuser, traegt, schluessel }
