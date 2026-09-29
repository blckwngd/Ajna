/// <reference path="../pb_data/types.d.ts" />
// `render_budget` und `render_range_m` an `agent_manifests`.
//
// WAS FEHLTE: Beide Werte wurden vom Client GELESEN (`AgentFilters`), aber nie
// gespeichert — die Collection hatte die Felder nicht, und
// `AjnaClient.upsertAgentManifest` baut seine Nutzlast aus einer festen Liste.
// Was ein Agent publishte, fiel lautlos auf dem Weg heraus.
//
// Gemerkt am 21.09.2026 beim Einbau der Sichtweite je Quelle: `adsb-bridge`
// setzt seit jeher `render_budget: 0` („unbegrenzt", weil Flugzeuge naturgemäß
// weit weg sind). Angekommen ist das nie — der Client fiel jedes Mal auf seine
// Vorgabe von 50 zurück, und die Kommentare im Code beschrieben eine Funktion,
// die es nicht gab.
//
// WOZU DIE ZWEITE ZAHL: Der Regler „Objekte" in den Einstellungen gilt für
// alles. Ein Flugzeug in 11 km ist erwünscht, ein Wegekreuz in 11 km ist
// Rauschen — wer den Regler so weit zudreht, dass die Denkmäler ausdünnen,
// verliert die Flugzeuge mit. `render_range_m` lässt eine dichte, ortsfeste
// Quelle sich selbst zügeln. Der Regler bleibt die Obergrenze: Es gilt immer
// der kleinere der beiden Werte.
//
// BEIDE SIND OPTIONAL. Ohne Angabe gilt, was bisher galt (Budget 50,
// Sichtweite unbegrenzt) — kein bestehender Agent ändert sein Verhalten.

migrate((app) => {
  const c = app.findCollectionByNameOrId('agent_manifests')
  for (const name of ['render_budget', 'render_range_m']) {
    if (!c.fields.getByName(name)) c.fields.add(new Field({ name, type: 'number' }))
  }
  return app.save(c)
}, (app) => {
  const c = app.findCollectionByNameOrId('agent_manifests')
  for (const name of ['render_budget', 'render_range_m']) {
    const f = c.fields.getByName(name)
    if (f) c.fields.removeById(f.id)
  }
  return app.save(c)
})
