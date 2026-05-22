/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = new Collection({
    "createRule": null,
    "deleteRule": null,
    "fields": [
      {
        "autogeneratePattern": "[a-z0-9]{15}",
        "hidden": false,
        "id": "text3208210256",
        "max": 15,
        "min": 15,
        "name": "id",
        "pattern": "^[a-z0-9]+$",
        "presentable": false,
        "primaryKey": true,
        "required": true,
        "system": true,
        "type": "text"
      },
      {
        "cascadeDelete": true,
        "collectionId": "pbc_592032537",
        "hidden": false,
        "id": "relation2829954028",
        "maxSelect": 1,
        "minSelect": 0,
        "name": "object",
        "presentable": false,
        "required": true,
        "system": false,
        "type": "relation"
      },
      {
        "hidden": false,
        "id": "select504681458",
        "maxSelect": 1,
        "name": "subject_type",
        "presentable": false,
        "required": true,
        "system": false,
        "type": "select",
        "values": [
          "user",
          "group",
          "authenticated",
          "anonymous",
          "everyone"
        ]
      },
      {
        "autogeneratePattern": "",
        "hidden": false,
        "id": "text4224597626",
        "max": 0,
        "min": 0,
        "name": "subject",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": false,
        "system": false,
        "type": "text"
      },
      {
        "hidden": false,
        "id": "select23122179",
        "maxSelect": 4,
        "name": "rights",
        "presentable": false,
        "required": false,
        "system": false,
        "type": "select",
        "values": [
          "view",
          "edit",
          "move",
          "owner"
        ]
      },
      {
        "hidden": false,
        "id": "json2638574667",
        "maxSize": 0,
        "name": "interact_actions",
        "presentable": false,
        "required": false,
        "system": false,
        "type": "json"
      },
      {
        "hidden": false,
        "id": "autodate2990389176",
        "name": "created",
        "onCreate": true,
        "onUpdate": false,
        "presentable": false,
        "system": false,
        "type": "autodate"
      },
      {
        "hidden": false,
        "id": "autodate3332085495",
        "name": "updated",
        "onCreate": true,
        "onUpdate": true,
        "presentable": false,
        "system": false,
        "type": "autodate"
      }
    ],
    "id": "pbc_2237939851",
    "indexes": [
      "CREATE UNIQUE INDEX `idx_object_perm_unique` ON `object_permissions` (\n  `object`,\n  `subject_type`,\n  `subject`\n)"
    ],
    "listRule": null,
    "name": "object_permissions",
    "system": false,
    "type": "base",
    "updateRule": null,
    "viewRule": null
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_2237939851");

  return app.delete(collection);
})
