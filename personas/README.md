# Personas — Figuren mit eigenem Konto

Eine Persona ist eine entworfene Figur wie in [`figuren/`](../figuren) — mit
einem Unterschied, der alles ändert: **sie gehört nicht dem World-Director,
sondern einem eigenen Konto.** Der Director schreibt an Objekten, die ihm
gehören, und kommt damit über den Besitzer-Pfad an jeder Rechteprüfung
vorbei. Eine Persona geht die Wege eines Spielers (`/interact`, `/pickup`,
`/chat/send`) und stößt an dieselben Wände wie ein Spieler. Für eine Figur,
die bemerken soll, was ein Spieler bemerken würde, ist genau das der Zweck.

Eine Datei je Persona, ein Prozess je Persona:

```
node agents/persona.mjs --persona wanderer --setup   # einmalig: Konto anlegen
node agents/persona.mjs --persona wanderer           # danach
npm run persona -- --persona wanderer                # dasselbe
```

`--setup` braucht `AJNA_SU`/`AJNA_SU_PASS` aus der Root-`.env`: Es legt das
Konto als Superuser an, **versiegelt** es (`agent_seal` — der Client zeigt
`✓ @wanderer` an allem, was die Figur anlegt) und schreibt
`agents/.env.persona-wanderer` mit dem eigenen Login. Das Superuser-Passwort
landet nicht in dieser Datei. Ein zweiter Lauf findet das Konto wieder und
fasst das Passwort nicht an; `--reset-password` vergibt ein neues.

## Die Datei

```json
{
  "name": "Jorin der Wanderer",
  "type": "npc",
  "lat": 50.3569, "lon": 7.5890,
  "description": "Ein Reisender, der sich alles genau ansieht.",
  "dialog": "mensch",
  "movement": "free",
  "appearance": { "gltf": "quaternius_men/Adventurer.gltf", "emoji": "🧭" },
  "mode": "debug",
  "prompt": "Du bist Jorin …"
}
```

Alles bis `appearance` ist das Figur-Format aus `figuren/README.md`; `id`
entfällt, der Dateiname ist der Anker. Eine Persona trägt ihren Namen
**dauerhaft über dem Kopf**: `appearance.label` ist als Vorgabe `{name}` — der
Client zeichnet die Tafel für jedes Objekt mit Vorlage (die 25 nächsten binnen
1,5 km, nach Entfernung skaliert). Wer mehr will, setzt die Vorlage in der
Datei, etwa `"label": "{name}\n{distance}"`. Dazu:

| Feld | |
|---|---|
| `mode` | `basic` (kein Sprachmodell, Verhalten wie der Director) · `passive` · `active` · `debug`. Vorgabe für den Regler `persona.mode` in `agent_settings` — dort zur Laufzeit umschaltbar |
| `prompt` | Die Rolle fürs Sprachmodell. Deutsch, es ist Inhalt. Steht **nur** hier und in `agent_settings` des eigenen Kontos — nie in `objects.state`, das jeder lesen kann, der die Figur sieht |

Der Dateiname ist zugleich der Handle des Kontos (`@wanderer`) und muss
dessen Regeln genügen: Kleinbuchstaben, Ziffern, `-`, `_`.

## Was eine Persona in der Welt ist

Ein gewöhnliches Objekt, `state.persistent = true`, `state.source =
persona-<name>`, mit eigenem Manifest — also im Agent-Filter der Spieler
ausblendbar wie jede andere Quelle. **Kein** `state.director`: sonst
adoptierte der Director die Figur als seine eigene.

Spieler erreichen sie über `Sprechen` und `Untersuchen`; die Antworten kommen
aus dem Parley-Paket unter `dialog`. In den Modi mit Sprachmodell kommt das
Modell dazu — Parley bleibt dabei die Quelle für alles Verbindliche.

## Interessensbereich

Eine Persona kann wie ein Spieler ihren unscharfen Bereich veröffentlichen
(`persona.publish_area`). Dann bevölkert der Director die Gegend um sie — ohne
das liefe sie durch eine leere Welt. Vorgabe: **an** im Modus `debug`, sonst
aus; eine dauerhaft stehende Figur hielte sonst still eine Gegend am Leben.

## Regler (`agent_settings`, Präfix `persona.`)

| Regler | Env | Vorgabe |
|---|---|---|
| `mode` | `PERSONA_MODE` | aus der Datei |
| `publish_area` | `PERSONA_PUBLISH_AREA` | an bei `debug` |
| `roam_radius_m` | `PERSONA_ROAM_RADIUS_M` | 150 |
| `speed` | `PERSONA_SPEED` | 1.3 |
| `tick_ms` | `PERSONA_TICK_MS` | 500 |
| `pause_s` | `PERSONA_PAUSE_S` | 12 |
| `talk_halt_s` | `PERSONA_TALK_HALT_S` | 45 |
| `heartbeat_s` | `PERSONA_HEARTBEAT_S` | 60 |
| `area_refresh_s` | `PERSONA_AREA_REFRESH_S` | 120 |
| `home` | `PERSONA_HOME` (`"lat,lon"` oder JSON) | aus der Datei |
| `call_walk_m` | `PERSONA_CALL_WALK_M` | 400 |
| `call_allow` | `PERSONA_CALL_ALLOW` | `*` |
| `llm.provider` | `PERSONA_LLM_PROVIDER` | `anthropic` (oder `openai` für Ollama/vLLM) |
| `llm.model` | `PERSONA_LLM_MODEL` | `claude-opus-5-5` |
| `llm.effort` | `PERSONA_LLM_EFFORT` | `low` |
| `llm.max_output` | `PERSONA_LLM_MAX_OUTPUT` | 1024 |
| `llm.rate_per_min` | `PERSONA_LLM_RATE_PER_MIN` | 6 |
| `llm.timeout_ms` | `PERSONA_LLM_TIMEOUT_MS` | 20000 |
| `llm.bundle_ms` | `PERSONA_LLM_BUNDLE_MS` | 1500 |
| `llm.idle_s` | `PERSONA_LLM_IDLE_S` | 180 (`active`/`debug`: Eigeninitiative und Mindestabstand der Ankunfts-Züge, 0 = nie) |
| `llm.max_rounds` | `PERSONA_LLM_MAX_ROUNDS` | 3 — **der Kostenregler:** Modellanfragen je Zug, jede schickt den ganzen Verlauf erneut |

Ein leerer Eintrag heißt: es gilt die `.env`.

## Das Sprachmodell

**Der Schlüssel steht nur in der Umgebung** — `agents/.env.persona-<name>`:

```
ANTHROPIC_API_KEY=sk-ant-…          # Anthropic
OPENAI_API_KEY=…  OPENAI_BASE_URL=http://127.0.0.1:11434/v1   # OpenAI-kompatibel, z. B. Ollama
```

Nie in der Datenbank: `konfig.mjs` legt keinen Regler an, dessen Name `key`
oder `token` enthält (deshalb heißt die Obergrenze `max_output`). Modell und
Anbieter stehen als Regler in `agent_settings` und lassen sich dort **im
Betrieb** umstellen — pro Persona, weil jede ihr eigenes Konto hat.

Ohne Schlüssel in einem Modell-Modus sagt die Figur es beim Start einmal und
verhält sich wie `basic`. Sie startet immer, und sie verstummt nie.

**Wie ein Zug abläuft** (`agents/lib/persona-llm.mjs`): Das Modell wird nie
pro Takt gefragt, nur bei Ereignissen — jemand spricht, jemand kommt näher,
„Sprechen" im Menü, Ankunft, und in `active`/`debug` alle `llm.idle_s`
Sekunden aus eigenem Antrieb. Ereignisse innerhalb von `llm.bundle_ms` werden
zu einem Zug gebündelt. **Parley läuft immer zuerst**: eine Regel mit
`"binding": true` antwortet wörtlich, das Modell wird dafür nicht gefragt;
alles andere bekommt es als Material. Es handelt ausschließlich über die
Werkzeuge des Aktionsregisters, jeder Aufruf geht durch den Wächter; ein
verweigerter Aufruf kommt als Ergebnis zurück. Zeitüberschreitung,
Rate-Limit, Anbieterfehler, Ablehnung: die Figur antwortet aus Parley.

Wird die Figur angesprochen, bleibt sie stehen (`talk_halt_s`) — als
Haltplan geschrieben, damit sie auch beim Betrachter steht und nicht
weiterläuft. Solange das Modell rechnet, spielt sie `think` (bei den
Alltagsleuten „Interact", bei den Helden „Spell", sonst ruhiges Stehen).

**Was Anfragen kostet.** Ein Zug besteht aus bis zu `llm.max_rounds`
Anfragen; jede schickt den ganzen Verlauf erneut, das Modell kann mehrere
Werkzeuge in eine Runde packen. Ankunfts- und Leerlauf-Züge (`active`/`debug`)
halten den Abstand `llm.idle_s`. Das Rate-Limit `llm.rate_per_min` zählt
Anfragen, nicht Züge; darüber hinaus antwortet die Figur aus Parley.

Was sie mit einem Spieler besprochen hat, merkt sie sich — begrenzt je
Spieler und insgesamt, und über einen Neustart hinweg (siehe unten).

## Journal, Befunde, Gedächtnis

Drei Dateien je Persona unter `agents/data/personas/<name>/` — gitignored,
sie enthalten, was Spieler zur Figur gesagt haben:

| Datei | Inhalt |
|---|---|
| `journal.jsonl` | **Beweise.** Eine Zeile je Aktion: Absicht, Aufruf, Erwartung, Ergebnis. Schreibt der Takt, urteilt niemand. Rotiert ab 8 MB (eine Vorgängerdatei bleibt) |
| `findings.jsonl` | **Urteil des Modells.** Eine Zeile je `report_finding`, mit den Journalzeilen, die dazu führten. Rotiert nie |
| `memory.json` | das Kurzzeitgedächtnis je Spieler; alle 5 Minuten und beim Beenden geschrieben |

Befunde lesen, ohne Login und ohne Netz:

```
node agents/persona.mjs --persona wanderer --findings
```

Gruppiert nach Art und Titel mit Zähler — **gruppiert, nicht gefiltert**:
nichts wird unterschlagen, man sieht nur, wie oft etwas kam. Die rohen
Zeilen stehen in der Datei; `journal.jsonl` daneben sagt, was die Figur
davor getan hat. Kein HTTP-Endpunkt, mit Absicht: Eine Datei liest, wer
Shell-Zugang hat, und sonst niemand.

## Die Figur woandershin schicken

**Nicht** über die Datenbank oder Drag & Drop auf der Karte: Der Agent ist die
einzige Instanz, die seine Position schreibt, und überschreibt beides beim
nächsten Takt. Zwei Wege, die er versteht:

* **Heimat als Regler.** `persona.home` in `agent_settings` auf
  `{"lat": 50.37, "lon": 7.59}` setzen — die Figur zieht sofort um (Sprung,
  mit Logzeile `🚩 relocated`), die Interest-Area wandert mit, und Heimat plus
  `roam_radius_m` sind ab da der Bereich, den sie untersucht. Überlebt einen
  Neustart; ein leerer Eintrag heißt wieder: die Datei gilt. **Ein** Wert mit
  beiden Koordinaten, nicht zwei — zwei Regler hätten einen Zwischenzustand,
  in dem nur eine Hälfte neu ist, und die Figur spränge dorthin.
* **Rufen.** Die Figur bietet `Rufen` im Menü (wie der Drache). Der Client
  schickt dabei die Position des Rufenden nach dessen Privatsphäre-Stufe —
  exakt oder aufs Raster gerundet, bei „Verborgen" gar nicht. Bis
  `call_walk_m` geht die Figur hin, darüber springt sie (0 = immer springen).
  Der Ort wird zur neuen Heimat und in die Regler geschrieben. Wer rufen darf,
  bestimmt `call_allow`: `*` oder eine Liste von Konto-Kennungen; ein
  abgewiesener Ruf wird im Chat beantwortet.
