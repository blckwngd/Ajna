/// <reference path="../pb_data/types.d.ts" />
// Wahrheitswerte reparieren, die beim Umbenennen zu Zahlen geworden sind.
//
// WAS PASSIERT WAR: Die erste Fassung von 1789000000 zog Schlüssel mit
// `json_set(state, neu, json_extract(state, alt))` um. `json_extract` gibt für
// JSON-`true` aber eine INTEGER 1 zurück — nach dem Umzug stand `"dryRun": 1`
// statt `"dryRun": true` im Datensatz.
//
// WARUM DAS ZÄHLT: Der Server prüft `c.dryRun === true`. Gegen die Zahl 1 ist
// das still falsch — ein Probelauf wäre nach dem Umzug ein ganz normaler
// Auftrag gewesen, hätte also Karma ausgezahlt. Dasselbe beim Inhaltsfilter:
// Das Prädikat `{ field: 'state.monument_revoked', equals: false }` vergleicht
// mit `false`, nicht mit `0`, und hätte kein einziges Denkmal mehr getroffen.
//
// Die Ursache ist in 1789000000 behoben (CASE über `json_type`). Diese
// Migration räumt hinter der Instanz auf, die die erste Fassung schon gesehen
// hat. Auf einer frischen Instanz findet sie nichts und tut nichts.
//
// NUR DIESE FÜNF: Alle fünf sind ausschliesslich Wahrheitswerte. Ein Feld, das
// auch eine echte Zahl tragen könnte, wäre hier nicht reparierbar — man wüsste
// nicht, ob die 1 „wahr" oder „eins" heissen soll.

migrate((app) => {
  const db = app.db()
  const PFADE = ['$.loot', '$.tool', '$.monument_revoked', '$.call.offered', '$.call.dryRun']

  for (const pfad of PFADE) {
    db.newQuery(`
      UPDATE objects
         SET state = json_set(state, '${pfad}', json('true'))
       WHERE json_valid(state)
         AND json_type(state, '${pfad}') = 'integer'
         AND json_extract(state, '${pfad}') = 1
    `).execute()
    db.newQuery(`
      UPDATE objects
         SET state = json_set(state, '${pfad}', json('false'))
       WHERE json_valid(state)
         AND json_type(state, '${pfad}') = 'integer'
         AND json_extract(state, '${pfad}') = 0
    `).execute()
  }

  console.log('[migrate] objects.state: Wahrheitswerte nach dem Umbenennen geradegezogen')
}, (app) => {
  // Kein Down — es gibt nichts, wohin zurück.
})
