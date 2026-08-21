/// <reference path="../pb_data/types.d.ts" />
//
// Collection `quest_confirmations` — Stimmen der Schwarm-Abnahme.
//
// WARUM EINE EIGENE COLLECTION UND NICHT `state.call`:
// Der `state` eines Objekts gehört seinem Besitzer und ist für ihn frei
// schreibbar. Läge dort „zwei von drei haben bestätigt", könnte der Aussteller
// sich die Zustimmung selbst eintragen — und der Bearbeiter sie sich ebenso,
// sobald ihm das Objekt gehörte. Eine Stimme muss sagen können, WER sie abgibt,
// und das darf niemand nachträglich ändern.
//
// Deshalb: eine Zeile je Stimme, `voter` vom Server gesetzt, und KEINE
// Schreibrechte über die API. Geschrieben wird ausschließlich in der Route
// `POST /api/objects/{id}/quest/confirm` — Hooks laufen mit $app und gehen an
// den Regeln vorbei.
//
// FELDER
//   call        Auftrag, um den es geht
//   submission  Kennung des EINREICHUNGS-Durchgangs. Ein wiederholbarer
//               Auftrag wird mehrfach eingereicht; ohne diese Kennung zählten
//               alte Stimmen beim nächsten Mal mit. Wird beim „Erledigt melden"
//               neu vergeben.
//   voter       wer abgestimmt hat
//   verdict     "ok" oder "nein"
//   note        optionale Begründung (bei Ablehnung nützlich)
//
// LESEN DÜRFEN ALLE ANGEMELDETEN: „2 von 3 Bestätigungen" ist die Information,
// wegen der der Schwarm überhaupt funktioniert. Wer abgestimmt hat, ist damit
// sichtbar — das ist Absicht: Eine anonyme Abnahme, die über echten Besitz
// entscheidet, wäre nicht überprüfbar.
//
// EINE STIMME JE PERSON UND DURCHGANG erzwingt der Unique-Index; die Route
// braucht sich darauf nicht zu verlassen, prüft aber vorher für eine
// verständliche Fehlermeldung.

migrate((app) => {
  const objects = app.findCollectionByNameOrId('objects')

  const collection = new Collection({
    type: 'base',
    name: 'quest_confirmations',
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    // Kein create/update/delete über die API — nur die Route schreibt.
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      {
        type: 'relation',
        name: 'call',
        required: true,
        collectionId: objects.id,
        cascadeDelete: true,     // Auftrag weg → Stimmen weg
        maxSelect: 1,
      },
      {
        type: 'text',
        name: 'submission',
        required: true,
        max: 40,
      },
      {
        type: 'relation',
        name: 'voter',
        required: true,
        collectionId: '_pb_users_auth_',
        cascadeDelete: true,
        maxSelect: 1,
      },
      {
        type: 'text',
        name: 'verdict',
        required: true,
        max: 8,
        pattern: '^(ok|nein)$',
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
      'CREATE UNIQUE INDEX `idx_qconf_call_sub_voter` ON `quest_confirmations` (`call`, `submission`, `voter`)',
      'CREATE INDEX `idx_qconf_call_sub` ON `quest_confirmations` (`call`, `submission`)',
    ],
  })
  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId('quest_confirmations')
  return app.delete(collection)
})
