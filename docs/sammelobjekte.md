# Sammelobjekte — Entwurf

**Stand 05.11.2026: Fragenkatalog läuft, NICHT freigegeben.** Umgesetzt wird
erst nach ausdrücklichem OK. Offene Fragen stehen unten.

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

## Offen (Runde 5, unterbrochen am 04.11.)

1. **Wer ist Sammelobjekt?** Nur ausdrücklich markierte (mit Container-Abschnitt,
   nur die bieten „Hierin platzieren") — oder jedes Objekt? *Vorschlag: nur markierte.*
2. **Wo landet ein Objekt nach „Hierin platzieren"?** Bleibt, wo es steht (Weltposition
   wird in Versatz umgerechnet; weiter als ~50 m weg → ans Sammelobjekt), immer ans
   Sammelobjekt, oder fragen? *Vorschlag: bleibt, wo es steht.*
3. **Herausnehmen:** eigene Aktion „Herausnehmen" (eine Ebene höher oder frei, behält
   Weltposition; Rechte: `edit` am Objekt und am bisherigen Eltern) — oder nur durch
   Umhängen? *Vorschlag: eigene Aktion.*
4. **Umfang der ersten Stufe**, zusätzlich zum Kern: Massenanlage per Agent-API,
   Objektliste als Baum, UWB-Netze als Sammelobjekte (uwb-anchors-Agent), Beute-Truhe
   im World-Director. *Vorschlag: Massenanlage per Agent-API.*

## Schlüssel in Nutzdaten (Vorschlag, englisch)

```
parent          → objects (single)          Elternobjekt
local           { east, north, up, heading } Versatz in m + Drehung, nur bei relativen Kindern
heading         Grad, Ausrichtung um die Hochachse (am Objekt selbst)
inherit_acl     bool, Standard true          false = Vererbung unterbrochen
container       { badge: "count"|"status"|"both"|"none",
                  view: "placed"|"exploded",
                  expanded: bool,             Standard des Besitzers
                  load: "always"|"on_expand" }
state.status    "ok"|"warning"|"error"|"unknown"
```

Die genaue Form wird mit der Freigabe festgelegt.
