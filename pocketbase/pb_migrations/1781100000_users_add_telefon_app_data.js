/// <reference path="../pb_data/types.d.ts" />
//
// users (generisch, für ALLE Ajna-Apps) — zwei zusätzliche Felder:
//
//   telefon  — optionales Standard-Kontaktfeld, neben name/email.
//   app_data — generischer Frei-Daten-Blob, analog zu objects.state.
//              Jede App legt ihre Daten unter einem eigenen Namespace-Key
//              ab (app_data.<app>.…), damit sich mehrere Anwendungen nicht
//              gegenseitig die Keys überschreiben.
//
// Eingeführt im Zuge der HeimatRadar-Integration, aber bewusst app-neutral
// als Teil des Ajna-Grundsystems gehalten.

migrate((app) => {
  const users = app.findCollectionByNameOrId("_pb_users_auth_")

  users.fields.add(new Field({
    type: "text",
    id: "text_users_telefon",
    name: "telefon",
    required: false,
    max: 25,
  }))
  users.fields.add(new Field({
    type: "json",
    id: "json_users_app_data",
    name: "app_data",
    required: false,
    maxSize: 0,
  }))

  return app.save(users)
}, (app) => {
  const users = app.findCollectionByNameOrId("_pb_users_auth_")
  try { users.fields.removeById("text_users_telefon") } catch (e) {}
  try { users.fields.removeById("json_users_app_data") } catch (e) {}
  return app.save(users)
})
