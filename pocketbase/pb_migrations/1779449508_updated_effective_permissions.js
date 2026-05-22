/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_4105781894")

  // update collection data
  unmarshal({
    "createRule": "object.owner = @request.auth.id",
    "deleteRule": "object.owner = @request.auth.id",
    "updateRule": "object.owner = @request.auth.id"
  }, collection)

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_4105781894")

  // update collection data
  unmarshal({
    "createRule": null,
    "deleteRule": null,
    "updateRule": null
  }, collection)

  return app.save(collection)
})
