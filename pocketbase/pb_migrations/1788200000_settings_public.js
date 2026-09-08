/// <reference path="../pb_data/types.d.ts" />
//
// settings.public + View `public_settings` — Einstellungen, die VOR dem Login
// lesbar sind.
//
// WARUM: Ein Anmeldeformular muss wissen, ob die Instanz Gastkonten annimmt
// und ob eine E-Mail-Adresse Pflicht ist (settings signup.*) — bevor irgend-
// jemand angemeldet ist. `settings` verlangt aber ein Login, mit Grund: Dort
// stehen Betriebsentscheidungen, die nicht jeden angehen. Ohne diesen Weg
// hält jede Anwendung eine eigene Kopie der Regel vor (HeimatRadar hatte zwei
// Schalter in config.js, die zu Ajnas Einstellung passen mussten — zwei
// Stellen für eine Entscheidung, mit Abgleichcode dazwischen).
//
// WIE: Ein Wahrheitswert `public` an jedem Datensatz. Die View
// `public_settings` zeigt id, key, value, updated der markierten Datensätze
// und ist für ALLE lesbar (listRule/viewRule leer). Über eine View lässt sich
// nichts schreiben; `settings` selbst bleibt, wie es ist. Wer einen Datensatz
// markiert, sagt damit: Schlüssel und Wert darf jeder sehen, auch ohne Konto.
// Geheimnisse gehören ohnehin nicht in `settings` (1787500000_settings.js) —
// mit `public` erst recht nicht.
//
// signup.guests und signup.require_email werden angelegt (falls sie fehlen)
// bzw. markiert (falls vorhanden): Genau diese beiden braucht ein Formular.
// Die Werte sind die Vorgaben des Hooks (gastkonten.js); ein Client, der die
// View leer vorfindet, nimmt dieselben Vorgaben an. signup.guest_ttl_days
// bleibt intern — kein Client braucht es.
//
// Idempotent: läuft auch auf einer Instanz, die Feld oder View schon hat
// (etwa über den Schema-Abzug einer Anwendung).

migrate((app) => {
  const settings = app.findCollectionByNameOrId("settings")

  if (!settings.fields.getByName("public")) {
    settings.fields.add(new Field({
      type: "bool",
      id: "bool_settings_public",
      name: "public",
      required: false,
    }))
    app.save(settings)
  }

  let view = null
  try { view = app.findCollectionByNameOrId("public_settings") } catch (e) { view = null }
  if (!view) {
    view = new Collection({
      type: "view",
      name: "public_settings",
      listRule: "",
      viewRule: "",
      viewQuery: "SELECT id, key, value, updated FROM settings WHERE public = 1",
    })
    app.save(view)
  }

  const oeffentlich = {
    "signup.guests": {
      value: true,
      note: "Konten ohne angemeldeten Aufrufer (Gäste) erlaubt. Öffentlich, damit Anmeldeformulare es vor dem Login wissen.",
    },
    "signup.require_email": {
      value: true,
      note: "Gast ohne E-Mail-Adresse wird abgewiesen (403 guest_email_required). Öffentlich, damit Anmeldeformulare das Feld richtig markieren.",
    },
  }
  for (const key in oeffentlich) {
    let rec = null
    try { rec = app.findFirstRecordByFilter("settings", "key = {:k}", { k: key }) } catch (e) { rec = null }
    if (rec) {
      if (!rec.getBool("public")) { rec.set("public", true); app.save(rec) }
      continue
    }
    rec = new Record(settings)
    rec.set("key", key)
    rec.set("value", oeffentlich[key].value)
    rec.set("note", oeffentlich[key].note)
    rec.set("public", true)
    app.save(rec)
  }
}, (app) => {
  try { app.delete(app.findCollectionByNameOrId("public_settings")) } catch (e) { /* schon weg */ }
  const settings = app.findCollectionByNameOrId("settings")
  try { settings.fields.removeByName("public") } catch (e) { /* schon weg */ }
  return app.save(settings)
})
