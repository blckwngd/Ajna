/// <reference path="../pb_data/types.d.ts" />
// Sammelobjekte: ein Objekt kann andere enthalten (docs/sammelobjekte.md).
//
// Fünf Felder an `objects`, alle optional, Bestand bleibt unverändert:
//
//   parent     → objects   das Sammelobjekt, in dem dieses Objekt steckt
//   local      json        Versatz zum Eltern in Metern und Grad
//                          { east, north, up, heading }; leer = eigene Lage
//   heading    number      Ausrichtung um die Hochachse, Grad im Uhrzeigersinn
//                          ab Nord (für den Versatz der Kinder)
//   acl_break  bool        true = erbt die ACEs des Eltern NICHT
//   container  json        vorhanden = darf Kinder aufnehmen; darin die
//                          Darstellung: { badge, view, expanded, load }
//
// `acl_break` statt `inherit_acl`: Ein bool-Feld steht für alte Zeilen und
// für jedes Anlegen ohne das Feld auf false. „false = erbt" ist damit die
// sichere Vorgabe; „false = erbt nicht" hätte jedes bestehende Objekt
// isoliert und jeden Agenten gezwungen, das Feld zu kennen.
//
// Mehrfach ausführbar: Felder und Index werden nur angelegt, wenn sie fehlen.

const INDEX = "CREATE INDEX `idx_objects_parent` ON `objects` (`parent`)"

migrate((app) => {
  const objects = app.findCollectionByNameOrId("objects")
  const add = (f) => { if (!objects.fields.getByName(f.name)) objects.fields.add(new Field(f)) }

  add({ name: "parent", type: "relation", collectionId: objects.id, maxSelect: 1, minSelect: 0, cascadeDelete: false })
  add({ name: "local", type: "json" })
  add({ name: "heading", type: "number" })
  add({ name: "acl_break", type: "bool" })
  add({ name: "container", type: "json" })

  // `childrenOf` fragt bei jeder Änderung eines Objekts nach seinen Kindern.
  const idx = objects.indexes || []
  if (!idx.some(s => /idx_objects_parent/.test(String(s)))) objects.indexes = idx.concat([INDEX])

  app.save(objects)
}, (app) => {
  const objects = app.findCollectionByNameOrId("objects")
  objects.indexes = (objects.indexes || []).filter(s => !/idx_objects_parent/.test(String(s)))
  for (const name of ["container", "acl_break", "heading", "local", "parent"]) {
    const f = objects.fields.getByName(name)
    if (f) objects.fields.removeById(f.id)
  }
  app.save(objects)
})
