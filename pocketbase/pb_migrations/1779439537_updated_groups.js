/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_3346940990")

  // add field
  collection.fields.addAt(4, new Field({
    "cascadeDelete": false,
    "collectionId": "pbc_3346940990",
    "hidden": false,
    "id": "relation2517741909",
    "maxSelect": 999,
    "minSelect": 0,
    "name": "subgroups",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "relation"
  }))

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_3346940990")

  // remove field
  collection.fields.removeById("relation2517741909")

  return app.save(collection)
})
