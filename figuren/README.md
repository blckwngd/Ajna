# Figuren — fest entworfene Gestalten

Der World-Director bevölkert die Welt mit Zufall: Namen aus Listen, Wege aus dem
Straßennetz, vier zufällige Dialogzeilen. Das belebt, aber es trägt nichts — und
beim Verlassen der Gegend wird alles abgeräumt und woanders neu gewürfelt.

Hier liegt der Gegenentwurf: **Figuren, die bleiben.** Eine Datei je Figur.

```json
{
  "id": "baumhueterin-wollendorf",
  "name": "Die Baumhüterin",
  "type": "npc",
  "lat": 50.452227,
  "lon": 7.432314,
  "description": "Steht bei der Gerichtslinde und erzählt von ihr.",
  "dialog": "baumhueterin",
  "dialog_vars": { "baum": "die alte Gerichtslinde" },
  "movement": "still",
  "appearance": { "emoji": "🌳", "color": "#6fae7a" }
}
```

| Feld | |
|---|---|
| `id` | **Pflicht, dauerhaft.** Daran erkennt der Director die Figur wieder. Ändern heißt: es entsteht eine zweite, die alte bleibt als Waise stehen. |
| `type` | `npc` · `enemy` · `animal` · `dragon` · `hint` · `item` · `diamond` |
| `dialog` | Name eines Parley-Pakets aus [`dialogs/`](../dialogs) — ohne Angabe redet sie wie ihr Archetyp |
| `dialog_vars` | füllt `{platzhalter}` im Dialog |
| `movement` | `still` (Vorgabe) oder `free` |
| `appearance` | `emoji`, `color`, `gltf` (Dateiname genügt, Pfad kommt davor) |

## Aufträge

Eine Figur kann einen Auftrag vergeben. Er steht als eigener Abschnitt in
derselben Datei:

```json
{
  "id": "baumhueterin-wollendorf",
  "…": "…",
  "quest": {
    "text": "Sieh nach der alten Linde und melde, wie es ihr geht.",
    "summary": "Nach der Linde sehen",
    "place": "Gerichtslinde, Wollendorf",
    "proof": ["photo", "onSite"],
    "review": "issuer",
    "karma": 5,
    "listAfter": 0,
    "repeatable": true,
    "reward": { "name": "Lindenblatt", "count": 5, "perRun": 1, "emoji": "🍃" }
  }
}
```

| Feld | |
|---|---|
| `text` | **Pflicht.** Was zu tun ist |
| `summary` | Zeile in der Liste (ohne Angabe: Anfang von `text`) |
| `place` | Ortsangabe im Klartext, für Menschen |
| `proof` | `photo` · `onSite` · `item` — was der Spieler beim Abschluss beilegt |
| `review` | `issuer` (Vorgabe, der Aussteller prüft) · `items` (Server entscheidet) · `agent` · `group` · `crowd` |
| `karma` | Mindest-Karma, um ihn annehmen zu dürfen |
| `onSiteRadiusM` | wie nah „vor Ort" ist (Vorgabe 150 m; nur bei Nachweis `onSite`) |
| `acceptRadiusM` | nur vor Ort annehmbar; 0 = überall |
| `listAfter` | `0` sofort in der Regionsliste · Stundenzahl = erst danach · `"nie"` = nur, wer die Figur findet |
| `repeatable` | mehrfach spielbar, bis der Vorrat erschöpft ist |
| `reward.name` | **Pflicht** — siehe unten |
| `reward.count` | Vorrat (1–20) |
| `reward.perRun` | wie viel pro Abschluss ausgezahlt wird (nur `repeatable`) |

**Belohnungen werden nie aus dem Nichts erzeugt.** Das ist eine Serverregel und
sie ist richtig: Sonst könnte jeder Agent beliebig viel Wert in die Welt
schütten. Der Director legt die Gegenstände deshalb als echte Objekte an, nimmt
sie in sein eigenes Inventar und hinterlegt sie dort treuhänderisch. Er gibt
also etwas her, das ihm gehört — und ein Auftrag ohne `reward.name` wird
schon beim Einlesen abgelehnt, nicht erst beim Ausschreiben.

**Ausgeschrieben wird einmal.** Veröffentlichen setzt den Lebenszyklus zurück
(`status` auf „offen", angenommene Aufträge werden frei). Bei jedem Neustart neu
auszuschreiben würde dem Spieler, der gerade unterwegs ist, den Auftrag unter
den Füßen wegziehen. Der Director zieht deshalb nur die beschreibenden Felder
nach — Text, Ort, Karma, Sichtbarkeit.

Ist der Vorrat aufgebraucht, wird ein `repeatable`-Auftrag beim nächsten Start
neu bestückt. Ein einmaliger bleibt erledigt: sonst wäre „einmalig" nur eine
Frage des nächsten Neustarts.

Technisch ist der Auftrag ein eigenes Objekt (`type: "call"`) am selben Ort wie
die Figur, an sie gebunden über `state.figure_quest`. Das ist keine Wahl,
sondern die Bauweise von Ajna: Aufträge sind Objekte, und die Server-Routen
prüfen das. Löschen wie eine Figur:

```bash
node tools/ajna.mjs prune-objects 'state.figure_quest = "baumhueterin-wollendorf"'
```

Parley-Dialoge und Aufträge schließen sich **nicht** aus — eine Figur kann
beides. Was ein Dialog nicht kann, ist einen Auftrag vergeben: `do:` kennt nur
`anim:`, und das ist Absicht. Ein Dialogsatz ist Text, den irgendwann jemand
anders beisteuert; er darf kein Karma verteilen.

Die alten deutschen Feldnamen (`typ`, `beschreibung`, `bewegung`, `aussehen`,
`auftrag` mit `kurz`/`ort`/`nachweis`/…) werden weiter gelesen, damit ältere
Dateien nicht brechen — siehe `docs/key-rename.md`.

## Was der Director damit macht

Bei **jedem Start**: anlegen, was fehlt — nachziehen, was sich geändert hat.
Wer eine Beschreibung umschreibt oder die Figur fünfzig Meter versetzt, sieht
das nach einem Neustart. Wiedererkannt wird an `id`, nicht am Namen; der darf
sich ändern.

**Gelöscht wird nie.** Verschwindet eine Datei, bleibt die Figur stehen. An ihr
können Aufträge, Karma und Gesprächsverläufe hängen — sie still wegzuräumen,
weil jemand eine Datei umbenannt hat, wäre der teuerste denkbare Tippfehler.
Wer eine Figur wirklich loswerden will, löscht das Objekt:

```bash
node tools/ajna.mjs prune-objects 'state.figure_id = "baumhueterin-wollendorf"'
```

## Warum sie überlebt

`state.persistent = true`. Der Director räumt beim Verlassen einer Gegend alles
ab, was er verwaltet — außer Objekten mit diesem Merker.

**Sie zählen zur Soll-Bevölkerung.** Die Dichte einer Gegend bleibt damit
gleich: Wer dort eine entworfene Gestalt hinstellt, bekommt eine zufällige
weniger, nicht eine mehr. Fehlt an einem Ort etwas, füllt der Director mit
Generiertem auf — entworfene Figuren ersetzen also Zufall, statt ihn zu
ergänzen.

(Anders als `on_demand`-Objekte, die ein Spieler selbst gesetzt hat: Die sind
Zugabe und zählen nicht mit, sonst hörte der Director auf zu spawnen, sobald
jemand ein paar Monster verteilt hat.)
