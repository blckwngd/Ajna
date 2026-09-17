# Arbeitspakete

**Wo wir stehen.** Diese Datei ist die stehende Antwort auf „was ist offen?" —
damit niemand nachfragen muss. Reihenfolge = Priorität.

Regel: Ein Paket verschwindet hier erst, wenn es *erledigt und geprüft* ist.
Verworfenes wandert nach unten statt gelöscht zu werden — sonst wird derselbe
Gedanke ein zweites Mal gedacht.

Stand: 17. September 2026 (neues Paket 1: die Objektliste laeuft in den Zeitablauf)

---

## Als Nächstes

### 1 · Ein Agent darf eine gescheiterte Liste nie für eine leere halten

Am 17.09.2026 fiel `getFullList()` aus (siehe „Erledigt" unten). Die Agenten
reagierten in zwei Lagern, und **beide waren falsch**:

* `wand-agent`, `uwb-anchors` — stürzten ab. Das ist die freundlichere Variante:
  man sieht es sofort.
* alle übrigen — fingen den Fehler ab, liefen mit LEEREM Bestand weiter und
  legten ihre Welt neu an. In 25 Minuten entstanden 281 Dubletten.

Die Ursache ist behoben, die Anfälligkeit nicht: Wer `catch` schreibt und dann
mit `[]` weitermacht, behandelt „ich konnte nicht fragen" wie „es gibt nichts".
Dasselbe Muster hat im September schon die doppelte Lupe erzeugt.

Zu tun: In `AjnaClient.refreshObjects()` zwischen Ausfall und Fehlanzeige
unterscheiden — ein Ausfall muss durchschlagen, nicht als leere Liste
weitergereicht werden. Bei den Agenten dann eine Stelle statt elf.

### 2 · Welt-Kontext: Vorausholen im Takt

Entschieden, Paket steht in `welt-kontext.md` (sieben Schritte). Agents holen
träge Daten periodisch für **aktive Interessensgebiete** und legen sie in die
Dialog-Variablen.

**Kostet keine Parley-Änderung** — Punktpfade funktionieren in Text und
Bedingungen bereits. Baut auf `taktgeber` und `Quellcache`, beides erprobt.

Größter spürbarer Gewinn fürs Spiel: Figuren, die auf Wetter, Tageszeit und Ort
reagieren.

### 3 · Anmeldeversuche sind ungedrosselt

**Die einzige echte Lücke auf dieser Liste**, alles andere sind fehlende
Funktionen.

Die `*:auth`-Regel wurde entfernt, weil keine Zahl zum Stack-Start passte —
mehrere Agents melden sich gleichzeitig von derselben Adresse an, und die
Testsuite loggt sich dutzendfach in Folge ein. Passwort-Durchprobieren ist damit
unbegrenzt möglich.

Braucht einen Weg, Agent-Schübe von Angriffen zu unterscheiden: eigenes
Kontingent je Konto, getrennte Instanz, oder Agents mit Token statt Passwort.
Begründung der Entfernung in `betrieb.md`.

### 4 · Objekte lassen sich über ACE-Rechte nicht ändern

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

### 5 · Karma-Inflation durch Absprache

Zwei Konten können sich gegenseitig Aufträge bestätigen und Karma aus dem Nichts
erzeugen. Die **Selbst**-Bestätigung ist geschlossen, die Absprache zu zweit
nicht.

Stand September 2026: **nirgends im Repo dokumentiert** — der Punkt lebte nur in
Gesprächen. Erster Schritt ist deshalb, ihn aufzuschreiben (zu `world-objects.md`
oder einer eigenen Datei), bevor er wieder verlorengeht.

---

## Kleiner, wartet auf eine Entscheidung

### 6 · Telefonbuch-Parser gegen die echte Seite prüfen

Bisher nur gegen erfundenes Markup getestet. Vor einem echten Einsatz des Modus
`erweitert` nötig. Der Parser hängt an `nasort`-Attributen — jedes Redesign der
Seite bricht ihn.

### 7 · Weitere Lupen für weitere Spieler

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

### 8 · Wo soll die Adress-Lupe liegen?

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
