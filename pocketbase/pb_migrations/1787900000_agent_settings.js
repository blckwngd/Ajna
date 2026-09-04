/// <reference path="../pb_data/types.d.ts" />
//
// Collection `agent_settings` — die Einstellungen EINES Agenten.
//
// WARUM NICHT `settings`
//
// `settings` gehört der Instanz: Aufbewahrungsfristen, Aufräum-Schonzeiten,
// alles, wofür der Betreiber des Servers zuständig ist. Jedes angemeldete Konto
// darf dort lesen, nur die Verwaltung schreiben.
//
// Ein Agent ist aber kein Teil der Instanz. Er ist ein eigenes Programm mit
// eigenem Konto, das sich an einem Server ANMELDET — derselbe Agent kann an
// mehreren Servern hängen, und an einem Server können mehrere Agents desselben
// Typs arbeiten. Seine Regler (Soll-Bestand, Geschwindigkeiten, Areal) sind
// deshalb nicht die Sache des Server-Betreibers, sondern seine eigene.
//
// Sie in die globale Liste zu legen hätte zwei Dinge kaputtgemacht:
//
//   • Zwei World-Directors am selben Server hätten sich denselben Datensatz
//     `wd.count.enemy` geteilt und sich gegenseitig überschrieben.
//   • Jedes angemeldete Konto — also jeder Spieler — hätte mitlesen können,
//     wie die Welt eingestellt ist.
//
// EIGENTUM ALS TRENNLINIE: `owner` ist das Konto des Agenten, und alle fünf
// Regeln lauten `owner = @request.auth.id`. Ein Agent sieht und schreibt
// ausschließlich seine eigenen Einstellungen — andere Agents existieren für ihn
// nicht. Das ist strenger als bei `settings` und braucht keinen Hook: Es ist
// dieselbe Regel, die schon die Manifest-Delegation absichert.
//
// SCHREIBEN DARF DER AGENT SELBST. Er legt beim Start seine Regler als LEERE
// Datensätze an, damit in der Verwaltungsoberfläche eine ausgefüllte Liste mit
// Erklärungen steht statt einer leeren Seite. Leer heißt: es gilt die `.env`.
// Wer etwas einträgt, übersteuert sie — ab dann sofort und ohne Neustart.
//
// Die Verwaltung sieht trotzdem alles: Superuser umgehen Regeln grundsätzlich.
// Die Trennung schützt Agents voreinander und vor den Spielern, nicht vor dem
// Betreiber.
//
// NICHTS GEHEIMES. Auch hier nicht. Zwar liest nur ein Konto mit, aber
// Datensätze landen in jeder Sicherung, und ein Regel-Tippfehler wäre sofort
// ein Leck. `Konfig` weigert sich darum, Env-Namen mit `pass`, `secret`,
// `token` oder `key` über die Datenbank steuerbar zu machen.

migrate((app) => {
  const collection = new Collection({
    type: 'base',
    name: 'agent_settings',
    // Alle fünf gleich: Es gibt genau einen Zuständigen, und das ist der Besitzer.
    listRule:   'owner = @request.auth.id',
    viewRule:   'owner = @request.auth.id',
    createRule: 'owner = @request.auth.id',
    updateRule: 'owner = @request.auth.id',
    deleteRule: 'owner = @request.auth.id',
    fields: [
      {
        type: 'relation',
        name: 'owner',
        required: true,
        collectionId: '_pb_users_auth_',
        cascadeDelete: true,   // Konto weg → seine Einstellungen weg
        maxSelect: 1,
      },
      {
        type: 'text',
        name: 'key',
        required: true,
        max: 120,
        // Wie in `settings`: <bereich>.<sache>, keine Leerzeichen — der
        // Schlüssel taucht in Env-Namen und Logzeilen auf.
        pattern: '^[a-z0-9][a-z0-9._-]*$',
      },
      {
        type: 'json',
        name: 'value',
        required: false,
        maxSize: 20000,
      },
      {
        type: 'text',
        name: 'note',
        required: false,
        max: 500,
      },
      { type: 'autodate', name: 'created', onCreate: true,  onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true,  onUpdate: true  },
    ],
    indexes: [
      // Der Schlüssel ist nur JE KONTO eindeutig — genau das ist der Unterschied
      // zu `settings`, wo er global eindeutig ist.
      'CREATE UNIQUE INDEX `idx_agent_settings_owner_key` ON `agent_settings` (`owner`,`key`)',
    ],
  })
  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId('agent_settings')
  return app.delete(collection)
})
