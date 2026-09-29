# Ajna — Regeln für die Arbeit an diesem Projekt

## Sprache

**Code ist englisch. Oberfläche und Inhalte sind deutsch.** Die Grenze verläuft
genau dort, wo ein Mensch den Text liest.

| | Sprache | warum |
|---|---|---|
| Bezeichner (Funktionen, Variablen, Konstanten, Dateinamen) | **englisch** | damit auch jemand mitarbeiten kann, der kein Deutsch spricht |
| Schlüssel in Nutzdaten (`state.*`, Layer, Aktionen, Aufzählungswerte) | **englisch** | sie stehen in der Datenbank und lassen sich später nur mit Migration ändern |
| Kommentare | **englisch** bei neuem Code | der Bestand ist deutsch und wird nicht auf einen Schlag übersetzt |
| Oberflächentexte in `t('…')` | **deutsch** | der deutsche Satz IST der Schlüssel — siehe `docs/mehrsprachigkeit.md` |
| Inhalte (Dialoge, Objektnamen, Beschreibungen) | **deutsch** oder Sprachkarte | Inhalt ist keine Programmierung |
| Doku unter `docs/` | deutsch, englisch erlaubt | Entwicklerdoku darf mitwandern |
| Doku unter `wiki/` | **deutsch** | richtet sich an Betreiber und Spieler hier |

Der Bestand ist noch gemischt (Stand 23.09.2026: rund 400 deutsch benannte
Bezeichner). **Kein Rundumschlag** — wer eine Datei ohnehin anfasst, benennt sie
beim Verlassen englisch um. Ein Massen-Umbenennen würde jeden offenen Zweig in
Konflikte stürzen und die rund 225 Prüfungen in `tests/run-ui.mjs` auf einen
Schlag rot machen, die den Quelltext wörtlich vergleichen.

**Neue Schlüssel in Nutzdaten sind sofort englisch, ohne Ausnahme.** Sie sind
das Einzige, was sich später nicht mehr billig ändern lässt.

## Arbeitsweise

* `docs/arbeitspakete.md` ist die stehende Antwort auf „was ist offen?".
* Tests vor dem Melden: `npm test` (Unit, UI, Geo, Landing, Quests, Privacy).
* Agents **nie** mit `&` in einer Bash-Kette starten — Windows lässt sie
  weiterlaufen, und zwei Schreiber auf denselben Objekten lassen Figuren
  springen.
* Zeilenenden sind **LF**. Dateien mit Python zu schreiben macht daraus unter
  Windows stillschweigend CRLF; dann scheitern die Quelltext-Vergleiche in
  `tests/run-ui.mjs`.
