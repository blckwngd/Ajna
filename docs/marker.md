# Marker — ArUco neben Bild-Targets, Anlage aus dem Objekt, Fixiert/Mobil

> **Status:** Entscheidungen vom 06.11.2026, Umsetzung gestartet. Schritt 1
> (Spike am Gerät) liegt unter `client/poc/marker/`. Der bestehende Bild-Marker-
> Pfad ist in `client/core/MarkerTracking.js` und
> [realworld-remote.md](./realworld-remote.md#marker-zum-ausdrucken-8th-wall-bild-targets)
> beschrieben.

## Ausgangslage

Es gibt heute **einen** Marker-Pfad: Objekte mit `state.marker` werden im
Umkreis von 25 m als Natural-Feature-Targets bei der 8th-Wall-Engine
registriert; die Engine liefert pro Bild die 6DoF-Pose erkannter Bilder, daraus
rechnet `MarkerTracking.computeSnap` die Kameraposition. Das funktioniert für
texturreiche Bilder (Wandbild, Plakat) und **nicht** für Binär-Fiducials wie
ArUco — die Engine sucht Textur, ein Tag hat keine. Einen zweiten Detektor gibt
es nicht.

Gewollt ist beides gleichzeitig: Bild-Marker in Wohnräumen, ArUco-Tags an
Serverschränken, Robotern, Gegenständen.

## Entschieden

### Zwei Detektoren, eine Bildquelle, ein Snap

| Frage | Entscheidung |
|---|---|
| Simultan | **Ja.** Bild-Targets bleiben in der Engine, ArUco läuft als eigener Detektor auf der CPU. Beide liefern dieselbe Größe: Relativpose Kamera↔Marker. |
| Bildquelle | Eine Abstraktion „Frame-Quelle“: im Passthrough-Modus das `<video>` von `ArPassthrough`, im SLAM-Modus die `slam-camerafeed`-Canvas. Der ArUco-Detektor merkt nicht, ob die Engine läuft. |
| 8th Wall schaltbar | **Ja, unabhängig.** Die Umschaltung nach Entfernung (`slamCfg.range`) und der Einstellungs-Schalter bleiben; ArUco läuft in beiden Zuständen weiter. Ziel: in präparierten Umgebungen (Rack, Wohnung mit Markern) kommt der Client **ohne** SLAM aus. |
| Intrinsics ohne Engine | Einmalige Kalibrierung pro Gerät mit einem Tag bekannter Größe in gemessenem Abstand (Brennweite in Pixeln), gespeichert in `localStorage`. Mit Engine kommen sie aus `reality.intrinsics`. |
| Snap | Über die vorhandene **kamera-relative** Variante von `computeSnap` (`relCamM`): Kamera = Marker-Geo − R_Kamera · Relativvektor. Modusunabhängig; die Kamerarotation darf von SLAM oder vom Gyro kommen. |
| Zwischen zwei Markern | Mit SLAM: wie heute (`drTimeS`/`drMaxM`). Ohne SLAM: Gyro für die Rotation, keine Translation. Später (Schritt 5): KLT-Feature-Tracking für Rotationskorrektur und Marker-Nachführung. |
| Detektor | **js-aruco2** (reines JS, ~60 KB für Detektor+POSIT, MIT, Wörterbuch ARUCO_MIP_36h12 mit 250 IDs, Hamming 12). OpenCV.js (~8 MB WASM) nur, wenn der Spike zeigt, dass Genauigkeit oder Schräglage nicht reichen. |

### Optical Flow ersetzt SLAM nicht

Flow liefert 2D-Bildbewegung, keine Pose. Metrische Translation aus einem
Monokularbild braucht Maßstab (IMU-Fusion oder bekannte Objektgröße) und
laufende Driftkorrektur — das ist SLAM. Nachgebaut mit OpenCV.js wäre es ein
Forschungsprojekt bei 20–40 ms pro Frame auf dem Telefon.

Was Flow bei uns leisten soll (Schritt 5): Rotation zwischen Marker-Sichtungen
stabilisieren (Homographie auf ferne Szene), Stillstand erkennen, die Ecken
eines erkannten Tags weiterverfolgen, wenn er für den Detektor zu schräg oder
zu klein wird.

### Marker gehören zum Objekt

| Frage | Entscheidung |
|---|---|
| Anlegen | Im Editor eines Objekts, das man **bearbeiten** darf, Abschnitt „Marker“: **Generieren** (ArUco: der Server vergibt eine freie ID aus dem Wörterbuch, der Client rendert das SVG zum Drucken mit Name und Größe) oder **Bild hochladen** (Natural Feature). Kein freier Marker ohne Objekt. |
| Verknüpfung | Der Marker liegt **am Objekt** (`state.marker`). Ein Objekt mit mehreren Tags (Rack vorn und hinten) kommt später über Sammelobjekte: Marker als Kinder mit `local`-Versatz, die mitwandern und Rechte erben. |
| Lage | Marker-Ursprung = Objektlage, Ausrichtung = `heading` des Objekts (wie heute). |
| ID-Wiederverwendung | Dieselbe Tag-ID darf an verschiedenen Orten vorkommen; die Zuordnung läuft wie heute über den Umkreis (`RADIUS_M`). 250 IDs sind kein globaler Vorrat, sondern ein lokaler. |

### Fixiert und Mobil

Physikalisch ist die Beziehung symmetrisch: Kamera↔Marker-Pose plus Welt-Pose
des Markers ergibt die Kamera-Welt-Pose — oder umgekehrt. Der Schalter
entscheidet, **wem geglaubt wird**, wenn beides nicht zusammenpasst.

| Modus | Referenz | Bei Sichtung |
|---|---|---|
| **Fixiert** (Wandbild, Schrank-Tag) | der Marker | Spielerposition wird korrigiert (Snap). |
| **Mobil mit Telemetrie** (Roboter, dessen Agent die Lage schreibt) | der Marker, solange der Datensatz frisch ist | wie Fixiert, mit Frischeprüfung (`updated` bzw. `state.motion`). |
| **Mobil ohne Telemetrie** (Tracker auf Wagen, Gegenstand) | der Beobachter | das Objekt wird dorthin geschrieben, wo es gesehen wird — mit `move`-Recht, entprellt. |

Der dritte Fall ist der erste echte Nutzer des bisher nirgends durchgesetzten
`move`-Rechts. Ein Beobachter muss kein Spieler sein: eine **fest montierte
Kamera** (Überwachungskamera mit bekannter Lage und Kalibrierung) als Agent
sieht Tags und schreibt Roboter- oder Gegenstandslagen laufend in die Welt —
derselbe Detektor in Node (`js-aruco2` läuft dort, Bilder aus FFMPEG), dieselbe
Bibliotheksmethode. Offen dafür: Regel bei mehreren Beobachtern (zuletzt
gesehen gewinnt; ein Agent mit eigener Telemetrie überstimmt Beobachter).

### Die Anzeige am Marker fixieren

Unabhängig vom Modus: solange ein Marker im Bild ist, wird sein Objekt
**relativ zur erkannten Marker-Pose im Kameraraum** gerendert, nicht über GPS
und Geo-Frame. Mit Sammelobjekten wird daraus das Rack-Bild: Server, Switch und
Sensor sind Kinder mit `local`-Versatz, der Tag an der Front gibt die Pose, die
Anzeige sitzt zentimetergenau auf dem Blech — egal was GPS, Kompass oder SLAM
gerade meinen. Die Spielerkorrektur ist ein Nebenprodukt derselben Messung.

## Datenmodell (Vorschlag, wird in Schritt 3 festgezurrt)

```jsonc
"state": {
  "marker": {
    "kind": "aruco",                      // "image" | "aruco"
    "aruco": { "dict": "ARUCO_MIP_36h12", "id": 17 },
    "image": null,                        // bei kind "image": URL des Targets
    "sizeM": 0.06,                        // Kante des schwarzen Quadrats bzw. Bildbreite
    "mode": "fixed"                       // "fixed" | "mobile"
  }
}
```

Heutige Bild-Marker (`image`, `widthM`) werden beim Lesen auf `kind: "image"`
abgebildet; nichts muss migriert werden. Schlüssel englisch, wie überall in
Nutzdaten.

## Reihenfolge

1. **Spike am Gerät** — `client/poc/marker/` (README dort). Entscheidet
   js-aruco2 gegen OpenCV.js. Braucht Telefon und gedruckten Tag.
2. **Marker-Pfad im Client** — Frame-Quelle, ArUco-Detektor als zweiter
   Lieferant für `computeSnap`, Overlay, `state.marker.aruco`,
   Intrinsics-Kalibrierung, Einstellungs-Schalter getrennt von SLAM.
3. **Anlage aus dem Editor** — Generieren/Hochladen, ID-Vergabe am Server
   (`POST /api/objects/{id}/marker`), Druckansicht, Schalter Fixiert/Mobil.
4. **Marker-relatives Rendern** — Objekt und seine Sammelobjekt-Kinder im
   Kameraraum, solange der Marker sichtbar ist.
5. **Danach** — Gyro+Flow-Brücke zwischen Markern; Mobil ohne Telemetrie mit
   `move` (Client und Kamera-Agent).

## Offen

* Spike-Ergebnis: Bildrate, Erkennungszeit, Rauschen (Schwellen im PoC-README).
* Akku und Bildrate mit **beiden** Detektoren bei laufendem SLAM — erst in
  Schritt 2 messbar.
* Wörterbuch: MIP_36h12 (250 IDs, robust) als Vorgabe; ob ARUCO 7×7 (1023 IDs)
  als zweites angeboten wird, hängt an der Erkennungsrate bei kleinen Tags.
* Mehrere Beobachter im Mobil-Modus; Frischeschwelle für Telemetrie.
