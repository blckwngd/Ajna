/// <reference path="../pb_data/types.d.ts" />
//
// Collection `agent_manifests` — Self-Service-Anmeldung von Agents am
// PB-Server. Jeder Agent (POI-Bridge, AIS-Bridge, …) trägt beim Boot ein,
// welche Daten-Layer er anbietet. Der Client lädt die Manifests und baut
// daraus den Filter-Dialog ("Welche Schiffe / POIs will ich sehen?").
//
// Felder:
//   source       — Marker, der zu state.source auf den vom Agent
//                  angelegten Objekten passt (z. B. "overpass", "aisstream").
//                  Der Client matched Objekt → Manifest darüber.
//   agent_name   — Anzeigename ("POI-Bridge", "AIS-Bridge")
//   description  — kurze Beschreibung
//   layers       — JSON-Array von { key, label, predicate? }.
//                  predicate=null → "alles anzeigen"-Layer
//                  predicate={ field: "state.osm_tags.amenity", equals: "cafe" }
//                  → matched objects where dieser Tag-Pfad === Wert
//   owner        — User, der den Agent betreibt
//
// Rules:
//   list/view = jeder eingeloggte User darf alle Manifests sehen
//                (sie sind reine Metadaten, kein Privacy-Risiko)
//   create    = nur als sich selbst eintragen
//   update    = nur eigenes Manifest
//   delete    = nur eigenes Manifest

migrate((app) => {
  const collection = new Collection({
    type: 'base',
    name: 'agent_manifests',
    listRule:   '@request.auth.id != ""',
    viewRule:   '@request.auth.id != ""',
    createRule: '@request.auth.id != "" && owner = @request.auth.id',
    updateRule: 'owner = @request.auth.id',
    deleteRule: 'owner = @request.auth.id',
    fields: [
      {
        type: 'text',
        name: 'source',
        required: true,
        max: 100
      },
      {
        type: 'text',
        name: 'agent_name',
        required: true,
        max: 200
      },
      {
        type: 'text',
        name: 'description',
        required: false,
        max: 1000
      },
      {
        type: 'json',
        name: 'layers',
        required: false,
        maxSize: 0
      },
      {
        type: 'relation',
        name: 'owner',
        required: true,
        collectionId: '_pb_users_auth_',
        cascadeDelete: true,
        maxSelect: 1
      },
      // System-Felder (created/updated) werden von PB automatisch ergänzt.
    ],
    indexes: [
      // (source, owner) als unique, damit ein Agent-User pro Source genau
      // EIN Manifest hat. Idempotent-Upsert in der Bridge: lookup by source
      // + owner, update oder create.
      'CREATE UNIQUE INDEX `idx_agent_manifests_source_owner` ON `agent_manifests` (`source`, `owner`)'
    ]
  })
  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId('agent_manifests')
  return app.delete(collection)
})
