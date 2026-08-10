/// <reference path="../pb_data/types.d.ts" />
// Korrektur der kanonischen Regeln: ANY-Match-Operatoren (?=) statt =.
//
// PocketBase-Falle: In API-Regeln bedeutet das nackte `=` auf
// `@collection.…`-Referenzen "ALLE Zeilen der referenzierten Collection
// müssen die Bedingung erfüllen" (Multi-Match via NOT-EXISTS über einen
// Cross-Join der GESAMTEN Tabelle!). Nur die ?-Operatoren (?=, ?~) bedeuten
// "mindestens eine Zeile". Die Vorgänger-Migration (1786700000) nutzte `=` —
// die Regeln matchten dadurch NUR, solange effective_permissions praktisch
// leer war (deshalb bestanden die lokalen Tests, während der VPS mit gut
// gefüllter Cache-Tabelle konsequent 404 lieferte).
//
// Zeilen-Bindung bleibt erhalten: Alle Bedingungen derselben @collection-
// Referenz laufen über EINEN Join-Alias — ?= entfernt nur die All-Match-
// Wrapper (verifiziert am generierten SQL, PB 0.38.2, plus E2E-Selftest
// tools/acl-selftest.mjs mit befüllter Cache-Tabelle).

const CACHE = (right) => `(@collection.effective_permissions.object ?= id && @collection.effective_permissions.user ?= @request.auth.id && @collection.effective_permissions.rights ?~ "${right}")`
const CACHE_VIA_OBJ = (right) => `(@collection.effective_permissions.object ?= object.id && @collection.effective_permissions.user ?= @request.auth.id && @collection.effective_permissions.rights ?~ "${right}")`
const IMPLICIT_AUTH = '(@request.auth.id != "" && @collection.object_permissions.object ?= id && (@collection.object_permissions.subject_type ?= "authenticated" || @collection.object_permissions.subject_type ?= "everyone") && @collection.object_permissions.rights ?~ "view")'
const IMPLICIT_ANON = '(@request.auth.id = "" && @collection.object_permissions.object ?= id && (@collection.object_permissions.subject_type ?= "anonymous" || @collection.object_permissions.subject_type ?= "everyone") && @collection.object_permissions.rights ?~ "view")'

const VIEW_RULE = `owner = @request.auth.id || ${CACHE('view')} || ${IMPLICIT_AUTH} || ${IMPLICIT_ANON}`
const UPDATE_RULE = `owner = @request.auth.id || ${CACHE('edit')}`
const DELETE_RULE = `@request.auth.id = owner.id || ${CACHE('owner')}`
const ACE_RULE = `object.owner = @request.auth.id || ${CACHE_VIA_OBJ('owner')}`

migrate((app) => {
  const objects = app.findCollectionByNameOrId("objects")
  objects.listRule = VIEW_RULE
  objects.viewRule = VIEW_RULE
  objects.updateRule = UPDATE_RULE
  objects.deleteRule = DELETE_RULE
  app.save(objects)

  const aces = app.findCollectionByNameOrId("object_permissions")
  aces.listRule = ACE_RULE
  aces.viewRule = ACE_RULE
  aces.createRule = ACE_RULE
  aces.updateRule = ACE_RULE
  aces.deleteRule = ACE_RULE
  return app.save(aces)
}, (app) => {
  // Down: Stand der (fehlerhaften) All-Match-Variante aus 1786700000.
  const C = (r) => `(@collection.effective_permissions.object = id && @collection.effective_permissions.user = @request.auth.id && @collection.effective_permissions.rights ?~ "${r}")`
  const CO = (r) => `(@collection.effective_permissions.object = object.id && @collection.effective_permissions.user = @request.auth.id && @collection.effective_permissions.rights ?~ "${r}")`
  const IA = '(@request.auth.id != "" && @collection.object_permissions.object = id && (@collection.object_permissions.subject_type = "authenticated" || @collection.object_permissions.subject_type = "everyone") && @collection.object_permissions.rights ?~ "view")'
  const IN = '(@request.auth.id = "" && @collection.object_permissions.object = id && (@collection.object_permissions.subject_type = "anonymous" || @collection.object_permissions.subject_type = "everyone") && @collection.object_permissions.rights ?~ "view")'
  const objects = app.findCollectionByNameOrId("objects")
  const view = `owner = @request.auth.id || ${C('view')} || ${IA} || ${IN}`
  objects.listRule = view
  objects.viewRule = view
  objects.updateRule = `owner = @request.auth.id || ${C('edit')}`
  objects.deleteRule = `@request.auth.id = owner.id || ${C('owner')}`
  app.save(objects)

  const aces = app.findCollectionByNameOrId("object_permissions")
  const rule = `object.owner = @request.auth.id || ${CO('owner')}`
  aces.listRule = rule
  aces.viewRule = rule
  aces.createRule = rule
  aces.updateRule = rule
  aces.deleteRule = rule
  return app.save(aces)
})
