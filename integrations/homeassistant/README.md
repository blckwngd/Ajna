# Home Assistant ↔ Ajna über MQTT — HA-Seite (PoC)

Konfigurations-Artefakte für die **HA-Seite** der MQTT-Anbindung. Design +
Sicherheitsmodell: [`docs/homeassistant-mqtt.md`](../../docs/homeassistant-mqtt.md).

HA verbindet sich **ausgehend** zu einem Ajna-seitigen MQTT-Broker, **publisht**
Gerätezustände und **abonniert** Schalt-Kommandos. Kein eingehender Port zu HA,
kein Ajna-Login/Token in HA.

Das Ajna-seitige **Gateway** (Node) existiert noch nicht — diesen PoC verifizierst
du daher mit `mosquitto_sub`/`mosquitto_pub` (spielt „das Gateway").

## Inhalt

| Datei | Zweck |
|---|---|
| `mqtt_statestream.yaml` | Statestream-Block für HAs `configuration.yaml` (Zustand → MQTT) |
| `blueprints/ajna_ha_command.yaml` | Automation-Blueprint (MQTT-Kommando → Service-Call) |
| `mosquitto/mosquitto.conf.example` | Broker-Konfiguration (Ajna-seitig) |
| `mosquitto/aclfile.example` | Broker-ACL — sperrt HA auf `ajna/ha/<instance>/#` |

## 1. Broker (Ajna-Seite)

Mosquitto mit den Beispiel-Configs starten und zwei Nutzer anlegen:

```bash
mosquitto_passwd -c /mosquitto/config/passwd ha_home       # HA-Client
mosquitto_passwd    /mosquitto/config/passwd ajna_gateway  # Gateway (später)
```

`aclfile` beschränkt `ha_home` auf `ajna/ha/home/#`. Öffentlich erreichbar →
TLS (Port 8883) nutzen.

## 2. HA einrichten

1. **MQTT-Integration** (Settings → Devices & Services → MQTT) auf den
   Ajna-Broker zeigen lassen (Host/Port `8883`, User `ha_home`, Passwort).
2. **Statestream**: Inhalt aus `mqtt_statestream.yaml` in `configuration.yaml`
   übernehmen; `base_topic` = `ajna/ha/home`, `include` auf die gewünschten
   Domains/Entities eingrenzen. HA neu starten.
3. **Kommando-Automation**: `blueprints/ajna_ha_command.yaml` nach
   `config/blueprints/automation/ajna/` kopieren (oder Settings → Automations →
   Blueprints → Import). Eine Automation daraus anlegen; `command_topic` =
   `ajna/ha/home/+/+/set`.

## Virtuelles Testgerät (empfohlen zum Experimentieren)

Damit du nicht an echten Lichtern testest: eine **virtuelle Lampe**, die nur
interne Helfer umschaltet — schaltet NICHTS Echtes.

- **Schnell (An/Aus):** Einstellungen → Geräte & Dienste → **Helfer** → *Helfer
  erstellen* → **Umschalter**, Name „Ajna Test-Lampe" → `input_boolean.ajna_test_lampe`.
  Die Domain `input_boolean` ist bereits im Statestream-`include` → der Gateway
  sieht das Gerät sofort.
- **Volle Lampe mit Dimmen:** `virtual-test-device.yaml` in `configuration.yaml`
  einbinden (template-`light` + Helfer) → `light.ajna_test_lampe` mit An/Aus **und
  Helligkeit** (zum Testen von ±20 %). Domain `light` ist ebenfalls schon inkludiert.

Danach: von Ajna aus schalten/dimmen → nur der Helfer/die virtuelle Lampe ändert
sich, die Familie bleibt im Dunkeln verschont. Für den Umstieg auf echte Geräte
später einfach deren Entitäten ins Statestream-`include` aufnehmen.

## 3. Verifikation (ohne Gateway)

**Zustand sehen** (HA publisht):
```bash
mosquitto_sub -h <broker> -p 8883 -u ha_home -P <pw> -t 'ajna/ha/home/#' -v
```
Ein Schalten in HA (oder ein Neustart) → Zeilen wie
`ajna/ha/home/light/deckenlicht/state on`.

**Kommando senden** (spielt das Gateway):
```bash
mosquitto_pub -h <broker> -p 8883 -u ha_home -P <pw> \
  -t 'ajna/ha/home/light/deckenlicht/set' -m '{"service":"turn_on","data":{"brightness_pct":60}}'
```
→ das Deckenlicht geht auf 60 %. Aus: `-m '{"service":"turn_off"}'`.
Rollo: `.../cover/rollo/set -m '{"service":"open_cover"}'`.

## Grenzen (ehrlich)

- **Nicht gegen eine echte HA-Instanz getestet** — die Snippets folgen der
  HA-Doku (Statestream, Blueprint mit MQTT-Trigger), bitte beim Einrichten
  gegenprüfen. Rückmeldung willkommen, dann justiere ich nach.
- **Entdeckung/Retain:** Statestream publisht nicht retained → das Gateway lernt
  eine Entität erst bei Zustandsänderung / HA-Neustart (siehe Design-Doc).
- **Kommandos** wirken nur auf freigegebene Domains (Whitelist im Blueprint) +
  was Statestream exponiert.
