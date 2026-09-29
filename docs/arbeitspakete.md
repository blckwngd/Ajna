# Arbeitspakete

**Wo wir stehen.** Diese Datei ist die stehende Antwort auf „was ist offen?" —
damit niemand nachfragen muss. Reihenfolge = Priorität.

Regel: Ein Paket verschwindet hier erst, wenn es *erledigt und geprüft* ist.
Verworfenes wandert nach unten statt gelöscht zu werden — sonst wird derselbe
Gedanke ein zweites Mal gedacht.

Stand: 29. September 2026 (Handbuch-Webseite, C-ITS-Brücke)

---

## Als Nächstes

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

### 2 · Objekte lassen sich über ACE-Rechte nicht ändern

**Gemessen am 16.09., ungelöst.** Ein Konto mit `edit` ODER `move` aus einer
Nutzer-ACE bekommt beim `PATCH` auf ein fremdes Objekt **404**, obwohl

* `effective_permissions` das Recht korrekt führt (`["view","edit"]`),
* `objects.updateRule` die passende Cache-Klausel enthält,
* und das **Lesen** über dieselbe Cache-Klausel funktioniert.

Nur `owner = @request.auth.id` greift zuverlässig. Damit ist das Rechtemodell an
dieser Stelle eine Zusage, die es nicht einlöst — dieselbe Sorte Fehler wie ein
Knopf ohne Draht, nur tiefer.

**Unsicher ist die Bedingung:** Ein früher Einzelversuch am selben Tag lieferte
einmal `200` — dort waren vorher alle anderen ACEs des Objekts gelöscht worden.
Der Verdacht ist deshalb, dass **mehrere ACE-Zeilen am selben Objekt** die
Auswertung kippen (Join über `@collection.*` in einer Update-Regel). Bestätigt
ist das nicht.

**Nicht nebenbei zu klären.** Ein Anlauf, hier ein `move`-Recht zu ergänzen, ist
am 16.09. gescheitert und wurde vollständig zurückgenommen — samt Migration und
Hook. Wer das angeht, braucht einen eigenen Durchgang mit einer sauberen
Instanz, nicht einen Seitenzweig einer Werkzeug-Aufgabe.

Nebenbefund, ebenfalls gemessen: Eine ACE für die impliziten Audiences
(`authenticated`, `everyone`) erlaubt **grundsätzlich kein** Schreiben — auch
als einzige Klausel der Regel nicht, während dieselbe Konstruktion in der
view-Regel wirkt.

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

**a) Verfall für Objekte** (~½ Tag, unabhängig nützlich). In ganz Ajna gibt es
heute **keine Lebensdauer für Objekte**. Ohne sie sammelt diese Idee — und jede
ähnliche — Müll an. Also `state.expires_at` plus ein `cronAdd("object_expiry", …)`
neben den vorhandenen Aufräum-Crons. Serverseitig, nicht im Agenten: „Was nur
tickt, solange ein Agent läuft, ist keine Regel" (dieselbe Begründung wie bei
den Auftragsfristen).

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

## Kleiner, wartet auf eine Entscheidung

### 6 · Kommentar-Bestand übersetzen

Neue Kommentare sind englisch (`CLAUDE.md`), der Bestand ist deutsch: 10.790 von
17.577 Kommentarzeilen, gemessen am 22.09.2026. **Der größte Block der ganzen
Sprachumstellung** — und der heikelste, weil diese Kommentare durchgehend das
*Warum* tragen („WARUM DAS NICHT BEI JEDEM START PASSIERT: …"). Maschinell
übersetzt verlieren sie genau das.

Vorgemerkt auf Wunsch des Owners. Sinnvoll in Dateigruppen statt am Stück, und
am besten dort zuerst, wo ohnehin gearbeitet wird.

### 7 · ADS-B und AIS auf `lib/fleet.mjs` umstellen

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

### 8 · `npm audit`: sechs Schwachstellen im Bestand

Beim Hinzufügen von `markdown-it` aufgefallen, **nicht davon verursacht** (das
Paket taucht in keinem Pfad auf): 1 niedrig, 2 mittel, 3 hoch. Der Großteil sind
Werkzeugkette und Umgebung — `browserslist`, `brace-expansion`, `ajv`, `lodash`
über Webpack und Babylon.

Zwei betreffen aber Laufzeit-Abhängigkeiten und verdienen einen Blick:
`body-parser` (Express) und `@xmldom/xmldom`. Erst nachsehen, über welchen Pfad
sie hereinkommen und ob ein `npm audit fix` ohne Bruch durchgeht — blind
aktualisieren heißt hier, die Bündel neu zu bauen und zu hoffen.

### 9 · Telefonbuch-Parser gegen die echte Seite prüfen

Bisher nur gegen erfundenes Markup getestet. Vor einem echten Einsatz des Modus
`erweitert` nötig. Der Parser hängt an `nasort`-Attributen — jedes Redesign der
Seite bricht ihn.

### 10 · Weitere Lupen für weitere Spieler

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

### 11 · Wo soll die Adress-Lupe liegen?

Steht derzeit auf **Moselring 11, 56073 Koblenz** (50.356717, 7.588443) — dorthin
verschoben, damit der erste Test etwas zeigt; an der ursprünglichen
Vorgabe-Koordinate lag im 25-m-Umkreis keine einzige Adresse. Ein bewusster Ort
ist das noch nicht. `ADR_START_LAT/LON` wirken nur beim Erzeugen, das vorhandene
Objekt lässt sich jederzeit verschieben.

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
