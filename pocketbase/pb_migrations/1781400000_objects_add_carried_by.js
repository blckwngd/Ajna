/// <reference path="../pb_data/types.d.ts" />
// Fügt der objects-Collection ein Relations-Feld `carried_by` (→ users) hinzu.
//
// Inventar-Lifecycle: leer = Objekt liegt in der WELT (an lat/lon), gesetzt =
// Objekt wird von diesem User GETRAGEN (im Inventar, aus der Welt ausgeblendet).
//   • Welt-Ansicht (Karte/AR) zeigt nur Objekte mit leerem carried_by.
//   • Inventar zeigt Objekte mit carried_by = eigener User.
// Aufnehmen/Platzieren laufen server-autoritativ über /api/objects/{id}/pickup
// und /place (main.pb.js) — kein direkter Client-Write.
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_592032537")

  collection.fields.addAt(16, new Field({
    "cascadeDelete": false,
    "collectionId": "_pb_users_auth_",
    "hidden": false,
    "id": "relation_carried_by0",
    "maxSelect": 1,
    "minSelect": 0,
    "name": "carried_by",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "relation"
  }))

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_592032537")
  collection.fields.removeById("relation_carried_by0")
  return app.save(collection)
})
