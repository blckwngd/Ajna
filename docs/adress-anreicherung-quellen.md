# Adress-Anreicherung — Quellen und Grenzen

Vorarbeit für einen Agenten, der zu einer Position die Adresse bestimmt und
dazu öffentlich verfügbare Angaben zusammenträgt (Name, Telefon, Unternehmen,
Webseite).

**Zweck:** Spielfunktion *und* Datenschutz-Demonstration — wie bei
`agents/ais-vesselfinder.mjs`. Eine öffentliche Bereitstellung ist nicht
vorgesehen. Das ist wie dort eine Betriebszusage, keine `.gitignore`-Regel: Der
Agent liegt regulär im Repo, er wird nur nicht angeboten.

**Verantwortung:** Es werden ausschließlich Daten genutzt, die auch von Hand
abrufbar sind. Nichts wird umgangen, nichts entsperrt. Wer den Agenten betreibt,
entscheidet über den Modus und trägt die Folgen.

> **Kein Rechtsrat.** Drei Punkte unten sind mit ⚖️ markiert — die gehören
> geprüft, bevor der erweiterte Modus irgendwo außerhalb des eigenen Hauses
> läuft.

---

## Schicht A — Position → Adresse

| Quelle | Taugt | Anmerkung |
|---|---|---|
| **Overpass** (`addr:*` im Radius) | **erste Wahl** | Liefert die *Menge* der Adressen, nicht eine |
| Nominatim `/reverse` | Ergänzung | 1 Anfrage/s, identifizierender User-Agent, kein Massenbetrieb |
| Photon (Komoot) | Alternative | OSM-basiert, lockerer, selbst hostbar |
| Selbst gehostet | Endstufe | Photon auf einem Geofabrik-Extrakt ist viel leichter als ein Nominatim-Import |
| BKG / OpenGeodata.NRW u. a. | punktuell | Amtliche Hauskoordinaten, aber Flickenteppich je Bundesland |

**Für die Auswahlliste braucht es Nominatim nicht.** Overpass kann den Radius,
und zwar durch `server/geo.js` hindurch — mit Spiegel-Ausweichen,
Ausfallerkennung und 12-Stunden-Cache, die dort bereits erprobt sind. Nominatim
liefert *eine* Antwort und ist damit für „welche Adressen liegen hier?" der
schlechtere Weg.

## Schicht B — Adresse → Gewerbe (Modus `gewerbe`)

| Quelle | Rechtlich | Technisch |
|---|---|---|
| **OSM-POI-Tags** (`name`, `phone`, `website`, `opening_hours`, `operator`, `contact:*`) | ODbL, unbedenklich | **derselbe Overpass-Aufruf** — kostet nichts zusätzlich |
| **Impressum** der gefundenen Webseite | §5 DDG *verpflichtet* zur Veröffentlichung genau dieser Angaben | ein HTTP-Abruf, Parsen ist Fleißarbeit |
| **OffeneRegister.de** | siehe unten | API + Komplettabzug |
| Handelsregister (handelsregister.de) | öffentlich, seit DiRUG kostenfrei | kein offizielles API, JS-Suchmaske, AGB gegen Automatisierung |
| Unternehmensregister / Bundesanzeiger | öffentlich abrufbar | kein API, Automatisierung unerwünscht |
| Wikidata / Wikipedia | unbedenklich, im Projekt bereits als verlinkbar freigegeben | sauberes SPARQL |
| ~~Gewerberegister~~ | **nicht öffentlich** — §14 GewO, Auskunft nur bei berechtigtem Interesse | entfällt |
| ~~Transparenzregister~~ | Zugang nach dem EuGH-Urteil zu wirtschaftlich Berechtigten eingeschränkt | entfällt |

**Die konforme Variante braucht fast keine neue Quelle.** OSM trägt Name,
Telefon, Webseite und Öffnungszeiten oft schon; das Impressum liefert den Rest —
Daten, die jemand von Gesetzes wegen veröffentlichen *muss*.

### OffeneRegister.de

Vom Open Knowledge Foundation Deutschland e. V. aufbereitete Handelsregister-
Daten: Firmenname, Registergericht und -nummer, Anschrift, Rechtsform und die
**Organe** (Geschäftsführer, Vorstand, Prokuristen). Es gibt eine Suche über
HTTP und einen Komplettabzug als SQLite-Datenbank.

**Warum das für uns die beste Registerquelle ist:** strukturiert statt
HTML-Suchmaske, offline nutzbar, keine AGB-Reibung bei automatisierten
Abrufen — ein lokaler Abzug erzeugt überhaupt keine Fremdlast.

**Die Schwäche, die man kennen muss: Aktualität.** Das Projekt wird nicht
durchgängig gepflegt; der Komplettabzug hinkt dem amtlichen Register um Jahre
hinterher. Für eine Demonstration ist das unerheblich, für eine Auskunft über
den *heutigen* Zustand einer Firma nicht. Vor dem Einbau prüfen, wie alt der
aktuelle Stand ist, und das Datum **in der Anzeige mitführen** — eine veraltete
Angabe ohne Datum ist schlimmer als keine.

> **Wichtig und leicht zu übersehen:** Handelsregisterdaten enthalten
> **Personennamen** (Geschäftsführer, Prokuristen). Auch die „konforme"
> Variante verarbeitet damit personenbezogene Daten — rechtmäßig veröffentlicht,
> aber eben personenbezogen. Für die Objektregel unten heißt das: Diese Namen
> gehören nicht in ein Weltobjekt.

## Schicht C — Adresse → Person (Modus `erweitert`)

### Rückwärtssuche bei Das Telefonbuch

**Existiert als angebotene Funktion.** (Hier stand zuerst das Gegenteil — falsch,
vom Betreiber mit einem Beispiel widerlegt.)

```
https://www.dastelefonbuch.de/Rückwärts-Suche/<PLZ>----<Straße>--<Hausnummer>
```

Umlaute prozent-kodiert. **Schema an einem echten Aufruf bestätigt** (Beispiel
des Betreibers, eigener Vereinseintrag). Die Trennzeichen sind nirgends
dokumentiert — bei Ausfällen ist das die erste Stelle zum Nachsehen.

Struktur der Antwort, gemessen:

| Befund | Folge für den Einbau |
|---|---|
| Felder je Treffer: Name, Straße + Hausnummer, PLZ/Ort, Telefonnummer, Link zum Detaileintrag | deckt den Bedarf |
| **Telefonnummer in der Liste teilweise maskiert** | die vollständige Nummer steckt erst im Detaileintrag → **zweiter Abruf**, nur auf Antippen |
| kein JSON-LD, kein schema.org, keine Microdata | geparst wird gegen Attribute wie `nasort`, `stsort`, `pcsort`, `seedidsort` — **bruchanfällig gegen jedes Redesign** |
| erste Trefferseite steht im HTML | kein Headless-Browser nötig |
| weitere Treffer über „Lade weitere Ergebnisse" per JavaScript | Mehr als die erste Seite braucht den Nachlade-Endpunkt; für eine Hausnummer reicht die erste |

**Die Maskierung ist ein Glücksfall, kein Hindernis.** Sie erzwingt genau die
Gestaltung, die ohnehin richtig wäre: Liste billig und ohne Nummern, und erst
wenn der Nutzer einen Eintrag antippt, ein einzelner Abruf für genau diesen. Das
ist zugleich sparsam, absichtsvoll und protokollierbar.

**Was dafür spricht:** Die Einträge sind **Opt-in** — wer dort steht, hat der
Veröffentlichung zugestimmt. Es ist eine reguläre Funktion der Seite, kein
verstecktes Endstück, und jeder Treffer ist von Hand genauso abrufbar.

**Was zu klären bleibt:**

* ⚖️ Die AGB der Seite dürften automatisiertes Auslesen untersagen. Das ist eine
  zivilrechtliche Frage zwischen Betreiber und Seite, kein Strafrecht — aber es
  ist der Grund, warum dieser Modus nicht die Vorgabe ist.
* ⚖️ §104 TKG regelt die **Inverssuche Nummer→Name**. Adresse→Name ist davon
  nicht erfasst; ob die Einwilligung zum Verzeichniseintrag diese Richtung
  mitträgt, ist die eigentliche offene Frage.
* Keine Last erzeugen, die auffällt: ein Abruf je Nutzerhandlung, Ergebnisse
  im Speicher halten, **negative Antworten mitzählen** (siehe Cache-Regeln).

### Die übrigen Quellen dieser Schicht

| Quelle | Status |
|---|---|
| Melderegister | namensbasiert, gebührenpflichtig, kein Bulk — **keine** Adress→Person-Quelle |
| Grundbuch | berechtigtes Interesse erforderlich — **in jedem Modus geschlossen** |
| Kommerzielle Datensätze (klicktel u. ä.) | lizenzierbar — der saubere Weg, kostet Geld |
| „Personensuche"-Aggregatoren | scrapen selbst, eigene Rechtslage wackelig, als Abhängigkeit unbrauchbar |

**Der Graubereich ist schmaler, als das Wort verspricht.** Die wirklich
geschlossenen Register bleiben in beiden Modi geschlossen. Was `erweitert`
hinzufügt, ist im Wesentlichen die Rückwärtssuche.

---

## Was die Demonstration eigentlich zeigt

Die Erwartung an so eine Vorführung ist „ein Knopf, und ich weiß, wer da wohnt".
Der Befund ist unbequemer:

> Der beunruhigende Teil ist nicht der Graubereich. Der beunruhigende Teil ist,
> wie viel sich aus OSM, Impressum und Handelsregister über eine Adresse
> zusammensetzen lässt — vollständig legal, ohne eine einzige fragwürdige
> Abfrage.

Wer an einer Adresse ein Gewerbe betreibt, hat Name, Anschrift und Telefonnummer
per Gesetz veröffentlicht. Bei Einzelunternehmen im Homeoffice ist das **die
Wohnadresse und der bürgerliche Name** — offengelegt durch die Impressumspflicht,
nicht durch ein Leck. Diese Lehre steckt im konformen Modus.

## Gestaltung

**Träger ist ein Werkzeug im Inventar**, kein automatischer Aufschlag auf die
Welt. Ansprechen → Abruf für den eigenen Standort → Trefferliste **an diesem
einen Objekt**. Erst wenn der Nutzer einen Eintrag auswählt, entsteht ein
bleibendes Objekt.

*Objekte bei Auswahl, nicht bei Suche.* Erzeugte Objekte sind für alle Spieler
sichtbar; eine Abfrage, die fünf davon ablegt, vermüllt die Welt für Fremde und
verlangt wieder einen Aufräum-Cron mit allen Fristen-Risiken.

Bei GPS-Ungenauigkeit von ±10 m ist ein einzelnes Ergebnis eine selbstbewusst
aussehende Lüge. Die Liste zeigt die Unschärfe, statt das Nachbarhaus als
Gewissheit zu verkaufen.

### Die Trennlinie

> **Das bleibende Objekt trägt die Adresse, nicht den Bewohner.**

Ortsbezogenes (Adresse, Gebäude, Gewerbe) darf Weltobjekt werden.
Personenbezogenes bleibt **flüchtig am Werkzeug** und verschwindet mit ihm. Das
deckt sich mit der bestehenden Regel, dass `object.name` keinen echten
Personennamen trägt — und gilt ausdrücklich auch für Geschäftsführernamen aus
dem Handelsregister.

Personennamen sind damit **nicht verboten, sondern ortsgebunden ausgeschlossen**:
Sie dürfen angezeigt werden, sie dürfen nur nirgends liegen bleiben.

## Flüchtigkeit — was dafür nötig ist

> **Inzwischen gebaut und Teil des Grundsystems** — siehe
> [`fluechtige-daten.md`](fluechtige-daten.md). Dieser Agent benutzt es nur, er
> bringt es nicht mit. Der Abschnitt bleibt stehen, weil er die Anforderung
> festhält, aus der es entstanden ist.

Die Anzeige personenbezogener Treffer soll **niemals auf permanentem Speicher
landen** und **nur der aufrufende Spieler** sie sehen. Beides ist erreichbar,
aber nicht geschenkt — der Weg führte durch eine Stelle, die mitschrieb.

**Der Transportweg stimmt bereits:** `sendChat(<Nutzer-ID>)` sendet auf das Topic
`chat:<Nutzer-ID>` — an genau ein Konto, ohne Datenbankschreibvorgang (so
ausdrücklich in `main.pb.js` vermerkt). Wer offline ist, bekommt nichts; es gibt
keine Ablage. Das ist die richtige Leitung.

**Die Stelle, die es kaputt macht:** `MessageLogPanel._onChat()` schiebt *jede*
eingehende Chat-Nachricht in `messageLog`, und `MessageLog._save()` schreibt nach
`localStorage`. Eine Agent-Antwort läge damit dauerhaft auf dem Gerät.

Die vier Ablagestellen, die geschlossen sein müssen:

| Stelle | Zustand | Nötig |
|---|---|---|
| PocketBase-Datenbank | `chat/send` schreibt nichts | nichts — passt |
| Client-Verlauf (`localStorage`) | **erledigt** | `sendChat(…, { ephemeral: true })` — der Verlauf zeigt solche Zeilen an, speichert sie aber nicht |
| Weltobjekt (`objects`) | — | Ergebnisse dürfen **nie** in `object.state` o. ä. — das Objekt ist Auslöser, nie Träger |
| Agent-Protokoll | offen | siehe unten |

### Das Protokoll protokolliert die Tatsache, nicht die Werte

Hier steckt ein Widerspruch, den man auflösen muss statt ihn zu übersehen: Für
eine Vorführung will man einen Nachweis, was abgerufen wurde — für die
Flüchtigkeit will man keinen.

**Auflösung:** Das Protokoll hält *Zeitpunkt, Adresse, Quelle und Feldnamen*
fest, nicht die Werte. „14:03 — Rückwärtssuche 56566 Hauptstraße 127 → 1 Treffer
(Name, Nummer)" belegt den Vorgang vollständig und legt niemanden ab.

### Zur Einordnung des Clients

Die Sicht des Betreibers — der Ajna-Client ist wie ein Browser, der Anbieter
haftet nicht für das, was jemand damit abruft — trägt, **solange dieses Design
eingehalten wird**. Sie hängt genau daran: an einem Empfänger, ohne Ablage, ohne
Weltobjekt. Sobald ein Ergebnis in ein Objekt geschrieben würde, wäre der Server
kein Übertragungsweg mehr, sondern eine Veröffentlichung — und die Analogie
bräche. Rechtliche Einordnung und technische Anforderung zeigen hier
ausnahmsweise in dieselbe Richtung.

⚖️ Die Verantwortung des Agent-Betreibers bleibt davon unberührt: Er bestimmt
Zweck und Mittel der Verarbeitung. Das ist der Grund, warum `erweitert` nicht
die Vorgabe ist und warum es diesen Abschnitt gibt.

### Herkunft je Feld

Jedes angezeigte Feld trägt, woher es stammt: „OSM", „Impressum §5 DDG",
„Handelsregister HRB 12345", „Telefonbuch (Eintrag freiwillig)".

Das ist die Zeile Code, die aus einem Auskunftswerkzeug eine Demonstration
macht: Der Betrachter sieht nicht nur, *was* zusammenkommt, sondern *dass jedes
Stück offen herumlag*. Für eine Vorführung ist das der ganze Punkt.

## Konfiguration

Über `Konfig.eigene()` (`agents/lib/konfig.mjs`) — die Regler gehören dem
Agenten-Konto, nicht der Instanz.

| Schlüssel | Vorgabe | Wirkung |
|---|---|---|
| `adress.modus` | `gewerbe` | `gewerbe` \| `erweitert` |
| `adress.radius_m` | `25` | Umkreis der Adressliste |
| `adress.halten_m` | `15` | Erst nach dieser Bewegung neu abfragen |
| `adress.protokoll` | `true` | Im erweiterten Modus jeden Abruf protokollieren |

**Ein benannter Modus, keine Sammlung von Schaltern** — bei einem halben Dutzend
Booleans weiß niemand mehr, in welchem Zustand der Agent gerade läuft.

Im erweiterten Modus ist das Protokoll der Nachweis — aber über **Tatsachen,
nicht Werte** (siehe „Flüchtigkeit"). Sonst schafft ausgerechnet die
Dokumentation der Sparsamkeit die Ablage, die vermieden werden sollte.

## Ein Agent oder drei? — drei

Naheliegend wäre, die Graubereich-Agenten (AIS/VesselFinder, Wigle,
Adress-Rückwärtssuche) zu einem OSINT-Agenten zusammenzufassen. Dagegen
sprechen drei Dinge, und das erste ist entscheidend:

**Sie haben gegensätzliche Ablage-Anforderungen.** Die AIS-Bridge *erzeugt
öffentliche Weltobjekte* — Schiffe, die jeder sieht, dauerhaft gespeichert. Die
Adresssuche darf **nie** etwas ablegen. Beides in einen Prozess zu legen, heißt,
die gefährlichste Kombination zu bauen, die dieses Vorhaben kennt: Ein
Konfigurationsfehler kreuzt die Wege, und ein Personentreffer landet im
Objektbestand. Getrennte Prozesse machen diesen Fehler technisch unmöglich statt
nur unwahrscheinlich.

**Die Gegenstände sind verschieden.** Ein Schiff ist eine Sache und sendet AIS
als öffentliche Sicherheitsinformation. Ein WLAN ist haushaltsnah. Eine
Telefonbuchadresse ist eine Person. Das unter „OSINT" zusammenzufassen, planiert
genau die Unterscheidung, an der die ganze Gestaltung hängt.

**„OSINT" ist keine Datenquelle, sondern eine Haltung.** Agenten sind in diesem
Projekt nach Quellen geschnitten (`*-bridge.mjs`), das Gemeinsame liegt in
`agents/lib/`. Die Haltung gehört genauso dorthin — nicht in eine Prozessgrenze.

**Also:** drei Prozesse, eine gemeinsame Bibliothek `agents/lib/osint.mjs` für
Herkunfts-Kennzeichnung, flüchtige Antwort (`ephemeral`), Modus-Schalter und
Tatsachen-Protokoll. Dazu kommt der übliche Nebeneffekt getrennter Prozesse: Ein
Absturz nimmt nicht alle drei mit, und ein kompromittiertes Zugangsdatum
betrifft einen.

## Cache-Regeln

Eine Adresse ist eine ortsfeste Tatsache — nach dem ersten Besucher kostet
dieselbe Stelle niemanden mehr etwas. Damit ist Last ein Cache-Problem, kein
Interaktionsproblem.

1. **Ortsdaten** (Schicht A und B): in `server/geo.js` mitspeichern, 12 Stunden
   oder länger. Adressen ziehen nicht um.
2. **Leere Antworten mitcachen.** Sonst wird für jede adresslose Wiese bei jedem
   Besuch erneut angefragt — der häufigste Grund, ausgesperrt zu werden.
3. **Personendaten nicht auf Platte.** Ein Adresse→Person-Cache *ist* eine
   Profildatenbank, gleich woher die Einzelteile stammen. Nur im Arbeitsspeicher,
   nur für die Dauer einer Sitzung.
4. Das Werkzeug hält sein Ergebnis, bis es weiter als `adress.halten_m` bewegt
   wurde. Wiederholtes Ansprechen kostet dann nichts.

## Spannung zum Heimatradar

Heimatradar löst dasselbe Problem **durch Einwilligung** — die Leute tragen sich
selbst ein. Ein automatischer Rückwärts-Lookup importiert die nicht
einwilligenden Nachbarn in dieselbe Karte. Zwei Systeme auf einer Karte, eines
mit Zustimmung, eines ohne: Das fällt spätestens dem ersten Nachbarn auf, der
sich dort findet, ohne je etwas eingetragen zu haben.

Deshalb ist `gewerbe` die Vorgabe, und deshalb ist dieser Agent nichts, was auf
einer Instanz mitläuft, auf der Heimatradar betrieben wird.
