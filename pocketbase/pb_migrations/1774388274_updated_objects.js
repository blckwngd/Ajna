/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_592032537")

  // remove field
  collection.fields.removeById("select3632233996")

  // add field
  collection.fields.addAt(1, new Field({
    "autogeneratePattern": "",
    "hidden": false,
    "id": "text1579384326",
    "max": 32,
    "min": 0,
    "name": "name",
    "pattern": "",
    "presentable": false,
    "primaryKey": false,
    "required": false,
    "system": false,
    "type": "text"
  }))

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_592032537")

  // add field
  collection.fields.addAt(1, new Field({
    "hidden": false,
    "id": "select3632233996",
    "maxSelect": 1,
    "name": "test",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "select",
    "values": [
      "1",
      "2",
      "3"
    ]
  }))

  // remove field
  collection.fields.removeById("text1579384326")

  return app.save(collection)
})
