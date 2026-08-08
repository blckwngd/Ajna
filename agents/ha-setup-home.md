# Home Assistant ↔ Ajna — Einrichtung (Instanz „home")

## 1. MQTT-Integration verbinden (HA-Oberfläche)
Einstellungen → Geräte & Dienste → Integration hinzufügen → **MQTT**:

| Feld | Wert |
|---|---|
| Broker | `localhost` |
| Port | `8883` |
| Benutzername | `ha_home` |
| Passwort | `sqcQRKNTX0bLyg_qcvVaPAE4` |
| Verschlüsselung | **aktivieren** |

> Selbstsigniertes Zertifikat: beim Verbinden das Zertifikat akzeptieren/pinnen
> (Fingerprint zeigt das Gateway beim Start an).

## 2. Zustände nach Ajna spiegeln (configuration.yaml)
```yaml
mqtt_statestream:
  base_topic: ajna/ha/home
  publish_attributes: true
  include:
    domains:
      - light
      - switch
      # weitere Domains nach Bedarf …
```
Danach HA neu starten. Die freigegebenen Entitäten erscheinen automatisch in Ajna.

## 3. Kommandos aus Ajna ausführen (Automation)
Ajna publisht Kommandos auf `ajna/ha/home/<domain>/<entity>/set`
als JSON `{"service": "...", "data": {...}}`. Eine generische Automation:
```yaml
automation:
  - alias: "Ajna: MQTT-Kommandos ausführen"
    trigger:
      - platform: mqtt
        topic: "ajna/ha/home/+/+/set"
    action:
      - service: "{{ trigger.topic.split('/')[3] }}.{{ (trigger.payload | from_json).service }}"
        target:
          entity_id: "{{ trigger.topic.split('/')[3] }}.{{ trigger.topic.split('/')[4] }}"
        data: "{{ (trigger.payload | from_json).data | default({}) }}"
```

## Sicherheit
- Der Broker sperrt diesen Zugang auf den Namespace `ajna/ha/home/#`.
- HA verbindet sich **ausgehend** — kein offener Port Richtung HA nötig.
- Wer Geräte in Ajna sehen/schalten darf, regeln die Ajna-Berechtigungen.
