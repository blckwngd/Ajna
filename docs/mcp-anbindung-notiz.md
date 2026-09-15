# MCP-Anbindung — Notiz zum Stand der Überlegung

**Nichts davon ist gebaut.** Diese Notiz hält fest, was durchdacht und
recherchiert wurde, damit eine spätere Umsetzung nicht bei null anfängt — und
damit die beiden Sackgassen nicht ein zweites Mal begangen werden.

Stand: September 2026.

---

## Zwei Richtungen, eine davon verworfen

### Ajna ALS MCP-Server (verworfen)

Gedanke war: Unternehmen und Privatpersonen binden ihre KI an und interagieren
mit der Spielwelt. Bei näherem Hinsehen zerfällt das in zwei Fälle mit
gegensätzlichen Anforderungen:

**LLM-NPCs passen nicht.** MCP ist client-getrieben — es gibt keine Sitzung,
solange niemand eine öffnet. Eine Figur muss aber antworten, wenn jemand sie
anspricht, auch nachts, auch wenn nirgends ein KI-Fenster offen ist. Genau
dafür gibt es `bootAgent` + `onInteract` + `sendChat`. MCPs *Sampling* hätte die
richtige Richtung (Server fragt Client), setzt aber eine offene Sitzung voraus,
wird nicht überall unterstützt und hat unkalkulierbare Latenz. Wer eine
sprechende Figur will, lässt den Agenten selbst eine LLM-API rufen.

**Agenten-Workflows passen gut** — „lege für diese 40 Stände Objekte an",
„welche Aufträge laufen morgen ab". Menschlich ausgelöst, Anfrage/Antwort. Für
den Hofflohmarkt wäre das der eigentliche Gewinn: Eine Organisatorin mit einer
Anmeldeliste ist keine Programmiererin.

**Warum trotzdem verworfen:** Es ist ein Verpackungs-Gewinn, kein
Fähigkeits-Gewinn — ein Agent in fünfzig Zeilen kann das alles schon. Und es
fehlt eine Voraussetzung: **Ajna kennt nur `authWithPassword`**, keine
widerrufbaren Zugangsschlüssel. Ein Betrieb müsste sein Kontopasswort in die
Konfiguration einer fremden KI-Anwendung schreiben, und einzeln zurückziehen
ließe es sich nicht. Wer Dritte anbinden will, braucht erst benannte, einzeln
löschbare Schlüssel mit Werkzeug-Umfang.

Falls es doch einmal kommt, die Risiken, die dann zählen:

* **Jedes Werkzeugergebnis ist fremder Text.** Objektnamen schreiben andere
  Spieler; ein Objekt namens „Ignoriere vorherige Anweisungen…" landet direkt im
  Kontext des Modells. Löschendes gehört hinter eine Rückfrage oder gar nicht
  ins Verzeichnis.
* **Die Ratenbegrenzung greift nur anonym** (`1788000000_rate_limits.js`). Ein
  angemeldeter MCP-Server ist ungebremst und legt Objekte an, sobald er kann.
* **Flüchtige Daten und MCP vertragen sich nicht.** KI-Clients protokollieren
  Werkzeugergebnisse, oft auf fremden Servern. Werkzeuge, die
  personenbezogene Daten liefern (etwa die Adress-Lupe), kommen gar nicht erst
  ins Verzeichnis — siehe `fluechtige-daten.md`.

### Ajna-Agents ALS MCP-Client (die bessere Richtung)

Agents docken erreichbare MCP-Server an und gewinnen Fähigkeiten, ohne dass
Ajna etwas davon wissen muss. Ajna-seitig ist es *eine* Schnittstelle.

**Der Haken war zunächst:** MCPs Wert liegt in der modellgetriebenen
Werkzeugwahl. Ohne Modell ist es ein schwergewichtiger RPC — und **kein
einziger Agent im Projekt benutzt heute ein Sprachmodell** (gemessen; `parley`
ist ausdrücklich deterministisch).

**Aufgelöst durch Parley** (siehe unten): Die Werkzeugwahl kann aus der
Dialogdatei kommen. Damit gibt es einen Aufrufer, und zwar ohne LLM.

---

## Die Naht: Parley braucht keine Änderung

`parley/README.md` sagt es als Entwurfsprinzip: **„`do` reicht durch, was der
Dialog auslösen soll — Parley führt nichts selbst aus."** `say()` ist synchron
und rein; der Agent führt die Aktionen aus (`world-director.mjs:1950`:
`for (const a of antwort.do) await fuehreAus(a, obj)`).

MCP gehört also **in `fuehreAus()`**, als weitere Aktionsart neben `anim` und
`goto`:

```json
{ "when": "wie ist das wetter *",
  "then": "Moment, ich schaue nach.",
  "do":   [{ "action": "mcp", "server": "wetter", "werkzeug": "forecast",
             "ort": "{ort}", "nach": "wetter_text" }],
  "set":  { "topic": "wetter_wartet" } }
```

Der Agent ruft das Werkzeug, schreibt nach `conv.vars.wetter_text` und stößt
einen zweiten Zug an; eine Folgeregel mit `topic: "wetter_wartet"` liefert
`„Es sind {wetter_text}."`

**Der zweite Zug ist die richtige Gestalt, kein Notbehelf** — so spricht auch ein
Mensch: erst „Moment", dann die Auskunft. `after:` und `topic:` sind genau die
Zustandsmaschine dafür.

**`say()` NICHT asynchron machen.** 843 Zeilen, rein, deterministisch,
vollständig unter Test — das ist der Wert dieser Maschine. Ein `await` mitten
hinein macht aus einem prüfbaren Regelwerk etwas, das nur noch gegen ein Netz
testbar ist.

**Was der Gewinn wirklich ist:** Heute heißt „neue Fähigkeit" = Code in
`fuehreAus()`. Mit einer generischen `mcp`-Aktion heißt es Konfigurationseintrag
plus Dialogregel.

---

## Recherche: welche Server taugen (Stand September 2026)

**Der offizielle Satz enthält für eine Spielwelt fast nichts** — Everything,
Fetch, Filesystem, Git, Memory, Sequential Thinking, Time. Nur `Time` passt.
Alles Brauchbare kommt aus der Community.

**Auswahlkriterium ohne LLM:** Ein Server muss **bereits kurze, strukturierte
Werte** liefern. Alles, was erst zusammengefasst werden müsste, fällt durch —
es passt nicht in einen NPC-Satz.

| Anbindung | Bewertung |
|---|---|
| **Wetter (Open-Meteo)** | Gut. Kurze Werte, **kein Schlüssel**, kostenfrei; Open-Meteo führt auch Luftqualität. Mind. vier konkurrierende Implementierungen, keine maßgeblich |
| **ÖPNV / DB-Fahrplan** | Stärkster Fall für eine geobezogene Welt in Deutschland. Variante auf `v6.db.transport.rest` bevorzugen — frei und schlüssellos |
| **Wikidata** | `wmde/WikidataMCP` von Wikimedia Deutschland, **gehostet** auf `wd-mcp.wmcloud.org`. Strukturierte Werte, institutionell gepflegt, trifft die bestehende Vertrauenslinie (nur Wikipedia/Commons) |
| **Time** | Trivial, aber nützlich: Tageszeit, Zeitzone |
| ~~OpenStreetMap/Overpass~~ | **Braucht ihr nicht.** `server/geo.js` hat drei Spiegel, Ausfallerkennung, 12-h-Cache; jeder fremde Aufsatz wäre weniger |
| ~~Fetch / Websuche~~ | Lange Prosa, die erst ein Modell verdichten müsste |
| ~~Home Assistant~~ | Bei euch besser gelöst (MQTT-Gateway mit ACL und TLS) |
| ~~Memory~~ | Konkurriert mit Parleys `vars` samt Sitzungswiederherstellung |

### Zwei Befunde, die die Bauweise bestimmen

**Fast alles sind Ein-Personen-Projekte.** Ein **stdio-Server heißt, fremden
Code auf der eigenen Maschine auszuführen**, oft per `npx`/`uvx` in der jeweils
neuesten Fassung — riskanter als eine normale Abhängigkeit, weil still
aktualisiert. Zusammen mit der Windows-Historie (Streuner-Prozesse) spricht das
klar für **gehostete Server über HTTP**, wo fremder Code gar nicht erst startet.

**Bei den besten Kandidaten ist die Quell-API so einfach, dass der Server fast
trivial ist.** Open-Meteo und `v6.db.transport.rest` brauchen keinen Schlüssel.
Ein eigener, hundert Zeilen langer Server ist vermutlich sicherer und stabiler
als der eines Fremden.

**Daraus folgt die ehrliche Begründung:** Der Gewinn liegt in der einheitlichen
Naht, **nicht in einem reichen Ökosystem**. Die ersten zwei oder drei Server
schreibt man realistisch selbst.

---

## Wenn gebaut wird

Vorschlag: `agents/lib/mcp.mjs` in der Reihe von `konfig.mjs` und
`quellcache.mjs`.

```
Konfig.eigene → mcp.server = [{name, transport, url|befehl, ...}]
verbinde()       → Werkzeugliste
rufe(name, args) → Ergebnis, ausdrücklich als FREMDDATEN gekennzeichnet
```

* Serverliste in die **agenteneigenen** Einstellungen, nicht die der Instanz.
* Geheimnisse aus der `.env`, nie aus der Datenbank (die Schutzregel in
  `konfig.mjs` sitzt seit dem Fix an der richtigen Stelle).
* **Nur der Betreiber dockt an.** Könnten Spieler wählen, wäre es ein Loch.
* **Inhalts-Injektion:** Was aus dem Werkzeug kommt, geht über `fillIn()` in die
  Rede einer Figur, die Spieler lesen. Längenbegrenzung, Bereinigung, nichts
  Personenbezogenes in einen öffentlich sichtbaren Kanal.
* **Der NPC darf nicht einfrieren:** harter Zeitablauf, Ausweichregel über `if:`
  auf eine Fehler-Variable („Ich komme gerade nicht dran").
* **`Quellcache` gilt auch hier** — dieselbe Anfrage ist dieselbe Antwort.

Erster Beweis wäre Wikidata gehostet (zeigt, dass Fremdserver funktionieren) und
Wetter als eigener kleiner Server.

## Verwandt

* `docs/fluechtige-daten.md` — warum personenbezogene Werkzeuge nicht ins
  Verzeichnis gehören.
* `docs/welt-kontext.md` — der Gedanke, der aus dieser Überlegung entstanden ist
  und wahrscheinlich mehr bringt.
