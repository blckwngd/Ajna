/// <reference path="../pb_data/types.d.ts" />
// `objects.updateRule` zurück auf ANY-Match (`?=`) — und damit das Ende von
// Arbeitspaket 2.
//
// WAS FALSCH WAR. In einer API-Regel bedeutet ein nacktes `=` auf einer
// `@collection.…`-Referenz nicht „es gibt eine passende Zeile", sondern „ALLE
// Zeilen der Tabelle erfüllen das" (PocketBase baut daraus ein NOT-EXISTS über
// die ganze Tabelle). Nur die Fragezeichen-Operatoren (`?=`, `?~`) heißen
// „mindestens eine Zeile". Die Regel traf deshalb genau so lange, wie
// `effective_permissions` praktisch leer war.
//
// Das ist zweimal aufgefallen und einmal schon behoben worden:
// `1786800000_any_match_rules.js` setzt alle Regeln auf `?=`, ist in dieser
// Instanz als ausgeführt vermerkt — und trotzdem stand in der laufenden
// Datenbank wieder `=`, ausgerechnet nur in dieser einen Regel (gemessen am
// 20.10. direkt in `_collections`; `pb_schema.json` im Quellbaum hatte die
// richtige Fassung, list/view/delete ebenso). Regel-Drift, wie sie
// `1786700000` im Kopf beschreibt. Eine Regel, die man in der Admin-Oberfläche
// anfassen kann, wandert eben.
//
// DIE FOLGE WAR DIE, DIE IN PAKET 2 STAND: Ein Konto mit `edit` aus einer
// ACE bekam beim PATCH 404, obwohl `effective-rights` das Recht korrekt
// auswies. Auch der Hinweis von damals passt — ein Einzelversuch lieferte
// einmal 200, nachdem alle anderen ACEs gelöscht worden waren: bei einer
// einzigen Zeile stimmt „alle Zeilen" zufällig.
//
// WAS GEMESSEN IST (Wegwerf-Kopie, 20.10.):
//   alte Regel: Besitzer-ACE-Inhaber PATCH → 404, Orga-Gruppe PATCH → 404
//   neue Regel: beide → 200
//   und NICHT durchlässig: Wer `edit` auf Objekt A hat, bekommt auf Objekt B
//   (fremde ACE) weiterhin 404 — die Bedingungen werden nicht aus
//   verschiedenen Zeilen zusammengesetzt, sie laufen über einen Join-Alias.
//
// Diese Migration setzt nur diese eine Regel und ist mehrfach ausführbar.

const CACHE_EDIT = '(@collection.effective_permissions.object ?= id'
  + ' && @collection.effective_permissions.user ?= @request.auth.id'
  + ' && @collection.effective_permissions.rights ?~ "edit")'

const RICHTIG = `owner = @request.auth.id || ${CACHE_EDIT}`
const FALSCH = 'owner = @request.auth.id || (@collection.effective_permissions.object = id'
  + ' && @collection.effective_permissions.user = @request.auth.id'
  + ' && @collection.effective_permissions.rights ?~ "edit")'

migrate((app) => {
  const objects = app.findCollectionByNameOrId("objects")
  if (objects.updateRule === RICHTIG) {
    console.log("[migration] objects.updateRule ist schon ANY-Match — nichts zu tun")
    return
  }
  console.log("[migration] objects.updateRule vorher: " + objects.updateRule)
  objects.updateRule = RICHTIG
  return app.save(objects)
}, (app) => {
  const objects = app.findCollectionByNameOrId("objects")
  objects.updateRule = FALSCH
  return app.save(objects)
})
