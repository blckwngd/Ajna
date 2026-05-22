/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_2237939851")

  // update collection data
  unmarshal({
    "createRule": "object.owner = @request.auth.id",
    "deleteRule": "object.owner = @request.auth.id",
    "listRule": "object.owner = @request.auth.id",
    "updateRule": "object.owner = @request.auth.id",
    "viewRule": "object.owner = @request.auth.id"
  }, collection)

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_2237939851")

  // update collection data
  unmarshal({
    "createRule": null,
    "deleteRule": null,
    "listRule": null,
    "updateRule": null,
    "viewRule": null
  }, collection)

  return app.save(collection)
})
