/// <reference path="../pb_data/types.d.ts" />
// Leere `created` in `agent_manifests` nachtragen.
//
// WAS PASSIERT WAR: Das Feld kam erst mit einer späteren Migration in die
// Collection. PocketBase füllt Autodate-Felder für BESTEHENDE Zeilen nicht nach
// — sie behalten einen leeren String. Auf einer gewachsenen Instanz betrifft
// das fast alle Manifeste.
//
// WARUM DAS ZÄHLT: Der Client entscheidet über `created`, WER einen
// Agentennamen führt (`beanspruchtFrueher` in client/core/AgentFilters.js).
// Der Ältere gewinnt — das ist der Schutz gegen Namensübernahme. Waren beide
// Daten leer, griff die Notfallregel darunter und verglich DATENSATZ-IDs, also
// Zufallsstrings.
//
// Gemessen am 18.09.2026 auf der Produktivinstanz: Ein seit drei Wochen totes
// Agenten-Konto hielt dadurch fünf von acht Namen. Der Filterdialog bot dessen
// veraltete Schichten an; die Objekte der laufenden Agenten passten auf keines
// dieser Prädikate und blieben deshalb sichtbar, was immer der Spieler
// anklickte. Die Filter „griffen nicht" — und niemand konnte sehen, warum.
//
// WARUM `updated` ALS ERSATZ: Es ist die beste verfügbare Schranke. Für eine
// alte Zeile ist es alt, für eine neue neu — die REIHENFOLGE stimmt damit
// wieder, und nur auf die kommt es an. Ein exaktes Anlegedatum ist für Zeilen,
// die es nie gespeichert haben, nicht rekonstruierbar; so zu tun, als wüsste
// man es, wäre schlechter als eine ehrliche Näherung.
//
// EINMALIG UND IDEMPOTENT: Neue Zeilen bekommen ihr `created` von PocketBase.
// Diese Migration fasst nur an, was leer ist.

migrate((app) => {
  // NICHTS ZURÜCKGEBEN. Der JSVM deutet einen Rückgabewert als Fehler
  // („could not convert [object Object] to error“) und rollt die Migration
  // zurück — die Zeile lief, das Ergebnis war trotzdem weg.
  app.db().newQuery(`
    UPDATE agent_manifests
       SET created = updated
     WHERE (created IS NULL OR created = '')
       AND updated IS NOT NULL AND updated != ''
  `).execute()

  // Zeilen, die AUCH kein `updated` haben, bleiben leer — sie gelten damit als
  // „unbekannt, also ältest möglich". Das ist die sichere Seite: Ein Name wird
  // dadurch nicht übernehmbar, sondern höchstens zu treu gehalten.
  console.log('[migrate] agent_manifests: leere created aus updated nachgetragen')
}, (app) => {
  // Kein Down: Welche Zeilen vorher leer waren, ist danach nicht mehr bekannt.
  // Ein Zurücksetzen auf '' träfe auch die, die ihr Datum rechtmäßig haben.
})
