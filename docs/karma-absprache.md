# Karma-Inflation durch Absprache — Befund und Optionen

**Aufgeschrieben am 22.10.2026** (Arbeitspaket 4). Bis dahin lebte der Punkt
nur in Gesprächen. Hier steht, was die Instanz heute tut, was zwei Konten
damit anfangen können, und welche Gegenmittel es gäbe — mit Preis. Entschieden
ist nichts davon; das ist der nächste Schritt.

## Was heute gilt (aus dem Code, nicht aus der Erinnerung)

Karma ist eine Zahl je Konto, `users.karma_points`, nur vom Server geschrieben,
an genau einer Stelle: `pb_hooks/karma.js`, `karmaFuerAbschluss()` und
`karmaFuerPruefer()`. Drei Routen rufen sie (`complete`, `approve`, `confirm`).

| Vorgang | Punkte | Datei |
|---|---|---|
| Auftrag erledigt, der Server hat geprüft (`verify: items`) | 2 | `PUNKTE_ABSCHLUSS` |
| Auftrag erledigt, ein Mensch hat abgenommen (`issuer`, `agent`, `group`, `crowd`) | 2 + 3 | `PUNKTE_ABNAHME_BONUS` |
| Für andere abgenommen (nicht der eigene Auftrag, nicht der Bearbeiter) | 1 | `PUNKTE_PRUEFER` |
| 20 Punkte = eine Stufe, höchstens Stufe 5 | | `KARMA_PRO_STUFE`, `KARMA_MAX_STUFE` |

**Geschlossen ist:** der eigene Auftrag (`call.owner === userId` → nichts),
der Probelauf (`dryRun` → nichts, bei niemandem), die Prüfer-Gutschrift für
den Aussteller selbst (`quest/approve` schließt ihn aus).

**Es gibt kein Kassenbuch.** `karmaAendern()` schreibt den neuen Stand und
eine Logzeile. Wer wann wofür von wem Punkte bekam, steht nirgends in der
Datenbank. Jedes Gegenmittel unten, das über „heute" hinaus zählt, braucht
zuerst ein solches Buch.

## Die Absprache

Zwei Konten A und B, beide echt angemeldet (Gastkonten können Aufträge nicht
ausstellen? — doch, nichts in `quest/publish` verlangt Karma oder Bestätigung):

1. A stellt einen Auftrag aus, `verify: issuer`, ohne Gegenstände.
2. B nimmt an, meldet erledigt. A nimmt ab. **B +5.** A bekommt als Aussteller
   nichts — das ist schon so.
3. Dann umgekehrt: B stellt aus, A erledigt, B nimmt ab. **A +5.**
4. Wiederholen. Ein `repeatable`-Auftrag spart sogar das Neu-Ausstellen.

Zwanzig Durchgänge, und beide stehen auf Stufe 5. Keine Nachweise nötig
(`proof: []` ist erlaubt), kein Ort nötig (ohne `onSite`), kein Warten (keine
Mindestfrist zwischen Annahme und Erledigung).

Mit drei Konten geht es über `crowd` (Vorgabe 3 Stimmen, `crowdCount`
einstellbar bis 1) — dann sammeln alle drei zusätzlich je 1 Prüferpunkt pro
Abnahme. Mit einer eigenen Prüfgruppe (`verify: group`) ebenso.

**Was es kostet:** Konten. Die Registrierung ist auf 100 je Stunde gedrosselt
(`1788000000_rate_limits.js`), ein Gastkonto braucht keine Bestätigung. Zwei
Konten hat jeder.

**Was es bringt:** `karmaReicht()` sperrt Aufträge nach Stufe, und andere
Spieler lesen die Stufe als Sterne an der Anwesenheit (`state.karma`). Also:
Zugang zu allem, was nach Karma gesperrt ist, und ein falsches Vertrauen bei
Mitspielern. Kein Geld, keine Gegenstände — die kommen aus der Treuhand des
Ausstellers und sind ein Nullsummenspiel.

## Gegenmittel, mit Preis

Keines verhindert die Absprache. Jedes macht sie teurer als den Nutzen.

| | Was | Wirkung auf die Absprache | Preis |
|---|---|---|---|
| **a** | **Gegenseitigkeit dämpfen.** Wer von A Karma bekam, bekommt für A-Aufträge 30 Tage lang nichts mehr, wenn A in dieser Zeit von ihm Karma bekam | Das Ping-Pong zu zweit ist vorbei; drei Konten im Kreis brauchen schon eine Runde mehr | Kassenbuch nötig: `karma_ledger` (von, an, Auftrag, Punkte, Zeit). Eine Abfrage je Abschluss |
| **b** | **Abnehmender Ertrag je Paar.** Erster Auftrag von A: voll, zweiter: halb, ab dem dritten: nichts — je Monat | Ein Paar bringt sich höchstens 8 Punkte je Monat, nicht 100 | Kassenbuch nötig. Ehrliche Vereine, die vielen Aufträgen desselben Ausstellers nachgehen, treffen die Grenze auch — sie müsste je Aussteller-Gruppe gelten |
| **c** | **Tagesdeckel.** Höchstens 10 Punkte je Konto und Tag | Stufe 5 dauert zehn Tage statt eine Stunde | Kassenbuch nötig (oder Zähler + Datum am Konto, billiger). Trifft auch den Fleißigen |
| **d** | **Bonus nur für Fremde.** Die 3 Punkte Abnahme-Bonus gibt es nur bei `group`/`crowd`, nicht bei `issuer` | Zu zweit bleibt es bei 2 statt 5 je Durchgang | Kein Kassenbuch. Aber der Bonus war genau als Anreiz gedacht, die Abnahme zu *suchen*; `issuer` ist der häufigste Weg |
| **e** | **Aussteller braucht Stufe 1.** Aufträge, die Karma bringen, kann nur ausstellen, wer selbst 20 Punkte hat | Frische Zweitkonten sind wertlos; das erste Konto muss ehrlich anfangen | Kein Kassenbuch. Henne-Ei für die ersten Spieler einer Instanz — der Betreiber muss Startaufträge ausstellen |
| **f** | **Mindestdauer.** Zwischen Annahme und Erledigung müssen 10 Minuten liegen | Zwanzig Durchgänge dauern Stunden statt Minuten | Billig. Allein zu schwach, in Verbindung mit c wirksam |
| **g** | **Nachweis-Pflicht für Karma.** Bonus nur, wenn ein Nachweis dabei ist (Foto, `onSite`) | Jede Runde kostet echte Arbeit vor Ort | Verschiebt die Fälschung aufs Foto; der Prüfer ist derselbe Komplize |

## Empfehlung

**a + c + e**, in dieser Reihenfolge, und zuerst das Kassenbuch:

* Das **Kassenbuch** ist ohnehin fällig: Heute lässt sich eine Beschwerde
  („der hat sich hochgezählt") nicht einmal prüfen, weil nichts dasteht.
  Sammlung `karma_ledger`, nur der Server schreibt, der Betreiber liest, das
  Konto sieht seine eigenen Zeilen. Eine Migration, zwölf Zeilen in
  `karmaAendern()`.
* **a** trifft genau das Muster und sonst niemanden: Ein ehrlicher Spieler
  erledigt selten innerhalb eines Monats Aufträge dessen, der gerade seine
  erledigt hat.
* **c** deckelt, was a nicht fängt (drei Konten im Kreis), ohne Kassenbuch-
  Abfrage: Zähler und Datum am Konto.
* **e** nimmt den Wegwerfkonten den Wert. Die Henne-Ei-Frage löst der
  Betreiber mit Startaufträgen — oder Stufe 1 gilt erst ab dem elften Auftrag
  der Instanz.

**Nicht empfohlen:** d (nimmt dem ehrlichsten Weg den Anreiz) und g (verlagert
nur).

Was es nicht gibt und nicht geben soll: eine Erkennung von Absprachen im
Nachhinein mit Strafen. Punkte kostet, was nachgewiesen ist, und das
entscheidet die Administration — das steht so in `karma.js`, und es bleibt
richtig.

## Prüfungen, die dazu gehören

`tests/quests/self.mjs` deckt den eigenen Auftrag, `probelauf.mjs` den
Probelauf. Die Absprache zu zweit hat **keine** Prüfung — sie würde heute grün
durchgehen (zwei Konten, zwei Aufträge, viermal 5 Punkte). Beim Umsetzen ist
das der erste Test: rot vorher, grün nachher.
