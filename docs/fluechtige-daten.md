# Flüchtige Daten

Ein Grundbaustein, kein Sonderfall: Inhalte, die **angezeigt, aber nirgends
gespeichert** werden sollen.

## Wofür

Ein Agent ruft im Auftrag eines Spielers etwas ab — eine Adresse, einen
Registerauszug, eine Auskunft aus einer öffentlichen Quelle. Der Spieler soll es
sehen. Danach soll es fort sein: nicht im Gesprächsverlauf, nicht in
`localStorage`, nicht in einem Weltobjekt, nicht in der Datenbank.

Ohne so ein Kennzeichen bliebe Agent-Autoren nur die Wahl zwischen „gar nicht
anzeigen" und „dauerhaft ablegen". Beides ist falsch.

## Der Vertrag

**Auf der Leitung** (`POST /api/chat/send`, Broadcast auf `chat:<Konto-ID>`):

```json
{ "from": "...", "to": "...", "text": "...", "meta": null,
  "ephemeral": true, "ts": "..." }
```

`ephemeral` ist **immer gesetzt**, nie `undefined`. Ein Empfänger soll
`=== true` prüfen können, ohne zwischen „nicht flüchtig" und „spricht mit einem
älteren Server" raten zu müssen — im Zweifel würde er speichern, und genau das
darf nicht passieren. Nur ein echtes `true` zählt; alles andere gilt als nicht
flüchtig.

**In der Client-Bibliothek:**

```js
// senden (Agent oder Anwendung)
await ajna.sendChat(nutzerId, { text: 'Hauptstraße 127 — …', ephemeral: true })

// empfangen
await ajna.onChat((m) => {
  if (m.ephemeral) { /* anzeigen, nicht ablegen */ }
})
```

**Im Verlaufsspeicher:**

```js
messageLog.push(text, 'dialog', { ephemeral: true })   // sichtbar, nie auf Platte
messageLog.clearEphemeral()                             // nur die flüchtigen verwerfen
```

Flüchtige Einträge liegen in einem **zweiten Feld**, nicht mit einem Merker im
ersten. Sonst verdrängten sie beim Rollen (`MAX = 300`) den gespeicherten
Verlauf — eine Handvoll Abfragen könnte das Gesprächsprotokoll aufzehren, ohne
dass jemand es merkt.

## Was es NICHT ist

**Keine Durchsetzung.** Der Server kann keinen Client zwingen, etwas zu
vergessen. `ephemeral` ist eine Zusage zwischen Beteiligten, die sich daran
halten wollen — wie `Cache-Control: no-store`. Ein fremder Client kann es
ignorieren.

Der eigentliche Schutz liegt woanders und ist echt: Diese Bahn **schreibt
ohnehin nichts in die Datenbank** und geht an **genau ein Konto**. Das
Kennzeichen schließt die letzte Lücke — beim Empfänger.

## Die vier Ablagestellen

Wer flüchtige Daten baut, muss alle vier kennen:

| Stelle | Zustand |
|---|---|
| PocketBase-Datenbank | `chat/send` schreibt nichts — passt von sich aus |
| Client-Verlauf (`localStorage`) | schrieb **jede** Chat-Nachricht mit; hält sich jetzt an das Kennzeichen |
| Weltobjekt (`objects`) | dauerhaft und für andere sichtbar — flüchtige Inhalte gehören **nie** hinein |
| Protokoll des Agenten | liegt beim Agent-Autor, siehe unten |

Das Weltobjekt ist die Stelle, die man am leichtesten übersieht. Ein Objekt darf
die Funktion **auslösen** (und damit steuern, wer sie überhaupt erreicht), es
darf das Ergebnis aber nicht **tragen**.

## Für Agent-Autoren

**Protokolliere die Tatsache, nicht die Werte.** „14:03 — Abfrage für 56566
Hauptstraße 127 → 1 Treffer (Name, Nummer)" belegt den Vorgang vollständig und
legt niemanden ab. Sonst schafft ausgerechnet der Nachweis der Sparsamkeit die
Ablage, die vermieden werden sollte.

**Kein Cache auf Platte für Personenbezogenes.** Ein Zwischenspeicher
Adresse→Person *ist* eine Profildatenbank, gleich woher die Einzelteile stammen.
Ortsdaten dürfen in `server/geo.js` liegen; Personendaten nur im Arbeitsspeicher,
nur für die Dauer einer Sitzung.

**Sichtbar nur für den Auslöser.** `sendChat` geht an ein Konto. Wer stattdessen
über `interact:<objekt>` antwortet, verteilt an **alle** Abonnenten dieses
Objekts — für Auskünfte im Auftrag einer Person ist das falsch.

## Geprüft durch

* `tests/run-ui.mjs` → „Flüchtige Daten" — der Client-Teil: Anzeige ja,
  `localStorage` nein, kein Aufzehren des Verlaufs, und die ganze Kette
  (Server → AjnaClient → AjnaManager → Gesprächsfenster).
* `tests/privacy/fluechtig.mjs` — der Server-Teil: Kennzeichen kommt
  unverfälscht an, immer als echtes `true`/`false`, unsaubere Werte gelten als
  nicht flüchtig.

## Verwandt

* `docs/adress-anreicherung-quellen.md` — der erste Anwendungsfall, und die
  Überlegungen zu Herkunftsangabe je Feld und Betreiberverantwortung.
