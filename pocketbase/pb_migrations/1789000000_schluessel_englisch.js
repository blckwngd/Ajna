/// <reference path="../pb_data/types.d.ts" />
// Deutsche Schlüssel in `objects.state` auf Englisch umstellen.
//
// Siehe docs/key-rename.md — dort steht die vollständige Zuordnung und warum
// gerade diese Gruppe zuerst dran ist: Ein Bezeichner im Code lässt sich
// jederzeit umbenennen, ein Schlüssel im Bestand nicht.
//
// WARUM SQL UND NICHT JS: Der JSVM liefert JSON-Felder je nach Version als
// String ODER als Byte-Array (siehe utf8.js) — jede Runde durch JavaScript ist
// eine Gelegenheit, Umlaute kaputtzumachen. SQLites `json_set`/`json_remove`
// fassen den Text nicht an, sie ersetzen nur Schlüssel. Und es ist eine
// Anweisung je Schlüssel statt einer Schleife über alle Objekte.
//
// IDEMPOTENT: Jede Anweisung greift nur, wo der ALTE Schlüssel noch steht.
// Zweimal laufen lassen ändert nichts.
//
// MANIFESTE FASST DIESE MIGRATION NICHT AN. Die Layer-Schlüssel
// (`natur` → `nature` …) stehen in `agent_manifests`, und die schreiben die
// Agents bei jedem Start neu. Nach dem Ausrollen also einmal `pm2 restart all`
// — sonst bietet der Filterdialog die alten Schichten weiter an. Was ein
// Spieler bereits gewählt hat, schlüsselt der Client selbst um
// (LAYER_ALT_NEU in client/core/AgentFilters.js).

migrate((app) => {
  const db = app.db()

  // Ein Schlüssel umziehen — oberste Ebene oder verschachtelt, egal.
  //
  // DIE FALLE: `json_extract` gibt für JSON-`true` eine INTEGER 1 zurück, nicht
  // den Wahrheitswert. Ohne die CASE-Behandlung stünde nach dem Umzug `1` im
  // Datensatz — und jeder Vergleich `=== true` im Code wäre still falsch.
  // `json_type` unterscheidet die beiden, `json('true')` setzt sie richtig.
  const umziehen = (pfadAlt, pfadNeu) => {
    db.newQuery(`
      UPDATE objects
         SET state = json_remove(json_set(state, '${pfadNeu}',
                       CASE json_type(state, '${pfadAlt}')
                         WHEN 'true'  THEN json('true')
                         WHEN 'false' THEN json('false')
                         ELSE json_extract(state, '${pfadAlt}')
                       END), '${pfadAlt}')
       WHERE json_valid(state)
         AND json_type(state, '${pfadAlt}') IS NOT NULL
         AND json_type(state, '${pfadNeu}') IS NULL
    `).execute()
    // Steht der neue Schlüssel schon da, gewinnt er — der alte fliegt nur weg.
    db.newQuery(`
      UPDATE objects
         SET state = json_remove(state, '${pfadAlt}')
       WHERE json_valid(state) AND json_type(state, '${pfadAlt}') IS NOT NULL
    `).execute()
  }

  // Einen Wert ersetzen (nicht den Schlüssel).
  const wertErsetzen = (pfad, alt, neu) => {
    db.newQuery(`
      UPDATE objects
         SET state = json_set(state, '${pfad}', '${neu}')
       WHERE json_valid(state) AND json_extract(state, '${pfad}') = '${alt}'
    `).execute()
  }

  // --- Gruppe A: state.* ---------------------------------------------------
  const STATE = {
    figur_id: 'figure_id',
    figur_auftrag: 'figure_quest',
    figur_belohnung: 'figure_reward',
    beute: 'loot',
    werkzeug: 'tool',
    hinweis: 'hint',
    bewegung: 'movement',
    osm_gruppe: 'osm_group',
    dm_art: 'monument_kind',
    dm_erloschen: 'monument_revoked',
    dm_key: 'monument_key',
    dm_liste: 'monument_list',
    dm_nummer: 'monument_ref',
    dm_ort: 'monument_place',
  }
  for (const alt in STATE) umziehen('$.' + alt, '$.' + STATE[alt])
  umziehen('$.hp.ist', '$.hp.current')

  // `quelle` war eine DUBLETTE zu `source` und wird nicht übersetzt, sondern
  // gestrichen. Nur falls irgendwo `source` fehlt, rückt `quelle` nach — ein
  // Objekt ohne Quelle fiele sonst aus jedem Inhaltsfilter.
  db.newQuery(`
    UPDATE objects
       SET state = json_set(state, '$.source', json_extract(state, '$.quelle'))
     WHERE json_valid(state)
       AND json_type(state, '$.quelle') IS NOT NULL
       AND json_type(state, '$.source') IS NULL
  `).execute()
  db.newQuery(`
    UPDATE objects
       SET state = json_remove(state, '$.quelle')
     WHERE json_valid(state) AND json_type(state, '$.quelle') IS NOT NULL
  `).execute()

  // --- Gruppe B: state.call.* ----------------------------------------------
  const CALL = {
    kurz: 'summary',
    ort: 'place',
    nachweis: 'proof',
    steigt: 'rewardStep',
    vorOrtRadiusM: 'onSiteRadiusM',
    annahmeRadiusM: 'acceptRadiusM',
    anbietenNachH: 'listAfterHours',
    angeboten: 'offered',
    probelauf: 'dryRun',
    pruefgruppe: 'reviewGroup',
    schwarmZahl: 'crowdCount',
  }
  for (const alt in CALL) umziehen('$.call.' + alt, '$.call.' + CALL[alt])

  // --- Gruppe D: Werte statt Schlüssel -------------------------------------
  wertErsetzen('$.monument_kind', 'natur', 'nature')
  wertErsetzen('$.monument_kind', 'kultur', 'cultural')
  // „stolperstein" bleibt — Eigenname, auch im Englischen.
  wertErsetzen('$.movement', 'steht', 'still')
  wertErsetzen('$.movement', 'frei', 'free')
  wertErsetzen('$.osm_group', 'natur', 'nature')

  // Nachweisarten stehen in einem ARRAY. `json_each` zerlegt es, die
  // CASE-Abbildung setzt es neu zusammen — nur dort, wo wirklich ein Array
  // steht (ein kaputter Wert soll nicht zu `null` werden).
  db.newQuery(`
    UPDATE objects
       SET state = json_set(state, '$.call.proof', (
             SELECT json_group_array(
               CASE value
                 WHEN 'foto'       THEN 'photo'
                 WHEN 'vorOrt'     THEN 'onSite'
                 WHEN 'gegenstand' THEN 'item'
                 ELSE value
               END)
               FROM json_each(json_extract(objects.state, '$.call.proof'))
           ))
     WHERE json_valid(state)
       AND json_type(state, '$.call.proof') = 'array'
       AND EXISTS (
             SELECT 1 FROM json_each(json_extract(objects.state, '$.call.proof'))
              WHERE value IN ('foto', 'vorOrt', 'gegenstand')
           )
  `).execute()

  console.log('[migrate] objects.state: deutsche Schlüssel auf Englisch umgestellt')

  // NICHTS ZURÜCKGEBEN. Der JSVM deutet einen Rückgabewert als Fehler
  // („could not convert [object Object] to error") und rollt die Migration
  // zurück — sie lief, das Ergebnis war trotzdem weg.
}, (app) => {
  // Kein Down. Zurückzubenennen hiesse, auch die Objekte zu treffen, die seit
  // der Umstellung mit den neuen Namen ANGELEGT wurden — und die waren nie
  // deutsch. Ein Rückweg, der mehr kaputtmacht als der Hinweg, ist keiner.
})
