/// <reference path="../pb_data/types.d.ts" />
//
// agent_manifests bekommt zwei ABGELEITETE Felder: `owner_handle` und
// `owner_sealed`. Beide schreibt ausschließlich ein Hook (main.pb.js) aus dem
// Konto des Eigentümers — Clients können sie nicht setzen.
//
// WARUM HIER UND NICHT AM KONTO: Der Client müsste sonst fremde Nutzer lesen,
// um einen Handle aufzulösen. PocketBase kennt aber keine Leserechte je FELD —
// `hidden` blendet ein Feld für alle aus, auch für den Eigentümer. Ein
// geöffnetes `users.listRule` gäbe damit zwangsläufig `telefon` und `app_data`
// mit heraus, und `app_data` ist genau das Feld, in dem Anwendungen ihre
// Nutzerdaten ablegen.
//
// Manifeste sind dagegen ohnehin für alle Angemeldeten lesbar und tragen
// bereits `owner`. Sie sind damit das natürliche öffentliche Verzeichnis der
// Agent-Identitäten — ohne irgendetwas Privates zu öffnen.

migrate((app) => {
  const c = app.findCollectionByNameOrId('agent_manifests')
  c.fields.add(new Field({
    type: 'text', id: 'text_manifest_owner_handle', name: 'owner_handle',
    required: false, max: 32,
  }))
  c.fields.add(new Field({
    type: 'bool', id: 'bool_manifest_owner_sealed', name: 'owner_sealed',
    required: false,
  }))
  return app.save(c)
}, (app) => {
  const c = app.findCollectionByNameOrId('agent_manifests')
  try { c.fields.removeById('text_manifest_owner_handle') } catch (e) {}
  try { c.fields.removeById('bool_manifest_owner_sealed') } catch (e) {}
  return app.save(c)
})
