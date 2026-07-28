# Echtwelt-Fernbedienung (Zauberstab) + Objekt-Marker — Konzeptskizze

> **Status: Skizze / Diskussion.** Entscheidungsgrundlage für die telefon-freie
> Interaktion mit präparierten Echtwelt-Objekten. Ergänzt
> [visual-tracking.md](./visual-tracking.md) (SLAM) und [[ajna-uwb]].

## Ziel

Der Spieler/Techniker interagiert mit realen Objekten, **ohne das Telefon in der
Hand zu halten** — es bleibt in der Tasche und übernimmt weiter Compute/Netz
(bestehende `WandManager`/`AccessoryBleService`-Architektur, BLE). Der **Zauberstab**
ist das gehaltene Gerät. Beispiel: ein Techniker zeigt auf ein Gerät im Serverrack
und sieht/hört dessen Zustand oder schaltet es — per GPS/SLAM zu ungenau, UWB
aufwändig, aber Marker am Objekt lösen es exakt.

## Kernidee: Auswahl per Objekt-ID statt Pose-Berechnung

Statt „berechne die Stab-Pose und schneide einen Zeigestrahl mit der Objektwelt"
kehren wir das um: **jedes Objekt sendet seine ID, der Stab empfängt die des
anvisierten Objekts.** Damit entfällt Pose/Triangulation/Kalibrierung — für
Auswahl-und-Handeln oft das eigentliche Ziel.

- **IR-ID-Beacon** am Objekt (moduliert, wie eine Fernbedienung, 38-kHz-Träger).
- **IR-Empfänger** am Stab (Vishay **TSOP**, Cent-Bauteil) mit **engem Kegel**
  (Röhrchen/Linse) → empfängt die ID des am direktesten anvisierten Objekts; der
  TSOP rastet per AGC auf das stärkste Signal → quasi selbst-selektierend.
- Stab → ID per BLE ans Telefon → Ajna handelt / gibt Haptik/Audio-Feedback.

Liefert **Identität** („worauf zeige ich"), **nicht** Position/Pose/Distanz — für
„Objekt wählen & steuern" ausreichend.

## Sensorik am Stab (Baukasten)

| Zweck | Sensor | Anmerkung |
|---|---|---|
| Zeigen/Gesten (Orientierung) | Fusion-IMU (**BNO085**) | absolute Zeigerichtung, Gesten (Flick/Twist) |
| Objekt-Auswahl (Identität) | **TSOP** + enger Kegel | einfachste tragfähige Variante |
| Auswahl **+** grobe Pose | **IR-Kamera** (PixArt/Wiimote) | trennt Quellen räumlich → dekodiert pro Blob ID **und** Bildposition; selbst-kartierend, kollisionsarm |
| cm-Position (keine Sichtlinie) | **UWB** (DW3000) | habt ihr; mehr Infra |
| Identität durch Kontakt | **NFC** (PN532) | Tap statt Zeigen |

**Fusion** = derselbe Komplementärfilter-Gedanke wie SLAM+GPS: IMU schnell/relativ,
IR/Marker/UWB langsam/**absolut**.

## Wake-on-Demand-Interrogation (Energie/Kollision)

1. Stab sendet einen **eng gebündelten** IR-Weck-Burst (Broadcast).
2. Nur Beacons **im Zeigekegel** wachen auf (weniger Strom, weniger Kollision).
3. Sie blinken ihre ID mit **Zufalls-Versatz** (slotted ALOHA) gegen Überlagerung.
4. Stab nimmt den zentralsten/stärksten → alle zurück in Tiefschlaf.

Der Stab (geladenes Gerät, große Batterie) trägt den „teuren" Part (Emitter +
aktives Lauschen); die Objekt-Beacons bleiben fast immer stromlos.

## Energieversorgung der Beacons

**Der Stromfresser ist das Lauschen, nicht das Senden** (ein ID-Blink ≈ 1–2 mC;
vernachlässigbar). Grob (CR2032 ≈ 220 mAh):

| Betriebsart | Ø-Strom | Laufzeit |
|---|---|---|
| Dauer-Blinken | mehrere mA | Tage–Wochen → nur **netz-/host-betrieben** |
| Dauer-Lauschen (TSOP an) | ~0,4–1,5 mA | Wochen–~1 Monat |
| **Wake, Poll-Sleep** (TSOP, ~250–500 ms Poll) | ~10–20 µA | **~1–3 Jahre** |
| **Wake, Flux-Interrupt** (Photodiode + nA-Komparator, z. B. TLV3691) | ~2–5 µA | **~5–8 Jahre** |

- **Poll-Sleep:** robust (TSOP-Bandpass blockt Umgebungslicht), ~0,3–0,5 s Latenz.
- **Flux-Wake:** fast stromlos, sofort — braucht Ambient-Licht-Behandlung
  (modulierter Weck-Burst + Verifikation, sonst weckt die Sonne die Zelle leer).
- Coin-Cell hat hohen Innenwiderstand → **Puffer-Kondensator** (10–100 µF) für die LED-Pulse.

### Randbedingung: OFF-THE-SHELF-Geräte (nicht modifizierbar)
Es geht um **fertige Geräte, deren Hard-/Firmware wir NICHT ändern** können. Also
**kein** interner Rail-Abgriff, **kein** Firmware-Feature — der Beacon ist ein
**eigenständiges Add-on** (Sticker/Gehäuse) mit eigener Energie:
- **Batterie + Wake-on-Demand** (Tabelle oben): Coin-Cell ~1–8 Jahre — der Default.
- **Indoor-PV + Supercap** auf der Oberfläche: batteriefrei, wo Licht ist.
- **Externe Schnittstellen** ohne Öffnen: ein freier **USB-Port** des Geräts (Beacon
  als Mini-Dongle) oder ein **Inline-Passthrough** (Zwischenstecker am Netzteil).
- CT-Spule am Netzkabel: nur um **einen** Leiter, lastabhängig, Puffer/Isolation →
  Nische. **Joule Thief:** Booster, keine Quelle (klärt Missverständnis).

### Kombi-Artefakt (Idee für später): Sticker mit Druck-Marker + IR-Beacon
Ein **Sticker/Gehäuse**, auf dessen Oberfläche ein **AR-Bild-Marker gedruckt** ist
und in dem ein **IR-ID-Beacon** steckt, deckt BEIDE Nutzungen mit EINEM Artefakt:
- **Kamera-AR** (Telefon in der Hand): der passive Druck-Marker → exakte 6DoF-Pose
  (8th-Wall-Bild-Targets, keine Energie nötig).
- **Stab** (Telefon in der Tasche): der aktive IR-Beacon → Identität/Auswahl.

Beide Kanäle tragen **dieselbe Ajna-Objekt-ID** → einmal provisionieren, beide
Modalitäten funktionieren. **Entkopplung:** das Add-on ist reiner räumlicher
Anker/Selektor („wo/welches"); **Zustand & Steuerung** des Geräts laufen weiter über
Ajnas normale Geräte-Integration (z. B. [[ajna-homeassistant-mqtt]]) — das Add-on
weiß nichts über das Gerät, es lokalisiert/identifiziert es nur.

## Einbindung in Ajna

- ID → BLE → Telefon → Ajna. Ersetzt/ergänzt den geometrischen
  [`PointingResolver`](../client/core/PointingResolver.js)-Pick durch einen
  **hardware-sicheren** Pick für präparierte Objekte.
- Provisionierung = Registry **IR-Code ↔ Ajna-Objekt** (beim Einrichten zugeordnet).
- Absolute Referenzen fürs Alignment `T` (aus [visual-tracking.md](./visual-tracking.md)):
  **Marker/IR ≈ UWB > GPS**. SLAM/8th Wall unterstützt zusätzlich **Bild-Targets**
  (`imageTargets`/`imagefound` im Binary verifiziert) → passiver Druckmarker gibt in
  der AR-Ansicht exakte 6DoF-Pose; IR-ID-Beacon gibt in der Stab-Nutzung die Identität.

## Marker zum Ausdrucken (8th-Wall-Bild-Targets)

8th Wall nutzt **Natural-Feature-Targets** (kein Binär-Fiducial wie ArUco), erkennt
also detailreiche Bilder. Was ein gutes Target ausmacht:
- **Viel Struktur/Textur, hoher Kontrast** (viele unterscheidbare Ecken/Kanten).
- **Asymmetrisch, nicht wiederholend** — KEINE Raster/Schachbretter/Symmetrie
  (mehrdeutige Orientierung), kein einfarbiger/leerer Bereich.
- **Matt gedruckt** (kein Glanz → keine Reflexe), **flach** montiert.

Konkret gut: ein **detailreiches Farbfoto** (belebte, texturierte Szene), ein
**dichtes abstraktes/generatives Muster**, ein **feingezeichnetes Logo/Emblem**, oder
die **Beispiel-Targets aus den 8th-Wall-Beispielen**. Schlecht: reiner Text, QR/Raster,
symmetrische oder flächige Motive.

**Größe:** hängt an der Interaktionsdistanz — Faustregel, das Target sollte ≳ 1/10 der
Bildbreite füllen.
- **~10–15 cm** für nahe Interaktion (0,3–2 m, z. B. Serverrack-Front).
- **A4/A3** für größere Distanz.
- **Mehrere Marker** für große Objekte/Racks (SLAM überbrückt dazwischen).
- Die **reale Breite** muss dem System mitgeteilt werden (für den metrischen Maßstab),
  und das Seitenverhältnis des Ausdrucks muss zum registrierten Bild passen.

**Alternative** (falls Natural-Feature auf dem Gerät zu unzuverlässig): klassische
**ArUco/AprilTag**-Fiducials via separatem Detektor — robuster, aber eigener Pfad.

## Offene Fragen

- Kegel-Optik/FOV am Stab (Trefferzone vs. Präzision).
- Ambient-Licht beim Flux-Wake; Code/Protokoll-Standardisierung der Beacons.
- Reichweite (LED-Leistung vs. Augensicherheit), Sichtlinie im Rack.
- Sicherheit/Isolation bei externen Netz-Abgriffen.
- Add-on-Formfaktor: Batterie- vs. PV- vs. USB-Dongle-Beacon; Kombi-Sticker
  (Druck-Marker + IR-Beacon) — Fertigung/Provisionierung.

**Verwandt:** [[ajna-uwb]], [[ajna-homeassistant-mqtt]], [visual-tracking.md](./visual-tracking.md), [[ajna-inventory-konzept]], [[ajna-rule-engine]].
