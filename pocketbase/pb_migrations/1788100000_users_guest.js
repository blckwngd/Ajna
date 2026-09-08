/// <reference path="../pb_data/types.d.ts" />
//
// users.guest — Gastkonten; users.email wird OPTIONAL.
//
// EIN GASTKONTO ist ein Konto, dessen Besitzer:in kein Passwort kennt: Eine
// Anwendung (erster Nutzer: HeimatRadar) legt es ohne angemeldeten Aufrufer
// an, damit jemand sofort ein Weltobjekt eintragen kann. Erst mit bestätigter
// E-Mail-Adresse — über die Passwortvergabe per Konten-Mail — wird daraus ein
// echtes Konto. Das ist ein Zustand des Kontos, keine Eigenschaft einer App;
// deshalb ein Feld, auf das Aufräumen, Anzeige und Rechte generisch reagieren
// können, statt dass jede App ihre eigene Markierung in app_data erfindet.
//
// NUR ZUSAMMEN MIT DEM HOOK AUSLIEFERN. `email.required = false` gilt für die
// ganze Collection — PocketBase kennt keine Pflicht je Zustand. Allein wäre das
// ein Loch: Auch eine gewöhnliche Registrierung könnte die Adresse weglassen.
// Zumachen tut pb_hooks/main.pb.js (Abschnitt „Gastkonten") mit
// pb_hooks/gastkonten.js: Ein Konto mit guest = false braucht eine Adresse,
// ein Gast ohne Adresse nur, wenn die Instanz es erlaubt
// (settings: signup.require_email).
//
// Entscheidungen und Messungen: docs/gastkonten-entscheidungen.md (F1–F4).

migrate((app) => {
  const users = app.findCollectionByNameOrId("_pb_users_auth_")

  users.fields.add(new Field({
    type: "bool",
    id: "bool_users_guest",
    name: "guest",
    required: false,
  }))

  const email = users.fields.getByName("email")
  if (email) email.required = false

  return app.save(users)
}, (app) => {
  const users = app.findCollectionByNameOrId("_pb_users_auth_")
  try { users.fields.removeById("bool_users_guest") } catch (e) {}
  const email = users.fields.getByName("email")
  if (email) email.required = true
  return app.save(users)
})
