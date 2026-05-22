/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_592032537")

  // update collection data
  unmarshal({
    "listRule": "owner = @request.auth.id || (@collection.effective_permissions.object = id && @collection.effective_permissions.user = @request.auth.id && @collection.effective_permissions.rights ?~ \"view\")",
    "updateRule": null,
    "viewRule": "owner = @request.auth.id || (@collection.effective_permissions.object = id && @collection.effective_permissions.user = @request.auth.id && @collection.effective_permissions.rights ?~ \"view\")"
  }, collection)

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_592032537")

  // update collection data
  unmarshal({
    "listRule": "public_read = true || @request.auth.id != \"\"",
    "updateRule": "owner = @request.auth.id",
    "viewRule": "@request.auth.id != \"\""
  }, collection)

  return app.save(collection)
})
