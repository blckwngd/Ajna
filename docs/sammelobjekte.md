# Sammelobjekte

**Stand 05.11.2026: Stufe 1 steht** — Server (Datenmodell, Hooks, Rechte-
Vererbung, Baum-Endpunkt), Client (Karte, AR, Minimap, Nähe-Liste; Kontextmenü,
Ziehen auf der Karte, Editor) und die beiden ersten Nutzer: UWB-Netze
(`agents/uwb-anchors.mjs`) und Beute-Truhen (`agents/world-director.mjs`).
19 Unit-, 39 E2E- und 9 Quelltext-Prüfungen; die Agenten sind gegen die
Hooks geprüft, aber noch nicht im Betrieb gelaufen. Die Entscheidungen des
Fragenkatalogs stehen unten, dann die Bedienung, dann die Schnittstelle.

**Erste Nutzer:**
* **UWB-Netz** — das `uwb_network`-Objekt ist ein Sammelobjekt (Abzeichen:
  Anzahl), seine Anker hängen darin mit eigener Lage. Auf der Karte ein
  Marker „UWB-Netz 0x89AB 12 ▸"; die Anker erscheinen beim Aufklappen (und nur,
  wenn der Debug-Schalter für Anker an ist).
* **Beute-Truhe** — Archetyp `chest` des World-Directors (Soll-Bestand
  `WD_COUNT_CHEST`, Vorgabe 1): Modell TreasureChest, Explosionsansicht, ein bis
  drei Stück Beute aus `kampf.mjs` darin. Aufklappen zeigt sie im Kreis,
  „Einsammeln" nimmt sie aus der Truhe (der Server löscht `parent` beim
  Aufheben), beim nächsten Start füllt der Director leere Truhen nach. Auch
  „auf Zuruf" im Spawn-Menü.

Ein Objekt kann andere Objekte enthalten: Schrank → Server → VM → Sensorwert,
UWB-Netz → Anker, Truhe → Beute, später Gebäude → Etage → Raum aus BIM.
Technisch ist das ein schlanker **Szenengraph** in den Daten: Elternverweis plus
lokale Transformation. „Eingeklappt/aufgeklappt" ist eine Darstellungsfrage
darüber, nicht der Graph selbst.

## Entschieden

### Struktur und Logik

| | Entscheidung |
|---|---|
| Baum oder Graph | **Baum**: genau ein Elternobjekt, Feld `parent`. Querbezüge später als eigene Verknüpfung. |
| Tiefe | **höchstens 8 Ebenen**, Zyklen verhindert der Server. |
| Position eines Kindes | **wahlweise relativ oder eigen**: relativer Versatz zum Eltern (bewegt sich mit) ODER eigene Geo-Position (z. B. UWB-Anker). Ohne beides: steht am Elternobjekt. |
| Drehung | **nur um die Hochachse** (ein Heading pro Objekt); Kinder stehen immer aufrecht. Der relative Versatz dreht mit dem Heading des Eltern. |
| Weltposition relativer Kinder | **Server schreibt lat/lon mit** (Hook), bei jeder Änderung von Eltern oder Versatz, für alle Nachfahren. Alles, was an lat/lon hängt (Interest-Area, Karte, Privatsphäre, Agenten, `max_distance`), bleibt unverändert. |
| Löschen mit Kindern | **ausdrücklich angeben**: Kinder mitlöschen ODER eine Ebene höher hängen. Ohne Angabe lehnt der Server ab — für Spieler wie für Agenten. |
| Inventar (`carried_by`) | **vorerst getrennt**. Eine Truhe als Sammelobjekt kann Gegenstände enthalten; Vereinigung mit dem Spieler-Inventar ist ein späterer Schritt. |

### Darstellung

| | Entscheidung |
|---|---|
| Eingeklappt | eigenes Aussehen plus **Abzeichen, konfigurierbar** pro Sammelobjekt: Anzahl, schlimmster Status, beides oder keins (eine Schatztruhe zeigt keinen Status). Kinder unsichtbar. |
| Aufklappen | per **Antippen / Kontextmenü, pro Spieler** (gerätelokal, gemerkt). Der **Besitzer legt einen Standard** fest (aufgeklappt ja/nein), jeder Spieler kann ihn für sich übersteuern. |
| Aufgeklappt | Standard: Kinder **an ihrer Position**, Kinder ohne eigene Lage in einer **Liste** am Elternobjekt. Pro Sammelobjekt umstellbar auf **Explosionsansicht** (Kinder im Kreis/Fächer aufgereiht — für Beute). |
| Status | Standardfeld **`state.status`**: `ok` / `warning` / `error` / `unknown`. Das Elternobjekt zeigt zusätzlich den **schlimmsten Status seiner für den Betrachter sichtbaren Nachfahren**. |

### Berechtigungen

| | Entscheidung |
|---|---|
| Vererbung | **wie NTFS**: Kinder erben die ACEs der Vorfahren, eigene ACEs kommen dazu (Vereinigung). Pro Kind **„Vererbung unterbrechen"**. |
| Kind sichtbar, Eltern nicht | **Kind steht allein in der Welt** an seiner Weltposition; Name und Existenz des Eltern bleiben verborgen. Begründung: Colocation — der Kunde sieht seinen Server im Rechenzentrum, nicht den Schrank des Anbieters. |
| Einhängen / Umhängen | **`edit` am Kind UND am Ziel**. Folge: eine öffentliche Truhe, in die jeder etwas legen darf, geht vorerst nicht (später ggf. Recht `contain`). |
| Zusammenfassung | zählt **nur sichtbare Kinder, im Client gerechnet** — verrät nichts über Verborgenes. |

### Daten, Netz, Bedienung

| | Entscheidung |
|---|---|
| Laden der Kinder | **pro Sammelobjekt einstellbar**: sofort (wie jedes Objekt in der Nähe, eingeklappt nur unsichtbar) ODER erst beim Aufklappen — dann **ohne Zusammenfassung** (folgt aus „nur sichtbare, im Client gerechnet"). |
| Bewegen | **relative Kinder folgen immer**, auch fremde — das Einhängen war beidseitig erlaubt. Kinder mit eigener Geo-Position bleiben stehen. |
| Sammelaktionen | **nicht in der ersten Stufe**. Ein Agent kann am Elternobjekt eigene Aktionen anbieten und selbst verteilen. |
| Einhängen in der Bedienung | Objekt **selektieren**, dann am Sammelobjekt die neue Aktion **„Hierin platzieren"**. Auf der **Karte** zusätzlich **Ziehen auf ein Objekt**, danach Rückfrage „Objekt1 in Objekt2 platzieren?". |

### Einhängen im Detail (Runde 5, 05.11.)

| | Entscheidung |
|---|---|
| Wer ist Sammelobjekt | **nur ausdrücklich markierte** — ein Objekt mit Container-Abschnitt. Nur diese bieten „Hierin platzieren" an; kein versehentliches Einhängen in Baum oder Drachen. |
| Ort nach „Hierin platzieren" | **bleibt, wo es steht**: die Weltposition wird in einen Versatz zum Sammelobjekt umgerechnet. Weiter als ~50 m weg → kommt ans Sammelobjekt, mit Hinweis. |
| Herausnehmen | eigene Aktion **„Herausnehmen"**: eine Ebene höher (oder frei), behält die Weltposition. Rechte: `edit` am Objekt und am bisherigen Sammelobjekt. |

## Umfang der ersten Stufe

**Kern:** Datenmodell, Server-Hooks (Weltposition, Zyklen, Tiefe, Löschen,
Rechte-Vererbung, Einhängen), Darstellung auf Karte und in AR (Abzeichen,
Aufklappen, Liste, Explosionsansicht, Status-Durchschlag), „Hierin platzieren",
„Herausnehmen", Ziehen auf der Karte, Container-Abschnitt im Editor.

**Dazu:**
* **Massenanlage per Agent-API** — ein Aufruf legt einen ganzen Baum an
  (Voraussetzung für NetBox/PRTG).
* **UWB-Netze als Sammelobjekte** — der uwb-anchors-Agent legt Netz-Objekte an
  und hängt seine Anker ein (eigene Geo-Position). Erster echter Nutzer.
* **Beute-Truhe im World-Director** — Truhen mit Gegenständen, Explosionsansicht.

**Nicht in Stufe 1:** Sammelaktionen, Objektliste als Baum, Recht `contain`,
Vereinigung mit dem Spieler-Inventar, volle 3D-Drehung.

## Bedienung (Client, seit 05.11.)

Alles Sichtbare läuft durch `client/core/containers.js` — `worldObjects()`
entscheidet für Karte, AR, Minimap und Nähe-Liste gemeinsam, was gezeigt wird.

* **Eingeklappt** zeigt ein Sammelobjekt sein Symbol, dahinter das Abzeichen
  (Anzahl · schlimmster Status der sichtbaren Nachfahren, je nach `badge`) und
  einen Pfeil ▸. In AR steht das Abzeichen in der Beschriftung (`{badge}` wird
  an die Vorlage angehängt, Objekte ohne Vorlage bekommen `{name} {badge}`).
  Orange bei Warnung, Rot bei Fehler.
* **Aufklappen / Zuklappen** im Kontextmenü des Sammelobjekts. Gilt nur für
  diesen Spieler auf diesem Gerät (`localStorage` `ajna.containers.expanded`);
  ohne eigene Wahl zählt die Vorgabe des Besitzers. Bei „erst beim Aufklappen
  laden" holt der Client die Kinder in diesem Moment nach.
* **Aufgeklappt** stehen die Kinder an ihrer Lage; bei `view: exploded` in
  einem Ring (1,5–6 m, nach Anzahl) um das Sammelobjekt, einen halben Meter
  erhöht — nur in der Darstellung, der Datensatz bleibt unverändert.
* **Hineinlegen:** am Objekt „📌 Zum Platzieren vormerken", dann am
  Sammelobjekt „📥 … hierin platzieren". Es bleibt, wo es steht; weiter als
  50 m entfernt kommt es ans Sammelobjekt, mit Hinweis. Auf der **Karte**
  genügt Ziehen auf das Sammelobjekt, dann die Rückfrage „… in … platzieren?".
  Angeboten wird nur, was der Server auch nähme (gleicher Server, kein Kreis,
  nichts Getragenes, `edit` auf beiden Seiten).
* **Aus dem Rucksack in die Truhe:** im Inventar „📍 Platzieren" wählen und
  dann das Sammelobjekt antippen — auf der Karte seinen Marker, in AR seine
  Figur. Das Stück (oder der ganze Stapel) landet am Sammelobjekt, Versatz 0.
  Tippt man ein gewöhnliches Objekt an, wird an dessen Stelle abgelegt; neben
  alles andere wie bisher. Voraussetzung: `edit` auf dem Sammelobjekt.
* **Herausnehmen** im Kontextmenü oder im Editor — eine Ebene höher, die
  Weltlage bleibt.
* **Editor:** Abschnitt „Sammelobjekt" (Haken „Enthält Objekte", Abzeichen,
  Ansicht, anfangs aufgeklappt, Inhalt laden, Ausrichtung) und bei Kindern
  „Enthalten in" mit Versatz (rechts/vorn/hoch, Drehung) und „Herausnehmen".
* **Löschen** eines Sammelobjekts mit Inhalt fragt: alles mitlöschen oder nur
  das Sammelobjekt (der Inhalt rückt eine Ebene hoch). Weiss der Client den
  Inhalt nicht (nicht geladen), fragt er, wenn der Server 409 sagt.

Agenten (`AjnaManager`): `createTree(objects)`, `loadChildren(id)`,
`deleteObject(id, { children: 'delete' | 'detach' })`.

## Die Schnittstelle (Server, seit 05.11.)

### Felder an `objects` (Migration `1793100000_sammelobjekte.js`)

```
parent      → objects       das Sammelobjekt, in dem dieses Objekt steckt
local       json            { east, north, up, heading } — Versatz in Metern und Grad
                            im Rahmen des Eltern (north = wohin das Eltern blickt,
                            east = rechts davon); leer = eigene Lage
heading     number          Ausrichtung um die Hochachse, Grad im Uhrzeigersinn ab Nord
acl_break   bool            true = erbt die ACEs des Eltern NICHT (Vorgabe false = erbt)
container   json            vorhanden = darf Kinder aufnehmen:
                            { badge: "count"|"status"|"both"|"none",   Vorgabe both
                              view: "placed"|"exploded",               Vorgabe placed
                              expanded: bool,                          Vorgabe false
                              load: "always"|"on_expand" }             Vorgabe always
state.status  "ok"|"warning"|"error"|"unknown"   (Konvention, kein Schema)
```

`acl_break` statt `inherit_acl`: Ein bool-Feld steht für alte Zeilen und für
jedes Anlegen ohne das Feld auf false — „false = erbt" ist die sichere Vorgabe.

### Was der Server beim Schreiben tut (`pb_hooks/hierarchy.js`)

* **Eltern prüfen:** muss existieren, einen `container`-Abschnitt tragen, darf
  nicht getragen sein (`carried_by`), kein Zyklus, höchstens 8 Ebenen
  (Vorfahren + dieses Objekt + sein Teilbaum). Fehler kommen als 400 mit
  `code`: `not_a_container`, `cycle`, `too_deep`, `parent_not_found`,
  `parent_carried`, `bad_local`, `bad_container`.
* **Rechte:** Ändert sich `parent`, braucht der Aufrufer `edit` am Objekt (die
  Regel) UND am neuen wie am bisherigen Sammelobjekt → sonst 403
  `parent_forbidden`. `move` darf `local` und `heading` ändern, `parent` nicht.
* **Lage eines relativen Kindes** — Vorrang in dieser Reihenfolge:
  1. `local` im Aufruf → Weltlage daraus. `local: { from: "world" }` heisst:
     rechne den Versatz aus der aktuellen Weltlage („bleibt, wo es steht").
  2. `lat/lon/altitude/heading` im Aufruf, ohne `local` → der Versatz wird
     aus der neuen Weltlage zurückgerechnet (Gizmo, Ziehen auf der Karte).
  3. neues Kind ohne beides → sitzt am Eltern (`local` = Nullen).
  4. neues Kind mit Weltlage, ohne `local` → eigene Lage, `local` bleibt leer
     (UWB-Anker). Ohne `parent` wird `local` immer geleert.
* **Nachziehen:** Nach jedem Speichern eines Objekts (auch durch Agenten und
  Hooks) bekommen seine relativen Kinder die neue Weltlage; deren Speichern
  zieht die Enkel nach. Geschrieben wird nur, was sich ändert.
* **Verwaiste Kinder** (Eltern am Hook vorbei gelöscht, etwa vom Verfalls-Cron)
  heilen beim nächsten Schreiben zu freien Objekten.
* **Aufheben** (`POST /api/objects/{id}/pickup`) nimmt ein Objekt aus seinem
  Sammelobjekt: `parent` und `local` werden geleert. Was in der Tasche ist,
  liegt in keiner Truhe mehr.

### Rechte-Vererbung (`pb_hooks/permissions.js`)

Für ein Objekt gelten die ACEs seiner Kette: es selbst, dann aufwärts bis zum
ersten `acl_break` (dieses eingeschlossen). Vereinigung, keine Verbote. Der
Cache `effective_permissions` und die Spalten `view_auth`/`view_anon` werden
für den ganzen Teilbaum neu gerechnet, wenn eine ACE, `parent` oder
`acl_break` sich ändert. **Der Besitzer eines Sammelobjekts ist nicht
automatisch Besitzer der Kinder** — `owner` ist ein Feld, keine ACE; wer das
will, setzt sich eine ACE auf das Sammelobjekt.

### Aus dem Inventar in ein Sammelobjekt

`POST /api/objects/{id}/place` mit `{ parent: "<id>" }` statt `lat`/`lon`:
das getragene Objekt verliert seinen Träger und hängt mit Versatz 0 im
Sammelobjekt, Weltlage = Lage des Sammelobjekts. Dieselben Prüfungen wie beim
Einhängen (`not_a_container`, `parent_carried`, `too_deep`, `parent_forbidden`
ohne `edit` auf dem Ziel), danach werden die geerbten Rechte neu berechnet.
Nur der Träger darf das — wie bei jedem `place`.

### Löschen

`DELETE /api/collections/objects/records/{id}` mit Kindern → **409
`has_children`**, bis man sagt, was geschehen soll:

* `?children=delete` — alle Nachfahren mit; nur, wenn der Aufrufer jedes
  einzelne löschen darf (Besitzer oder `owner`-Recht), sonst 403
  `children_not_owned` mit den IDs.
* `?children=detach` — die Kinder rutschen zum Grosseltern (dort waren sie
  schon, sie bekommen nichts Neues) oder werden frei; relative Kinder
  behalten ihre Weltlage.

### Baum in einem Aufruf

```
POST /api/objects/tree
{ "objects": [ { ...Felder wie beim Anlegen, "parent"?: id,
                 "children": [ { ...Felder, "children": [...] } ] } ] }
→ { ok, count, objects: [ { id, children: [ { id, children: [...] } ] } ] }
```

Der Aufrufer wird Besitzer aller Knoten; Wurzeln dürfen `parent` tragen
(braucht `edit` dort). Erst wird alles geprüft (Form, Tiefe, Container,
Quellenanspruch `state.source`), dann angelegt — ohne Transaktion; scheitert
ein Speichern mittendrin, nennt die Antwort unter `created` die bis dahin
angelegten IDs. Höchstens 2000 Knoten je Aufruf. `type: "player"` geht hier
nicht.

### Prüfungen

`pocketbase/pb_hooks/hierarchy.test.mjs` (Geometrie, Formen, Tiefe) und
`tests/privacy/sammelobjekte.mjs` (alles oben am lebenden System).
