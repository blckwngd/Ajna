/// <reference path="../pb_data/types.d.ts" />
//
// Collection `settings` — Betreiber-Einstellungen zur Laufzeit.
//
// WARUM NICHT NUR .env:
// Agents laufen als eigene Prozesse. Eine geänderte Env-Variable heißt heute:
// Prozess neu starten. Mit einem Datensatz und einem Realtime-Abo wirkt eine
// Änderung sofort und in allen Agents gleichzeitig. Das Verwaltungs-Interface
// bringt PocketBase mit — es fällt als Nebenprodukt ab.
//
// DIE REGEL: `.env` liefert die VORGABE, die Datenbank ÜBERSTEUERT sie.
// Eine frische Installation läuft aus der .env allein (nichts muss angelegt
// werden); im Betrieb dreht man an der Datenbank. Umgekehrt wäre es schlechter:
// Dann müsste jede Neuinstallation erst Datensätze bekommen, bevor irgendetwas
// startet.
//
// WAS HIER NICHT HINEINGEHÖRT — bewusst, nicht aus Bequemlichkeit:
//
//   • GEHEIMNISSE. API-Schlüssel, Passwörter, Tokens. Datensätze unterliegen
//     Regeln, die man falsch setzen kann, und landen in jeder Sicherung.
//     Die bleiben in `.env`.
//   • WAS VOR POCKETBASE GEBRAUCHT WIRD. Die Adresse von PocketBase selbst,
//     TLS-Pfade, Anmeldedaten der Agents. Henne und Ei.
//   • GERÄTELOKALE ENTSCHEIDUNGEN. Standort-Freigabe und „wer sieht mich" sind
//     die Aussage eines Menschen darüber, was der Server NICHT erfahren soll.
//     Sie auf dem Server zu speichern hieße, den Schutz beim Geschützten
//     abzugeben. Die liegen im Browser und bleiben dort.
//
// LESEN DÜRFEN ALLE ANGEMELDETEN — Agents sind gewöhnliche Konten und müssen
// ihre Einstellungen holen können. Genau deshalb gehört nichts Geheimes hinein:
// Was hier steht, ist für jedes angemeldete Konto sichtbar. SCHREIBEN darf nur
// die Verwaltung (keine Regel = nur Superuser).
//
// FELDER
//   key    Punkt-getrennter Name, z. B. "wd.count.enemy" oder "proof.maxAgeDays".
//          Die Namenskonvention ist <bereich>.<sache> — sie hält die Liste in
//          der Verwaltungsoberfläche sortiert und lesbar.
//   value  JSON. Zahl, Zeichenkette, Wahrheitswert oder Struktur — der Leser
//          entscheidet, was er erwartet. Ein reines Textfeld hätte bedeutet,
//          dass jeder Aufrufer selbst parst und dabei anders scheitert.
//   note   Wozu die Einstellung dient. Für den Menschen in der Verwaltung, der
//          sie in einem halben Jahr wiederfindet.

migrate((app) => {
  const collection = new Collection({
    type: 'base',
    name: 'settings',
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      {
        type: 'text',
        name: 'key',
        required: true,
        max: 120,
        // Kleinbuchstaben, Ziffern, Punkt, Bindestrich, Unterstrich. Kein
        // Leerzeichen: Der Schlüssel taucht in Env-Namen und Logzeilen auf.
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
      {
        type: 'autodate',
        name: 'created',
        onCreate: true,
        onUpdate: false,
      },
      {
        type: 'autodate',
        name: 'updated',
        onCreate: true,
        onUpdate: true,
      },
    ],
    indexes: [
      'CREATE UNIQUE INDEX `idx_settings_key` ON `settings` (`key`)',
    ],
  })
  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId('settings')
  return app.delete(collection)
})
