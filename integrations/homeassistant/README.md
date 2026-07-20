# Home Assistant in Ajna einbinden — Anleitung für die HA-Seite

## Ziel

Deine Home-Assistant-Geräte (Lampen, Schalter, Rollos …) sollen **in Ajna
auftauchen und dort schaltbar** sein, und ihr echter Zustand soll live angezeigt
werden — schaltet jemand die Lampe am Wandschalter, sieht man das auch in Ajna.

Die Verbindung läuft über **MQTT**, ein einfaches Nachrichtenprotokoll, das Home
Assistant von Haus aus mitbringt. Wichtig für die Sicherheit: **Home Assistant
verbindet sich nach außen** zum Ajna-Server. Es wird **kein Port zu deinem Home
Assistant geöffnet**, und Ajna bekommt **kein Passwort und kein Token** von Home
Assistant.

## Was du brauchst

- Eine laufende **Home-Assistant**-Installation.
- Die Zugangsdaten zum **Ajna-MQTT-Broker** — die bekommst du von der Person, die
  den Ajna-Server betreibt:
  - **Host** und **Port** (öffentlich erreichbar → meist Port `8883` mit TLS),
  - **Benutzername** und **Passwort** für Home Assistant (hier `ha_home` genannt),
  - die **Instanz-Bezeichnung** (Standard: `home`). Sie taucht unten überall im
    Namen `ajna/ha/<instanz>` auf — trag sie überall gleich ein.

> Auf der Ajna-Seite läuft ein Hilfsprogramm („Gateway"), das die Brücke zwischen
> MQTT und Ajna bildet und den MQTT-Broker gleich mitbringt. Du musst davon nichts
> verstehen — du brauchst nur die Zugangsdaten oben.

## Die Dateien in diesem Ordner

| Datei | Wofür |
|---|---|
| `mqtt_statestream.yaml` | Baustein für HAs `configuration.yaml` — lässt HA seine Gerätezustände senden |
| `blueprints/ajna_ha_command.yaml` | Automation-Vorlage — lässt HA auf Schalt-Kommandos reagieren |
| `virtual-test-device.yaml` | Optionale virtuelle Test-Lampe (schaltet nichts Echtes) |
| `mosquitto/*.example` | Nur nötig, falls du deinen **eigenen** Broker betreibst (siehe ganz unten) |

---

## Schritt 1 — Home Assistant mit dem Broker verbinden

In Home Assistant: **Einstellungen → Geräte & Dienste → Integration hinzufügen →
MQTT**.

Trage Host, Port, Benutzer (`ha_home`) und Passwort ein — die Werte aus „Was du
brauchst". Ist der Broker öffentlich erreichbar, nutze die **TLS-Variante**
(Port `8883`); ist das Zertifikat selbst signiert, muss HA ihm einmalig
vertrauen (in der MQTT-Integration das Zertifikat hochladen).

Fragt HA nach **Protokoll** und **Transport**, wähle **MQTT 3.1.1** und **TCP**.
(Der Ajna-Broker spricht MQTT 3.1.1 über TCP — nicht MQTT 5, nicht WebSocket.)

## Schritt 2 — Home Assistant seine Gerätezustände senden lassen

Öffne die Datei [`mqtt_statestream.yaml`](mqtt_statestream.yaml), kopiere ihren
Inhalt in deine `configuration.yaml` und passe zwei Dinge an:

- `base_topic` auf `ajna/ha/<instanz>` setzen (bei Standard-Instanz also
  `ajna/ha/home`).
- Unter `include` eintragen, **welche** Geräte überhaupt sichtbar werden sollen
  (nach Bereich, Domain oder einzelnen Entitäten). Nur was hier steht, verlässt
  dein Home Assistant.

Danach **Home Assistant neu starten**.

## Schritt 3 — Home Assistant auf Schalt-Kommandos reagieren lassen

Damit Schalten aus Ajna auch etwas bewirkt, braucht HA eine Automation:

1. Kopiere [`blueprints/ajna_ha_command.yaml`](blueprints/ajna_ha_command.yaml)
   nach `config/blueprints/automation/ajna/` — **oder** in HA über
   **Einstellungen → Automationen & Szenen → Blueprints → Blueprint importieren**.
2. Lege aus dem Blueprint eine Automation an. Als `command_topic` trägst du
   `ajna/ha/home/+/+/set` ein (die `home` wieder durch deine Instanz ersetzen).

Fertig — deine Geräte erscheinen jetzt in Ajna und lassen sich dort schalten.

---

## Schritt 4 (optional) — Gefahrlos testen mit einer virtuellen Lampe

Damit du nicht am echten Wohnzimmerlicht übst, kannst du eine **virtuelle Lampe**
anlegen, die nichts Echtes schaltet:

- **Einfach (nur An/Aus):** **Einstellungen → Geräte & Dienste → Helfer → Helfer
  erstellen → Umschalter**, Name „Ajna Test-Lampe". Ergibt
  `input_boolean.ajna_test_lampe`.
- **Mit Dimmen:** Inhalt aus [`virtual-test-device.yaml`](virtual-test-device.yaml)
  in die `configuration.yaml` übernehmen → `light.ajna_test_lampe` mit An/Aus
  **und** Helligkeit.

Achte darauf, dass die passende Domain (`input_boolean` bzw. `light`) im
`include` aus Schritt 2 steht. Dann von Ajna aus schalten — nur die virtuelle
Lampe ändert sich, echte Geräte bleiben unberührt.

## Schritt 5 (optional) — Ohne Ajna von der Kommandozeile prüfen

Wenn du kontrollieren willst, ob die MQTT-Verbindung selbst funktioniert
(unabhängig von Ajna), brauchst du die `mosquitto-clients` (`apt install
mosquitto-clients`).

**Sehen, was HA sendet:**
```bash
mosquitto_sub -h <broker> -p 8883 -u ha_home -P <passwort> -t 'ajna/ha/home/#' -v
```
Schaltest du jetzt in HA ein Gerät, erscheinen Zeilen wie
`ajna/ha/home/light/deckenlicht/state on`.

**Ein Schalt-Kommando von Hand senden** (so, wie Ajna es täte):
```bash
mosquitto_pub -h <broker> -p 8883 -u ha_home -P <passwort> \
  -t 'ajna/ha/home/light/deckenlicht/set' \
  -m '{"service":"turn_on","data":{"brightness_pct":60}}'
```
→ das Deckenlicht geht auf 60 %. Ausschalten: `-m '{"service":"turn_off"}'`.
Rollo öffnen: `.../cover/rollo/set -m '{"service":"open_cover"}'`.

---

## Nur falls du deinen eigenen Broker betreibst

Im Normalfall bringt das Ajna-Gateway den Broker schon mit — dann überspring
diesen Abschnitt und nutze einfach die Zugangsdaten aus „Was du brauchst". Willst
du stattdessen einen **eigenen Mosquitto**-Broker fahren, nimm die Beispiel-Dateien
aus [`mosquitto/`](mosquitto/) als Vorlage und lege zwei Benutzer an:

```bash
# Erster Benutzer: -c legt die Passwortdatei NEU an
mosquitto_passwd -c <pfad-zur-passwd> ha_home
# Weitere Benutzer OHNE -c (sonst wird die Datei überschrieben)
mosquitto_passwd    <pfad-zur-passwd> ajna_gateway
```

> **Zum Pfad `<pfad-zur-passwd>`:** Er hängt davon ab, wie Mosquitto installiert
> ist, und muss mit der `password_file`-Zeile in der Broker-Konfiguration
> übereinstimmen. `mosquitto_passwd -c` legt nur die **Datei** an, nicht den
> Ordner — der übergeordnete Ordner muss also schon existieren.
>
> - **Debian/Ubuntu (`apt install mosquitto`):** Konfig liegt unter
>   `/etc/mosquitto/`. Nutze z. B. `/etc/mosquitto/passwd`:
>   ```bash
>   sudo mosquitto_passwd -c /etc/mosquitto/passwd ha_home
>   ```
>   Die Beispiel-Configs gehören nach `/etc/mosquitto/conf.d/`.
> - **Offizielles Docker-Image:** dort existiert `/mosquitto/config/` — daher der
>   Pfad `/mosquitto/config/passwd`. Auf einem nativen Debian gibt es diesen
>   Ordner **nicht**, deshalb schlägt der Docker-Pfad dort fehl.

Die mitgelieferte `aclfile` beschränkt `ha_home` fest auf `ajna/ha/home/#` — HA
kann also nur seinen eigenen Bereich lesen/schreiben. Ist der Broker öffentlich
erreichbar, richte **TLS** ein (Port `8883`). Wie du dafür ein Zertifikat bekommst
— vorhandenes Caddy mitnutzen, Certbot oder selbst signiert — steht in
[`docs/homeassistant.md`](../../docs/homeassistant.md#tls-für-den-broker).

---

## Was noch nicht rund ist

- **Noch nicht gegen eine echte Home-Assistant-Instanz getestet.** Die Snippets
  folgen der offiziellen HA-Doku (Statestream, Blueprint mit MQTT-Trigger) — bitte
  beim Einrichten gegenprüfen. Rückmeldung willkommen.
- **Geräte erscheinen erst, wenn sie sich melden:** HA sendet einen Zustand erst
  bei einer Änderung oder nach einem Neustart. Ein gerade eingebundenes Gerät
  taucht also evtl. erst auf, nachdem du es einmal geschaltet oder HA neu
  gestartet hast.
- **Geschaltet werden kann nur, was du freigegeben hast** — begrenzt durch das
  `include` (Schritt 2) und den Rahmen der Kommando-Automation (Schritt 3).
