/// <reference path="../pb_data/types.d.ts" />
// Fügt der objects-Collection ein Top-Level-Feld `description` hinzu.
// Universelle Objekt-Beschreibung (wie `name`), die per "examine" ausgegeben
// wird — nützlich für Director-Figuren, AIS-Schiffe, POIs und beliebige Objekte.
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_592032537")

  // an Index 14 (nach `actions`, vor den autodate-Feldern created/updated).
  collection.fields.addAt(14, new Field({
    "autogeneratePattern": "",
    "hidden": false,
    "id": "text_description0",
    "max": 2000,
    "min": 0,
    "name": "description",
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
  collection.fields.removeById("text_description0")
  return app.save(collection)
})
