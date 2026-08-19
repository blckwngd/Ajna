# Die App

<!-- nav -->
[← Inhalt](Home.md#inhalt) · Benutzen: [Erste Schritte](Erste-Schritte.md) · **Die App** · [Privatsphäre](Privatsphaere.md)
<!-- /nav -->










Der Haupt-Client liegt unter `/` und hat vier Reiter. Daneben gibt es Einzelseiten für Sonderfälle: `/index-map.html` (nur Karte, Desktop-Editor) und `/index-ar.html` (nur 3D/AR, ohne Reiterleiste).

## 🗺 Karte

![Kartenansicht](img/app-karte.png)

Zweidimensionale Übersicht auf Basis von OpenStreetMap. Objekte erscheinen als Symbole an ihren echten Koordinaten.

- **Grundkarte umschalten** (oben rechts): hell, dunkel, Satellit. Die Wahl wird gemerkt.
- **Objekt antippen** öffnet das Aktionsmenü — welche Aktionen erscheinen, hängt von deinen Rechten am Objekt ab.
- **Eigene Objekte verschieben**: mit gedrücktem Zeiger ziehen.
- **Rechtsklick / langes Tippen** auf freie Fläche legt ein neues Objekt an dieser Stelle an.
- **Inhaltsfilter** (Knopf *Filter*): Agents melden an, welche Ebenen sie liefern. Hier wählst du pro Agent aus, was du sehen willst — z. B. POIs ja, WLAN-Netze nein.

## 🥽 AR

![AR-Ansicht mit Minimap](img/app-ar.png)

<sub>Entwicklungs-Instanz mit Testdaten; ohne immersives WebXR ersetzt eine Himmelskuppel das Kamerabild.</sub>

Dieselbe Welt in 3D, am selben Ort stehend. Mit immersivem WebXR mit Kamerabild, sonst als 3D-Vorschau.

- **Beschriftungen** schweben über den Objekten, an einer schmalen Säule zum Boden verankert. Sie skalieren mit der Entfernung; die angeschaute Tafel wird größer. Was draufsteht, bestimmt der Agent über `appearance.label` ([Objektmodell](Objektmodell.md)).
- **Kulisse**: Straßen, Gebäude und Gewässer aus OSM als Drahtgitter, dazu ein Höhenrelief. Beides zieht mit der Kamera mit.
- **Minimap** (🧭): runde Karte des aktuellen Kamerastandorts, nordorientiert, mit Blickkegel. Ziehen verschiebt sie, die vier Eckknöpfe schalten Kartenstil, Zoom und Schließen.
  Objekte im sichtbaren Umkreis erscheinen als reines Symbol und laufen live mit; den Namen zeigt ein Tooltip beim Überfahren (am Telefon beim Antippen). Anfassen lässt sich dort nichts — gehandelt wird in der AR-Ansicht oder auf der großen Karte. Der Inhaltsfilter gilt auch hier.
  Der Ausschnitt folgt der Flughöhe: je höher die Kamera, desto weiter der abgedeckte Radius. Zoomst du von Hand, gilt dein Abstand zur automatischen Stufe weiter — beim Steigen und Sinken zoomt die Karte dann entsprechend mit.
- **Inventar** (🎒) und **Verlauf** (💬) liegen als schwebende Knöpfe daneben.
- **Schnellzugriff**: das anvisierte Objekt zeigt am rechten Rand seine wichtigsten Aktionen.

## 📋 Objekte

Liste der nächstgelegenen Objekte mit Entfernung — nützlich, wenn ein Objekt hinter einer Hauswand liegt oder die Karte zu voll ist. Von hier aus lassen sich dieselben Aktionen auslösen wie auf der Karte.

## Woher ein Objekt stammt

Objekte tragen ein Feld, in dem der anlegende Agent seine Quelle nennt — das ist eine **Selbstauskunft**, kein Nachweis. Die App prüft sie gegen das Konto, dem die Quelle gehört, und zeigt das Ergebnis im AR-Callout, in der Objektliste und im Tap-Menü:

| | |
|---|---|
| **✓ @handle** | Bestätigter Agent dieser Instanz |
| **@handle** | Der Inhaber der Quelle — vom Betreiber aber nicht bestätigt |
| **? quelle** | Quelle auf diesem Server nicht registriert. Kein Verdacht, nur keine Bestätigung |
| **⚠ angeblich @handle** | Gibt sich als fremde Quelle aus. **Inhalt als unbelegt behandeln** |

In Listen erscheint nur die Warnung — sonst ginge sie in Häkchen unter. Gewöhnliche Nutzerobjekte tragen nichts, sie behaupten ja auch nichts.

## ⚙️ Einstellungen

Alle Einstellungen gelten **pro Gerät** und liegen lokal im Browser.

| Abschnitt | Inhalt |
|---|---|
| **Zugang** | Anmelden, abmelden, Server verwalten (mehrere gleichzeitig möglich) |
| **Verwaltung** | Gruppen, Profil, Standard-Rechte für neue Objekte |
| **Privatsphäre** | Standort-Freigabe je Server, siehe [Privatsphäre](Privatsphaere.md) |
| **Audio** | Namen und Aktionen vorlesen lassen |
| **Sichtweite** | Wie weit Objekte, Kulisse und Gelände gezeichnet werden |
| **AR-Ansicht** | Blickfeld, Nord-Offset, Augenhöhe, Kompass-Anzeige, Objekt-Aura, Tracking |
| **Geräte** | Zauberstab und UWB-Module verbinden |
| **Hintergrund** | Verhalten der mobilen App im Hintergrund |
| **Standort** | Quelle der Position, Testmodus |
| **Debug** | Ebenen ein-/ausblenden, Diagnose |

### Sichtweite

![Sichtweiten-Regler](img/app-sichtweite.png)

Drei Regler begrenzen, was die 3D-Ansicht zeichnet — der wirksamste Hebel gegen Ruckeln auf schwachen Geräten.

- **Objekte** — horizontale Entfernung zur Kamera. Ganz rechts heißt unbegrenzt und ist die Voreinstellung; sonst verschwinden Flugzeuge und Schiffe, die naturgemäß weit weg sind.
- **Kulisse** — Gebäude, Straßen, Gewässer, Gleise. Der teuerste Posten.
- **Gelände** — Höhenrelief ringsum. Wird automatisch mindestens so groß wie die Kulisse.

### Mehrere Server gleichzeitig

Unter *Zugang → Server* lassen sich weitere Instanzen hinzufügen. Der Client verbindet sich zu allen und zeigt deren Objekte nebeneinander; Anmeldung, Gruppen und Inventar bleiben **je Server getrennt**. Auch die Standort-Freigabe wird pro Server eingestellt — ein Server, dem du nicht traust, bekommt „Verborgen", während ein anderer „Genau" bekommt.

<!-- navfuss -->
---

← [Erste Schritte](Erste-Schritte.md) · [Inhalt](Home.md#inhalt) · [Privatsphäre](Privatsphaere.md) →
<!-- /navfuss -->
