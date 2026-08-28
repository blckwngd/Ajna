/// <reference path="../pb_data/types.d.ts" />
//
// Collection `quest_proofs` — Bilder zu einer Auftrags-Einreichung.
//
// WARUM EINE EIGENE COLLECTION:
// Dateien brauchen ein Dateifeld, und `objects.state` ist JSON. Wichtiger noch:
// Ein Beweis muss GELÖSCHT werden können, ohne den Auftrag anzufassen — genau
// das ist der Sinn der Aufbewahrungsfrist weiter unten. Ein eigener Datensatz
// macht daraus einen Einzeiler; PocketBase räumt die Dateien mit dem Datensatz
// weg.
//
// DREI BILDER, KEINE ROLLENPFLICHT
// Anfangs war das als „Vorher/Nachher" gedacht. Das ist eine Falle: Ein sauber
// erledigter Auftrag scheitert sonst daran, dass jemand vergessen hat, VORHER
// zu fotografieren. Deshalb: bis zu drei Bilder, frei belegt. Ein Vorher-Bild
// macht die Abnahme leichter und wird darum empfohlen — erzwungen wird es nie.
//
// WAS NICHT HOCHGELADEN WIRD: die Aufnahme-Metadaten. Der Client zeichnet jedes
// Bild vor dem Senden neu (siehe client/core/BildAufbereitung.js) — damit sind
// GPS-Koordinaten und Aufnahmezeit weg. Ein Beweisfoto, das die Position
// mitliefert, würde die vier Privatsphäre-Stufen aushebeln, für die der Rest
// des Systems einigen Aufwand treibt.
//
// WER DARF ES SEHEN: der Einreichende und der Aussteller. Ein Foto von einem
// realen Ort, womöglich mit Menschen darauf, ist nichts, was alle Angemeldeten
// sehen müssen. Die Schwarm-Abnahme bestätigt vor Ort und braucht es nicht.
//
// SCHREIBEN darf nur, wer den Datensatz auf sich selbst ausstellt — `user` muss
// das eigene Konto sein. Ändern darf ihn niemand: Ein nachträglich
// ausgetauschtes Beweisbild wäre kein Beweis.

migrate((app) => {
  const objects = app.findCollectionByNameOrId('objects')

  const collection = new Collection({
    type: 'base',
    name: 'quest_proofs',
    listRule: 'user = @request.auth.id || call.owner = @request.auth.id',
    viewRule: 'user = @request.auth.id || call.owner = @request.auth.id',
    // Anlegen ja, ändern nein. Löschen übernimmt der Aufräum-Lauf mit $app.
    createRule: '@request.auth.id != "" && user = @request.auth.id',
    updateRule: null,
    deleteRule: null,
    fields: [
      {
        type: 'relation',
        name: 'call',
        required: true,
        collectionId: objects.id,
        cascadeDelete: true,     // Auftrag weg → Beweise weg, samt Dateien
        maxSelect: 1,
      },
      {
        type: 'relation',
        name: 'user',
        required: true,
        collectionId: '_pb_users_auth_',
        cascadeDelete: true,
        maxSelect: 1,
      },
      {
        // Wie in quest_confirmations: Ein wiederholbarer Auftrag wird mehrfach
        // eingereicht. Ohne diese Kennung hinge das Bild des vorigen Durchgangs
        // am nächsten.
        type: 'text',
        name: 'submission',
        required: true,
        max: 40,
      },
      {
        type: 'file',
        name: 'images',
        required: false,
        maxSelect: 3,
        maxSize: 2000000,        // 2 MB je Bild — der Client verkleinert vorher
        mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
        // Vorschau für die Abnahme-Liste; PocketBase erzeugt sie auf Anfrage
        // und legt sie neben dem Original ab.
        thumbs: ['320x240'],
      },
      {
        type: 'text',
        name: 'note',
        required: false,
        max: 500,
      },
      {
        type: 'autodate',
        name: 'created',
        onCreate: true,
        onUpdate: false,
      },
    ],
    indexes: [
      'CREATE INDEX `idx_qproof_call_sub` ON `quest_proofs` (`call`, `submission`)',
      'CREATE INDEX `idx_qproof_created` ON `quest_proofs` (`created`)',
    ],
  })
  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId('quest_proofs')
  return app.delete(collection)
})
