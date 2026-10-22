/// <reference path="../pb_data/types.d.ts" />
// `objects.updateRule` lässt `move` zusätzlich zu `edit` durch — Arbeitspaket 2a.
//
// Die Regel allein kann Feldmengen nicht vergleichen; sie öffnet nur die Tür.
// Was ein `move`-Konto hinter der Tür darf (Position und Drehung, sonst
// nichts), prüft der Hook `moveNurPosition` in main.pb.js und antwortet mit
// 403, wenn mehr geändert werden soll.
//
// In der `?=`-FASSUNG, nicht mit `=`: Ein nacktes `=` auf einer
// `@collection`-Referenz heißt „ALLE Zeilen" (siehe 1792600000). Genau diese
// Erweiterung ist am 16.09. einmal gescheitert — in der ALL-Match-Form
// geschrieben, konnte sie nie treffen.
//
// Mehrfach ausführbar; setzt nur diese eine Regel.

const CACHE = (recht) => '(@collection.effective_permissions.object ?= id'
  + ' && @collection.effective_permissions.user ?= @request.auth.id'
  + ` && @collection.effective_permissions.rights ?~ "${recht}")`

const MIT_MOVE = `owner = @request.auth.id || ${CACHE('edit')} || ${CACHE('move')}`
const OHNE_MOVE = `owner = @request.auth.id || ${CACHE('edit')}`

migrate((app) => {
  const objects = app.findCollectionByNameOrId('objects')
  if (objects.updateRule === MIT_MOVE) {
    console.log('[migration] objects.updateRule kennt move schon — nichts zu tun')
    return
  }
  console.log('[migration] objects.updateRule vorher: ' + objects.updateRule)
  objects.updateRule = MIT_MOVE
  return app.save(objects)
}, (app) => {
  const objects = app.findCollectionByNameOrId('objects')
  objects.updateRule = OHNE_MOVE
  return app.save(objects)
})
