# Arbeitspakete

**Wo wir stehen.** Diese Datei ist die stehende Antwort auf „was ist offen?" —
damit niemand nachfragen muss. Reihenfolge = Priorität.

Regel: Ein Paket verschwindet hier erst, wenn es *erledigt und geprüft* ist.
Verworfenes wandert nach unten statt gelöscht zu werden — sonst wird derselbe
Gedanke ein zweites Mal gedacht.

Stand: 29. September 2026 (Handbuch-Webseite, C-ITS-Brücke)

---

## Als Nächstes

### 0 · Jedes Konto kann jedes Gespräch mitlesen — **behoben am 20.10., Rest am 22.10.**

Behoben durch `pb_hooks/realtime-guard.pb.js`, Netz dagegen:
`tests/privacy/realtime-themen.mjs` (25 Prüfungen). **Gegen eine ungeschützte
Instanz schlägt die Suite rot aus — beide Male nachgemessen, bevor der Wächter
stand** (20.10.: Chat und Näherung; 22.10.: Interaktion und Agent-Kanal, fünf
rote Prüfungen an der Wegwerf-Instanz mit den alten Hooks).

| Thema | wer hören darf |
|---|---|
| `chat:<konto>` | nur das Konto selbst |
| `proximity:<objekt>` | der Betreiber (Besitzer oder ACE-Recht `owner`) |
| `interact:<objekt>:owner` | der Betreiber — volle Fassung mit Absender und Nutzlast |
| `interact:<objekt>` | alle, die das Objekt sehen — nur noch `{ action, ts }` |
| `agent:<quelle>`, `agent:<quelle>:public` | Inhaber des ältesten Manifests der Quelle plus Delegierte (`pb_hooks/sources.js`, dieselbe Regel wie für `state.source`) |

**Interaktion: ein Ereignis, zwei Themen (22.10.).** Das öffentliche Thema
trug Absender und Nutzlast — „Rufen" enthält die Position des Rufenden. Wer
ein beliebiges Objekt abonnierte, erfuhr, wer wo mit wem spricht. Die Viewer
lesen aus dem Ereignis nur `action` (Reaktion zeigen) und `source` zum
Erkennen des eigenen Echos; `payload` liest allein der Betreiber (Director,
Persona, Adress-Lupe). Also schickt der Server die volle Fassung nur noch auf
`interact:<id>:owner`, und `source` im öffentlichen Ereignis nur an den
Auslöser selbst (`client.get("auth")` im Broker — gemessen, funktioniert).
`AjnaClient.onInteract` abonniert beide Themen (Vorgabe `owner: true`),
`AjnaManager.subscribeInteract` für Viewer nur das öffentliche; der Server
stellt je Client genau eines zu. **Die laufende Instanz muss neu starten**,
PocketBase lädt Hooks nicht nach.

**Agent-Kanal: ein unbeanspruchter Name bleibt offen — bewusst.** Ein Agent,
der kein Manifest veröffentlicht, soll nicht aus seinem eigenen Kanal fallen;
das wäre schlimmer als das Leck. Unsere beiden Kommando-Empfänger
(World-Director, Robot-Agent) veröffentlichen ihr Manifest VOR dem Abo
(geprüft 22.10.). Die Suite misst beides: Dritte hören bei beanspruchtem
Namen nichts, bei unbeanspruchtem alles. Nebenwirkung, sichtbar im
PocketBase-Log: Der Director adoptiert Objekte, die ihm nicht mehr gehören,
und bekommt für sie `interact:<id>:owner` verweigert (siehe Notiz unten) —
auf solchen Figuren wirken „Rufen" und „Angreifen" nicht mehr, bis der
Adoptionsfilter steht.

**Gefiltert, nicht abgelehnt.** Beides wirkt (gemessen), aber ein Client
schickt bei jeder Änderung seine GANZE Themenliste — eine abgelehnte Anfrage
nähme die erlaubten Themen derselben Anfrage mit. Der Filter entfernt nur das
beanstandete.

**Entschieden (22.10.):** Umstehende hören ein Gespräch mit einer Figur
**nicht** mit. Für Nachrichten in der Umgebung kommt ein eigener Weltchat
(Paket 0d). Offen bleibt der Missbrauchsschutz auf `/api/chat/send` (jeder
Angemeldete darf jedem schreiben) — eine Entwurfsfrage, kein Leck.

**Postfach (22.10.).** Eine Nachricht an jemanden, der nicht verbunden ist,
ging verloren. Jetzt legt `/api/chat/send` sie in `chat_inbox` ab — **nur**
bei `delivered === 0`, **nie** bei `ephemeral`, und nur bis der Empfänger sie
abholt: `AjnaClient.onChat` leert das Postfach nach dem Abo und löscht jede
übergebene Zeile (Rückruf mit `stored: true`). Lesen und löschen darf allein
der Empfänger, nicht einmal der Absender; schreiben kann nur der Server.
Nicht Abgeholtes räumt der Cron `chat_inbox_expiry` nach `chat.inbox_days`
Tagen (Vorgabe 14) weg. Kein Mitschnitt: Was zugestellt wurde, steht
nirgends. Netz: `tests/privacy/postfach.mjs` (15 Prüfungen). Director und
Persona antworten auf wartende Nachrichten nicht — der Spieler ist längst
weiter; der Client zeigt sie mit dem Zusatz „während du weg warst".

**Sprechblasen und Chatfenster (22.10.).** Sagt eine Figur etwas, steht der
Satz einige Sekunden über ihr — in AR als Tafel an der Mastspitze
(`LabelLayer.say`), auf der Karte als Tooltip am Marker; der Toast bleibt.
Beide Ansichten hören auf das Fensterereignis `ajna:speech`, das
`MessageLogPanel` auslöst. Das Fenster ist flacher (42 % der Höhe) und
durchscheinend, der Schleier dunkelt nicht mehr ab; der Knopf heißt
„Chat (C)" und schaltet das Fenster an und aus.

### 0c · Freundesliste — *eigenes Paket, nicht jetzt*

Spieler zu einer Freundesliste hinzufügen; Freunde sind auch dann
anschreibbar, wenn sie nicht in der Nähe sind (der Transport kann es schon:
`sendChat` an ein Konto, das Postfach fängt Abwesende auf). Dazu ein
eigener schwebender Knopf mit Verwaltungsfenster: Freunde sehen und
entfernen, Einladungen sehen und annehmen oder ablehnen, Gespräch starten.
Offen zu entwerfen: Sammlung für Freundschaften (gegenseitig, mit Status
„eingeladen"/„angenommen"), wer wen finden darf (Handle? QR vor Ort?),
und wie eine Einladung den anderen erreicht (Postfach-Nachricht mit `meta`).

### 0d · Weltchat in der Umgebung — *eigenes Paket, nicht jetzt*

Nachrichten von Spielern in der eigenen Umgebung lesen, ohne Gespräch und
ohne Figur. Entschieden ist schon: ein **eigenes Thema**, ausdrücklich
öffentlich — die Regel für gerichtete Nachrichten (`chat:<konto>`) wird dafür
nicht aufgeweicht (siehe Paket 0). Offen: Reichweite (Raster der
Interest-Area oder Umkreis), ob der Weltchat ein Postfach braucht (eher
nicht: wer nicht da war, war nicht da), Drosselung, und ob Figuren dort
mitreden dürfen.

<details>
<summary>Der ursprüngliche Befund</summary>

**Gemessen am 20.10. an einer Wegwerf-Instanz.** Drei Konten: A, ein Lauscher L,
ein Sender S. L abonniert `chat:<A>`, S schreibt an A.

```
Abo auf fremdes chat-Thema: ANGENOMMEN
  MITGEHÖRT: {"from":…,"to":…,"text":"Vertraulich: mein Passwort lautet Banane."}
Empfänger bekam 1, Lauscher bekam 1
```

Realtime-Themen sind frei wählbare Zeichenketten; PocketBase prüft beim
Abonnieren nicht, ob der Name den Abonnenten etwas angeht. Der Chat-Hook kennt
die Lücke im Ansatz („Missbrauchsschutz: jeder Angemeldete darf jedem
schreiben"), aber das Mitlesen steht dort nicht — und es ist das Schwerere von
beidem.

**Die Grenze verläuft zwischen gerichtet und öffentlich.** Weltnachrichten
*dürfen* jeden erreichen, das ist ihr Zweck. Gerichtete Nachrichten — Spieler
an Spieler, Spieler an Figur — dürfen es nicht. Heute ist **alles** auf
`chat:*` gerichtet (ein Weltchat steht in `AjnaClient.js` als „später"), also
gehört `chat:*` vollständig zugemacht. Ein künftiger Weltchat bekommt ein
eigenes Thema und ist dort ausdrücklich öffentlich, statt die Regel für die
gerichteten Nachrichten aufzuweichen.

**Warum es auffiel:** Heute antwortet eine Figur aus einer festen Satzliste,
der Schaden ist begrenzt. Sobald NPCs frei formulieren und mitbekommen, was ein
Spieler ihnen erzählt hat (geplante LLM-Sonderrollen), ist derselbe Kanal etwas
anderes.

Die drei Fragen, die vor dem Bauen gemessen wurden — wirkt ein Zuweisen auf
`e.subscriptions`, wirkt ein Ablehnen, nimmt ein Ablehnen die übrigen Abos
mit — sind mit ja / ja / nein beantwortet.

</details>

### 0b · Personas: Figuren mit eigenem Konto — und später mit Sprachmodell

**Was es ist.** Wenige Sonderrollen, keine Bevölkerung: eine Figur je Prozess,
mit **eigenem Konto** (`agent_seal` vom Betreiber, `✓ @name` im Client),
eigener Figur, eigenem Manifest. Sie geht die Wege eines Spielers
(`/interact`, `/pickup`, `/chat/send`) und stößt an dieselben Wände — der
Director kommt über den Besitzer-Pfad an jeder Rechteprüfung vorbei, genau
deshalb blieb die kaputte `updateRule` ein halbes Jahr unentdeckt. Entwurf und
Entscheidungen: `personas/README.md`, `agents/persona.mjs` (Kopf).

**Entschieden (21.10.):** ein Prozess je Persona · Persona-Konfiguration in
`agent_settings` des eigenen Kontos, nie in `objects.state` (das liest jeder,
der die Figur sieht) · Schlüssel nur in der Umgebung · Interest-Area pro
Persona einstellbar, Vorgabe **an** im Modus `debug` (sonst liefe sie durch
eine leere Welt, weil der Director nur dort bevölkert) · **was ein Befund ist,
entscheidet das Modell, kein vorab geschriebenes Prädikat** — sonst entgingen
genau die Logikfehler, an die niemand gedacht hat; deterministisch ist nur das
Sammeln der Beweise (Erwartung → Beobachtung).

| Schritt | | Stand |
|---|---|---|
| 0 | Realtime-Themen absichern (Paket 0) | ✅ |
| 1 | Aktionsregister `agents/lib/actions.mjs` — Spieler-Oberfläche, Wächter, Werkzeugdefinitionen | ✅ 25 Tests |
| 2 | `agents/persona.mjs` **ohne** Modell: Konto, Figur, Manifest, ACE, Parley, Laufen, Näherung | ✅ live geprüft, 21 Tests |
| 3 | `agents/lib/llm.mjs` + Adapter Anthropic (offizielles SDK) / OpenAI-kompatibel (Ollama, vLLM — roher `fetch`), offline gegen Attrappen getestet | ✅ 34 Tests |
| 4 | Ereignisse → Bündelung → Rate-Limit → Tool-Calls → Wächter → Rückfall; Modi basic/passive/active/debug (`agents/lib/persona-llm.mjs`, Einbau in `persona.mjs`) | ✅ 19 Tests gegen Attrappen; der Einbau in `persona.mjs` ist syntaxgeprüft, der Live-Lauf steht aus (Persona läuft beim Betreiber, Neustart nötig) |
| 5 | Journal (Beweise) + Befunde (Urteil des Modells) + Gedächtnis auf Platte, `agents/data/personas/<name>/`, Export `--findings` (gruppiert, nicht gefiltert) | ✅ 9 Tests |
| 6 | Modi active/debug | offen |
| 7 | Doku | offen |
| 8 | Lehren aus dem ersten Lauf (50 Befunde, 8 Ursachen): Werkzeuge antworten beschreibend und mit dem Fehlertext des Servers, `use` nur für Angebotenes und nicht zweimal in dieselbe Wand, Befunde werden nicht doppelt geschrieben, Namen aus der Anwesenheit, ein Gruß je Besuch | ✅ 22.10., 13 Tests |
| 9 | **Welt aufräumen (vorgemerkt):** verwaiste Anwesenheiten (eine vom 31.08. steht noch) per Cron löschen; erledigte Aufträge der Figur nicht mehr als Objekt anbieten | offen |
| 10 | Gesten aus der Antwort: `say` nimmt `do` in Parley-Schreibweise (`anim:<clip>`), die Figur liest ihre Clips aus dem Modell (`lib/model-clips.mjs`, glTF und GLB), der Systemprompt nennt sie einmal, der Wächter hält sie daran — kein eingebautes `emote` | ✅ 22.10., 7 Tests |

Parley bleibt die Quelle für Verbindliches: eine als `binding: true` markierte
Regel geht wörtlich raus, ohne Modell. Das Feld gibt es seit Schritt 4
(`parley/src/doc.mjs`, erbt über `same_as`; `say()` liefert es zurück).

**Entscheidungen aus Schritt 3.** Vorgabe-Modell `claude-opus-5-5`, Denken
adaptiv (Parameter wird nicht gesendet), Tiefe `output_config.effort = low` —
eine Spielfigur muss nicht grübeln. Werkzeuge `strict`, `tool_choice` bleibt
`auto` (Erzwingen gibt auf den aktuellen Modellen 400). **Keine
Server-Fallbacks bei einer Ablehnung** (`stop_reason: refusal`): bei einer
Figur ist der richtige Rückfall Parley, den gibt es, und ein Beta-Schalter
bleibt dem Spiel erspart. Regler-Namen dürfen kein `token`/`key` enthalten
(`konfig.mjs` weigert sich) — also `llm.max_output`, nicht `max_tokens`.

### 1 · Welt-Kontext: der Ort fehlt noch

Wetter, Sonne, Mond und Tageszeit stehen (23.09., siehe `welt-kontext.md`).
Offen ist der zweite Bereichstyp: **Stadt / Bundesland / Land** über
Rückwärts-Geokodierung. Genau dort lohnt der geteilte Vorrat am meisten —
Nominatim erlaubt eine Anfrage je Sekunde, und ohne Vorrat löste jedes Gespräch
eine aus.

Braucht ein eigenes Bereichsmodell: amtliche Grenzen statt Raster. Eine Zelle
liegt irgendwann auf einer Landesgrenze, und dann sagt die Figur das falsche
Bundesland.

Dazu kleiner: Luftqualität (zweiter Open-Meteo-Endpunkt, ein Anbieter mehr) und
Abfahrten als 30-Minuten-Vorrat.

### 2 · Objekte lassen sich über ACE-Rechte nicht ändern — **behoben am 20.10.**

Es war **ein Operator**. In `objects.updateRule` stand

```
@collection.effective_permissions.object  = id    ← ALLE Zeilen müssen passen
@collection.effective_permissions.object ?= id    ← mindestens eine (richtig)
```

Ein nacktes `=` auf einer `@collection.…`-Referenz heisst in einer API-Regel
nicht „es gibt eine passende Zeile", sondern „alle Zeilen der Tabelle erfüllen
das". Die Regel traf also nur, solange `effective_permissions` praktisch leer
war. Das erklärt rückblickend auch den Einzelversuch vom 16.09., der nach dem
Löschen aller anderen ACEs einmal `200` lieferte: bei genau einer Zeile stimmt
„alle Zeilen" zufällig. Der Verdacht damals („mehrere ACE-Zeilen kippen die
Auswertung") war also richtig, nur die Ursache lag eine Ebene tiefer.

Behoben durch `pb_migrations/1792600000_update_rule_any_match.js`. Gemessen an
einer Wegwerf-Kopie: alte Regel 404, neue 200 — und **nicht durchlässig**, wer
`edit` auf Objekt A hat, bekommt auf Objekt B weiterhin 404.

**Das Unangenehme daran:** Behoben war es schon einmal. `1786800000_any_match_
rules.js` setzt alle Regeln auf `?=` und ist in der Instanz als ausgeführt
vermerkt — und trotzdem stand in der Datenbank wieder `=`, ausgerechnet nur in
dieser einen Regel (list/view/delete waren richtig, `pb_schema.json` im
Quellbaum auch). PocketBase schreibt Regeländerungen aus der
Verwaltungsoberfläche als eigene Migration, deren `down` die Falle
zurückbringt; genau so ein Artefakt ist bei der Fehlersuche am 20.10. auch
entstanden. Eine Regel, die man anklicken kann, wandert.

**Was das nächste Mal auffällt, bevor es wehtut:** `tools/acl-selftest.mjs`
hätte diesen Fehler jederzeit gefunden — es stand nur in keinem `npm test`.
Jetzt gibt es `tests/privacy/ace-schreiben.mjs` (13 Prüfungen: Nutzer-ACE,
Gruppen-ACE, Untergruppe, lat/lon, Fremdobjekt, nur-`view`, nur-`move`), und
`tools/snapshot-ajna-schema.mjs` in HeimatRadar verweigert einen Abzug, der
eine ALL-Match-Regel einfrieren würde.

Offen bleibt der Nebenbefund vom 16.09., unverändert gültig: Eine ACE für die
impliziten Audiences (`authenticated`, `everyone`) erlaubt **grundsätzlich
kein** Schreiben — auch als einzige Klausel nicht, während dieselbe
Konstruktion in der view-Regel wirkt. Das ist so gewollt (`UPDATE_RULE` kennt
die Audiences nicht), nur nirgends sonst notiert.

### 2a · `move` durchsetzen

**Heute ist `move` ein Wort ohne Wirkung** (gemessen, Prüfung in
`tests/privacy/ace-schreiben.mjs`). Es steht in `ALL_RIGHTS`, lässt sich
in jeder ACE setzen, erscheint in den effektiven Rechten — und wird nirgends
geprüft. `objects.updateRule` verlangt `edit`, auch für `lat`/`lon`. Also:

* wer `edit` hat, verschiebt auch ohne `move`;
* wer **nur** `move` hat, kann nichts (jedes Update scheitert an der Rule).

`docs/permissions.md` sagt das inzwischen offen; der Eintrag dort war vorher
eine Zusage ohne Draht.

**Warum die Trennung trotzdem gewollt ist.** Es gibt Objekte, die ein Spieler
benutzen und bewegen, aber nicht umschreiben darf: ein Schwert ablegen und
mitnehmen — ja; ihm höhere Trefferpunkte geben — nein. Heute braucht genau das
`edit`, und `edit` erlaubt jedes Feld. Für Inventar-Gegenstände ist der Bedarf
noch gering, weil deren Lebenszyklus ohne `edit` auskommt (`interact` prüft
`interact_actions`, `pickup` braucht `view` + `state.portable`, `place` den
Träger). Sichtbar wird die Lücke bei **fremdem Inventar an fester Welt**:
Wegweiser gerade ziehen, Marker einer Geokodierung korrigieren, Möbel in einem
Raumplan schieben — alles Fälle aus Paket 8.

**Entwurf**, bewusst als Hook und nicht als Regel (die Regel kann Feldmengen
nicht vergleichen):

```js
onRecordUpdateRequest((e) => {
  const { resolveEffective } = require(`${__hooks}/permissions.js`)
  const user = e.requestInfo().auth
  if (!user) return e.next()
  if (String(e.record.get("owner")) === String(user.id)) return e.next()

  const { rights } = resolveEffective(user, e.record)   // nicht (id, id)!
  if (rights.indexOf("edit") !== -1) return e.next()
  if (rights.indexOf("move") === -1) return e.next()    // Rule lehnt eh ab

  // Nur Position: alles andere gegen den gespeicherten Stand vergleichen
  const alt = $app.findRecordById("objects", e.record.id)
  const ERLAUBT = ["lat", "lon", "altitude"]
  for (const f of e.record.collection().fields) {
    if (ERLAUBT.indexOf(f.name) !== -1) continue
    if (JSON.stringify(e.record.get(f.name)) !== JSON.stringify(alt.get(f.name))) {
      return e.json(403, { error: `move erlaubt nur ${ERLAUBT.join("/")}` })
    }
  }
  return e.next()
}, "objects")
```

Der Hook allein genügt nicht: `objects.updateRule` muss `move` zusätzlich
durchlassen, sonst kommt die Anfrage nie beim Hook an — die Klausel also um
`|| CACHE('move')` erweitern, in der **`?=`-Fassung** (siehe Paket 2; genau
diese Erweiterung ist am 16.09. gescheitert, und rückblickend ist klar warum:
sie wurde in der ALL-Match-Form geschrieben und konnte nicht treffen).

Beim Umsetzen schlägt die Prüfung „move allein verschiebt (noch) NICHT" in
`tests/privacy/ace-schreiben.mjs` fehl — das ist der Wecker. Dann dort und in
`docs/permissions.md` nachziehen.

### 3 · Übergangszeit der Schlüssel-Umstellung abbauen

Die Umstellung selbst ist am 23.09.2026 gelaufen (`key-rename.md`): Schlüssel in
`objects.state`, Layer, Aufzählungswerte, Lupen-Protokoll und Figuren-Dateien
sind englisch, der Bestand ist migriert.

**Was noch offen ist, ist der Rückbau.** An acht Stellen wird vorerst BEIDES
gelesen, und `/api/quests/near` schickt jedes umbenannte Feld doppelt — weil die
Android-App ihre Web-Dateien im APK trägt (`webDir: "client"`, kein
`server.url`) und damit älter sein kann als der Server. Die Liste dieser Stellen
steht in `key-rename.md`.

Wegräumen, sobald eine neue App draußen ist. Kein Zeitdruck, aber auch nichts,
was man vergessen sollte: Doppelt gelesene Felder verstecken den nächsten
Tippfehler.

### 4 · Karma-Inflation durch Absprache

Zwei Konten können sich gegenseitig Aufträge bestätigen und Karma aus dem Nichts
erzeugen. Die **Selbst**-Bestätigung ist geschlossen, die Absprache zu zweit
nicht.

Stand September 2026: **nirgends im Repo dokumentiert** — der Punkt lebte nur in
Gesprächen. Erster Schritt ist deshalb, ihn aufzuschreiben (zu `world-objects.md`
oder einer eigenen Datei), bevor er wieder verlorengeht.

### 5 · Blitzeinschläge als Fundorte (Umwelt-Agent)

**Entschieden am 23.09.2026, Umsetzung vertagt.** Nach einem Gewitter sollen an
Einschlagstellen besondere Gegenstände oder Diamanten liegen — mit einstellbarer
Auftauch- und Verschwindezeit.

Drei Schritte, in dieser Reihenfolge:

**a) Verfall für Objekte — ERLEDIGT am 20.10.2026.** `state.expires_at` plus
`cronAdd("object_expiry", "23 * * * *")`, serverseitig und nicht im Agenten
(„Was nur tickt, solange ein Agent läuft, ist keine Regel"). Abschaltbar und
**aus in der Vorgabe**: `objects.expiry` = false, `objects.expiry_max` = 200.
Ein Objekt verfällt nur, wenn es selbst ein `expires_at` trägt — damit braucht
es keine Typ-Ausnahmen für AR-Marker und UWB-Anker. Einzelheiten samt der
Filter-Falle in `docs/betrieb.md`, Abschnitt „Aufräumen". 14 Prüfungen gegen
eine Wegwerf-Kopie, davon sieben Grenzfälle, die NICHT gelöscht werden dürfen.

**b) `agents/environment-bridge.mjs` mit Simulationsquelle** (~1 Tag). Quelle
austauschbar hinter einer schmalen Schnittstelle, `--simulate` von Anfang an —
Gewitter kommen nicht auf Zuruf, ohne Simulation ist die Mechanik an einem
sonnigen Tag nicht einmal ansehbar.

Der Agent **verdichtet**: Raster von ~200 m, ein Punkt je Cluster, Obergrenze je
km². Ein Gewitter bringt hunderte Einschläge; ein Item je Blitz wäre eine
Müllhalde.

**Ruhe-Regel statt fester Verzögerung:** Ein Fundort erscheint erst, wenn im
Umkreis von **5 km seit 1 Stunde kein Blitz** mehr gemeldet wurde. Zweck ist
Sicherheit — niemand soll in die zweite Gewitterzelle laufen. Eine feste
Verzögerung („2 h nach dem Blitz") leistet das nicht.

**Kein Einrasten auf erreichbaren Boden** (ausdrücklich entschieden). Liegt ein
Fundort im Acker, auf Gleisen oder im Privatgrundstück, kommt man eben nicht
dran. Das ist hingenommen; `findLandingSpot()` wird hier NICHT benutzt.

**c) Kommando + Kontingent im Director** (~½ Tag). Der Draht existiert bereits
(`ajna.sendAgentCommand('world-director', 'spawn', { archetype, at })`,
`world-director.mjs`, mit Absenderprüfung über `WD_COMMAND_USERS`). Zwei Dinge
passen nicht: Die Drosselung ist auf Menschen zugeschnitten (3 s Abstand,
`WD_CMD_MAX=40` insgesamt), und `on_demand`-Objekte werden bewusst **nie**
abgeräumt. Die Umweltquelle braucht daher ein eigenes Kontingent und einen
eigenen Merker statt `on_demand`.

**Datenquelle.** Eigener Blitzortung-Empfänger ist beschlossen, aber später
(System-Blue-Bausatz ~300 €; schaltet die Daten des gesamten Netzes frei,
Genauigkeit in Deutschland oft ~1 km). Bis dahin: Zugriff **auf eigene
Verantwortung**, wie beim erweiterten Adress-Modus und bei
`ais-vesselfinder.mjs`. Der Agent trägt denselben Warnkopf und dieselbe Haltung:
Rohdaten von Blitzortung.org sind ausdrücklich Stationsbetreibern vorbehalten
und nur nicht-kommerziell nutzbar — serverschonend abfragen, ehrlicher
User-Agent, keinerlei Umgehung von Sperren, nicht für öffentliche Instanzen,
und bei Blockade ist Schluss. Zweite, saubere Option ohne Hardware wäre der
**EUMETSAT MTG Lightning Imager** (kostenlos mit Konto, europaweit), aber mit
3,3–4,5 km Ortsfehler — gut für „hier zog ein Gewitter durch", zu grob für
„dieser Baum wurde getroffen".

**Abgrenzung zum Welt-Kontext** (`welt-kontext.md`, Paket 2): Wetter als
**Zustand** („es regnet, UV 7") gehört dorthin — 10-km-Zelle, 15-Minuten-Takt,
von NPCs erwähnt. Ein Blitz ist ein **Ereignis** mit Ort und Zeitpunkt, das
etwas auslöst. Beides darf derselbe Agent bedienen, aber über zwei getrennte
Ausgänge; ein Blitz in eine 10-km-Zelle gepresst wirft genau die Genauigkeit
weg, für die später der Empfänger aufgestellt wird.

---

### 6 · Teilautonomes Gerät in der echten Welt (Rover)

**Festgehalten am 09.10.2026, Umsetzung offen.** Ein kleiner Rover mit
Smartphone als GPS, Sensorplattform und Ajna-Schnittstelle, der als Spielobjekt
auf einem **gesicherten Gelände** fährt. Für eine Vorführung der stärkste
denkbare Beleg dafür, wofür Ajna gebaut ist: Die Grenze zwischen Spielwelt und
Wirklichkeit ist der Punkt, an dem es interessant wird.

**Öffentliche Sicherheit wird ausdrücklich NICHT systemseitig garantiert**
(Zusammenstöße mit Fahrzeugen, Personenschutz). Das Gerät fährt auf
abgestecktem Gelände unter Aufsicht. Diese Entscheidung macht das Vorhaben
überhaupt erst klein — ohne sie wäre es ein anderes Projekt.

**a) Stufe 0 ist gebaut (09.10.2026).** `npm run robot` betreibt einen Rover
mit Simulationstreiber: Agent, Navigation, Spielaktionen und Ajna-Objekt sind
echt, nur die Räder nicht. Live geprüft — auf `goto` dreht er auf die richtige
Peilung, fährt mit 1 m/s, bremst ab vier Metern ab und hält innerhalb der
Toleranz. Der Kern liegt in `agents/lib/robot.mjs` (ohne DOM und Capacitor,
läuft also headless unter Node), der Vertrag für eigene Antriebe in
`agents/lib/robot-driver.mjs`.

Ursprünglich so geplant und weiterhin gültig: Ein Agent
veröffentlicht das **Telefon in der Hosentasche** als Objekt vom Typ `rover`,
mit Aktionen „hierher kommen" und „Bericht" sowie `max_distance: 30`. Damit
lässt sich die ganze Interaktion durchspielen — Rechte, Reichweite, Dialog,
Auftragsanbindung —, bevor eine Schraube gekauft ist. Fühlt es sich gut an,
lohnt die Hardware; fühlt es sich nicht gut an, war die Erkenntnis umsonst zu
haben. **Diese Stufe ist auch dann nützlich, wenn nie ein Rover gebaut wird.**

**b) Drei Schichten, und die Reihenfolge ist nicht verhandelbar.**

```
Ajna-Server      Objekt, Rechte, Weltdaten, Aufträge
     │  (Sekunden, Internet)
Telefon          Ajna-Agent: Wegpunkte abfahren, Position melden
     │  (Millisekunden, BLE)
Mikrocontroller  Motoren, Odometrie — UND DIE NOTBREMSE
```

Die unterste Schicht muss **ohne die oberen auskommen**. Ein Totmannschalter in
der Firmware: kommt 300 ms kein frisches Kommando vom Telefon, bleibt der Rover
stehen. Das gilt bei Funkloch, bei App-Absturz, bei einem Fehler in der
Spiellogik und bei einem abgestürzten PocketBase. Dazu ein Bumper-Schalter und
ein physischer Not-Aus, der die Motorversorgung trennt — **nicht über
Software**. Die Notbremse darf dumm sein; sie muss nur unter allem liegen.

**c) Der Agent läuft als Betriebsart der Ajna-App**, nicht als Node-Prozess in
Termux — Android räumt das weg. Der Client ist ohnehin JavaScript, der
Capacitor-Wrapper mit Vordergrunddienst steht auf dem Plan
(`ajna-mobile-background`), und BLE sprechen wir für Zauberstab und UWB
bereits. Damit zahlt die Mobil-Arbeit diesen Teil gleich mit.

**Was dafür schon steht** — der eigentliche Grund, warum das machbar ist:

| Braucht | Gibt es als |
|---|---|
| Gerät als Spielobjekt, Befehle zurück | `ajna.subscribeInteract(objId, cb)` — durchgestochen im HomeAssistant-Gateway, beide Richtungen gegen echte Hardware |
| Flüssige Position trotz seltener Meldungen | `state.motion` → `client/core/PositionSmoother.js` |
| Wer darf steuern | ACE-Rechte mit `interact_actions` |
| Nur aus der Nähe | `max_distance` an der Aktion (`client/core/aktionsReichweite.js`) |
| Bewegungspläne im Figuren-Format | `agents/lib/bewegung.mjs` |

Letzteres ist der elegante Teil: Hält sich der Rover an dasselbe
`state.motion`-Format wie die Figuren des World-Directors, zeichnet der Client
ihn **genau wie eine Figur** — eine Mechanik für Virtuelles und Echtes.

**d) Die zwei harten Stellen.**

**Position.** Handy-GPS liegt 3–5 m daneben, zwischen Gebäuden schlechter; ein
Rover, der sich um vier Meter irrt, fährt in die Hecke. Auf einem gesicherten
Gelände ist die Antwort **UWB** — Zentimeter statt Meter, und die Kern-Pipeline
steht bereits (`docs/uwb.md`). RTK-GPS (ab ~200 € je Empfänger plus
Korrekturdaten) erst, wenn das Gelände größer wird als die Ankerreichweite.

**Blickrichtung.** Die unterschätzte Hälfte: GPS liefert einen Kurs nur in
Fahrt, und ein Magnetometer neben Motoren lügt. Praktikabel sind **zwei
UWB-Tags** am Rover (vorne/hinten) — Richtung direkt aus der vorhandenen
Multilateration, ohne neue Mathematik.

**e) Wegpunkte, nicht Joystick.** Die Schreibtakte (500 ms beim Director, 5 s
bei den Flotten) sind für Teleoperation zu langsam, für Zielvorgaben völlig
ausreichend. Der Spieler sagt „fahr zum Brunnen", der Rover plant und fährt
selbst. Das ist nicht nur die technisch ehrliche Lösung, sondern das bessere
Spiel: Der Rover wirkt wie eine Figur mit eigenem Willen statt wie ein
Modellauto — und passt damit zu dem, was unter NPC-Lebendigkeit ohnehin
vorgesehen ist.

Anschluss an den Rest ohne neue Mechanik: Parley gibt ihm eine Stimme („ich
stehe vor einem Zaun"), `carried_by` lässt ihn Beute transportieren, und die
Kamera speist Fotos in die Auftrags-Nachweise (`quest_proofs`). Der Rover als
Bote, Kundschafter und Auftraggeber.

**f) Hardware, rund 150–350 €.**

| | |
|---|---|
| Fahrgestell aus gebrauchtem Hoverboard | 30–80 € — Nabenmotoren, Räder, Akku |
| …oder RC-Auto 1:10 | 80–150 € |
| ESP32 + Motortreiber | ~20 € |
| Altes Android-Telefon | 0–100 € |
| Akku, Halterung, Kleinkram | 40–80 € |

Das Hoverboard ist der Geheimtipp: gebraucht spottbillig, und die Motoren
tragen auch auf Wiese und Schotter. **Kleine Räder sterben im Gras** — der
häufigste Grund, warum solche Projekte im Rasen liegenbleiben.

**Firmware für das Hoverboard.** Es gibt kein empfehlenswertes *Modell* —
Hoverboards sind namenlose Ware, bei der zählt, welches Mainboard verbaut ist,
und das sieht man erst nach dem Öffnen. Zwei Wege:

* **`hoverboard-firmware-hack-FOC`** (Emanuel Feru, GPL) ist der Standard der
  Szene: feldorientierte Regelung, leiser und drehmomentstärker bei niedriger
  Drehzahl als die ältere Fassung von Niklas Fauth, aus der sie hervorging.
  Zielt auf Mainboards mit **STM32F103** (GD32-Nachbauten laufen meist auch).
  Die Variante `VARIANT_USART` bietet genau das, was hier gebraucht wird: ein
  schlichtes serielles Protokoll für Tempo und Lenkung, das ein ESP32 bedient.
  Zum Flashen genügt ein ST-Link-V2-Nachbau (~3 €) an den SWD-Pads; die Boards
  sind oft auslesegeschützt und müssen zuerst entsperrt werden.
  **Kaufrat:** defekte Hoverboards „Akku tot" für 20–40 € nehmen, Motoren und
  Board sind in der Regel heil. Mehrere kaufen ist billiger als das falsche.
* **Weniger Überraschungen, mehr Geld: Hoverboard-Motoren an einem VESC.** Die
  Nabenmotoren sind gewöhnliche BLDC mit Hall-Sensoren. Ein VESC (Benjamin
  Vedder, offen) kostet je nach Nachbau 50–120 €, man braucht zwei oder einen
  Doppel-VESC. Dafür entfällt das Raten über das Mainboard, und es gibt eine
  saubere UART/CAN-Schnittstelle samt großer Gemeinde.

Für eine Vorführung, bei der die Software im Mittelpunkt steht, ist der VESC
das ruhigere Nervenkostüm; für den Bastelspaß und das kleinste Budget die
FOC-Firmware.

**h) Der Antriebs-Treiber ist austauschbar.** Die App führt einen
**Agenten-Kern** aus — nicht die Hardware-Anbindung. Darunter sitzt je
Plattform ein Treiber:

```
Ajna-Objekt  <->  Agenten-Kern         (einmal, für alle Plattformen)
                  Wegpunkte, Spielaktionen, Telemetrie, Totmann-Takt
                       |   fahre({ v, omega })   halt()
                       |   zustand()        -> Odometrie, Akku, Fehler
                       |   faehigkeiten()
                  Antriebs-Treiber      (Hoverboard | Hexapod | …)
```

**Der Schnitt liegt bei Geschwindigkeit und Drehrate**, nicht bei Motoren und
nicht bei Wegpunkten. Dieselbe Grenze zieht ROS seit Jahren als `cmd_vel`, und
sie hat sich quer über Räder, Ketten und Beine bewährt: Der Kern rechnet „zum
Brunnen" in „vorwärts 0,8 m/s, Drehrate 0,2 rad/s" um, der Treiber macht daraus
zwei Raddrehzahlen oder einen Gangzyklus. **Die Gangart ist Sache des Hexapods,
nicht des Spiels.**

Zwei Pflichten hat der Treiber zusätzlich:

* **Fähigkeiten melden.** Ein Hexapod kann sich hinsetzen und über eine Stufe
  steigen, ein Hoverboard nicht. Daraus leitet der Kern sogar die **Aktionen am
  Ajna-Objekt** ab — ohne dass die Spiellogik die Plattformen kennt.
* **Den Totmann-Takt bedienen.** Die Notbremse bleibt in der Firmware, egal
  welcher Treiber. Der Treiber verpflichtet sich nur auf das Lebenszeichen, und
  `halt()` ist das eine, was immer funktionieren muss.

Hält sich der Kern von DOM und Capacitor fern und bekommt `ajna` und `treiber`
hereingereicht, läuft derselbe Code später auch unter Node auf einem Raspberry
Pi — falls eine Plattform ohne Telefon auskommt. Das kostet jetzt nichts und
spart später den Neubau.

Der Agent ist zugleich eines der Funktionsmodule aus Paket 7.

**g) Drohne: später und von jemand anderem verantwortet.** Nicht wegen der
Technik, wegen der Vorschriften. Nach EU-VO 2019/947 braucht jede Drohne mit
Kamera eine Betreiberregistrierung, und **autonomer Wegpunktflug fällt nicht in
die offene Kategorie** — dort muss ein Fernpilot auf Sicht jederzeit eingreifen
können. Eingezäuntes Privatgelände ändert daran weniger, als man hofft. Dazu:
Ein Absturz kostet die Drohne, ein umgefahrener Rover eine Schramme. Wer das
angeht, braucht jemanden, der den Flugbetrieb verantwortet — nicht einen
Seitenzweig dieses Pakets.

---

### 7 · Zusatzfunktionen als Module (Stufen 2–4)

**Stufe 1 ist erledigt (09.10.2026):** „Geräte" und „Debug" liegen hinter einem
Schalter in den Einstellungen, Vorgabe aus (`client/core/advancedMode.js`). Das
löst das gemeldete Problem — neue Nutzer sehen nicht mehr „UWB-Ortung" und
„Zauberstab", bevor sie die Karte gesehen haben.

**Was „Plugin" NICHT heissen soll.** Keine Registry für Dritte, keine
versionierte Erweiterungsschnittstelle, nichts Nachinstallierbares. Das wäre
ein eigenes Projekt und löst ein Problem, das wir nicht haben. Gewollt sind
**Funktionsmodule mit einem Schalter** — mehr nicht.

Drei Ebenen stecken dahinter, und nur die erste ist erledigt:

| | Löst | Stand |
|---|---|---|
| Menüpunkte verstecken | Verwirrung | **fertig** |
| Code nicht laden | Startzeit, Speicher | offen |
| Berechtigungen nicht anfragen | Vertrauen beim Installieren | offen |

**Die dritte Ebene wird übersehen.** Das Manifest fordert heute 14
Berechtigungen, darunter `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, `RECORD_AUDIO`,
`CAMERA`, `ACCESS_FINE_LOCATION`. Ein verstecktes Menü ändert daran nichts: Die
Laufzeit-Abfrage bleibt zwar aus, solange der Code nicht läuft, aber im
Store-Eintrag steht weiterhin „Bluetooth, Mikrofon, Kamera". Für eine Geo-App
ist das der Moment, in dem jemand abbricht. Dagegen hilft nur eine zweite
Build-Variante, kein Schalter zur Laufzeit.

**Stufe 2 — `AccessoryHub` entflechten (~1 Tag).** Der eigentliche Aufwand,
gemessen am 09.10.2026:

```
Zugriffe auf uwb/wand:  MobileShell.js  50
                        map.js           9
                        main.js          6
                        EditorUI.js      6
                        … insgesamt ~90 Stellen
```

Und der Hub baut heute alles beim Start und verdrahtet es sofort:

```js
const positionSource = new FusedPositionSource(gps, uwb.roleSource('viewer'))
```

Die Positionsquelle bekommt UWB **im Konstruktor**. Ohne UWB muss sie trotzdem
laufen und das Gerät später annehmen können — das ist der Umbau. Nicht die
Schalter sind die Arbeit.

**Stufe 3 — dynamische Importe (~½ Tag).** Erst danach schrumpft das Bundle.
Ein Modul beschreibt sich selbst:

```js
{ key: 'uwb', label: 'UWB-Ortung', braucht: ['bluetooth'],
  abschnitt: () => import('./features/uwb.js') }
```

Die ausgelagerten `_renderGeraeteSektion()` / `_renderDebugSektion()` aus Stufe
1 sind bereits die Form, in der ein Modul seinen Abschnitt beisteuert.

**Stufe 4 — Build-Varianten.** Gradle product flavours: `basic` ohne BLE und
Mikrofon im Manifest, `full` mit. Erst das löst die Berechtigungsfrage
wirklich.

**Reihenfolge ist nicht beliebig.** Stufe 3 ohne Stufe 2 geht nicht (der Hub
baut alles eifrig), Stufe 4 ohne Stufe 3 bringt wenig (der Code läge ja
trotzdem bei). Jede Stufe ist aber für sich nützlich und darf liegenbleiben.

**Der Roboter-Agent (Paket 6) ist die Probe aufs Exempel.** Er entstünde von
Anfang an als Modul — und ist damit der erste ehrliche Test, ob der Mechanismus
taugt oder ob er nur für die zwei Dinge passt, für die er gebaut wurde.

---

### 8 · Raumpläne als Spielobjekte

**Entschieden am 19.10.2026.** Nutzer sollen Pläne ihrer Räume einbinden, um
IoT-Geräte und UWB-Anker präzise zu platzieren. Pläne sind **Spielobjekte** und
hängen damit am bestehenden Rechtesystem — nicht jeder Spieler sieht jeden Plan.

**Nicht in AR platzieren.** Dafür bräuchte es eine Lokalisierung, die in den
meisten Fällen nicht vorliegt; Platzieren in AR wäre Scheingenauigkeit. Der Ort
ist der **Free-Roam-3D-Modus mit vorhandenem Gebäudemodell**.

**Drei Formate, zwei Stufen.** Raster und SVG sind die Vorlage, GeoJSON das
Ergebnis: niemand hat GeoJSON seiner Wohnung, aber fast jeder ein Foto des
Grundrisses. Also hochladen → grob georeferenzieren → Räume nachzeichnen.
SVG wird **als reines Bild** eingebunden, nie inline — SVG kann Skripte
tragen, und von eigener Herkunft ausgeliefert wäre das XSS mit Token in
Reichweite.

GeoJSON ist das einzige **semantische** Format: ein Rasterplan ist Pixel, da
kann man nichts fragen. Mit benannten Flächen wird „Gerät in der Küche" ein
Punkt-in-Polygon-Test statt einer Schätzung. Eigenschaftsnamen nach
[Simple Indoor Tagging](https://wiki.openstreetmap.org/wiki/Simple_Indoor_Tagging)
(`level`, `indoor=room|corridor|area`), damit der Inhaltsfilter darauf greifen
kann wie auf andere Quellen und ein Export nach OSM möglich bleibt.

**Drei Dinge, die vorher festgelegt sein müssen:**

1. **`rotation`/`scale` gelten für Raster und SVG — für GeoJSON NICHT.** Ein
   Bild muss platziert werden, dafür sind die Felder da (`rotation` ist Euler in
   Radiant, `scale` ein Multiplikator, beide wendet `GameObject` auf den
   Babylon-Root an). GeoJSON trägt seine Koordinaten schon; eine Drehung
   obendrauf drehte den Plan ein zweites Mal. Das gehört **erzwungen**, nicht
   dokumentiert. Und die Nordabweichung muss durch `client/core/yaw.js` —
   wegen `invertNorthSouth` ist die naive Formel falsch-händig, siehe den
   Flieger-Fix.
2. **Die Geometrie gehört in ein DATEIFELD, nicht in `state`.** `state` reist
   bei jeder Aktualisierung über Realtime an alle Clients in Reichweite; das
   grösste `state` im Bestand ist 890 Byte, ein Grundriss sind Kilobyte. In
   `state` bleibt nur, was zum Filtern nötig ist: Etage, Format, Bounding-Box,
   Ursprung. Das Dateifeld wird `protected` (wie `quest_proofs.images` seit
   19.10.), der Abruf läuft über den Datei-Token.
3. **Lokale Meter, nicht Grad.** 1e-7 ° sind 1,1 cm — man bräuchte sieben
   Dezimalstellen, und jede Rundung im Weg zerstört das. Schlimmer: in Koblenz
   ist ein Längengrad ~71 km, ein Breitengrad ~111 km, der Maßstab in
   Gradkoordinaten also um Faktor 1,56 anisotrop — ein quadratisches Zimmer ist
   kein Quadrat. Richtig ist ein lokaler Meterrahmen relativ zum Ursprung des
   Planobjekts, Umrechnung nach WGS84 nur für die Anzeige. Der
   Anker→Welt-Transform des UWB-Systems ist genau so ein Rahmen.

**Aufwand**, geschätzt: Datenmodell 1,5 T · Raster/SVG platzieren 1,5 T ·
GeoJSON in Leaflet und Babylon 1,5 T · **Zeichen-Editor 3–4 T** · Etagen und
Inhaltsfilter 1–2 T · Anker setzen im Free-Roam-3D 2–3 T · Tests und Doku 25 %
obendrauf. Brauchbare erste Fassung **~4 Tage** (platzieren + anzeigen,
Geometrie kommt von aussen), vollständig **13–16 Tage**. Wer anfangs GeoJSON
aus JOSM oder QGIS importiert, spart den Editor und ist bei ~7 Tagen.

**Die Kartenbibliothek ist dafür NICHT die Frage** — siehe Paket 15.

---

## Kleiner, wartet auf eine Entscheidung

### Der Director adoptiert Objekte, die ihm nicht mehr gehören

Beim Start sammelt er alles mit `state.director = true` ein — auch Beute, die
ein Spieler eingesammelt hat (`/pickup` überträgt den Besitz). Für die
schlägt dann jedes Schreiben fehl: `ACE für … fehlgeschlagen`,
`state.actions … wasn't found`, bei jedem Start, 11 Zeilen am 21.10. Harmlos,
aber Rauschen — und die Stücke zählen zum Soll-Bestand, obwohl sie die Welt
verlassen haben. Beim Adoptieren nach `owner === eigenes Konto` filtern; dann
spawnt der Director Ersatz, was richtig ist.

### 9 · Kommentar-Bestand übersetzen

Neue Kommentare sind englisch (`CLAUDE.md`), der Bestand ist deutsch: 10.790 von
17.577 Kommentarzeilen, gemessen am 22.09.2026. **Der größte Block der ganzen
Sprachumstellung** — und der heikelste, weil diese Kommentare durchgehend das
*Warum* tragen („WARUM DAS NICHT BEI JEDEM START PASSIERT: …"). Maschinell
übersetzt verlieren sie genau das.

Vorgemerkt auf Wunsch des Owners. Sinnvoll in Dateigruppen statt am Stück, und
am besten dort zuerst, wo ohnehin gearbeitet wird.

### 10 · ADS-B und AIS auf `lib/fleet.mjs` umstellen

Die C-ITS-Brücke benutzt die gemeinsame Flotten-Bibliothek; `adsb-bridge` und
`ais-bridge` tragen ihre eigene Kopie derselben hundert Zeilen weiter. Das ist
kein Notstand — die Kopien laufen —, aber jede Korrektur an einer Falle muss
heute dreimal gemacht werden.

Nacheinander umstellen, nicht auf einen Schlag: Beide sind live im Einsatz, und
der Nutzen ist Aufräumen, nicht Funktion. `ais-bridge` zuerst, sie ist der
WebSocket-Fall und damit am nächsten an der Vorlage.

**Nicht zusammenlegen.** Drei Prozesse bleiben drei Prozesse: eigene
Zugangsdaten, eigenes Kontingent, eigenes Konto, eigenes Manifest — und ein
Parser-Fehler in einer Quelle darf die anderen beiden nicht mitreissen. Die
Wiederholung war das Problem, nicht die Trennung.

### 11 · `npm audit`: sechs Schwachstellen im Bestand

Beim Hinzufügen von `markdown-it` aufgefallen, **nicht davon verursacht** (das
Paket taucht in keinem Pfad auf): 1 niedrig, 2 mittel, 3 hoch. Der Großteil sind
Werkzeugkette und Umgebung — `browserslist`, `brace-expansion`, `ajv`, `lodash`
über Webpack und Babylon.

Zwei betreffen aber Laufzeit-Abhängigkeiten und verdienen einen Blick:
`body-parser` (Express) und `@xmldom/xmldom`. Erst nachsehen, über welchen Pfad
sie hereinkommen und ob ein `npm audit fix` ohne Bruch durchgeht — blind
aktualisieren heißt hier, die Bündel neu zu bauen und zu hoffen.

### 12 · Telefonbuch-Parser gegen die echte Seite prüfen

Bisher nur gegen erfundenes Markup getestet. Vor einem echten Einsatz des Modus
`erweitert` nötig. Der Parser hängt an `nasort`-Attributen — jedes Redesign der
Seite bricht ihn.

### 13 · Weitere Lupen für weitere Spieler

**Entschieden:** Die Lupe wechselt den Besitzer. Sie ist `portable`, und
Aufnehmen überträgt in Ajna den Besitz („Loot: Eigentum übergeht auf den
Sammler"). Wer sie hat, darf sie auch verschieben; die ACE am Objekt
(`authenticated`: view+move, Aktionen lookup/examine) überlebt den Wechsel, also
können andere sie weiter benutzen.

**Die Folge, die noch offen ist:** Es gibt genau EINE. Wer sie im Inventar
behält, hat sie allen anderen weggenommen. Vorgemerkt ist deshalb, dass der
Agent auf Anfrage **weitere Lupen** erzeugt — und der anfragende Spieler
zugleich das Recht bekommt, seine zu benutzen.

Zu klären, wenn es soweit ist: Auslöser (Kommando? Aktion an einer vorhandenen
Lupe?), Obergrenze je Spieler, und was mit herrenlosen Lupen geschieht.

### 14 · Wo soll die Adress-Lupe liegen?

Steht derzeit auf **Moselring 11, 56073 Koblenz** (50.356717, 7.588443) — dorthin
verschoben, damit der erste Test etwas zeigt; an der ursprünglichen
Vorgabe-Koordinate lag im 25-m-Umkreis keine einzige Adresse. Ein bewusster Ort
ist das noch nicht. `ADR_START_LAT/LON` wirken nur beim Erzeugen, das vorhandene
Objekt lässt sich jederzeit verschieben.

### 15 · Leaflet, Vektorkacheln oder MapLibre?

**Geprüft am 19.10.2026, zurückgestellt.** Der Anlass war scharfes Zoomen für
Innenräume. Zwei Befunde:

* **Das Schärfeproblem ist echt und messbar:** `maxNativeZoom: 19` bei
  `maxZoom: 22` — die Stufen 20 bis 22 sind hochskalierte Pixel. Die
  CARTO-Ebene hat schon 20, OSM nur 19. **Vorher billiger prüfen, ob ein
  Wechsel der Rasterquelle genügt** — das kostet nichts.
* **Vektorkacheln bringen KEINE Innenräume.** Weder Protomaps noch
  OpenMapTiles führen Innenraumdaten; OpenMapTiles schliesst „indoor features"
  ausdrücklich aus. Die Innenraum-Frage ist damit Paket 8, nicht diese.

**Gegen `maplibre-gl-leaflet`:** Die Brücke schaltet MapLibre nicht-interaktiv,
Leaflet nimmt die Eingaben. Laut README keine Rotation, kein Bearing, kein
Pitch, plus Verzögerung. Man zahlt 259 KB gzip (gemessen; Leaflet 44 KB) und
bekommt nur Schärfe. Als Zwischenschritt zu einem späteren Umstieg taugt es
nicht — der nicht-interaktive Modus ist gerade nicht die Zielfassung.

**Zwei Kontexte sind erlaubt, aber nicht gratis.** Das Browser-Limit liegt bei
rund acht WebGL-Kontexten. Aber: alle Ansichten liegen in EINEM Dokument
(`index.html`, umgeschaltet per `display`), und `display:none` beendet keinen
Kontext — eingeschaltete Vektorkacheln heissen zweiter Kontext neben Babylon,
unabhängig vom aktiven Tab. Abhilfe wäre, MapLibre erst beim Einschalten zu
erzeugen und beim Tabwechsel `map.remove()` zu rufen.

**Das Pixi-Rezept aus der Babylon-Doku ist NICHT übertragbar.** Es teilt EINEN
Kontext (Pixi bekommt `engine._gl` und Babylons Canvas übergeben). MapLibre
besitzt seinen Kontext; die Teilung läuft umgekehrt (deck.gl und luma.gl hängen
sich an MapLibres Canvas). Einen fremden Kontext hineinzugeben gibt es nicht.

**Was für MapLibre spricht, falls die Frage wiederkommt:** `transformRequest`
hängt jedem Request Header an (Token für geschützte Pläne — Leaflets
`imageOverlay` ist ein `<img>` und kann das nicht), `ImageSource` georeferenziert
über vier Ecken (Leaflet-Kern kann nur achsparallel, rotierte Pläne brauchen ein
Drittanbieter-Plugin), und Bearing — was `Minimap.js` im Kopfkommentar
ausdrücklich als in Leaflet 1.x unmöglich notiert.

### 16 · Interoperabilität mit OpenARCloud (GeoPose, OpenVPS, OSCP)

**Recherchiert am 19.10.2026, Entscheidung offen.** Vier Bausteine, drei
verschiedene Antworten:

**GeoPose 1.0 — ERLEDIGT am 19.10.2026**, `client/core/geopose.js` (39 Tests).
Verabschiedete OGC-Norm (21-056r11), gebaut gegen die veröffentlichten
JSON-Schemata: Basic-YPR und Basic-Quaternion, Winkel in Grad, Drehungen um
z, y, x. Liegt in `client/core/`, weil Agents von dort schon neun Module
beziehen und der Server keines.

Zwei Fallen waren echt, und beide sind jetzt an einer Stelle festgenagelt:

* **Die Achsen.** GeoPose ist ENU mit Ost→X, **Nord→Y, Hoch→Z**; die Szene ist
  Ost→X, **Hoch→Y, Nord→−Z**. Die Abbildung ist eine Drehung um +90° um X,
  Determinante +1 — eine Spiegelung hätte jede Drehung verkehrt herausgegeben,
  und das fällt erst auf, wenn ein Modell eine Vorderseite hat. Ein Test rechnet
  die Determinante nach.
* **GeoPose-Yaw ist kein Kompasskurs.** Die Vorwärtsachse des inneren Rahmens
  ist +X, Yaw läuft gegen den Uhrzeigersinn: `yaw = 90° − kurs`, selbstinvers.
  Dieselbe Verwechslung, die `yaw.js` schon als `h − π/2` gegen `π − h` kennt.

Geprüft wird nicht gegen die eigene Rechnung, sondern gegen die geometrischen
Zusicherungen aus `yaw.js` (`richtungFuerKurs`, `blickFuerYaw`) — gegen sich
selbst wäre es rund und falsch.

**Zwei Dinge rät das Modul bewusst NICHT.** Es übernimmt `rotation.x`/`.z`
nicht (was sie in GeoPose-Begriffen heissen, hängt vom Modell ab — dieselbe
Trennlinie wie in `yaw.js`), und es erfindet keine Höhe: Ajnas `altitude` ist
Meter über Grund, GeoPose `h` ist ellipsoidisch. Ohne Geländehöhe bleibt `h`
auf 0 und `heightKnown` false. Dabei hat ein Test den Fehler gefangen, der in
`kvm.mjs` schon einmal zugeschlagen hat: **`Number(null)` ist 0**, also war
`Number.isFinite(Number(null))` wahr und eine fehlende Geländehöhe galt als
Meereshöhe 0.

**Offen geblieben:** dass die Vorwärtsachse +X ist, ist eine FOLGERUNG aus
„Pitch um y, Roll um x" — der Normtext war nicht am Stück lesbar (eingebettete
Bilder in der HTML-Fassung, PDF braucht poppler). Ergibt die
[OGC-Konformitätssuite](https://cite.opengeospatial.org/te2/about/geopose10/1.0/site/)
etwas anderes, ändert sich genau eine Funktion: `headingToYaw()`.

**OpenXR — nichts zu tun, und das ist die gute Nachricht.** Ajna ist ein
Browser-Client und spricht **WebXR** (W3C); OpenXR ist die native Schnittstelle,
die eine Browser-WebXR-Umsetzung darunter benutzt. Aus einer Seite ist OpenXR
nicht aufrufbar, und das ist richtig so — die Trennung ist gewollt. Relevant
würde es erst bei einem NATIVEN Client: Babylon Native hat eine
OpenXR-gestützte WebXR-Umsetzung (bisher für HoloLens), die Tür steht also
offen, ist aber ein eigenes Projekt.

Und das, was man sich von OpenXR erhoffen würde, liefert es gerade nicht:
`XR_EXT_spatial_entity`, `XR_EXT_spatial_anchor` und `XR_EXT_spatial_persistence`
gibt es, aber **nichts Geospatiales** — Anker sind gerätelokal, Persistenz ist
auf „gleiches Gerät, gleicher Nutzer, gleiche App" begrenzt. Genau diese Lücke
füllen GeoPose und OpenARCloud. Ajna nutzt mit `immersive-ar` und dem
`unbounded`-Bezugsraum schon die richtige Wahl für eine weltweite Anwendung.

**OpenVPS — Protokoll unterstützen, Dienst aufschieben.** Selbst hostbarer
visueller Positionierungsdienst (MapBuilder, MapAligner, MapLocalizer, HLOC),
von Nokia Bell Labs unter NGI Search gebaut, aktiv (Stand Oktober 2026). Er
löst genau das, was dem SLAM-Spike fehlte: eine Lage aus einem Kamerabild,
**ohne IMU** — und Brave sowie der WebView blockieren Sensoren. Aber: er
braucht je Ort eine aus vielen Bildern gebaute Karte, ist ein Dienstverbund mit
FusionAuth und realistisch eine eigene Maschine mit GPU. Auf der 2-GB-VM
ausgeschlossen (dort passen sechs Agents). Dazu ein Mismatch, der Ajna
besonders trifft: die Kartenhöhe ist laut Repo „über Grund" statt echte Höhe,
und Ajna nimmt Höhe ernst (Geländeabtastung, `findLandingSpot`).
→ Über GeoPose und das OSCP-GeoPose-Protokoll anschlussfähig bleiben, den
Dienst später und auf eigener Hardware.

**OSCP Spatial Service / Content Discovery — passt auf den eigenen Fahrplan,
aber nicht jetzt.** SSD beantwortet „welche Dienste deckt dieses Gebiet ab?",
SCD „welche Inhalte hängen hier?". Das ist dieselbe Frage wie beim
Multi-Server-Konzept, wo der Nutzer heute Server-Adressen eintippt, und
überlappt mit `agent_manifests`. MIT-lizenziertes TypeScript, Sandbox-Instanzen,
aktiv (ISMAR2026-Stand September 2026). **Aber es ist ein öffentliches
Register** — eine Ajna-Instanz dort anzumelden ist eine Preisgabe-Entscheidung,
und die Instanz ist in der Testphase ohne öffentliche Zugriffe. Also: die
Manifest- und Multi-Server-Arbeit so formen, dass ein Adapter möglich bleibt;
nicht anmelden.

**SpatialDDS 1.7 — beobachten.** Sehr neu (August 2026). DDS ist schweres
Echtzeit-Pub/Sub; Ajna hat PocketBase-Realtime über SSE, ein Austausch oder
eine Brücke ist ein grosser Schritt für unklaren Gewinn. **Eine Verbindung ist
aber bemerkenswert:** ROS 2 spricht DDS — für Paket 6 (Rover) könnte das
später der natürliche Weg nach draussen sein.

---

## Älteres, vor dem Anfassen abzugleichen

Aus früheren Sitzungen, in dieser nicht verifiziert:

* Der **Movebank-Agent** läuft nicht.
* Die **UI-Text-Bereinigung** ist nur teilweise erledigt (nur knapp sagen, WAS
  ein Element tut — keine Code-Begründungen).

---

## Entschieden und verworfen

Damit es nicht zweimal gedacht wird:

* **Ajna als MCP-Server** — passt nicht für NPCs (client-getrieben, keine
  Sitzung = keine Antwort), und es fehlen widerrufbare Zugangsschlüssel. Details
  und die Recherche zum Server-Bestand in `mcp-anbindung-notiz.md`.
* **`world_context` als Collection** — erst fällig, wenn ein *Client* die Daten
  anzeigen soll. Für Agents genügt die Bibliothek: `Quellcache` teilt seine
  Dateien bereits über den Quellnamen, also auch zwischen Prozessen.
* **Lesezugriff „hat diese Instanz Mailversand?"** — von der HeimatRadar-Seite
  ausdrücklich abbestellt, sie prüfen SMTP beim Ausrollen.

---

## Erledigt (jüngste zuerst)

* **Speicher auf einer kleinen Maschine** (19.10.) — der 2-GB-Server hat
  mehrfach PocketBase verloren und hing dann, bis er neu startete. Gemessen
  statt geraten, und zwei Vermutungen dabei verworfen:

  * **`--hooksPool` ist nicht der Punkt.** Die Vorgabe 15 klingt nach viel,
    kostet aber gegenüber 1 ganze **4 MB** (52,4 → 56,3 MB) — goja compiliert
    faul, füllt den Pool nicht vor. Hook-Nebenläufigkeit dafür zu opfern wäre
    ein schlechtes Geschäft. PocketBase liegt stabil bei 66–71 MB und ist
    nicht der Verbraucher.
  * **Der System-CA-Re-Exec ist nicht teuer.** Die Agents starten sich für
    `--use-system-ca` selbst neu, der Elternprozess bleibt in `spawnSync`
    stehen — aber Windows lagert ihn auf 2–3 MB aus, nicht auf 40. Der
    Doppelstart entfällt jetzt trotzdem (`NODE_OPTIONS` wird erkannt,
    `agent-wrapped.sh` gibt das Flag direkt mit); er war nur nie das Problem.

  Gefunden wurde zweierlei. **Der `graphCache` im world-director kannte nur
  `set`** — die TTL entschied, ob ein Eintrag benutzt wird, entfernt hat sie
  nie etwas. 45 Zellen in 20 Minuten, rund 1 MB je Wegegraph (1600–2300 Knoten,
  ~500 Byte je Knoten), für die Lebensdauer des Prozesses. Dafür gibt es jetzt
  `agents/lib/bounded-cache.mjs`: **eine TTL ist kein Budget** — sie begrenzt,
  wie *alt* ein Eintrag sein darf, nicht wie *viele* es sind, und wandernde
  Spieler erzeugen Zellen schneller als alte verfallen. Nur eine harte Zahl
  ergibt eine Obergrenze, mit der man rechnen kann. Verdrängt wird der am
  längsten *unbenutzte*, nicht der älteste, damit die Heimatzelle einen Ausflug
  übersteht. 21 Tests.

  **Und der Rest war nirgends begrenzt.** `--max-old-space-size` allein
  genügt nicht: es deckelt nur den alten Bereich, die junge Fläche legt V8 dazu.
  Gemessen mit Node 25.8 — ohne Flags 4288 MB Grenze, mit `=96` noch **288 MB**,
  erst mit `--max-semi-space-size=8` die erwarteten 120 MB. Beides steht jetzt
  in `scripts/agent-wrapped.sh`, je Agent übersteuerbar.

  Das Ergebnis, nachgemessen: `cits-bridge` 177 → **99 MB**, der Director
  203 → **107 MB**, alle übrigen 33–56 MB. Neun Agents zusammen rund 510 MB.

  Die unbequeme Zahl: **ein frischer Node kostet 49 MB, bevor er etwas tut.**
  `ecosystem.config.cjs` rechnet beim Start nach und warnt — wobei die Warnung
  *Obergrenzen* addiert, nicht den Normalbetrieb: gemessen passen alle Agents
  bequem (625 MB mit PocketBase und Caddy), aber wenn mehrere gleichzeitig
  ihre Marke erreichen, ist die 2-GB-VM überbucht, und dann greift der
  OOM-Killer vor pm2. Genau für diesen Fall soll Swap da sein — er tauscht
  Überbuchung gegen Langsamkeit statt gegen einen Ausfall.
  `docs/deployment.md` hat die vier Schichten samt `oom_score_adj` und
  `earlyoom`; der Kernel wählt sein Opfer nach Grösse, und das ist hier die
  Datenbank.

  Damit das nicht wieder unsichtbar passiert, meldet **jeder** Agent über
  `agents/lib/memory-report.mjs` seinen Speicher (Vorgabe alle 10 min) mit
  Zuwachs seit der letzten Meldung und seit dem Start, und warnt **einmal** je
  Überschreitung der Marke — eine Warnung, die sich alle zehn Minuten
  wiederholt, wird weggefiltert und warnt dann niemanden. 14 Tests, inklusive
  Gegenprobe, dass der Takt den Prozess wirklich nicht wach hält.

  Nebenbei aufgefallen, nicht behoben: **der Migrationssatz kann keine leere
  Datenbank aufbauen** — `1773779228_updated_objects.js` scheitert mit „no rows
  in result set", weil die anlegende Migration fehlt. Betrifft nur einen
  Neuaufbau von Null, nicht den Betrieb.

* **Handbuch als Webseite** (29.09.) — `tools/manual.mjs` baut aus `wiki/`
  und `docs/` statische Seiten nach `client/manual/`. Statisch, weil das drei
  Dinge auf einmal löst: kein Markdown-Parser im Browser-Bündel und keiner im
  Server, die Seiten laufen ohne JavaScript, und sie wandern in die Android-App
  mit. Liegt im Client-Ordner, den Caddy ohnehin ausliefert — **keine Zeile
  Caddy-Konfiguration nötig**, `npm run build` erledigt es beim Deploy.
  `html: false` im Renderer ist hier nicht nur sicher, sondern richtig: In der
  Doku stehen Platzhalter wie `<name>` im Fließtext, die als HTML gedeutet
  spurlos verschwänden. Der Test über die ECHTEN Dateien fand, was die
  Stichprobe übersah — 44 tote Verweise in zwei Klassen (relative Ziele
  innerhalb von `docs/` und Verweise auf Quelldateien); beide sind behoben, der
  Test hält sie fest. 16 Modultests, dazu im Browser gegengesehen.


* **C-ITS: Straßenverkehr als vierte Fahrzeug-Brücke** (29.09.) —
  `cits-bridge.mjs` über opentrafficmap.org. Gemessen vor dem Bauen: Der
  MQTT-Weg ist zu (Verbindung wird angenommen, jedes `subscribe` abgelehnt),
  aber die öffentliche Karte benutzt `wss://opentrafficmap.org/ws_ext` — ohne
  Schlüssel, 3985 Punkte, 1183 Ampeln mit Signalphase, 856 Gefahrenmeldungen.
  Im 50-km-Umkreis um Neuwied 22 frische Punkte, ausschliesslich Fahrzeuge;
  Ampeln stehen dort keine. Private PKW werden mitgespiegelt, `CITS_PRIVAT=off`
  nimmt sie aus — und zwar sofort, nicht erst durch Veralten. Kennzeichen
  werden nie übernommen, auch wenn die Quelle das Feld führt.
  **Dabei entstand `lib/fleet.mjs`**: der dreifach kopierte Teil aller
  Fahrzeug-Brücken (Bestand übernehmen, anlegen-oder-ändern, Drossel,
  Aufräumen) mit den drei Fallen, die jede Kopie einzeln gelernt hatte — Platz
  vor dem Anlegen belegen, ihn beim Fehlschlag freigeben, Übernommenes als eben
  gesehen zählen. 15 + 17 Modultests.


* **Anmeldeversuche gedrosselt — nach FEHLversuchen** (23.09.) — die einzige
  echte Lücke der Liste. Die mitgelieferte Regel (2 Versuche in 3 s) passte
  nicht: `npm run stack` meldet mehrere Agents gleichzeitig von derselben
  Adresse an, die Testsuite dutzendfach in Folge. Der Ausweg war die Zählweise
  statt eine andere Zahl — ein Agenten-Schub besteht aus GELUNGENEN
  Anmeldungen, ein Angriff aus MISSLUNGENEN, und eine erfolgreiche Anmeldung
  löscht den Zähler. Zwei Zähler: je Konto 5 in 10 min → 15 min Sperre, je
  Adresse 50 in 10 min → nur 2 min, weil hinter einer Adresse ein ganzes WLAN
  stehen kann. Gemessen am laufenden Server: 40 gleichzeitige gültige
  Anmeldungen von einer Adresse → alle 200; sechster Fehlversuch auf ein Konto
  → 429 `auth_locked`; Neustart löscht die Sperre (der Notausgang für den
  Betreiber, den ein Angreifer nicht hat). Neun Modultests.
  **Zwei Funde nebenbei:** Ein Hook in `pb_hooks/` läuft nur, wenn die Datei auf
  `.pb.js` endet — die erste Fassung war nie aktiv. Und die dokumentierte Form
  `fehler.<code>` als Übersetzungsschlüssel geht für jede Sprache ausser der
  eigenen; die Zuordnung steht jetzt als `FEHLER_TEXT` im Client, wo der
  deutsche Satz wieder der Schlüssel ist.

* **Welt-Kontext: Figuren wissen, wie das Wetter ist** (23.09.) — Vorrat je
  Zelle (`weltkontext.mjs`), Anbieter für Open-Meteo (`wetter.mjs`, kein
  Schlüssel nötig), Mondphase und Tageszeit als reine Arithmetik
  (`himmel.mjs`). Der Director frischt auf dem Puls des Reconcile-Laufs auf —
  nur für Zellen, in denen auch eine eigene Figur steht — und mischt die Werte
  synchron in `dialogVarsFor`. Zwei Abweichungen vom Entwurf, beide begründet:
  kein eigener Zeitgeber (die Gültigkeitsdauer entscheidet, und der
  Reconcile-Lauf sieht einen Neuankömmling sofort), und Tageszeit/Mond liegen
  NICHT im Vorrat — aus einer Viertelstunde bedient sagte eine Figur um 19:59
  „Nachmittag". Parley blieb unverändert, wie vorhergesagt. 22 Modultests,
  10 Prüfungen in der UI-Suite, darunter eine auf die Regelreihenfolge: Beim
  Schreiben stand `wetter_echt` zuerst und hätte Regen und Gewitter verdeckt.

* **Ein Ausfall ist keine leere Liste** (23.09.) — elf Agents hatten
  `refreshObjects()` in ein eigenes `try/catch` gepackt und liefen bei einem
  Ausfall mit LEEREM Bestand weiter; am 17.09. entstanden so 281 Dubletten in
  25 Minuten. Gemessen: `refreshObjects()` wirft korrekt, aber `getObjects()`
  liefert danach `[]` — wer den Wurf abfängt, sieht eine leere Welt und legt
  sie neu an. Jetzt entscheidet das `ladeBestand()` in `agent-base.mjs`, an
  einer Stelle: dreimal versuchen (ein Server, der gerade hochfährt, ist kein
  Grund aufzugeben), dann sterben statt weiterlaufen. `connect()` im bootAgent
  geht denselben Weg, damit die vier Agents ohne eigenes Listing dieselbe
  Meldung bekommen. Sieben Agents umgestellt, sieben Modultests, und eine
  UI-Prüfung, die durchfällt, sobald ein Agent wieder selbst listet.

* **Objektliste lief in den Zeitablauf** (17.09.) — die View-Regel verband je Zeile `effective_permissions` UND `object_permissions`; zwei LEFT JOINs bilden ein Kreuzprodukt, darüber ein
  DISTINCT. 100 Sätze brauchten 4,02 s statt 0,04 s, ab rund 650 Objekten kam
  ein nichtssagender 400 nach 30 s. Als Superuser (Regeln übersprungen) lagen
  500 Sätze bei 0,07 s — die Daten waren nie das Problem, ein Index hätte
  nichts geändert. Behoben mit `1788300000_audience_flags.js`: Die implizite
  Audience steht als zwei Merker am Objekt (`view_auth`, `view_anon`),
  gepflegt in `recomputeForObject` — dort, wo auch der Rechte-Cache entsteht.
  Die ACEs bleiben die Quelle, die Spalten sind ihr Abdruck. Danach 638
  Objekte in 0,06 s unter voller Agenten-Last, Rechte- und Auftrags-Suite
  grün (61 + 280).

* **Adress-Marker in 3D und auf der Karte** (16.09.) — je Treffer ein Marker an
  der echten Position, `client/core/AdressMarker.js`. Mehrere Abfragen sammeln
  sich (dedupliziert, gedeckelt) und verschwinden, sobald die Lupe ins Inventar
  wandert. Reine Babylon-Knoten bzw. Leaflet-Layer: nichts in `objects`, nichts
  in `localStorage` — bauartbedingt flüchtig, nicht bloss zugesichert. Dazu ein
  **Nominatim-Rückfall**, wenn OSM nichts hergibt; dessen Lage wird sichtbar als
  geschätzt gekennzeichnet (blass, gestrichelt, „Lage geschätzt").
* **OffeneRegister-Abzug eingehängt** (16.09.) — lokal statt über die tote
  HTTP-Schnittstelle, `node:sqlite`, FTS5-Suche in ~10 ms. Der Stand des Abzugs
  steht an jedem Feld; ohne Stand gibt `registerFelder()` gar nichts aus. Jeder
  Treffer wird gegen die **Postleitzahl** gegengeprüft — ohne Gegenprobe keine
  Aussage. Der Agent meldet sich am **Inhaltsfilter** an; der objektlose
  Kommandoweg wurde entfernt, weil er diese Sperre unterlaufen hätte.
* **Flüchtige Daten** (`164e1c4`) — `ephemeral` als Grundbaustein über Server,
  Client-Bibliothek und Verlaufsspeicher. `docs/fluechtige-daten.md`.
* **Adress-Agent** (`ee3dbb0`) — zwei Betriebsarten, Herkunft je Feld, 17 Tests.
* **Gastkonten Phase A+B** — Entscheidungen in `gastkonten-entscheidungen.md`,
  Umsetzung in `gastkonten.md`.
