/// <reference path="../pb_data/types.d.ts" />
//
// Folgemigration zu 1780200000_objects_implicit_audiences.js:
//
// Die vorige Migration hatte DREI separate `@collection.object_permissions.X`-
// Referenzen (eine pro impliziter Audience). PB generiert daraus drei
// LEFT-Joins, und bei manchen Versionen/Konfigurationen werden die unter
// OR-Klauseln zu INNER-Joins — Effekt: Objekte mit nur EINER passenden
// Audience-ACE fallen wieder aus der Sicht, weil die anderen beiden Joins
// leer sind. Symptom: "1 Objekt sichtbar, dann nichts mehr", nach Reload
// gar keine Objekte mehr.
//
// Diese Migration konsolidiert auf EINEN object_permissions-Join, der die
// drei Audience-Bedingungen intern OR-verknüpft. Ein einzelner Join mit
// inneren ORs ist für SQL-Optimizer + PB-DSL deterministischer.

const RULE =
  'owner = @request.auth.id'
  + ' || (@collection.effective_permissions.object = id'
  +     ' && @collection.effective_permissions.user = @request.auth.id'
  +     ' && @collection.effective_permissions.rights ?~ "view")'
  + ' || (@collection.object_permissions.object = id'
  +     ' && @collection.object_permissions.rights ?~ "view"'
  +     ' && (@collection.object_permissions.subject_type = "everyone"'
  +         ' || (@collection.object_permissions.subject_type = "authenticated"'
  +             ' && @request.auth.id != "")'
  +         ' || (@collection.object_permissions.subject_type = "anonymous"'
  +             ' && @request.auth.id = "")))'

// Rollback-Wert = das, was 1780200000 gesetzt hat (drei separate Joins).
const PREV_RULE =
  'owner = @request.auth.id'
  + ' || (@collection.effective_permissions.object = id'
  +     ' && @collection.effective_permissions.user = @request.auth.id'
  +     ' && @collection.effective_permissions.rights ?~ "view")'
  + ' || (@collection.object_permissions.object = id'
  +     ' && @collection.object_permissions.rights ?~ "view"'
  +     ' && @collection.object_permissions.subject_type = "everyone")'
  + ' || (@collection.object_permissions.object = id'
  +     ' && @collection.object_permissions.rights ?~ "view"'
  +     ' && @collection.object_permissions.subject_type = "authenticated"'
  +     ' && @request.auth.id != "")'
  + ' || (@collection.object_permissions.object = id'
  +     ' && @collection.object_permissions.rights ?~ "view"'
  +     ' && @collection.object_permissions.subject_type = "anonymous"'
  +     ' && @request.auth.id = "")'

migrate((app) => {
  const c = app.findCollectionByNameOrId('objects')
  c.listRule = RULE
  c.viewRule = RULE
  return app.save(c)
}, (app) => {
  const c = app.findCollectionByNameOrId('objects')
  c.listRule = PREV_RULE
  c.viewRule = PREV_RULE
  return app.save(c)
})
