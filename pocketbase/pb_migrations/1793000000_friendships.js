/// <reference path="../pb_data/types.d.ts" />
//
// Collection `friendships` — Freundesliste (Arbeitspaket 0c, 23.10.2026).
//
// Eine Zeile je Beziehung, GERICHTET angelegt (wer hat wen eingeladen), aber
// als Freundschaft gegenseitig gelesen: Freund ist, wer in einer Zeile mit
// `status = accepted` auf der anderen Seite steht. Der Hook in main.pb.js
// verhindert die Gegenrichtung als zweite Zeile — lädt B den A ein, während
// A→B offen ist, wird A→B angenommen und B bekommt das gesagt.
//
// Felder:
//   from, to      die beiden Konten; `from` hat eingeladen
//   status        invited | accepted | declined
//   from_name,    Anzeigenamen, vom SERVER gestempelt (Hook). Ein Konto darf
//   to_name       fremde Nutzer nicht lesen (users.viewRule = nur ich); die
//                 Namen stehen deshalb in der Zeile, wie bei agent_manifests
//                 (owner_handle) und invitations (inviter_email).
//
// Regeln: Lesen und Löschen dürfen beide Seiten (Entfernen = Löschen, egal
// wer), Anlegen nur als `from` und nur als Einladung, Ändern nur die
// eingeladene Seite — und der Hook lässt dabei nur `status` zu, nur von
// invited nach accepted/declined.
//
// Wozu: Freunde sind anschreibbar, auch wenn sie nicht in der Nähe sind.
// Der Transport kann das schon (`/api/chat/send` an ein Konto, das Postfach
// fängt Abwesende auf) — es fehlte der Weg, ein Konto als Gegenüber zu
// WÄHLEN. Mehr gibt eine Freundschaft nicht her: keine Position, kein
// Zugriff. Wer mehr will, benutzt Gruppen und Rechte.

migrate((app) => {
  const collection = new Collection({
    type: 'base',
    name: 'friendships',
    listRule:   'from = @request.auth.id || to = @request.auth.id',
    viewRule:   'from = @request.auth.id || to = @request.auth.id',
    createRule: '@request.auth.id != "" && from = @request.auth.id && status = "invited"',
    updateRule: 'to = @request.auth.id',
    deleteRule: 'from = @request.auth.id || to = @request.auth.id',
    fields: [
      { type: 'relation', name: 'from', required: true, collectionId: '_pb_users_auth_', cascadeDelete: true, maxSelect: 1 },
      { type: 'relation', name: 'to',   required: true, collectionId: '_pb_users_auth_', cascadeDelete: true, maxSelect: 1 },
      { type: 'select', name: 'status', required: true, maxSelect: 1, values: ['invited', 'accepted', 'declined'] },
      { type: 'text', name: 'from_name', required: false, max: 120 },
      { type: 'text', name: 'to_name', required: false, max: 120 },
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE UNIQUE INDEX `idx_friendships_pair` ON `friendships` (`from`, `to`)',
      'CREATE INDEX `idx_friendships_to` ON `friendships` (`to`, `status`)',
    ],
  })
  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId('friendships')
  return app.delete(collection)
})
