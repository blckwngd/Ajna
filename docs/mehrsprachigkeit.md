# Mehrsprachigkeit

Drei Arten von Text, drei verschiedene Antworten. Sie zu vermischen ist der
Fehler, den man hinterher nicht mehr auseinanderbekommt.

| | was | wie |
|---|---|---|
| **Oberfläche** | Knöpfe, Hinweise, Dialoge | `core/i18n.js` — Katalog im Client |
| **Inhalte** | Objektbeschreibungen, POI-Namen, NPC-Dialoge | `core/Sprachwahl.js` — Sprachkarte am Datensatz |
| **Von Menschen** | Auftragstexte, Objektnamen, Nachrichten | **nie übersetzen** |
| **Der Code selbst** | Bezeichner, Schlüssel in Nutzdaten, Kommentare | **englisch** — siehe unten |

## Oberfläche: der deutsche Satz ist der Schlüssel

```js
t('Erledigt melden')     // → "Report as done" / "Erledigt melden"
'Erledigt melden'        // → funktioniert weiter, eben nur auf Deutsch
```

**Kein `t('quest.submit.label')`.** Schlüsselnamen sind eine zweite Sprache, die
man ebenfalls pflegen muss, und im Code sieht man dann nicht mehr, was dasteht.
Mit dem Klartext als Schlüssel ist eine nicht übersetzte Stelle kein Fehler,
sondern einfach Deutsch — das System bleibt jederzeit lauffähig, auch halb
übersetzt. **`t()` ist deshalb nirgends Pflicht.**

Der Preis, den man kennen muss: Wird der deutsche Satz geändert, verliert er
seine Übersetzung und fällt auf Deutsch zurück. Das ist billiger als der
umgekehrte Fehler — ein Schlüssel, dessen Übersetzung stillschweigend etwas
anderes sagt als das Original.

Einsetzungen mit benannten Platzhaltern; unbekannte bleiben sichtbar stehen:

```js
t('{n} Punkte bis Karma {stufe}.', { n: 4, stufe: 3 })
```

**Plural bleibt bewusst außen vor.** Eine echte Pluralregel (Polnisch hat drei
Formen) gehört in eine Bibliothek, nicht in 40 Zeilen. Bis dahin: Sätze so
bauen, dass die Zahl davorsteht („3 Objekte"), nicht mitgebeugt wird.

Sprachdateien liegen unter `client/lang/<code>.js`. Deutsch braucht keine — es
*ist* der Katalog.

### Was noch fehlt, findet man selbst

```js
window.ajnaFehlendeTexte()   // alles, was untersetzt angezeigt wurde
window.ajnaSprache('en')     // umstellen, ohne die Einstellungen zu öffnen
```

Ein Extraktor, der den Quelltext liest, findet nur, was statisch dasteht. Diese
Liste findet, was tatsächlich auf dem Bildschirm war.

## Der Code selbst: englisch

Die drei Arten oben handeln von Text, den jemand liest. Der Code ist die vierte
Art, und für ihn gilt das Gegenteil: **Bezeichner, Schlüssel und neue Kommentare
sind englisch.** Begründung ist dieselbe wie bei allem hier — die Stelle, an der
Sprache wirklich weh tut, ist die, an der jemand Neues dazukommt.

Das steht **nicht** im Widerspruch zum deutschen Satz als Übersetzungsschlüssel.
Beides trennt sauber:

```js
function reportDone(quest) {          // Code: englisch
  toast(t('Erledigt melden'))         // Oberfläche: deutscher Satz als Schlüssel
}
```

Wer `t('quest.submit.label')` schriebe, hätte beides vermischt — genau der
Fehler, den der Abschnitt oben beschreibt.

**Schlüssel in Nutzdaten sind der harte Teil.** `state.figure_id`, ein
Layer-Schlüssel `nature`, ein Nachweiswert `onSite` — die stehen in der Datenbank
und im Browser-Speicher der Spieler. Sie umzubenennen kostet eine Migration und
eine Übergangszeit, in der beide Schreibweisen gelesen werden. Neue sind deshalb
ab sofort englisch, ohne Ausnahme; der Bestand wird in einem Zug umgestellt
(`arbeitspakete.md`).

Der vorhandene Code ist gemischt. Er wird **nicht** auf einen Schlag übersetzt:
Wer eine Datei ohnehin anfasst, benennt sie beim Verlassen um. Die Regeln dazu
stehen in `CLAUDE.md`.

## Inhalte: ein Text darf einfach ein Text sein

```js
description: "Ein alter Brunnen."                    // völlig in Ordnung
description: { de: "Ein alter Brunnen.",             // wer mag, kann mehr
               en: "An old well." }
```

**Kein Agent muss Sprachkarten schreiben.** Ein Dialogpaket in einer Sprache ist
kein Mangel — die meisten Figuren stehen in einer Gegend, in der eine Sprache
gesprochen wird. Das Werkzeug ist da, die Pflicht nicht.

Auswahl in dieser Reihenfolge: gewünschte Sprache → dieselbe Sprache ohne Region
(`de-AT` → `de`) → `*` (sprachunabhängig, z. B. ein Eigenname) → die vom Autor
als Original markierte (`_quelle`) → der erste Eintrag.

Der letzte Schritt ist Absicht: **Lieber ein Satz in einer fremden Sprache als
ein leeres Feld.** Wer nichts versteht, sieht wenigstens, dass da etwas steht.

Erkannt wird eine Sprachkarte an ihren Schlüsseln — nicht jedes Objekt, sonst
würde `{lat, lon}` mit übersetzt.

## Server-Meldungen: Code statt Satz

Der Server übersetzt **nicht**. Er benennt die Lage, der Client sagt sie in der
Sprache des Lesers:

```json
{ "error": "someone is working on this call — the reward may be raised, not reduced",
  "code": "reward_reduced" }
```

Der englische Text bleibt als Rückfall stehen — er soll im Log lesbar sein.
Nebenwirkung, die den Aufwand allein rechtfertigt: **Fehler werden prüfbar.**
Vorher hingen Tests an englischen Satzfragmenten.

**Die Zuordnung steht im Client, nicht im Katalog** — `FEHLER_TEXT` in
`core/i18n.js`, gelesen von `serverFehler(err, rueckfall)`:

```js
catch (err) { zeige(serverFehler(err, 'Anmeldung fehlgeschlagen')) }
```

Hier stand zuerst, die Zuordnung gehöre als `'fehler.<code>'` in die
Sprachdatei. **Das geht für jede Sprache ausser der eigenen.** Der deutsche Satz
ist hier der Schlüssel; ein Katalogeintrag `'fehler.auth_locked'` hätte auf
Deutsch nichts nachzuschlagen, und der Spieler sähe entweder den Schlüssel oder
den englischen Server-Text. Aufgefallen ist es erst, als die Anmeldedrossel den
ersten Verbraucher bekam — die Einträge standen bis dahin unbenutzt im Katalog.

Also: Code → deutscher Satz in `FEHLER_TEXT`, und der geht durch `t()` wie jeder
andere Text. Ein unbekannter Code fällt auf die Server-Meldung zurück; die ist
englisch, sagt aber wenigstens etwas.

## Reihenfolge der Arbeit

Die UI-Texte **nicht zweimal anfassen.** Strings in einen Katalog zu ziehen
heißt, jeden einzelnen zu lesen — das *ist* der Bereinigungslauf (nur knapp
sagen, WAS ein Element tut; keine Code-Begründungen). Beides in einem Zug, sonst
macht man dieselbe Arbeit doppelt.

## Werkzeuge

```
node scripts/texte-pruefen.mjs              Übersicht je Datei
node scripts/texte-pruefen.mjs QuestPanel   die offenen Texte einer Datei
```

Das Gegenstück zu `ajnaFehlendeTexte()` im Browser: Der Konsolen-Aufruf findet,
was durch `t()` lief und keine Übersetzung hatte — das Skript findet, was gar
nicht erst durch `t()` läuft. Beides zusammen deckt beide Lücken ab.

Es ist eine **Heuristik**: Zeichenketten, die aussehen wie Anzeige und nicht wie
Code. Sie liegt gelegentlich daneben. Sie ist ein Wegweiser, kein Torwächter.

Konstanten-Tabellen (Beschriftungen, die erst beim ZEICHNEN durch `t()` laufen)
erscheinen dort als offen. Das ist richtig so: Es sind Texte, und wer sie
ändert, muss an die Übersetzung denken.

## Stand des Bereinigungslaufs

Durchgezogen sind die Wege, in denen ein Spieler täglich steht: Auftragsliste
und -editor, Melden und Abnahme, Objektmenü und Erzeugen, Nachbarschaftsliste,
Rechte- und Gruppen-Dialoge, Server-Verwaltung, Einstellungen, die AR- und
Karten-Oberfläche.

Offen sind die Randbereiche: Zauberstab-Sprachausgabe, UWB-Verwaltung,
GPS-Diagnose, Spracherkennung, Minimap. Dort steht viel Text, der gar keine
Anzeige ist, sondern Konsolen-Ausgabe — der gehört nicht in den Katalog.
`texte-pruefen.mjs` ist die Liste, die abgearbeitet wird.
