# Visuelles Tracking (SLAM) — Integrations-Spike

> **Status:** Entscheidungsgrundlage für die Verankerung geo-referenzierter
> Objekte in *nicht* präparierten Umgebungen. **Spike-Schritt 1 (Engine liefert
> 6DoF-Pose im WebView) verifiziert** ✅ — `client/poc/slam/index.html`.
> **Schritt 2 (Pose → Babylon, verankerter Würfel) gebaut**, Geräte-Test offen —
> `client/poc/slam/step2.html`. Schritte 3–6 noch offen.

## Problem

Steht der Spieler direkt **vor** einem geo-verankerten Objekt und will damit
interagieren, driftet das Objekt: GPS ist auf dieser Skala blind (Sub-Meter-
Bewegungen), der Kompass driftet, und kleine seitliche Bewegungen erzeugen keine
Parallaxe → das Objekt „klebt am Bildschirm" statt im Raum zu stehen. Die
Gyro-Fusion ([`headingStabilizer.js`](../client/core/headingStabilizer.js)) nimmt
den Heading-Jitter, aber **nicht** die fehlende Translations-Parallaxe — und die
lässt sich per IMU allein nicht lösen (doppelte Integration → quadratische Drift,
Schwerkraft-Leck; nur visuelles Tracking korrigiert das laufend).

- **Präparierte Bereiche:** löst [[UWB]] (cm-genaue absolute Position).
- **Nicht präparierte Umgebungen:** brauchen visuelles Tracking → **SLAM**.

## Warum 8th Wall

Seit Feb 2026 Open Source: die **SLAM-/World-Tracking-Engine** ist ein
kostenloses „Distributed Engine Binary" (Binary-only-Lizenz, kommerziell frei),
das umgebende Framework MIT. **Browserbasiert (WASM), läuft im WebView, plattform-
übergreifend** (eigenes VIO, kein ARCore/ARKit → kein per-Plattform-Nativcode),
**selbst gehostet**. Passt zum self-hosted-/Privatsphäre-Modell. Vorbehalt: der
SLAM-Teil ist ein Binary-Blob; Babylon-Integration ist weniger first-class als
three.js.

## Kernidee: zwei Ebenen, EIN Alignment-Transform `T`

SLAM liefert die Kamera-Pose in einem **eigenen, willkürlichen Weltframe `S`**
(Ursprung = Session-Start, schwerkraft-ausgerichtet, aber Yaw beliebig, kennt
kein Nord). Ajnas Objekte leben im **Geo-/ENU-Frame `G`** (Meter,
[`GeoTransformer`](../client/core/GeoTransformer.js)). Gesucht: der Transform
`T: S → G`.

Weil beide schwerkraft-ausgerichtet und metrisch sind, ist `T` **nur** ein
Yaw + Translation (Scale = 1, kein Pitch/Roll):

```
Kamera_geo = T ∘ Kamera_slam
  T.yaw  = Versatz zwischen SLAM-Yaw und echtem Nord
  T.t    = Geo-Position des SLAM-Ursprungs (wo der Spieler bei Session-Start stand)
```

- **SLAM** liefert `Kamera_slam` pro Frame → schnelle, driftfreie Nahbewegung
  (Parallaxe, stabile Verankerung).
- **`T` wird LANGSAM korrigiert** aus der jeweils besten absoluten Quelle —
  analog zum Komplementärfilter beim Heading (SLAM kurzfristig, absolute Quelle
  langfristig):

  | `T`-Anteil | Absolute Quelle (langsam korrigiert) |
  |---|---|
  | `T.yaw` | fused Kompass-Heading (+ [[WorldMagneticModel]]-Deklination) |
  | `T.t` (nicht präpariert) | GPS-Position, stark tiefpassgefiltert |
  | `T.t` (präpariert) | **UWB** — exakt gesnappt |

**Das ist der springende Punkt: UWB und SLAM konkurrieren nicht, sie komponieren.**
UWB fixt `T.t` präzise, SLAM liefert die glatte Hochfrequenz-Bewegung dazwischen.
Ohne UWB übernimmt GPS die (grobe) Rolle von `T.t` — die Nahbewegung bleibt
trotzdem SLAM-stabil.

## Rendering: EIN Frame, keine zwei Schichten

Der Zwei-Schichten-Ansatz (natives Kamerabild unten, transparentes WebView oben)
ist die bekannte Drift-Falle: die Timestamp-Synchronisation von Bild und Pose
gelingt nicht sauber (siehe google-ar/WebARonARKit). Deshalb:

**Eine Babylon-Szene, ein Render-Loop.** Die 8th-Wall-Engine liefert pro Frame
(a) die Kamera-Pose und (b) die Kamera-Textur. Ajna setzt daraus seine
Babylon-Kamera und zeichnet die Textur als Hintergrund. So gibt es keine
Cross-Layer-Latenz. Die Kamera-**Intrinsics** kommen dann von der Engine → die
[[ArFovCalibration]] (heute FOV-Schätzung) wird weitgehend überflüssig.

## Einbau in Ajna

Ein neues Modul `WorldTracker` (client-seitig), das die heutige GPS+Kompass-
Kamerasteuerung **ersetzt, solange Tracking gut ist**:

```
WorldTracker
  • init: 8th-Wall-Engine laden (Binary self-hosted), Kamerafreigabe, Session
  • pro Frame: pose_S = Engine.getCameraPose()
  • T pflegen:  T.yaw  ← lowpass(fusedCompass)          (bestehende Gyro-Fusion)
                T.t    ← lowpass(GPSProvider) bzw. UWB-Snap
  • Ausgabe:    Kamera_geo = T ∘ pose_S  → Babylon-Kamera (pos + Quaternion)
  • Kamerabild als Szenen-Hintergrund
```

Andockpunkte im Bestand:
- **Kamera:** heute [`CameraComponent`](../client/engine/components/CameraComponent.js)
  + der `onAfterCheckInputs`-Hook (Kompass/Gyro-Fusion) in `main.js`. Der
  WorldTracker treibt dieselbe Kamera, nur aus der SLAM-Pose statt aus dem
  DeviceOrientation-Input.
- **Position/Geo:** [[ajna-gps-flow|GPSProvider]] bleibt die zentrale absolute
  Quelle — jetzt als *langsame* Referenz für `T.t` statt als Pro-Frame-Position.
  UWB fließt weiter über den GPSProvider ein und wird für `T.t` bevorzugt.
- **Objekte:** unverändert. Sie stehen im Geo-Frame; weil die Kamera jetzt
  SLAM-stabil ist, „stehen" sie im Raum und zeigen Parallaxe.

## Interaktion & Privatsphäre — unverändert

Der Spieler zielt/tippt auf das nun **stabil verankerte** Objekt → Point-to-Select
und Tap treffen zuverlässig (der Pick-Ray trifft die feste Position). **Kein**
Eingriff ins Interaktions- oder Privatsphäre-Modell: `interact(objectId, action)`
sendet weiterhin keine Koordinaten, die SLAM-Pose bleibt **on-device** (das
Kamerabild verlässt das Gerät nie) — konsistent mit [[ajna-privacy-stufen]].

## Degradation (Fallback)

SLAM kann ausfallen: kein WebView-Kamerazugriff, verdeckte Kamera, texturlose
Wand („tracking lost"). Dann sauber zurück auf **GPS + Kompass + Gyro-Fusion**
(das heutige Verhalten) und `T` neu ansetzen, sobald Tracking wieder greift. Der
WorldTracker ist also additiv: bricht er weg, ist die App wie heute.

## Risiken / offene Fragen

- **Babylon-Anbindung** der Open-Source-Engine (favorisiert three.js/A-Frame) —
  evtl. Pose-Shim nötig. **Größte Unbekannte:** läuft die Engine überhaupt im
  Capacitor-WebView? (WebXR tut es nicht — muss die WASM-VIO also selbst mitbringen.)
- **Binary-Vertrauen** (SLAM = closed Blob) + Selbst-Hosting des Binaries.
- **Akku/Perf** (SLAM ist CPU/GPU-intensiv) — ggf. nur im „Interaktions-Nahmodus".
- **`T`-Schätzung** ist die eigentliche Ingenieursarbeit (Yaw/Translation-Fusion,
  Recentering bei GPS-Sprung / SLAM-Reset).
- **Community-Zukunft** von 8th Wall nach dem Niantic-Rückzug offen.

## Minimaler Spike (De-Risk-Reihenfolge)

1. **Läuft es im WebView?** 8th-Wall-Engine in der Capacitor-App laden,
   Kamerafreigabe, Pose-Stream + Kamera-Textur rendern. (Beantwortet die größte
   Unbekannte, bevor Integrationsarbeit reingeht.)
2. **Pose → Babylon:** SLAM-Pose in eine Babylon-Kamera, ein Testwürfel an fester
   `S`-Position; bleibt er beim Umhergehen verankert? (Tracking + Babylon-Wiring.)
3. **Geo-Alignment `T`:** Würfel an eine **Geo-Koordinate**; `T` aus GPS+Kompass
   initialisieren; steht der Würfel grob an der richtigen realen Stelle UND bleibt
   bei kleinen Bewegungen fest? (Die Fusion — der eigentliche Beweis.)
4. **UWB-Snap:** in einem präparierten Bereich `T.t` aus UWB statt GPS → prüfen,
   dass sich SLAM-Glätte und UWB-Präzision addieren.
5. **Fallback:** SLAM aus/verloren → zurück auf GPS+Kompass+Gyro, sauberer Wechsel.
6. Erst dann Integration in die echte AR-Ansicht + Interaktion.

**Abbruchkriterium:** Scheitert Schritt 1 (Engine läuft nicht im WebView) oder
Schritt 3 (Alignment bleibt instabil), ist der Weg tot — dann bleibt UWB für
präparierte Bereiche die einzige cm-Lösung, und für den Rest die Gyro-Fusion als
Best-Effort.

**Verwandt:** [[ajna-uwb]], [[ajna-gps-flow]], [[ajna-privacy-stufen]],
[[ajna-architektur-prinzipien]]
