# Auftrag: Geräteanbindung unterwegs — Zeigegerät, Eingabegeräte, Wear-OS-App

> **Umgesetzt am 27.10.2026** bis auf die Messungen am Gerät. Was gebaut ist und
> wie man es benutzt: `geraete-anbindung.md`, das Protokoll: `geraete-protokoll.md`.
> Dieser Auftrag bleibt als Begründung stehen.

Stand 27.10.2026. Überarbeitete Fassung des ersten Entwurfs, nach Abgleich mit
dem bestehenden Code. Der Auftrag richtet sich an die Instanz, die ihn umsetzt.

## Kontext

Spieler sollen unterwegs (draußen, Bildschirm oft aus, Telefon in der Tasche)
mit Spielobjekten interagieren, ohne durch Menüs zu gehen.

Bedienkonzept:

1. **Peilmodus**: Der Spieler zeigt mit dem Arm in eine Richtung, das Objekt im
   Zielkegel wird anvisiert.
2. Per Geste oder Taste wird der **Objektname angesagt** (TTS, nur auf
   Anforderung, nie automatisch).
3. **Beenden des Peilmodus selektiert** das zuletzt anvisierte Objekt. Der
   Zielstrahl wird zu Beginn der Beenden-Aktion eingefroren, plus Rückblick-
   Puffer: verwendet wird die Richtung von etwa 200 ms vor der Aktion.
4. Danach lösen **Eingaben** Interaktionen mit dem selektierten Objekt aus.
5. **Haptik** meldet Zielwechsel und Objekttyp (Muster je Typ).

Geräte: TicWatch Pro 3 Ultra (Wear OS) als erstes Uhrmodell, ein Standard-
Bluetooth-Controller („Daydream-Nachbau"), später ein selbstgebautes
Kombigerät (Zeigerichtung, Tasten, Haptik).

## Was schon existiert — darauf aufbauen, nicht daneben

| Modul | Was es kann |
|---|---|
| Capacitor-App (`android/`, `webDir: client`) | WebView mit eigenen nativen Plugins: `WandPlugin`, `UwbPlugin`, `SttPlugin`, `LocalServerPlugin` |
| `AccessoryBleService.java` | Foreground-Service (`connectedDevice`), hält BLE bei Bildschirm aus |
| `client/core/WandManager.js` | Zauberstab über BLE: Zeigemodus, **Ziel sperren beim Loslassen**, Interaktionen auf das gesperrte Objekt, Positionen bleiben auf dem Gerät |
| `client/core/PointingResolver.js` | Zielwahl im Kegel mit **Hysterese** (enger Erfassungs-, weiter Haltewinkel), reine Funktion |
| `client/core/WandEventBus.js` | Ereignis-Pipeline mit lokalem Verbrauch oder Weiterleitung |
| `client/core/WandAudioFeedback.js` | TTS-Ansagen — heute **automatisch** beim Zielwechsel, umzubauen auf „nur auf Anforderung" |
| `client/core/VoiceCommandManager.js` | Sprachbefehl auf das gesperrte Objekt |
| `client/core/AccessoryHub.js` | geteilte Zubehör-Sitzung über alle Ansichten |
| `client/core/compassHeading.js`, `headingStabilizer.js` | Kompasskurs des Telefons, Gyro-gestützte Glättung |
| `client/core/solarPosition.js` | Sonnenstand aus Position und Zeit |

**Daraus folgt die Architektur:** `PointingSource` und `InputSource` sind keine
neue Schicht neben dem Zauberstab. Der Zauberstab ist das **erste Gerät**, das
beide Rollen anbietet; seine Ausrichtung wird die erste `PointingSource`, seine
Tasten die erste `InputSource`. `PointingResolver` bleibt die Zielwahl,
`WandEventBus` trägt die semantischen Aktionen. Uhr, Controller und
Kombigerät kommen als weitere Geräte dazu.

## Schritt 1: Analyse und eine Messung — vor jedem Code

**Die Messung zuerst, sie entscheidet über alles Weitere:** Läuft die
Zielwahl in der WebView bei **ausgeschaltetem Bildschirm** in brauchbarer
Rate? Der native Dienst hält BLE wach, aber Android drosselt WebView-Timer im
Hintergrund. Messen: Zauberstab oder Testsender schickt Ausrichtung mit
20 Hz, Telefon im Bildschirm-aus-Zustand, wie oft rechnet `PointingResolver`
tatsächlich? Wenn es nicht trägt: Wake-Lock während des Peilmodus, oder die
Zielwahl wandert nativ in den Dienst. Ergebnis mit Zahlen berichten.

Danach kurz berichten:

- **Controller:** Was kommt an — KeyEvents, D-Pad, Gamepad, oder meldet sich
  das Touchpad als **Maus**? Testweise loggen. Eine Maus bewegt in der
  WebView einen Zeiger und kann in die Oberfläche klicken; dann muss das
  Touchpad nativ abgefangen werden.
- **Bildschirm aus:** Welche Controller-Eingaben kommen dann noch an?
  Erwartung: nur Medientasten, über eine MediaSession im bestehenden Dienst.
  Bestätigen oder widerlegen.
- **Uhr:** Kann die TicWatch als **BLE-Peripheral werben**
  (`BluetoothLeAdvertiser`)? Davon hängt die Transportwahl ab (unten).

Bericht und Einbauvorschlag vorlegen, auf Bestätigung warten.

## Transport Uhr ↔ Telefon

**BLE mit dem Zauberstab-Protokoll** (oder einer Obermenge davon). Die
Telefon-Seite samt Hintergrunddienst steht, das Kombigerät wird dasselbe
Protokoll sprechen. Rückfall nur, wenn die Uhr nicht werben kann: Data Layer
API (setzt Play Services voraus, chinesische Uhrvarianten haben sie nicht).
WebSocket im lokalen Netz scheidet aus — draußen gibt es kein gemeinsames Netz.

Nachrichten klein und binär oder kompaktes JSON:

- Uhr → Telefon: `hello` (Fähigkeiten, siehe unten), `orientation`
  (`yaw`, `pitch`, `accuracy`, `timestamp`), `button`, `status`
- Telefon → Uhr: `target` (Name, Typ, Distanz, mögliche Interaktionen),
  `haptic` (Muster-ID), `mode`, `notice` (kurzer Text), `calibrate`

## Architektur-Prinzipien

- **Zwei Rollen, ein Interface je Rolle, keine weitere Abstraktion.**
  - `PointingSource`: `{yaw, pitch, accuracy, timestamp}` in Weltkoordinaten
    (Norden = 0°), Start/Stop je Quelle. `accuracy` in Grad.
  - `InputSource`: semantische Aktionen.
  - **Fähigkeiten-Deskriptor** je Gerät: `pointing` (`absolute` mit Kompass,
    `relative` nur Gyro, keine), `input`, `haptics`, `display`. Die
    Konfigurations-UI und das Feedback-Routing lesen ihn.
- **Ein Zeigegerät, beliebig viele Eingabegeräte**, getrennt wählbar,
  persistent gespeichert. Ein nicht erreichbares Zeigegerät fällt auf die
  Telefon-Sensoren zurück und meldet das (Haptik oder Ton). Wechsel zur
  Laufzeit: alte Quelle stoppt, bevor die neue startet.
- **Der Zielkegel hängt am Zeigegerät.** Eine Uhr am Handgelenk liegt
  magnetisch oft 10 bis 20 Grad daneben, der Zauberstab-Kegel ist 12 Grad.
  `accuracy` weitet den Kegel.
- **Semantische Aktionen statt Rohtasten:** `aim_toggle`, `announce_target`,
  `select_target`, `cancel`, `interact_1..n`, `next_target`/`prev_target`,
  `calibrate`. Standard-Mapping je Gerät, vom Nutzer anpassbar, über
  `WandEventBus`. Entprellen, Doppelauslösung durch zwei Geräte verhindern.
- **Optional, aber naheliegend: Peilmodus per Armhaltung.** Arm gehoben heißt
  peilen, Arm gesenkt heißt selektieren — passt zum Einfrieren beim Absenken
  und spart eine Taste. Abschaltbar.
- **Feedback-Routing:** Zielwechsel, Selektion, Ergebnis → Haptik-Muster und
  Anzeigedaten an alle verbundenen Geräte mit `haptics`/`display`. TTS nur auf
  `announce_target`, über das Telefon.
- **Akku:** Die Uhr sendet Ausrichtung nur im Peilmodus, 20–30 Hz.
- **Privatsphäre wie beim Zauberstab:** Positionen und Zielwahl bleiben auf
  dem Telefon; zur Uhr gehen nur Name, Typ, Distanz und Aktionen des Ziels.
- **Robustheit:** Abbruch, Neuverbindung, Timeouts. Ohne Zusatzgeräte
  funktioniert das Spiel unverändert.

## Kalibrierung auf eine bekannte Richtung

Löst zwei Probleme: magnetische Störungen bei Geräten mit Kompass, und
**Geräte ohne Magnetometer** (nur Gyro), die damit überhaupt zum Zeigegerät
werden.

- Der Nutzer zeigt auf ein **Ziel bekannter Richtung** und drückt
  `calibrate`. Das Telefon rechnet die Soll-Richtung aus Position, Zeit und
  Ziel und schickt der Quelle den Gier-Versatz.
- Ziele, in dieser Reihenfolge angeboten:
  1. **Der eigene Schatten** — Sonnenazimut + 180°. Man blickt nicht in die
     Sonne, geht auch bei leichter Bewölkung.
  2. **Die Sonne** selbst.
  3. **Ein bekannter Ort** — Kirchturm aus OSM, Ajna-Objekt, Wikipedia-Ort
     der POI-Brücke. Geht nachts und bei Wolken.
- **Plausibilitätstest:** Bei Sonne und Schatten ist auch die Soll-Neigung
  bekannt (Sonnenhöhe). Weicht die gemessene Neigung um mehr als einige Grad
  ab, wird die Kalibrierung abgewiesen und das gemeldet.
- **Drift im Modell:** Für Gyro-Geräte (`TYPE_GAME_ROTATION_VECTOR`, Gier
  relativ) wächst `accuracy` mit der Zeit seit der letzten Kalibrierung; der
  Zielkegel weitet sich von selbst, nach einer einstellbaren Grenze bittet das
  Gerät um neue Kalibrierung. Erst messen, wie stark die TicWatch ohne
  Magnetometer driftet, dann die Rate festlegen.
- Sonnenstand: `client/core/solarPosition.js`, nicht neu schreiben.

## Wear-OS-App — generisch, nicht TicWatch-spezifisch

Kotlin, Compose for Wear OS, **Wear OS 3 und neuer, jede Uhr.** Alles, was
modellabhängig ist, wird zur Laufzeit erkannt und im `hello` gemeldet:

- **Sensoren:** `TYPE_ROTATION_VECTOR` vorhanden → `pointing: absolute`;
  nur `TYPE_GAME_ROTATION_VECTOR` → `pointing: relative` (braucht
  Kalibrierung); keins von beiden → **kein Zeigegerät, aber weiterhin Anzeige
  und Eingabe.** Eine Uhr ohne Kompass ist also nie wertlos.
- **Tasten:** Anzahl und Lage über die `WearableButtons`-API; die
  Standard-Belegung richtet sich danach. Systemseitig belegte Tasten nicht
  verwenden. Fehlen Zusatztasten, bleiben Touch-Flächen und Gesten.
- **Haptik:** `hasAmplitudeControl()` prüfen; Muster mit Amplitude, Rückfall
  auf reine Zeitmuster. Tabelle der Muster an einer Stelle.
- **Anzeige:** rund und eckig, Ambient-Modus mit minimalem Verbrauch.
- **Transport:** BLE-Peripheral, wenn das Gerät werben kann; sonst Data Layer,
  wenn Play Services da sind; sonst meldet die App ehrlich, dass sie dieses
  Telefon nicht erreichen kann.

Inhalt:

- **SensorService** (Foreground Service), aktiv nur im Peilmodus, rechnet auf
  yaw/pitch um, sendet `accuracy` aus dem Sensorstatus.
- **UI:** Peilmodus-Status, anvisiertes Objekt (Icon nach Typ, Name,
  Distanz), Interaktionen als große Touch-Flächen, Kalibrierungs-Knopf mit
  Zielwahl (Schatten, Sonne, Ort).
- **Optional später:** Tile oder Complication für den Schnellstart.

## Reihenfolge der Umsetzung

Kleine, nachvollziehbare Commits. Bestehendes Verhalten ohne konfigurierte
Geräte bleibt unverändert.

1. Messung Hintergrund-WebView, Analysebericht, Bestätigung.
2. Rollen-Interfaces um `WandManager` herum, Zauberstab als erstes Gerät,
   Aktions-Mapping über `WandEventBus`, `announce_target` statt automatischer
   Ansage (Schalter für das alte Verhalten bleibt).
3. Bluetooth-Controller als Eingabegerät, inklusive MediaSession für
   Bildschirm aus.
4. Wear-OS-App: zuerst Anzeige und Eingabe (geht auf jeder Uhr), dann
   Zeigerichtung, dann Kalibrierung.
5. Konfigurations-UI.
6. Kalibrierung auf bekannte Richtung, auch für das Telefon selbst.

## Erwartete Ergebnisse

- Messbericht und Einbauvorschlag, vor dem Code.
- Geräte-/Rollenlogik, Mapping, Konfigurations-UI.
- Controller-Anbindung (Medientasten, Touchpad).
- Wear-OS-App wie oben, auf mindestens zwei Uhrmodellen oder dem Emulator
  geprüft.
- Doku: Geräterollen, Mapping, neues Gerät anbinden, Protokoll Uhr↔Telefon,
  Kalibrierung.
- Tests: ein aktives Zeigegerät, mehrere Eingabegeräte parallel, Rückfall
  bei Verbindungsverlust, Entprellen, Einfrieren mit Rückblick-Puffer,
  Hysterese, Kalibrierungs-Rechnung (Schatten, Sonne, Ort), Abweisen bei
  falscher Neigung, wachsende `accuracy` bei Gyro-Geräten, Uhr ohne Sensoren
  meldet sich als reines Anzeige- und Eingabegerät.

Minimal und direkt bleiben. Bei Unklarheiten im Code oder auf den Geräten
nachfragen statt annehmen.
