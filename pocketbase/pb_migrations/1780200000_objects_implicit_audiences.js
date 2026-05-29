/// <reference path="../pb_data/types.d.ts" />
//
// objects.listRule / objects.viewRule erweitern: bisher zählte nur ein
// Eintrag in effective_permissions, was bei impliziten Audiences nie
// passiert (authenticated/anonymous/everyone werden bewusst NICHT cached
// — siehe permissions.js Header). Folge: ACEs mit subject_type=authenticated
// & rights=[view] hatten zwar einen Eintrag in object_permissions, aber
// niemand außer dem Owner sah das Objekt.
//
// Neue Rule prüft den Resolver-Cache UND zusätzlich object_permissions
// direkt für die drei impliziten Audiences. Identische Klauseln für
// listRule + viewRule.

const RULE =
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

const OLD_RULE =
  'owner = @request.auth.id'
  + ' || (@collection.effective_permissions.object = id'
  +     ' && @collection.effective_permissions.user = @request.auth.id'
  +     ' && @collection.effective_permissions.rights ?~ "view")'

migrate((app) => {
  const c = app.findCollectionByNameOrId('objects')
  c.listRule = RULE
  c.viewRule = RULE
  return app.save(c)
}, (app) => {
  const c = app.findCollectionByNameOrId('objects')
  c.listRule = OLD_RULE
  c.viewRule = OLD_RULE
  return app.save(c)
})
