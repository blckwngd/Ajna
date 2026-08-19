/// <reference path="../pb_data/types.d.ts" />
//
// users — zwei getrennte Dinge, die man nicht verwechseln darf:
//
//   username    OPTIONALER, selbstgewählter, eindeutiger Anzeigename. Darf
//               geändert werden und dient zugleich als zweite Login-Kennung
//               neben der E-Mail (siehe identityFields unten).
//
//   agent_seal  Bestätigung des BETREIBERS: „dieses Konto ist ein offizieller
//               Agent dieser Instanz". Nur über die Administration setzbar —
//               kein Nutzer und kein Agent kann es sich selbst geben.
//
// WARUM GETRENNT: Ein änderbarer Name ist ein guter Anzeigename, aber ein
// schlechter Vertrauensanker. Gibt ein Agent seinen Namen frei, kann ihn ein
// Fremder greifen. Technisch bleibt das harmlos, weil zugeschrieben wird über
// die unveränderliche `owner`-ID — Menschen merken sich aber Namen, nicht IDs.
// Deshalb hängt das Vertrauenszeichen am `agent_seal`, nicht am Namen: ein neu
// gegriffener Name trägt schlicht kein Siegel.
//
// Später ersetzt OIDC die Betreiber-Bestätigung als QUELLE des Siegels; die
// Anzeige-Logik bleibt dieselbe. Genau dafür ist es ein eigenes Feld.
//
// INDEX: partiell UND case-insensitiv, beides nötig.
//   • `WHERE username != ''` — PocketBase-Textfelder sind leer, nicht NULL;
//     ein gewöhnlicher Unique-Index kollidierte beim ZWEITEN Konto ohne Namen.
//   • `COLLATE NOCASE` — sonst wären „PoiBridge" und „poibridge" zwei Namen,
//     und die Eindeutigkeit wäre optisch wertlos.

migrate((app) => {
  const users = app.findCollectionByNameOrId("_pb_users_auth_")

  users.fields.add(new Field({
    type: "text",
    id: "text_users_username",
    name: "username",
    required: false,
    max: 32,
    // Enger Zeichensatz gegen Verwechslungen (poi-bridge vs. poi-bridqe vs.
    // kyrillisches о). Kleinschreibung erzwungen, damit der Name eindeutig
    // GESCHRIEBEN wird und nicht nur eindeutig verglichen.
    pattern: "^[a-z0-9][a-z0-9_-]{1,31}$",
  }))
  users.fields.add(new Field({
    type: "bool",
    id: "bool_users_agent_seal",
    name: "agent_seal",
    required: false,
  }))

  users.indexes = [
    ...(users.indexes || []).filter(i => !/idx_users_username/.test(i)),
    "CREATE UNIQUE INDEX `idx_users_username` ON `users` (`username` COLLATE NOCASE) WHERE `username` != ''",
  ]

  // Login wahlweise per E-Mail ODER Username.
  if (users.passwordAuth) {
    const felder = users.passwordAuth.identityFields || []
    if (!felder.includes("username")) users.passwordAuth.identityFields = [...felder, "username"]
  }

  return app.save(users)
}, (app) => {
  const users = app.findCollectionByNameOrId("_pb_users_auth_")
  users.indexes = (users.indexes || []).filter(i => !/idx_users_username/.test(i))
  if (users.passwordAuth) {
    users.passwordAuth.identityFields =
      (users.passwordAuth.identityFields || []).filter(f => f !== "username")
  }
  try { users.fields.removeById("text_users_username") } catch (e) {}
  try { users.fields.removeById("bool_users_agent_seal") } catch (e) {}
  return app.save(users)
})
