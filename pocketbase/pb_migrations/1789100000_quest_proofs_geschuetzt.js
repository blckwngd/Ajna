/// <reference path="../pb_data/types.d.ts" />
// Beweisbilder von Aufträgen gegen den direkten Abruf schützen.
//
// WAS OFFEN WAR: `quest_proofs` hat eine enge Leseregel —
//   listRule/viewRule: 'user = @request.auth.id || call.owner = @request.auth.id'
// — aber die schützt den DATENSATZ, nicht die DATEI. PocketBase liefert
// Dateien unter `/api/files/<collection>/<recordId>/<dateiname>` ohne jede
// Prüfung aus, solange das Feld nicht als `protected` markiert ist. Wer eine
// solche Adresse hatte (Weitergabe, Verlauf, Protokoll eines Proxys), bekam das
// Bild ohne Anmeldung.
//
// Das ist bei Beweisfotos nicht beliebig: sie entstehen an einem echten Ort, zu
// einer bekannten Zeit, und zeigen oft die Person, die den Auftrag erledigt hat.
// Die Adresse zu kennen ist kein Recht, sie zu sehen.
//
// WAS `protected` ÄNDERT: Die Datei braucht einen kurzlebigen Datei-Token
// (`POST /api/files/token`, im SDK `pb.files.getToken()`), und der Abruf wird
// zusätzlich gegen die `viewRule` des Datensatzes geprüft. Der Token allein
// öffnet also nichts — er weist nur aus, WER fragt. Genau die Trennung, die
// hier fehlte.
//
// FOLGE FÜR DEN CLIENT: Adressen ohne `?token=` liefern ab jetzt 403. Der
// Client holt den Token in `AjnaClient.fileToken()` und hängt ihn an; ältere
// Fassungen zeigen an dieser Stelle ein kaputtes Bild statt eines falschen.
// Das ist die richtige Richtung für einen Fehler dieser Art.

migrate((app) => {
  const collection = app.findCollectionByNameOrId('quest_proofs')
  const feld = collection.fields.getByName('images')
  if (!feld) throw new Error('quest_proofs.images nicht gefunden')
  feld.protected = true
  return app.save(collection)
}, (app) => {
  // Zurück ist möglich, aber es ist eine Verschlechterung — deshalb steht es
  // hier ausdrücklich und nicht als stilles `return`.
  const collection = app.findCollectionByNameOrId('quest_proofs')
  const feld = collection.fields.getByName('images')
  if (feld) feld.protected = false
  return app.save(collection)
})
