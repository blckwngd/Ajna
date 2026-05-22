/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_592032537")

  // update collection data
  unmarshal({
    "updateRule": "owner = @request.auth.id",
    "viewRule": "@request.auth.id != \"\""
  }, collection)

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_592032537")

  // update collection data
  unmarshal({
    "updateRule": "@request.auth.id != \"\"\n",
    "viewRule": null
  }, collection)

  return app.save(collection)
})
