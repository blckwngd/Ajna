# Home Assistant ↔ Ajna über MQTT

Alternative zur direkten [Node-Bridge](homeassistant.md): Ajna und HA reden über
**MQTT** statt über den PocketBase-Client. Vorteile: HA spricht MQTT nativ (kein
per-Sprache-Client nötig), MQTT ist die Lingua Franca im IoT, und die
Verbindungsrichtung passt zur typischen Topologie (HA privat, Ajna öffentlich).

> Status: **Design + HA-Seiten-PoC + Gateway (v1)**. Das Ajna-seitige Gateway
> ([`agents/homeassistant-gateway.mjs`](../agents/homeassistant-gateway.mjs),
> `npm run ha-gateway`) bringt einen **eingebetteten MQTT-Broker (aedes)** mit
> ACL mit und ist end-to-end getestet (HA-Client → Discovery → Controller-Menü).
> HA-Seiten-Artefakte: [`integrations/homeassistant/`](../integrations/homeassistant/).

## Konnektivität — HA verbindet sich zu Ajna (nicht umgekehrt)

MQTT-Clients bauen die Verbindung **ausgehend** auf; danach ist sie über dieselbe
Verbindung **beidseitig** (publish + subscribe).

- Der **Broker steht bei Ajna** (öffentlich erreichbar).
- HA verbindet sich **ausgehend** dorthin (`mqtts://…:8883`) und hält die
  Verbindung offen.
- Darüber **publisht** HA Zustände **und abonniert** Kommandos.

→ **Kein eingehender Port zu HA. Kein Aufruf der HA-REST-API von Ajna.** Das war
die Sorge beim Hybrid-Ansatz — MQTT umgeht sie komplett, weil Kommandos über HAs
*bestehende ausgehende* Subscription laufen.

## Topic-Design (Namespace pro HA-Instanz)

Basis-Topic je Instanz: `ajna/ha/<instance>` (z. B. `ajna/ha/home`). Der
Broker-ACL sperrt den HA-Client genau auf `ajna/ha/<instance>/#`. Das Format
entspricht dem der eingebauten **MQTT-Statestream**-Integration.

| Topic | Richtung | Payload | Zweck |
|---|---|---|---|
| `ajna/ha/<inst>/<domain>/<entity>/state` | HA → Ajna | HA-State (String), z. B. `on` | Zustand + Entdeckung |
| `ajna/ha/<inst>/<domain>/<entity>/attributes` | HA → Ajna | JSON der Attribute | Helligkeit, friendly_name … |
| `ajna/ha/<inst>/<domain>/<entity>/set` | Ajna → HA | `{"service":"turn_on","data":{"brightness_pct":60}}` | Schalt-Kommando |
| `ajna/ha/<inst>/status` | HA → Ajna | `online`/`offline` (LWT) | Verbindungsstatus |

Ablauf „einschalten": Ajna-User interagiert mit „Deckenlicht" → Ajna prüft die
ACE → **Gateway** publisht `ajna/ha/home/light/deckenlicht/set` → HA-Automation
ruft `light.turn_on` → HA-State ändert sich → `…/state` → Gateway zieht das
Ajna-Objekt nach → alle Clients sehen es. Alles über HAs Ausgangs-Verbindung.

## HA-Seite — reines MQTT, kein Custom-Plugin

- **Zustand + Entdeckung:** eingebaute **`mqtt_statestream`**-Integration
  ([`mqtt_statestream.yaml`](../integrations/homeassistant/mqtt_statestream.yaml))
  publisht die State-Changes der freigegebenen Domains. Das Gateway leitet die
  Entitätenliste aus diesen Topics ab → HA „meldet" seine Geräte allein durch
  State-Topics an.
- **Kommandos:** eine **MQTT-getriggerte Automation** aus dem Blueprint
  ([`blueprints/ajna_ha_command.yaml`](../integrations/homeassistant/blueprints/ajna_ha_command.yaml))
  parst `…/<domain>/<entity>/set` und ruft den Service.

Ein Plugin/Blueprint ist reine Politur — **keine neue Fähigkeit**. Setup-Schritte
+ Verifikation: [`integrations/homeassistant/README.md`](../integrations/homeassistant/README.md).

> **Entdeckung/Retain-Hinweis:** `mqtt_statestream` publisht **nicht retained** —
> das Gateway lernt eine Entität erst bei einer Zustandsänderung bzw. nach einem
> HA-Neustart (dann publisht HA alle States neu). Für sofortige Vollständigkeit
> beim Gateway-Start später optional retained „Birth"-Nachrichten pro Entität
> (kleine Startup-Automation) ergänzen.

## Sicherheit — mehrschichtig

1. **Broker-ACL (Topic-Ebene):** der HA-Client authentifiziert sich am Broker
   und ist **hart auf `ajna/ha/<instance>/#` beschränkt**
   ([`mosquitto/aclfile.example`](../integrations/homeassistant/mosquitto/aclfile.example)).
   HA erhält **keinen** Ajna-Login, keinen eingehenden Port, kein API-Token nach innen.
2. **Gateway = einzige Vertrauensgrenze:** nur es übersetzt MQTT ↔ PocketBase,
   als eng gescopter Ajna-User, und legt/ändert **ausschließlich** HA-getaggte
   Objekte (`state.ha_bridge`, `state.ha_instance=<inst>`). PB-Regeln
   (owner-basiert, kein Admin) verhindern Zugriff auf fremde Objekte.
3. **Ajna-ACE regelt Steuer-Rechte:** *wer* ein Geräte-Objekt schalten darf,
   entscheidet die per-Objekt-Berechtigung — geprüft im Ajna-Interact-Hook, bevor
   das Gateway ein Kommando publisht.
4. **HA gibt nur frei, was du willst:** der `include`-Filter in Statestream + der
   Scope der Command-Automation bestimmen, welche Entitäten überhaupt
   exponiert/schaltbar sind.
5. **Mehrere HA-Instanzen isoliert:** je Instanz eigener Namespace + eigene
   Broker-Credentials + `ha_instance`-Tag an den Objekten.

## Gateway (Ajna-Seite) — `agents/homeassistant-gateway.mjs`

Weiterer Node-Agent (geteilte JS-Lib). Bringt einen **eingebetteten MQTT-Broker
(aedes)** mit ACL mit — HA verbindet sich direkt dorthin; extern (Mosquitto/EMQX)
optional per `MQTT_EXTERNAL_URL`. Aufgaben:

- Broker mit **Namespace-ACL**: jeder HA-Client nur auf `ajna/ha/<instance>/#`.
- State-Topics abonnieren → Entitätenliste ableiten → Controller-Objekt + Menü.
- „Entität hinzufügen"/interact → Geräte-Objekt anlegen; Geräte-Aktion → `…/set`
  publishen ({service,data}).
- HA-State → Ajna-Objekt (Zustand/Beschreibung) nachziehen.

**Starten:** `npm run ha-gateway`. Konfiguration (`.env`): `AJNA_URL/USER/PASS`,
`HA_INSTANCE` (Default `home`), `MQTT_PORT` (Default 1883), `MQTT_HA_USER/PASS`
(Zugangsdaten des HA-Clients), optional `MQTT_TLS_CERT/KEY`, `MQTT_EXTERNAL_URL`,
`HA_LAT/HA_LON` (Controller-Koordinaten). In HA die MQTT-Integration auf
`<gateway-host>:<MQTT_PORT>` mit `MQTT_HA_USER/PASS` zeigen lassen.

> **Rechte:** Controller/Geräte-Objekte bekommen die Standardrechte des
> Gateway-Users (wie bei der Node-Bridge) — Profil-Default setzen, sonst
> Startwarnung.
