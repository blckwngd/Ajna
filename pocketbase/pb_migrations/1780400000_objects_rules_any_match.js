/// <reference path="../pb_data/types.d.ts" />
//
// Folge-Migration zu 1780300000_objects_rules_consolidated.js.
//
// Aus der SQL-Analyse (mit PB_LOG_LEVEL=-4 sichtbar gemacht) ergibt sich:
// der `=`-Operator in der PB-Filter-DSL erzeugt für Join-Spalten eine
// "ALL match"-Semantik. Das heißt z. B. `@collection.object_permissions.subject_type = "authenticated"`
// fordert, dass ALLE gejointen object_permissions-Zeilen subject_type=
// "authenticated" haben — und sobald irgendwo in der DB eine ACE mit
// einem anderen subject_type existiert (User/Group/everyone/anonymous),
// kippt das für JEDES Objekt um.
//
// Korrekter Operator ist `?=` ("any-match", analog zu `?~` für
// LIKE-Vergleiche). Damit prüft die Klausel per-Row: "es existiert
// EINE gejointe Zeile mit subject_type=X" — was wir eigentlich wollen.
//
// Das gleiche Problem schlug bei effective_permissions zu: dort
// erzeugt `user = @request.auth.id` einen NOT-EXISTS-Check "alle Rows
// gehören diesem User", was sobald andere User Cache-Einträge haben
// einknickt.

const RULE =
  'owner = @request.auth.id'
  + ' || (@collection.effective_permissions.object ?= id'
  +     ' && @collection.effective_permissions.user ?= @request.auth.id'
  +     ' && @collection.effective_permissions.rights ?~ "view")'
  + ' || (@collection.object_permissions.object ?= id'
  +     ' && @collection.object_permissions.rights ?~ "view"'
  +     ' && (@collection.object_permissions.subject_type ?= "everyone"'
  +         ' || (@collection.object_permissions.subject_type ?= "authenticated"'
  +             ' && @request.auth.id != "")'
  +         ' || (@collection.object_permissions.subject_type ?= "anonymous"'
  +             ' && @request.auth.id = "")))'

const PREV_RULE =
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
