/// <reference path="../pb_data/types.d.ts" />
//
// Aufbewahrungsfrist für PocketBase-Logs — und einmal ausmisten.
//
// GEMESSEN am 2026-08-26, vor dieser Migration:
//
//   pb_data gesamt      900 MB
//     auxiliary.db      898 MB   ← 949.489 Zeilen Log
//     data.db           1,1 MB   ← die tatsächlichen Daten
//     storage             0 MB
//
// Die echten Daten waren ein Tausendstel des Verzeichnisses. Aufgefallen ist es
// erst bei der Frage, was Beweisfotos kosten würden — die Antwort war, dass
// nicht die Fotos das Problem sind, sondern das Fehlen einer Frist überhaupt.
//
// Nebenwirkung, die man kennen sollte: Jede Sicherung packte diese 900 MB mit
// ein. Ein Backup war fast vollständig Logbuch.
//
// 14 TAGE ist die Wahl. Kürzer wäre bei einem Fehler, der am Wochenende
// auftritt, zu knapp; länger bringt nichts, weil niemand vier Wochen alte
// Zugriffslogs liest. Über die Verwaltungsoberfläche jederzeit änderbar —
// PocketBase prunt danach selbst.
//
// `minLevel: 4` (WARN) statt jeder einzelnen Anfrage: Der Grund für die
// Dateigröße war nicht ein Ausbruch, sondern der Normalbetrieb. Der Director
// schreibt im Sekundentakt, jede Realtime-Nachricht erzeugte eine Zeile. Wer
// für eine Fehlersuche mehr braucht, stellt es kurz zurück auf 0.

// DIESE MIGRATION DARF NIEMALS WERFEN.
//
// Eine Migration, die scheitert, verhindert den START von PocketBase — und
// damit die ganze Instanz. Für das Anlegen einer Collection ist das richtig
// so: Ohne sie läuft die Anwendung nicht sinnvoll weiter. Für eine
// Log-Einstellung ist es grotesk: Eine Feinjustierung am Logbuch darf den
// Server nicht aussperren.
//
// Sie ist außerdem die einzige hier, die `app.settings()` anfasst. Das ist die
// versionsanfälligste Stelle — der PocketBase-Binary ist gitignored, jeder
// Server bringt seinen eigenen mit, und die Struktur von `logs` ist nicht in
// Stein gemeißelt. Deshalb: alles einzeln, alles in try/catch, und wenn nichts
// davon geht, bleibt es eben bei den Vorgaben.

const TAGE = 14
const WARN = 4      // 0=DEBUG, 4=WARN, 8=ERROR (slog-Stufen)

migrate((app) => {
  try {
    const s = app.settings()
    if (s && s.logs) {
      s.logs.maxDays = TAGE
      s.logs.minLevel = WARN
      app.save(s)
      console.log(`[migration] Log-Aufbewahrung: ${TAGE} Tage, ab WARN`)
    } else {
      console.log('[migration] Log-Aufbewahrung: settings.logs nicht vorhanden — übersprungen')
    }
  } catch (err) {
    console.log('[migration] Log-Aufbewahrung nicht gesetzt: ' + (err && err.message))
  }

  // Den Altbestand nicht auf den nächsten Prune-Lauf warten lassen. Auch das
  // ist Kür: PocketBase räumt ihn beim nächsten eigenen Lauf ohnehin ab.
  try {
    const grenze = new Date(Date.now() - TAGE * 86400000).toISOString().replace('T', ' ').slice(0, 19) + 'Z'
    app.deleteOldLogs(new DateTime(grenze))
  } catch (err) {
    console.log('[migration] Logs ausmisten: ' + (err && err.message))
  }
}, (app) => {
  try {
    const s = app.settings()
    if (!s || !s.logs) return
    s.logs.maxDays = 0        // 0 = unbegrenzt (der vorherige Zustand)
    s.logs.minLevel = 0
    app.save(s)
  } catch (err) {
    console.log('[migration] Rücknahme der Log-Aufbewahrung: ' + (err && err.message))
  }
})
