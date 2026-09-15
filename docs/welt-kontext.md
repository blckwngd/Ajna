# Welt-Kontext — orts- und regionsbezogene Tatsachen

**Noch nicht gebaut.** Diese Datei hält den Entwurf fest, samt der zwei Stellen,
an denen er schiefgehen kann.

---

## ARBEITSPAKET (vorgemerkt, entschieden)

Der Weg steht fest; die Begründungen stehen unten. Reihenfolge:

1. **`agents/lib/weltkontext.mjs`** — Vorausholen je Zelle, `Quellcache`
   darunter (er teilt seine Dateien über den Quellnamen, also auch zwischen
   Agent-Prozessen). Anbieter als lokale Funktionstabelle im Agenten.
2. **Takt je Datenart** über `taktgeber()`: Wetter 15 min, UV/Luft 30–60 min,
   Stadt/Land einmal je Zelle, Mond/Sonne stündlich oder gerechnet.
3. **Sofort holen bei neuer Zelle** — sonst steht der Neuankömmling bis zu
   15 Minuten vor einer ahnungslosen Figur (Interessensgebiete leben 3 Minuten,
   der Takt schlägt alle 15).
4. **Menge begrenzen:** Schnitt aus aktiven Interessensgebieten und Zellen, in
   denen dieser Agent eigene Figuren hat.
5. **Werte in `dialogVarsFor()`** legen, namensraumweise (`wetter.*`, `ort.*`).
6. **Abfahrten als 30-Minuten-Vorrat**, Plan und Verspätung getrennt.
7. **„Grübeln"** für das, was doch erst geholt werden muss.

**Was ausdrücklich NICHT dazugehört:** eine Änderung an Parley. Punktpfade in
Text und Bedingungen funktionieren bereits. Und die `world_context`-Collection —
die wird erst fällig, wenn ein **Client** die Daten anzeigen soll.

## Der Gedanke

Ein geteilter Vorrat an Tatsachen über eine Gegend — Wetter, UV-Belastung,
Luftqualität, Stadt/Bundesland/Land —, den **Agents befüllen** und auf den
**NPCs über Parley zugreifen**. Damit kann eine Figur auf mehr reagieren als auf
ihre eigene Koordinate.

Entstanden aus der MCP-Überlegung (`mcp-anbindung-notiz.md`) und wahrscheinlich
nützlicher als diese.

## Was das bestehende System schon kann

**Der Leseweg steht vollständig.** Parley kennt `vars`, und der Agent füllt sie
beim Öffnen eines Gesprächs (`dialogVarsFor(figur)`). Eine Regel schreibt dann

```json
{ "when": "wie ist das wetter", "then": "{wetter_text}, wie man sieht." }
```

und braucht dafür **keine Änderung an Parley**. Dieselbe Naht wie bei der
MCP-Aktion: Parley bleibt rein und synchron, der Agent besorgt die Welt.

## Was fehlt: eine Ablage

Es gibt heute keinen Ort für **geteilten, regionsbezogenen, von Agents
gepflegten** Zustand. Die drei vorhandenen passen alle nicht:

| Vorhanden | Warum es nicht passt |
|---|---|
| `settings` | Instanzweit, nicht regional — und Agents dürfen dort ausdrücklich **nicht** schreiben (`konfig.mjs`) |
| `agent_settings` | Einem Agenten gehörend und privat. Das Gegenteil von geteilt |
| `objects` | Weltobjekte werden gerendert, gefiltert, rechteverwaltet. Ein unsichtbares Trägerobjekt ist genau die Lösung, die schon beim Kommandokanal verworfen wurde |

Es wäre also das dritte Geschwister: `settings` (Instanz, dem Menschen
gehörend), `agent_settings` (je Agent, privat), **`world_context`** (geteilt,
von Agents gepflegt).

Skizze eines Datensatzes:

```
bereich      "zelle:u0v9h" | "amtlich:DE-RP-Koblenz" | "global"
schluessel   "wetter.text" | "uv.index" | "ort.stadt"
wert         JSON
gueltig_bis  Zeitpunkt
quelle       Konto des schreibenden Agenten
```

Dazu: Schreibregel nur für die **eigene Quelle** (sonst vergiftet ein fehlerhafter
Agent die Figuren aller anderen), Leseregel offen — der Inhalt ist nicht
personenbezogen. Sollen Clients vor der Anmeldung lesen, gibt es mit
`1788200000_settings_public.js` bereits das Vorbild einer öffentlichen View.

Ein Pflege-Agent hält die Einträge frisch; das `taktgeber`-Muster aus dem
World-Director passt dafür unverändert.

## Die zwei Stellen, an denen es schiefgeht

### 1. „Region" ist nicht EINE Sache

Der naheliegende Fehler ist ein einziges Regionsmodell. Die Tatsachen haben aber
verschiedene natürliche Zuschnitte:

* **Wetter, UV, Luft** — etwa 10-km-Zellen. Ein Raster ist hier richtig.
* **Stadt, Bundesland, Land** — amtliche Grenzen. Ein Raster wäre hier falsch:
  Eine Zelle liegt irgendwann auf einer Landesgrenze.
* **Zeitzone** — amtlich.

Deshalb trägt **jeder Eintrag seinen eigenen Bereich**, statt dass die Ablage
einen vorgibt.

### 2. Berechnetes gehört SEHR WOHL hinein — aber als fertiger Wert

> Hier stand zuerst: „Der Vorrat hält genau das, was sich nicht lokal berechnen
> lässt." **Das war falsch**, und der Einwand des Betreibers trifft den Kern.

Der Fehler war, *wo etwas ausgerechnet wird* mit *wo es veröffentlicht wird* zu
verwechseln. **Parley rechnet nicht — es setzt ein.** Soll eine Figur nachts
sagen „Der Himmel ist klar, man sieht den zunehmenden Halbmond toll!", dann muss
die Zeichenkette `zunehmender Halbmond` als Variable vorliegen. Die Uhrzeit zu
kennen nützt einer Mustermaschine nichts.

Also: Der Agent rechnet Mondphase, Sonnenauf- und -untergang selbst aus (ohne
Netz, das bleibt richtig) — und **stellt das Ergebnis als sprechfertigen Wert
bereit**.

> **Die Auswahlregel lautet: Der Vorrat hält, was ein Dialog SAGEN können muss.**
> Woher es stammt — Netz oder Arithmetik — ist die Sache des Agenten.

Was von der alten Regel übrig bleibt, ist schmaler und stimmt weiterhin: Der
**Client rechnet, was er zum ZEICHNEN braucht** — Sonnenstand für Licht und
Schatten, in voller Genauigkeit und ohne Umweg. Zwei Verbraucher, zwei
Bedürfnisse: sprechfertige Werte in den Vorrat, Darstellungsgenauigkeit bleibt
lokal.

## Interest-Areas: der richtige Auslöser, der falsche Schlüssel

Naheliegender Vorschlag: die Daten an die bestehenden Interest-Areas knüpfen.
Der Instinkt stimmt — nur nicht für die Ablage.

`server/presence.js` zeigt, was sie sind: **absichtlich flüchtig.** Roh-Bereiche
liegen nur im Arbeitsspeicher, werden nie gespeichert, haben keine Historie;
Agents lesen ein gemergtes, auf 250 m gerastertes, identitätsfreies Set mit drei
Minuten Lebensdauer. Der Client verwischt seine Position vorher (Raster +
500-m-BBOX), es gibt eine Kappung bei ~2 km und einen Opt-out-Schalter.

Als **Schlüssel** taugt das nicht: Ein Zwischenspeicher, dessen Schlüssel alle
drei Minuten verschwindet und sich verschiebt, sobald jemand weitergeht, verliert
seine Treffer laufend. Derselbe Ort läge mal in dieser, mal in jener BBOX.

Als **Auslöser** ist es dagegen genau richtig — und der World-Director macht es
längst so: Daten nur dort holen, wo wirklich jemand ist. Für den Kontext heißt
das: **auffrischen, was eine aktive Interest-Area schneidet; ablegen unter einer
stabilen Zelle.** Auslöser und Schlüssel sind zwei Dinge.

Schön nebenbei: Die Privatsphäre-Arbeit ist dort bereits getan und dokumentiert
(„PRIVACY-GRENZE liegt HIER, nicht in PB-Rules") — der Kontext erbt sie, statt
eine zweite Präsenzquelle zu schaffen.

## Warum es sich lohnt: es ist in Wahrheit ein geteilter Zwischenspeicher

Das ist die stärkste Begründung, und sie wird leicht übersehen.

„In welcher Stadt stehe ich" heißt Rückwärts-Geokodierung — und Nominatim
erlaubt **eine Anfrage pro Sekunde**. Löste jedes NPC-Gespräch eine aus, wäre
die Instanz binnen Kurzem gesperrt. Ein geteilter Vorrat mit Gültigkeitsdauer
macht daraus **eine** Abfrage je Zelle und Zeitraum, für alle Agents und alle
Spieler zusammen.

Ohne ihn ist die Funktion nicht sparsam machbar. Mit ihm ist sie fast gratis.

## Privatsphäre: passt zusammen

Ein Client, der „Kontext hier" abfragt, verrät seine Gegend. Das ist aber
unkritisch, weil Kontext **von Natur aus grob** ist: Eine 10-km-Wetterzelle
braucht viel weniger Genauigkeit, als `privacy.positionFor()` mit seinem
100-m-Raster ohnehin liefert.

Abgefragt wird **nach Zelle, nicht nach Position** — der Client wählt die Zelle
selbst und meldet keine Koordinate. Damit funktioniert der Kontext auch auf
strengen Stufen, auf denen eine Positionsmeldung ausgeschlossen ist.

## Drei weitere Regeln

**Veraltung ist der Hauptausfall.** Ein Wetter von vor sechs Stunden ist
schlechter als keines. Jeder Eintrag trägt `gueltig_bis`; abgelaufen gilt als
**nicht vorhanden**. Wer das Alter aussprechen will, kann es: „heute früh war
es…".

**Inhalts-Injektion.** Werte fließen über `fillIn()` in die Rede einer Figur,
die Spieler lesen — Längenbegrenzung, Bereinigung, nichts Personenbezogenes.
Dieselbe Regel wie bei der MCP-Aktion.

**Mehrere Server.** Ajna ist mehrserverfähig; ein Client an drei Servern
bekäme womöglich drei Wetter für denselben Ort. Für allgemeingültige Tatsachen
gilt die eigene Rechnung oder ein benannter Server, nicht das erste Ergebnis.

## Der tragende Entwurf: Vorausholen im Takt, je aktivem Interessensgebiet

Der Agent holt seine dynamischen Daten periodisch — **nur für Gebiete, in denen
gerade jemand ist** — und legt sie in die `vars`, wenn ein Gespräch beginnt.
Dann liegt beim Sprechen alles vor.

**Der große Vorteil: Parley braucht dafür KEINE Änderung.** Die
Platzhalter-Grammatik ist `/\{([a-z0-9_.]+)(?::([^}]*))?\}/`, Punktpfade
eingeschlossen, und `_bedingung()` liest über dasselbe `lookup()`. Also gilt
heute schon:

```json
{ "if":   [{ "wetter.regen": true }],
  "then": "Was ein Mistwetter. Mein dicker Zeh sagt: {wetter.forecast_24h}" }
```

Der Agent muss nur ein `wetter`-Objekt in `conv.vars` legen —
`dialogVarsFor(figur)` ist genau diese Naht. Kein Weltkontext, kein Schema,
keine Asynchronität im Dialogpfad.

### Takt je Datenart, nicht ein Takt für alles

| Art | Sinnvoller Abstand |
|---|---|
| Wetter | 15 Minuten |
| UV, Luftqualität | 30–60 Minuten (folgt der Sonne, ändert sich träge) |
| Stadt / Bundesland / Land | einmal je Zelle, praktisch dauerhaft |
| Mondphase, Sonnenauf-/-untergang | stündlich — oder direkt gerechnet |

`taktgeber()` aus dem World-Director kann verschiedene Abstände nebeneinander,
und zwar zur Laufzeit änderbar.

### Die Lücke im reinen Takt: der Neuankömmling

**Interessensgebiete leben drei Minuten, der Takt schlägt alle fünfzehn.** Das
passt nicht zusammen: Wer eine Gegend betritt, in der gerade niemand war, trifft
auf Figuren ohne Wetter — bis zu fünfzehn Minuten lang. Genau im interessanten
Moment weiß der NPC nichts.

**Abhilfe:** Der Durchlauf holt nicht nur turnusmäßig, sondern **sofort für jede
Zelle, die neu auftaucht und keinen frischen Wert hat.** Kein zweiter
Mechanismus — dieselbe Schleife, ein zusätzlicher Blick auf „habe ich das
schon?".

### Die minimale Menge

Nicht alle aktiven Gebiete, sondern der **Schnitt aus aktiven Gebieten und den
Zellen, in denen dieser Agent eigene Figuren hat.** Wo niemand steht, hört
niemand zu; wo der Agent keine Figur hat, muss er nichts wissen.

Geholt wird je **stabiler Zelle** — das Interessensgebiet ist der Auslöser, nie
der Schlüssel (siehe oben).

### Schnelle Daten: als Vorrat holen, nicht als Punktabfrage

Für Flüchtiges wie Abfahrten gibt es einen Griff, der die Punktabfrage ganz
vermeidet: **nicht „die nächste Abfahrt" holen, sondern „die geplanten Abfahrten
der nächsten 30 Minuten".**

Damit wird aus einer sich ständig ändernden Einzelauskunft eine träge Liste.
Die Antwort „wann kommt der nächste Bus" ist dann ein **lokaler Filter über
einen vorliegenden Vorrat** — synchron, sofort, ohne Netz. Nachgeholt wird erst,
wenn der Horizont unter etwa zehn Minuten schrumpft.

**Fahrplan und Verspätung trennen.** Der Plan ist stabil und eignet sich für den
Vorrat; die Echtzeit-Verspätung ist es nicht. Für einen NPC-Satz reicht der Plan
meistens — aber dann muss er auch **planmäßig** sagen: „Planmäßig um 14:07" ist
ehrlich, „um 14:07" wäre eine Behauptung über etwas, das der Agent nicht weiß.
Wer Verspätungen will, frischt sie in kurzem Takt auf, und nur, solange jemand
an der Haltestelle steht.

### „Grübeln": die Wartezeit als Figurenverhalten

Bleibt eine Auskunft, die wirklich erst geholt werden muss, dann **antwortet der
NPC zweistufig**: „Moment, lass mich überlegen…" — und die eigentliche Auskunft
kommt, sobald sie da ist, als zweite Nachricht über `sendChat`.

Das ist genau das Zwei-Schritt-Verfahren von unten, nur aus der Sicht des
Spielers — und deshalb **braucht es keine synchronen Antworten und keine
Änderung an `say()`**. Eine Figur, die kurz nachdenkt, ist besseres Spiel als
eine, die einfriert; der technische Zwang wird zur Charakterisierung.

Drei Bedingungen:

* **Nur wenn wirklich kalt.** Liegt der Wert vor, wird sofort geantwortet —
  sonst grübelt die Figur jedes Mal, und aus Charakter wird Marotte.
* **Zeitablauf und Ausweichsatz**, damit aus „Moment" kein Verstummen wird.
* **Geht der Spieler weg**, läuft die zweite Nachricht ins Leere
  (`delivered = 0`) und wird verworfen.

### Wo der faule Getter doch bleibt

Vorausholen passt für alles Träge. Es passt **nicht** für Schnelles, das selten
gefragt wird: die nächste Abfahrt an einer Haltestelle ändert sich im
Minutentakt und ist Sekunden später veraltet — sie im Takt für jede Haltestelle
jeder aktiven Zelle zu holen, wäre teuer und trotzdem falsch.

Dafür bleibt der Getter im Ausgabetext die richtige Form, und dann braucht es
das Zwei-Schritt-Verfahren: `say()` **meldet** den Bedarf (`pending`), statt ihn
aufzulösen; der Agent holt; ein zweiter, reiner Aufruf setzt ein. Erklären statt
ausführen — dasselbe Prinzip wie `do`.

> **Bedingungen lesen immer vorbelegte Variablen.** Ein `{...}` im `if:` ent-
> scheidet, WELCHE Regel greift; das lässt sich nicht aufschieben, ohne ein
> Nachlade-Karussell mit unklarem Ende zu bauen.

Und: `{wetteragent.get("regen")}` würde nicht parsen — Klammern und
Anführungszeichen kennt die Schlüsselgrammatik nicht. `{wetter:abfahrt}` passt
dagegen ohne jede Änderung hinein.

## Der billigere erste Schritt — und warum er vermutlich reicht

Die Alternative: **gar keine Ablage.** Der Agent fragt live und legt das Ergebnis
direkt in die `vars`. Kein Schema, keine Migration, keine Regeln, keine neue
Angriffsfläche.

Dagegen sprach der Zwischenspeicher-Gedanke oben — bis man nachsieht, was
`Quellcache` eigentlich tut:

```js
export const cacheWurzel = (name) => join(HIER, '..', '..', '.cache', 'agents', name)
```

Der Ablageort hängt am **Namen der Quelle, nicht am Agenten.** Zwei Agent-
Prozesse, die `new Quellcache('weltkontext-wetter')` benutzen, **teilen sich die
Dateien bereits** — samt Tagesbudget und Mindestabstand. Das stärkste Argument
für eine eigene Collection („viele Agents, eine Abfrage") gilt damit auf einer
Maschine gar nicht.

Also: **`agents/lib/weltkontext.mjs` mit `Quellcache` darunter** — gemeinsamer
Code *und* gemeinsamer Zwischenspeicher, ohne eine Zeile Schema.

**Was dieser Weg NICHT kann**, und das ist der eigentliche Auslöser für die
Collection:

* **Clients können nicht lesen.** Wer die UV-Belastung in der Oberfläche
  anzeigen will, braucht einen Endpunkt — ein Client kann keinen Agent-Cache
  lesen.
* **Agents auf verschiedenen Maschinen** teilen nichts.

> **Empfehlung: mit der Bibliothek anfangen, die Collection erst bauen, wenn ein
> Client die Daten braucht.** Der Entwurf oben bleibt das Ziel; er ist nur nicht
> der erste Schritt.

## Der dauerhafte Preis

Es ist ein **Zwischenspeicher, der aussieht wie ein Weltmodell**. Ein Eintrag
kann fehlen — Agent aus, Frist abgelaufen, Quelle gesperrt. Jeder Dialog, der
Kontext benutzt, braucht deshalb einen Ausweichzweig über `if:`. Parley kann
das, aber jeder Dialogautor muss daran denken.

Das ist kein Grundproblem, sondern laufende Sorgfalt — man sollte es nur vorher
wissen und nicht nach dem ersten stummen NPC entdecken.
