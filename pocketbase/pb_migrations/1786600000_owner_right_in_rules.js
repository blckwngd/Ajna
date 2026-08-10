/// <reference path="../pb_data/types.d.ts" />
// Das ACE-Recht "owner" bekommt Zähne: Bisher prüften die Regeln für
// ACE-Verwaltung (object_permissions) und Objekt-Löschen stur das owner-FELD.
// Jetzt zählt zusätzlich ein effective_permissions-Cache-Eintrag mit dem
// Recht "owner" — damit kann ein Agent (z. B. HA-Gateway) einem Spieler per
// User-ACE de facto Besitzrechte geben, ohne das owner-Feld umzuhängen
// (der Agent bleibt Besitzer und kann seine Objekte weiter pflegen).
//
// Hinweis: Der Cache wird von den pb_hooks bei ACE-Änderungen neu berechnet;
// implizite Audiences (authenticated/…) landen NICHT im Cache — das
// owner-Recht ist ohnehin nur für user/group erlaubt (applyOwnerDefaults).

const OWNER_VIA_CACHE_OBJ = '(@collection.effective_permissions.object = object.id && @collection.effective_permissions.user = @request.auth.id && @collection.effective_permissions.rights ?~ "owner")'
const OWNER_VIA_CACHE_SELF = '(@collection.effective_permissions.object = id && @collection.effective_permissions.user = @request.auth.id && @collection.effective_permissions.rights ?~ "owner")'

migrate((app) => {
  const aces = app.findCollectionByNameOrId("object_permissions")
  const rule = `object.owner = @request.auth.id || ${OWNER_VIA_CACHE_OBJ}`
  aces.listRule = rule
  aces.viewRule = rule
  aces.createRule = rule
  aces.updateRule = rule
  aces.deleteRule = rule
  app.save(aces)

  const objects = app.findCollectionByNameOrId("objects")
  objects.deleteRule = `@request.auth.id = owner.id || ${OWNER_VIA_CACHE_SELF}`
  return app.save(objects)
}, (app) => {
  const aces = app.findCollectionByNameOrId("object_permissions")
  const rule = "object.owner = @request.auth.id"
  aces.listRule = rule
  aces.viewRule = rule
  aces.createRule = rule
  aces.updateRule = rule
  aces.deleteRule = rule
  app.save(aces)

  const objects = app.findCollectionByNameOrId("objects")
  objects.deleteRule = "@request.auth.id = owner.id"
  return app.save(objects)
})
