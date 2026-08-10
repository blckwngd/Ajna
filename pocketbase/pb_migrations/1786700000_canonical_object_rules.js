/// <reference path="../pb_data/types.d.ts" />
// Kanonischer Regelsatz für objects + object_permissions — setzt die Regeln
// EXPLIZIT, statt sich auf den historisch gewachsenen Stand der jeweiligen
// Instanz zu verlassen. Anlass: Auf dem VPS fehlte der updateRule die
// edit-über-Cache-Klausel (PATCH → 404 für Admin-Spieler), lokal war sie da —
// Regel-Drift zwischen Instanzen. Ab jetzt ist DIESE Migration die Wahrheit.
//
// Semantik (vgl. Memory ajna-permissions-concept):
//   view   = Besitzer | Cache-view (user/group-ACEs) | implizite Audiences
//            (authenticated/everyone bzw. anonymous/everyone) direkt auf ACEs
//   update = Besitzer | Cache-edit          (Audiences editieren NICHT implizit)
//   delete = Besitzer | Cache-owner
//   ACE-Verwaltung (object_permissions) = Besitzer | Cache-owner

const CACHE = (right) => `(@collection.effective_permissions.object = id && @collection.effective_permissions.user = @request.auth.id && @collection.effective_permissions.rights ?~ "${right}")`
const CACHE_VIA_OBJ = (right) => `(@collection.effective_permissions.object = object.id && @collection.effective_permissions.user = @request.auth.id && @collection.effective_permissions.rights ?~ "${right}")`
const IMPLICIT_AUTH = '(@request.auth.id != "" && @collection.object_permissions.object = id && (@collection.object_permissions.subject_type = "authenticated" || @collection.object_permissions.subject_type = "everyone") && @collection.object_permissions.rights ?~ "view")'
const IMPLICIT_ANON = '(@request.auth.id = "" && @collection.object_permissions.object = id && (@collection.object_permissions.subject_type = "anonymous" || @collection.object_permissions.subject_type = "everyone") && @collection.object_permissions.rights ?~ "view")'

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
  // Down: Stand VOR der owner-Recht-Ära (Besitzer-only für ACEs/Delete,
  // view/update mit Cache — der historisch dokumentierte pb_schema-Stand).
  const objects = app.findCollectionByNameOrId("objects")
  const OLD_VIEW = 'owner = @request.auth.id || (@collection.effective_permissions.object = id && @collection.effective_permissions.user = @request.auth.id && @collection.effective_permissions.rights ?~ "view")'
  objects.listRule = OLD_VIEW
  objects.viewRule = OLD_VIEW
  objects.updateRule = 'owner = @request.auth.id || (@collection.effective_permissions.object = id && @collection.effective_permissions.user = @request.auth.id && @collection.effective_permissions.rights ?~ "edit")'
  objects.deleteRule = '@request.auth.id = owner.id'
  app.save(objects)

  const aces = app.findCollectionByNameOrId("object_permissions")
  const OLD_ACE = 'object.owner = @request.auth.id'
  aces.listRule = OLD_ACE
  aces.viewRule = OLD_ACE
  aces.createRule = OLD_ACE
  aces.updateRule = OLD_ACE
  aces.deleteRule = OLD_ACE
  return app.save(aces)
})
