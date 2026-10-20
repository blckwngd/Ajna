/// <reference path="../pb_data/types.d.ts" />
//
// Lebensdauer für Objekte — die beiden Schalter dazu anlegen.
//
// WARUM ÜBERHAUPT ANLEGEN, wenn der Cron ohne sie nichts tut? Weil niemand
// einschalten kann, was er nicht sieht. Ein fehlender Datensatz ist in der
// Verwaltung nicht von einer Funktion zu unterscheiden, die es gar nicht gibt;
// ein vorhandener mit `note` erklärt sich selbst.
//
// VORGABE IST AUS. `objects.expiry = false` heisst: eine Instanz, die diese
// Migration einspielt, löscht deswegen nichts. Das Einschalten ist eine
// Betriebsentscheidung, und sie soll bewusst getroffen werden — es ist die
// einzige Einstellung in Ajna, die Daten vernichtet.
//
// NICHT ÖFFENTLICH (`public` bleibt aus): Kein Client muss vor dem Login
// wissen, ob Objekte verfallen. Siehe 1788200000_settings_public.js.
//
// Idempotent: vorhandene Datensätze werden nicht überschrieben — wer den
// Schalter schon umgelegt hat, behält seine Entscheidung.

migrate((app) => {
  const anlegen = (key, value, note) => {
    try {
      app.findFirstRecordByFilter("settings", "key = {:k}", { k: key })
      return false   // schon da — Wert und Markierung bleiben, wie sie sind
    } catch (err) { /* nicht vorhanden → anlegen */ }
    const col = app.findCollectionByNameOrId("settings")
    const rec = new Record(col)
    rec.set("key", key)
    rec.set("value", value)
    rec.set("note", note)
    rec.set("public", false)
    app.save(rec)
    return true
  }

  anlegen("objects.expiry", false,
    "Verfallen Objekte mit state.expires_at? AUS = der Cron object_expiry löscht nichts. "
    + "Ein Objekt verfällt nur, wenn es selbst ein expires_at trägt (ISO-8601 UTC, "
    + "z. B. 2026-05-30T22:00:00Z) — ohne dieses Feld ist nichts betroffen.")

  anlegen("objects.expiry_max", 200,
    "Höchstens so viele verfallene Objekte je Lauf (stündlich). Schutz gegen eine falsch "
    + "gestellte Uhr oder ein versehentlich gesetztes expires_at: so fällt es auf, bevor "
    + "ein ganzer Bestand weg ist. Erlaubt 1–1000.")
}, (app) => {
  // Zurück nimmt nur, was diese Migration angelegt hat. Ein Betreiber, der den
  // Schalter inzwischen bewusst eingeschaltet hat, verliert dabei seine
  // Entscheidung — deshalb steht es hier und nicht als stilles `return`.
  for (const key of ["objects.expiry", "objects.expiry_max"]) {
    try { app.delete(app.findFirstRecordByFilter("settings", "key = {:k}", { k: key })) }
    catch (err) { /* nicht da */ }
  }
})
