/// <reference path="../pb_data/types.d.ts" />
// Implizite Audiences als Spalte am Objekt statt als zweiter JOIN.
//
// WARUM: Die View-Regel verband je Zeile EINMAL `effective_permissions` und
// EINMAL `object_permissions`. Zwei LEFT JOINs auf derselben Zeile bilden ein
// Kreuzprodukt — und darüber läuft ein DISTINCT. Gemessen am 17.09.2026 bei
// 974 Objekten, 12 Cache-Zeilen und 952 ACEs, jeweils 100 Sätze:
//
//     nur `owner`                          0,02 s
//     owner + Cache-JOIN                   0,03 s
//     owner + Audience-JOIN                0,35 s
//     owner + BEIDE JOINs (bisher)         4,02 s   ← keine Summe, ein Produkt
//     owner + Spalte + Cache-JOIN          0,04 s   ← diese Migration
//
// Als Superuser (Regeln übersprungen) dauerten 500 Sätze 0,07 s — die Daten
// waren also nie das Problem, und ein Index hätte nichts geändert.
//
// WAS DARAN HING: Bei rund 650 Objekten überschritt die Abfrage PocketBases
// 30-Sekunden-Grenze und kam als nichtssagender 400 zurück
// („Something went wrong while processing your request"). Agenten, die den
// Fehler abfingen, liefen mit LEEREM Bestand weiter und legten ihre Welt neu
// an: An einem Nachmittag entstanden 281 Dubletten. Wer ihn nicht abfing
// (`wand-agent`, `uwb-anchors`), stürzte beim Start ab.
//
// DIE SEMANTIK BLEIBT UNVERÄNDERT. Die beiden Spalten sind kein neues Recht,
// sondern eine Materialisierung dessen, was die ACEs ohnehin sagen:
//
//     everyone       → view_auth UND view_anon
//     authenticated  → view_auth
//     anonymous      → view_anon
//
// Gepflegt werden sie in `recomputeForObject` (pb_hooks/permissions.js) — an
// derselben Stelle, an der auch der Rechte-Cache entsteht, und ausgelöst von
// denselben Hooks auf `object_permissions`. Eine zweite Wahrheit entsteht
// dadurch nicht: Die ACEs bleiben die Quelle, die Spalten sind ihr Abdruck.
//
// `public_read` bleibt unangetastet. Das Feld ist tot (1 von 976 Objekten,
// nirgends im Code gelesen) — es hier umzudeuten hiesse, einen alten Namen mit
// neuer Bedeutung zu belegen, und das ist die Sorte Falle, die man zwei Jahre
// später nicht mehr sieht.

const CACHE = (right) => `(@collection.effective_permissions.object ?= id && @collection.effective_permissions.user ?= @request.auth.id && @collection.effective_permissions.rights ?~ "${right}")`
const AUDIENCE = '((@request.auth.id != "" && view_auth = true) || (@request.auth.id = "" && view_anon = true))'

const VIEW_RULE = `owner = @request.auth.id || ${CACHE('view')} || ${AUDIENCE}`

// Stand VOR dieser Migration (1786800000_any_match_rules.js) — für das Down.
const ALT_IMPLICIT_AUTH = '(@request.auth.id != "" && @collection.object_permissions.object ?= id && (@collection.object_permissions.subject_type ?= "authenticated" || @collection.object_permissions.subject_type ?= "everyone") && @collection.object_permissions.rights ?~ "view")'
const ALT_IMPLICIT_ANON = '(@request.auth.id = "" && @collection.object_permissions.object ?= id && (@collection.object_permissions.subject_type ?= "anonymous" || @collection.object_permissions.subject_type ?= "everyone") && @collection.object_permissions.rights ?~ "view")'
const ALT_VIEW_RULE = `owner = @request.auth.id || ${CACHE('view')} || ${ALT_IMPLICIT_AUTH} || ${ALT_IMPLICIT_ANON}`

migrate((app) => {
  const objects = app.findCollectionByNameOrId("objects")

  // Felder anlegen, falls sie fehlen (die Migration soll wiederholbar sein).
  for (const name of ["view_auth", "view_anon"]) {
    if (!objects.fields.getByName(name)) {
      objects.fields.add(new Field({ name, type: "bool" }))
    }
  }
  app.save(objects)

  // NACHTRAGEN, WAS DIE ACEs SCHON SAGEN. Per SQL statt über die Hooks: Für
  // knapp tausend Objekte einzeln `recomputeForObject` zu rufen hiesse, beim
  // Start jedes Servers minutenlang denselben Abdruck neu zu erzeugen.
  //
  // `rights LIKE '%view%'` genügt: Die erlaubten Werte sind view/edit/move/
  // owner, und "view" ist in keinem der anderen enthalten.
  app.db().newQuery(`
    UPDATE objects SET
      view_auth = (SELECT count(*) > 0 FROM object_permissions p
                   WHERE p.object = objects.id
                     AND p.subject_type IN ('authenticated', 'everyone')
                     AND p.rights LIKE '%view%'),
      view_anon = (SELECT count(*) > 0 FROM object_permissions p
                   WHERE p.object = objects.id
                     AND p.subject_type IN ('anonymous', 'everyone')
                     AND p.rights LIKE '%view%')
  `).execute()

  objects.listRule = VIEW_RULE
  objects.viewRule = VIEW_RULE
  return app.save(objects)
}, (app) => {
  const objects = app.findCollectionByNameOrId("objects")
  objects.listRule = ALT_VIEW_RULE
  objects.viewRule = ALT_VIEW_RULE
  app.save(objects)

  const frisch = app.findCollectionByNameOrId("objects")
  for (const name of ["view_auth", "view_anon"]) {
    const f = frisch.fields.getByName(name)
    if (f) frisch.fields.removeById(f.id)
  }
  return app.save(frisch)
})
