# Zeigen unterwegs — Zeigegerät, Eingabegeräte, Uhr

Stand 27.10.2026. Spieler interagieren unterwegs mit Spielobjekten, ohne durch
Menüs zu gehen — Telefon in der Tasche, Bildschirm aus. Der Entwurf und seine
Begründungen stehen in `auftrag-geraeteanbindung.md`; hier steht, was gebaut
ist und wie man es benutzt und erweitert.

## Bedienung

1. **Peilen** (`aim_toggle`): Arm in eine Richtung, das Objekt im Zielkegel
   ist anvisiert. Jeder Zielwechsel vibriert, je Objekttyp anders.
2. **Ansagen** (`announce_target`): der Name und die Entfernung, nur auf
   Anforderung, nie von selbst.
3. **Wählen** (`aim_toggle` noch einmal oder `select_target`): Das Ziel wird
   **eingefroren**, und zwar das von 200 ms vor dem Druck — wer beim
   Drücken den Arm sinken lässt, verreißt nicht.
4. **Aktion** (`interact_1` … `interact_4`): die N-te angebotene Aktion des
   gewählten Objekts.
5. **Abbrechen** (`cancel`): Peilen ohne Wahl beenden, oder die Wahl aufheben.
6. **Vor / Zurück** (`next_target`, `prev_target`): durch die Kandidaten im
   Kegel; die Wahl hält 1,5 s gegen die Armbewegung.
7. **Kalibrieren** (`calibrate`): siehe unten.

Optional **Arm heben zum Peilen**: über 35° Neigung startet das Peilen, unter
10° wird gewählt.

## Einrichten

Einstellungen → (erweitert) Geräte → **Zeigen unterwegs**:

* einschalten — vorher tut nichts davon etwas,
* **ein Zeigegerät**: Telefon, Zauberstab oder eine Uhr,
* **beliebig viele Eingabegeräte**: Tasten (App vorn), Bluetooth-Fernbedienung
  (auch bei Bildschirm aus), Uhren,
* Uhren hinzufügen: den Namen eintragen, den die Uhr-App anzeigt,
* Tastenbelegung je Eingabegerät, mit „Taste zuweisen" (die nächste gedrückte
  Taste) und „Zurücksetzen",
* Kalibrieren, und die **Bildschirm-aus-Messung**.

Fällt das Zeigegerät aus (getrennt, oder 2,5 s ohne Werte beim Peilen),
übernimmt das Telefon, es vibriert lang dreimal und sagt es an. Kommt das Gerät
zurück, übernimmt es wieder.

## Die Messung, die zuerst kommt

**Rechnet die Zielwahl bei ausgeschaltetem Bildschirm schnell genug?** Sie
läuft in der WebView. Der Vordergrund-Dienst hält CPU und BLE wach, aber
Android darf eine Seite ohne Bildschirm drosseln. Wenn Ereignisse sekundenlang
liegen bleiben, funktioniert Zeigen in der Tasche nicht, egal was sonst
gebaut ist.

„Bildschirm-aus-Messung starten", Bildschirm aus, nach einer Minute wieder an.
Ergebnis im Verlauf: **trägt**, **trägt eingeschränkt** oder **trägt NICHT**,
mit Ereignissen, Verzögerung und Lücken. Trägt es nicht, sind die Auswege
(nicht gebaut): die Zielwahl nativ in den Dienst verlegen, oder einen
Wake-Lock auf den Bildschirm-Prozess nehmen.

**Gemessen am 27.10. (Fairphone 5, nicht am Ladekabel): trägt.** 1200/1200
Ereignisse, Verzögerung Median 3 ms, 95 % 4 ms, größte Lücke 81 ms. Die
Zielwahl bleibt in der WebView. Aber: Der JS-Takt fiel auf 126/1200, größte
Lücke 1001 ms — Chrome drosselt Zeitgeber einer verdeckten Seite auf einmal pro
Sekunde. **Daraus die Regel für den Zeigepfad:** alles, was schneller als eine
Sekunde sein muss (Halten, Festhalten, Entprellen, lang gedrückt), rechnet mit
Zeitstempeln beim Eintreffen eines Ereignisses, nie mit `setTimeout` oder
`setInterval`. Zeitgeber nur für Dinge, denen eine Sekunde Unschärfe nichts
ausmacht (Ausfall-Wächter, Kalibrierfenster). `tests/run-ui.mjs` hält das fest.
Das Telefon selbst ist bei Bildschirm aus kein Zeigegerät — die Seite bekommt
dann keine Lagesensor-Ereignisse; in der Tasche zeigt die Uhr oder der Stab.

## Geräte

| Gerät | Zeigen | Eingabe | Haptik | Anzeige | Weg |
|---|---|---|---|---|---|
| Telefon | Kompass + Neigung | — | ja | — | `deviceorientationabsolute` |
| Tasten | — | ja, nur App vorn | — | — | `keydown`/`keyup` in der WebView |
| Fernbedienung | — | ja, auch Bildschirm aus | — | — | nativ: Abfang externer Geräte + MediaSession |
| Uhr | absolut, relativ oder keins | ja | ja | ja | BLE, `docs/geraete-protokoll.md` |
| Zauberstab | ja | eigene Wege (`WandManager`) | — | — | BLE, wie bisher |

**Fernbedienung** (`ExternalInput.java`, `AimMediaKeys.java`): Solange sie
aktiv ist, fängt die App Eingaben **externer** Geräte vor der WebView ab — ein
Touchpad, das sich als Maus meldet, bewegt sonst einen Zeiger und klickt in die
Oberfläche. Wischen wird `swipe_left/right/up/down`, Antippen `tap`, Klick
`click`, Tasten heißen wie in `KeyboardEvent.key` (`MediaPlayPause`,
`ArrowLeft`, `Enter`). Die eingebauten Tasten des Telefons bleiben unberührt.
Eine externe Tastatur tippt in dieser Zeit nicht in Textfelder.

Bei **Bildschirm aus** kommen nur Medientasten an, über eine MediaSession;
Android stellt sie der Sitzung zu, die zuletzt Ton abgespielt hat, deshalb
spielt das Einschalten eine Viertelsekunde Stille. Ob ein bestimmtes Telefon
das mitmacht, ist **ungeprüft** — die Messung oben deckt es nicht ab, bitte mit
der Fernbedienung bei Bildschirm aus ausprobieren.

**Uhr** (`android/wear`): eigene App, Wear OS 3 und neuer, jede Uhr. Was die
Uhr kann, erkennt sie selbst und meldet es beim Verbinden:

* Kompass (`TYPE_ROTATION_VECTOR`) → zeigt **absolut**,
* nur Gyro (`TYPE_GAME_ROTATION_VECTOR`) → zeigt **relativ**, wählt erst nach
  einer Kalibrierung ein Ziel,
* keins → **kein Zeigegerät, aber Anzeige und Eingabe** wie jede andere Uhr,
* Tasten über `WearableButtons`, Vibration mit oder ohne Amplitude.

Die Uhr zeigt Ziel, Peilen/Wählen, die Aktionen des gewählten Objekts als große
Flächen, Ansagen, Abbrechen, Kalibrieren und die Wahl des Handgelenks (das
Zifferblatt liegt links andersherum als rechts). Ihre Hardware-Tasten schickt
sie als Rohcodes (`stem1`, `stem2`); was sie bedeuten, legt die Belegung im
Telefon fest. Die Uhr sendet Ausrichtung nur, solange das Telefon darum bittet
(beim Peilen und Kalibrieren), mit 25 Hz.

## Kalibrieren

Auf ein Ziel bekannter Richtung zeigen, still halten, auslösen (Knopf im
Telefon, auf der Uhr, oder die Aktion `calibrate`). Die App mittelt 0,6 s und
speichert den Versatz **je Gerät**:

| Ziel | Richtung | Prüfung |
|---|---|---|
| eigener Schatten | Sonnenazimut + 180° | Arm zeigt nach unten |
| Sonne | Sonnenazimut | Neigung ≈ Sonnenhöhe (±15°) |
| bekannter Ort | Peilung zum Ort (POI, Figur in 30 m – 3 km) | keine |

Sonne und Schatten nur, wenn sie mindestens 3° über dem Horizont steht;
`calibrate` von einer Taste nimmt den Schatten. Bei einem relativen Gerät wächst
die Unsicherheit mit der Zeit seit der Kalibrierung (Vorgabe 1,5°/min,
**ungemessen** — an der Uhr messen und dann je Gerät setzen), und der Zielkegel
weitet sich mit.

## Ein neues Gerät anbinden

**Mit BLE** (das Kombigerät, eine andere Uhr): das Protokoll in
`geraete-protokoll.md` sprechen, mehr nicht. In der App als Uhr hinzufügen —
der Name ist der beworbene BLE-Name.

**Anders** (ein neuer Weg): ein Objekt nach `client/core/aim/devices.js`
bauen — `id`, `label`, `kind`, `caps`, dazu je nach Fähigkeit
`startPointing(onSample) → stop`, `onInput(cb) → unsubscribe`,
`onStatus(cb)`, `haptic(pattern)`, `display(view)` — und in
`AimSession.js` registrieren. Ein neuer `kind` bekommt seine Standardbelegung
in `inputMapping.js`.

## Was noch offen ist

* Medientasten bei Bildschirm aus mit der echten Fernbedienung.
* Driftrate einer Uhr ohne Magnetometer.
* Zauberstab-Tasten als semantische Aktionen, sobald die Firmware sie schickt —
  bis dahin wählt der Stab weiter über Knopf 2 (WandManager).
* Kachel oder Komplikation auf der Uhr für den Schnellstart.
* Ob eine Uhr ohne `BluetoothLeAdvertiser` vorkommt; dann wäre die Data Layer
  API der Rückfall (braucht Play Services und dieselbe App-Kennung).

## Bauen

```
npm run mobile:run          Telefon-App (nur :app)
npm run wear:run            Uhr-App auf die per adb verbundene Uhr
npm run wear:run -- <serial>
```

Die Uhr über Drahtlos-Debugging verbinden (Entwickleroptionen → Drahtloses
Debugging, dann `adb pair` und `adb connect`).

## Code

| | |
|---|---|
| `client/core/aim/AimController.js` | Peilmodus als Zustandsmaschine |
| `client/core/aim/DeviceManager.js` | Rollen, Rückfall, Mapping, Feedback, Kalibrierung |
| `client/core/aim/devices.js` | Telefon, Tasten, Fernbedienung, Uhr, Zauberstab |
| `client/core/aim/aimMath.js` | Richtungen, Kalibrierung, Drift |
| `client/core/aim/inputMapping.js` | Aktionen, Standardbelegungen, Entprellen |
| `client/core/aim/haptics.js` | die Mustertabelle |
| `client/core/aim/probe.js` | Auswertung der Bildschirm-aus-Messung |
| `android/app/…/aim/` | `AimDevicesPlugin`, `ExternalInput`, `AimMediaKeys`, `AimBridge` |
| `android/wear/` | die Uhr-App |
