# Parley

Kleine Dialogsprache in JSON. Kein Sprachmodell, keine Abhängigkeiten, ein
Bündel von rund 700 Zeilen — gedacht für NPCs, Assistenten und alles, was ein
paar Sätze wechseln soll, ohne dass ein Rechenzentrum mitläuft.

Geistige Verwandte sind AIML und RiveScript. Übernommen wurde, was sich bewährt
hat (Muster mit Platzhaltern, Themen, Zufallsantworten, Vererbung), weggelassen
wurde, was in fünfzehn Jahren niemand vermisst hat (XML, `learn`, entfernte
Botsuchen).

```js
import { Parley } from 'parley'

const doc = {
  name: 'wirtin',
  lists: { gruss: ['hallo', 'moin', 'guten tag'] },
  rules: [
    { label: 'gruss', when: ['@gruss *'], then: ['Willkommen!', 'Setz dich.'] },
    { when: ['ich heisse *'], then: 'Freut mich, {1}.', set: { gast: '{1}' } },
    { when: ['* bier *'], if: { gast: { set: true } }, then: 'Kommt sofort, {gast}.' },
  ],
  fallback: [{ when: ['*'], then: 'Hm. Sag das nochmal anders.' }],
}

const p = new Parley(doc)
const chat = p.open('wirtin', 'tisch-3')

chat.say('Moin!')            // → { text: 'Setz dich.', … }
chat.say('Ich heiße Ada')    // → { text: 'Freut mich, ada.', … }
chat.say('Ein Bier bitte')   // → { text: 'Kommt sofort, ada.', … }
```

## Inhalt

- [Dokument](#dokument)
- [Regeln](#regeln)
- [Muster](#muster)
- [Bedingungen](#bedingungen)
- [Variablen setzen](#variablen-setzen)
- [Platzhalter](#platzhalter)
- [Auswahlantworten](#auswahlantworten)
- [Aktionen](#aktionen)
- [Vererbung](#vererbung)
- [API](#api)
- [Was Parley nicht kann](#was-parley-nicht-kann)

## Dokument

Ein Dialogsatz ist ein JSON-Objekt:

```jsonc
{
  "name": "mensch",            // Pflicht, eindeutig
  "extends": "basis",          // greift, wenn hier keine Regel passt
  "input": "auto",             // Vorgabe: "text" | "choice" | "auto"
  "vars":  { "kennt_mich": false },
  "lists": { "gruss": ["hallo", "moin"] },
  "rules": [ … ],
  "fallback": [ … ],           // nur, wenn KEINE Regel gegriffen hat
  "_note": "wird ignoriert"
}
```

`_note` darf an jeder Stelle stehen und wird überall ignoriert — JSON kennt
keine Kommentare, Dialoge brauchen aber welche. Der Wert darf ein String oder
ein Array von Strings sein.

**Reihenfolge entscheidet.** Regeln werden von oben nach unten geprüft, die
erste passende gewinnt. Wer eine engere Variante einer Regel schreibt, stellt
sie über die allgemeine.

## Regeln

```jsonc
{
  "label":   "gruss",              // Name, auf den sich after/same_as beziehen
  "when":    ["@gruss *", "hey"],  // Muster, ODER-verknüpft
  "if":      { "kennt_mich": false },
  "after":   "name",               // nur direkt nach dieser Regel
  "topic":   "markt",              // nur, solange vars.topic == "markt"
  "once":    true,                 // höchstens einmal je Gespräch
  "then":    ["Hallo!", { "text": "Tag auch.", "weight": 3 }],
  "set":     { "kennt_mich": true, "laune": { "+": 1 } },
  "do":      ["anim:wave"],
  "choices": [{ "label": "Ja klar", "send": "ja" }],
  "input":   "choice",
  "suggest": "hallo",              // Beschriftung als Vorschlag; false = nie
  "same_as": "andere_regel"        // then/do/set von dort übernehmen
}
```

Alle Felder sind optional außer `then` (oder ersatzweise `do`/`set`/`same_as`).
Fehlt `when`, passt die Regel auf jede Eingabe.

`then` ist eine Antwort oder eine Liste, aus der zufällig gewählt wird.
`{ "text": …, "weight": n }` macht eine Variante wahrscheinlicher.

## Muster

Eingabe und Muster laufen durch dieselbe Normalisierung: kleingeschrieben,
Satzzeichen weg, `ß` → `ss`, Umlaute in ihre Umschrift (`ä` → `ae`), andere
Diakritika auf den Grundbuchstaben (`é` → `e`). „Schön!" und „schoen" sind
also dasselbe.

| Zeichen | Bedeutung | Beispiel |
|---|---|---|
| Wort | wörtlich | `guten tag` |
| `*` | beliebig viele Wörter, **auch keine** | `* wetter *` |
| `?` | genau ein Wort | `ich bin ?` |
| `#` | eine Zahl | `ich bin # jahre alt` |
| `(a\|b)` | Alternativen, auch mehrwortig | `(guten tag\|moin)` |
| `[…]` | darf fehlen | `[na] moin` |
| `@name` | Alternativen aus einer Liste | `@gruss *` |

`*`, `?` und `#` merken sich, was sie gefunden haben — der erste Fund heißt
`{1}`, der zweite `{2}` und so weiter. Der Fund behält die
**Originalschreibweise**: „Ich heiße Ada" liefert `{1}` = `Ada`, verglichen
wird trotzdem kleingeschrieben.

Ein Fragezeichen im Mustertext ist **kein** Satzzeichen, sondern der
Ein-Wort-Platzhalter. `wie geht es dir?` verlangt also ein zusätzliches Wort
am Ende. Fragezeichen gehören in die Antwort, nicht ins Muster.

## Bedingungen

`if` ist ein Block UND-verknüpfter Vergleiche. Ein Array von Blöcken ist
ODER-verknüpft.

```jsonc
"if": { "kennt_mich": true, "laune": { ">": 0 }, "topic": "markt" }
"if": [{ "gold": { ">=": 10 } }, { "held": true }]     // eins von beidem
```

| Operator | Bedeutung |
|---|---|
| Wert direkt | gleich |
| `"="`, `"!="` | gleich / ungleich |
| `">"`, `">="`, `"<"`, `"<="` | numerisch |
| `"in"`, `"not_in"` | in einer Liste enthalten |
| `"has"` | Array enthält / String enthält |
| `"set"` | `true` = gesetzt, `false` = nicht gesetzt |

Neben den eigenen Variablen stehen drei von der Maschine geführte bereit:
`_last` (Etikett der zuletzt gegriffenen Regel), `_turn` (Zug-Zähler) und
`_hits.<label>` (wie oft eine Regel schon gegriffen hat). Punktpfade
(`"_hits.gruss"`, `"inventar.gold"`) funktionieren überall.

## Variablen setzen

```jsonc
"set": {
  "kennt_mich": true,
  "laune":  { "+": 1 },
  "gold":   { "-": 5 },
  "notizen": { "push": "{1}" },
  "wach":   { "toggle": true },
  "temp":   { "clear": true }
}
```

Strings laufen vorher durch die Platzhalter-Ersetzung, `"spieler": "{1}"`
speichert also den Wildcard-Fund.

`topic` ist eine gewöhnliche Variable mit einer Sonderrolle: Regeln mit
`"topic": "x"` greifen nur, solange `vars.topic` genau `"x"` ist.

## Platzhalter

| Form | Ergebnis |
|---|---|
| `{1}` … `{9}` | Wildcard-Fund |
| `{name}` | Variable (Punktpfade erlaubt) |
| `{swap:1}` | Fund mit gedrehter Perspektive: „ich mag dich" → „du magst mich" |
| `{upper:name}` | Variable in Großbuchstaben |
| `{input}` | die rohe Eingabe |
| `{rnd:a\|b\|c}` | eine der Varianten |

Unbekannte Variablen werden zu Leerstring — eine Antwort mit Lücke ist besser
als ein Absturz mitten im Gespräch.

## Auswahlantworten

Zwei Wege. **Explizit** listet die Regel ihre Knöpfe selbst:

```jsonc
{ "when": ["* karte *"], "then": "Welche Karte?",
  "choices": [{ "label": "Die alte", "send": "die alte karte" }, "keine"],
  "input": "choice" }
```

**Abgeleitet** — `"input": "auto"` — findet die Maschine selbst heraus, was
als Nächstes sinnvoll ist: alle Regeln, die im aktuellen Zustand greifen
würden und ein wörtliches Muster haben. Anschlussregeln (`after` passt zur
eben gefeuerten) stehen vorn, denn das ist der Gesprächsfaden; danach steht
vorn, was noch nie gefragt wurde. So rotieren die Vorschläge, statt bei jedem
Zug dieselben vier Knöpfe anzubieten. Eine Regel kann mit `"suggest": "Text"`
eine schönere Beschriftung setzen oder sich mit `"suggest": false` heraushalten.

`input` sagt dem anzeigenden Programm, was es tun soll:

- `"text"` — nur Freitext (Vorgabe)
- `"choice"` — nur die Knöpfe
- `"auto"` — Knöpfe **und** Freitext

## Aktionen

`do` reicht durch, was der Dialog auslösen soll — Parley führt nichts selbst
aus, es weiß ja nicht, in welchem Programm es steckt.

```jsonc
"do": ["anim:wave", { "action": "goto", "to": "markt" }]
```

Die Kurzform `"a:b"` wird zu `{ action: "a", value: "b" }`. String-Werte
durchlaufen die Platzhalter-Ersetzung.

## Vererbung

`extends` nennt einen oder mehrere Dialogsätze, die einspringen, wenn hier
nichts passt. Die Suchreihenfolge ist:

1. Regeln des eigenen Dokuments
2. Regeln der Vorfahren (in Reihenfolge der Angabe, tiefengeschichtet)
3. `fallback` des eigenen Dokuments
4. `fallback` der Vorfahren

`lists` und `vars` werden über die Kette zusammengeführt, eigene Einträge
gewinnen. `same_as` bleibt dokumentlokal.

So bekommt ein Standardfundus („was jeder sagen kann") jede Figur, ohne dass
er in jeder Datei steht:

```jsonc
{ "name": "wirtin", "extends": "mensch" }   // mensch wiederum: extends basis
```

## API

```js
const p = new Parley(docs, { rng, maxChoices })
```

| Aufruf | Zweck |
|---|---|
| `p.add(doc)` | Dialogsatz aufnehmen (gleicher Name ersetzt) |
| `p.names` | Namen aller geladenen Sätze |
| `p.chain(name)` | aufgelöste Erbkette (wirft bei fehlenden Sätzen) |
| `p.open(name, id, { vars, restore })` | Gespräch beginnen oder fortsetzen |
| `p.session(id)` | laufendes Gespräch oder `null` |
| `p.close(id)` | Gespräch vergessen |
| `p.sweep(msAlt)` | alle Gespräche vergessen, die länger als `msAlt` still sind |
| `p.reply(name, id, text)` | Kurzform für `open(…).say(text)` |
| `p.openCount` | Anzahl offener Gespräche |

Ein Gespräch (`Conversation`):

| Aufruf | Zweck |
|---|---|
| `chat.say(text)` | antworten |
| `chat.vars` | Variablen (les- und schreibbar) |
| `chat.hits`, `chat.last`, `chat.turn` | Trefferzähler, letztes Etikett, Zug |
| `chat.toJSON()` | Zustand sichern |
| `chat.reset()` | auf den Anfangszustand zurück |

`say()` liefert:

```js
{
  text: 'Hallo!',            // null, wenn keine Regel gegriffen hat
  matched: true,
  label: 'gruss',
  choices: [{ label: 'Wer bist du', send: 'wer bist du' }],   // oder null
  input: 'auto',
  do: [{ action: 'anim', value: 'wave' }]
}
```

Zustand liegt in der Sitzung, nie im Dokument — ein Dialogsatz trägt beliebig
viele Gespräche gleichzeitig. `toJSON()`/`open(…, { restore })` überstehen
einen Neustart.

`rng` nimmt einen eigenen Zufallsgenerator (für reproduzierbare Tests),
`maxChoices` begrenzt die abgeleiteten Vorschläge (Vorgabe 4).

## Was Parley nicht kann

Absichtlich nicht: lernen (`learn`/`learnf` aus AIML), fremde Bots befragen
(`sraix`), Rechtschreibkorrektur, Synonymwörterbücher, Wortstammbildung.

Technisch bedingt: Der Mustervergleich läuft mit Rücksetzen. Für Chat-Sätze
ist das schnell genug, ein Muster mit einem Dutzend `*` auf einem
Hundert-Wort-Satz ist es nicht. Wer fremde Dialogsätze lädt, begrenzt die
Zahl der Wildcards, bevor er sie kompiliert.

## Tests

```bash
node test/parley.test.mjs
```

## Lizenz

MIT
