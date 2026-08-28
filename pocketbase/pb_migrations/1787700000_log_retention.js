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

const TAGE = 14
const WARN = 4      // 0=DEBUG, 4=WARN, 8=ERROR (slog-Stufen)

migrate((app) => {
  const s = app.settings()
  s.logs.maxDays = TAGE
  s.logs.minLevel = WARN
  app.save(s)

  // Den Altbestand nicht auf den nächsten Prune-Lauf warten lassen.
  const grenze = new Date(Date.now() - TAGE * 86400000).toISOString().replace('T', ' ').slice(0, 19) + 'Z'
  try {
    app.deleteOldLogs(new DateTime(grenze))
  } catch (err) {
    // Kein Grund, die Migration scheitern zu lassen — PocketBase räumt die
    // Altlast beim nächsten eigenen Lauf ohnehin ab.
    console.log('[migration] Logs ausmisten: ' + (err && err.message))
  }
}, (app) => {
  const s = app.settings()
  s.logs.maxDays = 0        // 0 = unbegrenzt (der vorherige Zustand)
  s.logs.minLevel = 0
  return app.save(s)
})
