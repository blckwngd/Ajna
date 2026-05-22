/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_592032537")

  // update collection data
  unmarshal({
    "updateRule": "owner = @request.auth.id || (@collection.effective_permissions.object = id && @collection.effective_permissions.user = @request.auth.id && @collection.effective_permissions.rights ?~ \"edit\")"
  }, collection)

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_592032537")

  // update collection data
  unmarshal({
    "updateRule": null
  }, collection)

  return app.save(collection)
})
