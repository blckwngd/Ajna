/// <reference path="../pb_data/types.d.ts" />
// Fügt der objects-Collection ein Top-Level-JSON-Feld `appearance` hinzu.
// Agent-definierte Darstellung — der Viewer interpretiert nur noch:
//   {
//     "shape": "circle" | "emoji" | "pin" | "box" | ...,  // 2D-Repr + AR-Fallback
//     "emoji": "🤖",            // bei shape:"emoji"
//     "gltf":  ".../model.glb", // optionales 3D-Upgrade (gewinnt in AR)
//     "color": "#28a0d7",       // Füll-/Strichfarbe
//     "radius": 12,             // optional, sonst aus scale
//     "texture": "..."          // optional, falls der Client es kennt
//   }
// Map nutzt nur `shape`(+emoji/color/radius); AR: gültiges `gltf` gewinnt, sonst
// `shape`-Fallback. So sind Agents und Viewer entkoppelt — neue Agent-Arten
// brauchen keine Viewer-Änderung. Fehlt `appearance`, greift die bisherige
// Logik (model_url / MARKER_TYPES / encStyle) weiter.
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_592032537")

  // an Index 15 (nach `description`, vor created/updated).
  collection.fields.addAt(15, new Field({
    "hidden": false,
    "id": "json_appearance0",
    "maxSize": 0,
    "name": "appearance",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "json"
  }))

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_592032537")
  collection.fields.removeById("json_appearance0")
  return app.save(collection)
})
