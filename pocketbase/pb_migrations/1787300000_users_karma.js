/// <reference path="../pb_data/types.d.ts" />
//
// users.karma_points — wie verlässlich sich ein Konto bei Aufträgen gezeigt hat.
//
// EIN PUNKTESTAND, KEINE STUFE: Die Stufe (0–5, je 20 Punkte) ist eine reine
// Ansicht und wird überall aus den Punkten gerechnet — client/core/karma.js und
// pb_hooks/karma.js benutzen dieselbe Formel. Speicherte man die Stufe, gäbe es
// zwei Wahrheiten, die auseinanderlaufen können.
//
// PRO SERVER, NICHT PRO PERSON: Das Feld hängt an der `users`-Collection DIESER
// Instanz. Wer auf zwei Ajna-Servern spielt, hat dort zwei Konten und zwei
// Punktestände. Ein serverübergreifender Wert wäre genau die zentrale Instanz,
// die Ajna nicht sein will — und er wäre auch inhaltlich falsch: Wie verlässlich
// jemand war, kann nur beurteilen, wer die Aufträge kennt.
//
// NUR DER SERVER SCHREIBT: Die Rechteregel der users-Collection erlaubt jedem,
// seinen EIGENEN Datensatz zu ändern, und PocketBase kennt keine Schreibrechte
// je Feld. Ohne den Hook in main.pb.js (`schuetzeKarma`) könnte sich jedes Konto
// per `updateCurrentUser({karma_points: 999})` selbst auf Stufe 5 setzen —
// dieselbe Falle wie bei `agent_seal`, dort gemessen und behoben.
//
// KEIN NEGATIVER STAND: Wer neu ist, steht bei 0 — nicht, weil er etwas falsch
// gemacht hat, sondern weil er noch nichts gezeigt hat. Abzüge können den Stand
// nur bis 0 senken (siehe pb_hooks/karma.js), damit ein leeres Konto und ein
// bestraftes Konto nicht dasselbe aussehen.

migrate((app) => {
  const users = app.findCollectionByNameOrId("_pb_users_auth_")

  users.fields.add(new Field({
    type: "number",
    id: "number_users_karma_points",
    name: "karma_points",
    required: false,
    onlyInt: true,
    min: 0,
  }))

  return app.save(users)
}, (app) => {
  const users = app.findCollectionByNameOrId("_pb_users_auth_")
  try { users.fields.removeById("number_users_karma_points") } catch (e) {}
  return app.save(users)
})
