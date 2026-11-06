# Marker-Spike — ArUco ohne 8th Wall

Beantwortet Schritt 1 aus [docs/marker.md](../../../docs/marker.md):

> **Reicht js-aruco2 (reines JS, ohne OpenCV) auf dem Telefon für Tags von
> 5–7 cm auf 0,5–2 m — bei welcher Bildrate und mit welchem Posen-Rauschen?**

Die Seite braucht keine Sensoren und keine Engine. Sie läuft im normalen
Browser, in Brave und im WebView.

## Ablauf

1. **Tag drucken:** `/poc/marker/print.html?ids=17&mm=60` → Drucken mit 100 %,
   matt, flach aufkleben. `mm` ist die Kante des **schwarzen** Quadrats; die
   weiße Ruhezone gehört dazu.
2. **Kalibrieren** (einmal pro Gerät): Tag in genau 1,00 m Abstand mittig
   zeigen, Seite `/poc/marker/aruco.html?size=0.06&d=1.0` öffnen. Nach ein paar
   Sekunden steht im Kopf „f ≈ NNN px“. Diese Zahl ist die Brennweite des
   Verarbeitungsbilds.
3. **Messen:** `/poc/marker/aruco.html?size=0.06&f=NNN` — Tag aus 0,5 m, 1 m
   und 2 m zeigen, je 10–20 s ruhig halten, dazwischen „Messung neu“. Einmal mit
   `&w=480`, einmal mit `&w=960` wiederholen.
4. **„Protokoll kopieren“** und den Text hierher zurückgeben. Er enthält
   Gerät, Einstellungen, Bildrate, Erkennungszeit (p50/p95) und je ID Abstand und
   Rauschen (σ in mm) der POSIT-Pose.

## Was wir wissen wollen

| Frage | Schwelle |
|---|---|
| Erkennungszeit bei 640 px | unter 15 ms p50 — sonst nur jedes zweite Bild oder kleiner |
| Erkennt der Detektor einen 6-cm-Tag auf 2 m | Seitenlänge ≳ 20 px nötig; bei 640 px Breite und ~70° Sichtfeld sind das ~25 px — knapp |
| Rauschen der Pose in 1 m | σ unter 10 mm in x/y und unter 30 mm in z: brauchbar für den Snap; darüber muss OpenCV.js (solvePnP, Subpixel-Ecken) ran |
| Schräge Sicht (45°) | wird noch erkannt? POSIT-Fehler stabil? |
| Bildrate der Seite | bleibt bei 30 fps, während erkannt wird? |

## Dateien

- `aruco.html` — das Messgerät. Parameter stehen im Kopf der Datei.
- `print.html` — Tags als SVG in exakter Größe, einzeln oder als Blatt (`?ids=0-11`).
- `vendor/` — js-aruco2 2.0.0 unverändert (MIT), siehe `HERKUNFT.txt`.

Nicht Teil dieses Spikes: ArUco **neben** laufendem SLAM. Das misst sich erst im
echten Client, wenn der Detektor an der Bildquellen-Abstraktion hängt (Schritt 2).
