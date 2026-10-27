# Protokoll Telefon ↔ Zeige- und Eingabegeräte (BLE)

Für die Uhr-App (`android/wear`) und jedes weitere Gerät, etwa das
selbstgebaute Kombigerät. Dieselbe Familie wie der Zauberstab: Nordic UART
Service, **eine JSON-Nachricht je Schreibvorgang bzw. Benachrichtigung**.

## Transport

| | UUID |
|---|---|
| Dienst | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` |
| RX (Telefon schreibt) | `6e400002-…` — write / write without response |
| TX (Gerät benachrichtigt) | `6e400003-…` — notify |

* Das Gerät ist **Peripheral** und wirbt mit der Dienst-UUID; der Name steht in
  der Scan-Antwort. Das Telefon verbindet über den Namen (exakt, wie in der
  App eingetragen) oder die Adresse.
* Das Telefon fordert MTU 247 an. Eine Nachricht darf **MTU − 3** Bytes nicht
  überschreiten; was länger wäre, schickt die Uhr nicht.
* Beide Seiten senden der Reihe nach (GATT erlaubt einen laufenden Vorgang);
  das Telefon puffert bis zu 32 Nachrichten, die Uhr 16, ältere fallen zuerst.

## Gerät → Telefon

```jsonc
// sobald das Telefon TX abonniert hat
{"type":"hello","dev":"watch","v":1,"model":"Mobvoi TicWatch Pro 3 Ultra",
 "caps":{"pointing":"absolute","haptics":true,"display":true,"buttons":2,"amplitude":true}}
// pointing: "absolute" (nordbezogen), "relative" (Gier ohne Norden — braucht Kalibrierung), null (keins)

// Ausrichtung, nur nach {"cmd":"stream","on":true}; kompakt, 25-mal je Sekunde
{"type":"o","y":123.5,"p":-4.0,"a":8}
// y Gier in Grad (0 = Norden bzw. Bezug, im Uhrzeigersinn), p Neigung über dem Horizont, a Unsicherheit in Grad

// Rohe Taste — die Bedeutung legt die Belegung im Telefon fest
{"type":"button","code":"stem1","long":false}

// Semantische Aktion — für Touch-Flächen, deren Bedeutung feststeht
{"type":"action","name":"interact_2"}
// aim_toggle, announce_target, select_target, cancel, next_target, prev_target, calibrate, interact_1..4

{"type":"status","battery":81}
```

## Telefon → Gerät

```jsonc
{"cmd":"stream","on":true,"hz":25}      // Ausrichtung senden / aufhören
{"cmd":"haptic","p":[0,25,60,25]}       // Zeiten in ms, aus/an abwechselnd, beginnend mit aus
{"cmd":"view","aiming":true,
 "target":{"name":"Bank","type":"poi","dist":12},
 "locked":null,"actions":["examine"],"acc":9,"notice":null}
{"cmd":"notice","text":"Kalibriert (Schatten): +12°"}
```

Die Haptik kommt als **Zeiten**, nicht als Muster-Nummer: Das Gerät braucht
keine Kopie der Tabelle (`client/core/aim/haptics.js`), und ein neues Muster
braucht kein Geräte-Update.

## Was ein Gerät mindestens tun muss

* werben, verbinden lassen, TX-Benachrichtigungen erlauben,
* `hello` schicken,
* als **Eingabegerät**: `button` oder `action`,
* als **Zeigegerät** zusätzlich: auf `stream` hören, `o` senden,
* mit `haptics: true`: `haptic` abspielen; mit `display: true`: `view` zeigen.

Unbekannte Nachrichten ignorieren, auf beiden Seiten.
