# Home Assistant ↔ Ajna

Smart-Home-Geräte aus Home Assistant (HA) in Ajna **sichtbar und schaltbar**
machen. Es gibt **zwei Wege** mit demselben Ergebnis (ein Controller-Objekt,
Geräte als Spielobjekte, Live-Zustand, Interaktions-Aktionen), aber
unterschiedlicher Topologie — **nur einer wird gebraucht:**

| | **MQTT-Gateway** (empfohlen) | **Node-Bridge** |
|---|---|---|
| Agent | [`agents/homeassistant-gateway.mjs`](../agents/homeassistant-gateway.mjs) | [`agents/homeassistant-bridge.mjs`](../agents/homeassistant-bridge.mjs) |
| läuft auf | **Ajna-Server** | **HA-Maschine** |
| HA-Kopplung | MQTT (Statestream + Blueprint), kein Plugin | HA-WebSocket/REST mit Long-Lived Token |
| Verbindungsrichtung | HA → Ajna-Broker (**ausgehend**) | Agent → HA (localhost) + Agent → Ajna |
| HA-Token | **keiner** nötig | bleibt auf der HA-Maschine |
| Vorteil | HA bleibt privat, kein Ajna-Projekt auf dem HA-Host | zwei-Wege-Live-Sync per WebSocket, sofort vollständig |
| Start | `npm run ha-gateway` | `npm run ha-bridge` |

> Status: Beide sind Node-Agenten (geteilte JS-Lib). Das MQTT-Gateway bringt einen
> **eingebetteten MQTT-Broker (aedes)** mit ACL mit und ist end-to-end getestet
> (HA-Client → Discovery → Controller-Menü). HA-Seiten-Artefakte:
> [`integrations/homeassistant/`](../integrations/homeassistant/).

## Gemeinsame Konzepte (beide Wege)

1. **Controller-Objekt** an `HA_LAT`/`HA_LON`: Sein Kontextmenü (`state.actions`)
   listet die nutzbaren HA-Entitäten.
2. **Entität hinzufügen:** Klick auf eine Entität → ein **Geräte-Objekt** in der
   Szene (z. B. „Deckenlicht" 💡 mit *Einschalten / Ausschalten / Heller /
   Dunkler*), mit dem aktuellen HA-Zustand. Danach frei verschieb-/bearbeitbar,
   mehrfach anlegbar (dieselbe Entität an mehreren Orten).
3. **Steuern:** Interaktion auf einem Geräte-Objekt → HA-Service-Call
   (`light.turn_on`, `cover.open_cover`, …).
4. **Live-Sync (zwei-Wege):** Der echte Zustand wird in Echtzeit nachgezogen —
   auch bei EXTERNEN Änderungen (Licht per Wandschalter an → Objekt zeigt „an").

Steuerbare Domains: `light`, `switch`, `input_boolean`, `fan`, `cover`, `lock`,
`climate`, `media_player`, `scene`, `script`.

### Berechtigungen (beide Wege)

Es werden **keine** Rechte hartcodiert. Controller- und Geräte-Objekte entstehen
mit den **Standardrechten des Gateway-/Bridge-Users** (Server-Hook, aus
`users.default_permissions`) und sind danach **pro Objekt frei anpassbar**
(Kontextmenü → Berechtigungen).

> **Wichtig:** Damit andere Nutzer die Geräte sehen und schalten dürfen, muss das
> **Profil des Gateway-/Bridge-Users** unter „Standardrechte" der Zielgruppe
> (Gruppe oder `authenticated`) `view` **und** `interact` = `*` geben. Ohne
> Default gehören die Objekte nur diesem User und sind für andere unsichtbar —
> der Agent warnt beim Start entsprechend.

---

## Weg A — MQTT-Gateway (empfohlen)

Ajna und HA reden über **MQTT** statt über den PocketBase-Client. HA spricht MQTT
nativ (kein per-Sprache-Client nötig), und die Verbindungsrichtung passt zur
typischen Topologie (HA privat, Ajna öffentlich).

### Konnektivität — HA verbindet sich zu Ajna (nicht umgekehrt)

MQTT-Clients bauen die Verbindung **ausgehend** auf; danach ist sie über dieselbe
Verbindung **beidseitig** (publish + subscribe).

- Der **Broker steht bei Ajna** (öffentlich erreichbar; das Gateway bringt ihn mit).
- HA verbindet sich **ausgehend** dorthin (`mqtts://…:8883`) und hält offen.
- Darüber **publisht** HA Zustände **und abonniert** Kommandos.

→ **Kein eingehender Port zu HA. Kein Aufruf der HA-API von Ajna.** Kommandos
laufen über HAs *bestehende ausgehende* Subscription.

### Topic-Design (Namespace pro HA-Instanz)

Basis-Topic je Instanz: `ajna/ha/<instance>` (z. B. `ajna/ha/home`). Der
Broker-ACL sperrt den HA-Client genau auf `ajna/ha/<instance>/#`. Format wie bei
HAs eingebauter **MQTT-Statestream**-Integration.

| Topic | Richtung | Payload | Zweck |
|---|---|---|---|
| `ajna/ha/<inst>/<domain>/<entity>/state` | HA → Ajna | HA-State (String), z. B. `on` | Zustand + Entdeckung |
| `ajna/ha/<inst>/<domain>/<entity>/attributes` | HA → Ajna | JSON der Attribute | Helligkeit, friendly_name … |
| `ajna/ha/<inst>/<domain>/<entity>/set` | Ajna → HA | `{"service":"turn_on","data":{"brightness_pct":60}}` | Schalt-Kommando |
| `ajna/ha/<inst>/status` | HA → Ajna | `online`/`offline` (LWT) | Verbindungsstatus |

Ablauf „einschalten": Ajna-User interagiert mit „Deckenlicht" → Ajna prüft die
ACE → **Gateway** publisht `ajna/ha/home/light/deckenlicht/set` → HA-Automation
ruft `light.turn_on` → HA-State ändert sich → `…/state` → Gateway zieht das
Ajna-Objekt nach → alle Clients sehen es.

### HA-Seite — reines MQTT, kein Custom-Plugin

- **Zustand + Entdeckung:** eingebaute **`mqtt_statestream`**-Integration
  ([`mqtt_statestream.yaml`](../integrations/homeassistant/mqtt_statestream.yaml))
  publisht die State-Changes der freigegebenen Domains. Das Gateway leitet die
  Entitätenliste aus diesen Topics ab → HA „meldet" seine Geräte allein durch
  State-Topics an.
- **Kommandos:** eine **MQTT-getriggerte Automation** aus dem Blueprint
  ([`blueprints/ajna_ha_command.yaml`](../integrations/homeassistant/blueprints/ajna_ha_command.yaml))
  parst `…/<domain>/<entity>/set` und ruft den Service.

Setup-Schritte + Verifikation:
[`integrations/homeassistant/README.md`](../integrations/homeassistant/README.md).

> **Entdeckung/Retain-Hinweis:** `mqtt_statestream` publisht **nicht retained** —
> das Gateway lernt eine Entität erst bei einer Zustandsänderung bzw. nach einem
> HA-Neustart (dann publisht HA alle States neu). Für sofortige Vollständigkeit
> beim Gateway-Start später optional retained „Birth"-Nachrichten pro Entität.

### Gateway-Konfiguration (`.env`)

| Variable | Default | Zweck |
|---|---|---|
| `AJNA_URL` / `AJNA_USER` / `AJNA_PASS` | `http://127.0.0.1:8090` / – / – | Ajna-Login (Gateway-User; seine Standardrechte gelten für die Objekte) |
| `HA_INSTANCE` | `home` | Namespace/Instanz — muss zu `base_topic` (Statestream) passen |
| `MQTT_PORT` | `1883` | Broker-Port (für TLS konventionell `8883` setzen) |
| `MQTT_HA_USER` / `MQTT_HA_PASS` | – | Zugangsdaten des HA-Clients (Pflicht beim eingebetteten Broker) |
| `MQTT_GATEWAY_USER` / `MQTT_GATEWAY_PASS` | `ajna_gateway` / zufällig | interner Gateway-Client (nur localhost) |
| `MQTT_EXTERNAL_URL` | – | externen Broker (Mosquitto/EMQX) statt des eingebetteten nutzen |
| `HA_LAT` / `HA_LON` | `50.3569` / `7.5890` | Controller-Koordinaten |
| `MQTT_TLS_*` | – | TLS, siehe nächster Abschnitt |

**Start:** `npm run ha-gateway` (oder in `ecosystem.config.cjs` unter PM2). In HA
die MQTT-Integration auf `<gateway-host>:<MQTT_PORT>` mit `MQTT_HA_USER/PASS`
zeigen lassen. Beim eingebetteten Broker brauchst du **kein** `mosquitto_passwd`
— das Gateway authentifiziert `MQTT_HA_USER/PASS` selbst.

### TLS für den Broker

Der Broker ist öffentlich erreichbar und HA verbindet sich über das Internet —
**TLS ist Pflicht** (Verschlüsselung + Server-Authentifizierung). Drei Wege:

**1. Echtes Zertifikat (empfohlen bei eigener Domain).** Für den Broker-Hostnamen
ein Zertifikat besorgen, z. B. per Let's Encrypt:

```bash
certbot certonly --standalone -d mqtt.example.com
# → /etc/letsencrypt/live/mqtt.example.com/{fullchain,privkey}.pem
```
```dotenv
MQTT_PORT=8883
MQTT_TLS_CERT=/etc/letsencrypt/live/mqtt.example.com/fullchain.pem
MQTT_TLS_KEY=/etc/letsencrypt/live/mqtt.example.com/privkey.pem
```
HA vertraut dem automatisch (öffentliche CA). Nach der Zertifikats-Erneuerung das
Gateway neu starten (es liest die Dateien beim Start).

**2. Gateway generiert selbst signiert (am einfachsten).** Ohne eigene Domain:

```dotenv
MQTT_PORT=8883
MQTT_TLS_AUTO=1
# optional: Namen/IPs, unter denen HA den Broker erreicht (CSV), fürs SAN:
MQTT_TLS_SAN=mqtt.fritz.box,192.168.1.10
# optional: MQTT_TLS_CN (Default Hostname), MQTT_TLS_DIR (Default .ha-gateway-tls/)
```

Beim ersten Start erzeugt das Gateway per `openssl` ein selbst signiertes
Zertifikat, **persistiert** es in `MQTT_TLS_DIR` und **verwendet es bei jedem
Neustart wieder** (stabiler Fingerprint — HA „pinnt" das Zertifikat, ein bei
jedem Boot neues würde das Vertrauen brechen). Der Start-Log zeigt den
**SHA-256-Fingerprint**. `MQTT_TLS_CN` + `MQTT_TLS_SAN` landen als SAN im
Zertifikat (sonst schlägt HAs Hostname-Prüfung fehl).

> Weil es selbst signiert ist, muss **HA ihm einmalig vertrauen**: in der
> MQTT-Integration das Broker-Zertifikat hochladen. Alternativ die Prüfung
> deaktivieren — dann ist die Verbindung *verschlüsselt, aber nicht
> authentifiziert* (theoretisch MITM-anfällig).
> Voraussetzung serverseitig: `openssl` im `PATH` (auf Linux-Servern üblich).

**3. Manuell selbst signiert** (falls du das Zertifikat lieber selbst erzeugst):

```bash
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout key.pem -out cert.pem -subj "/CN=mqtt.example.com" \
  -addext "subjectAltName=DNS:mqtt.example.com,IP:192.168.1.10"
```
Dann `MQTT_TLS_CERT`/`MQTT_TLS_KEY` darauf zeigen lassen (wie Weg 1).

### Sicherheit — mehrschichtig

1. **Broker-ACL (Topic-Ebene):** der HA-Client ist **hart auf
   `ajna/ha/<instance>/#` beschränkt**. HA bekommt **keinen** Ajna-Login, keinen
   eingehenden Port, kein API-Token nach innen.
2. **Gateway = einzige Vertrauensgrenze:** nur es übersetzt MQTT ↔ PocketBase, als
   eng gescopter Ajna-User, und legt/ändert **ausschließlich** HA-getaggte
   Objekte (`state.ha_bridge`, `state.ha_instance=<inst>`). PB-Regeln (owner-
   basiert, kein Admin) verhindern Zugriff auf fremde Objekte.
3. **Ajna-ACE regelt Steuer-Rechte:** *wer* ein Geräte-Objekt schalten darf,
   entscheidet die per-Objekt-Berechtigung — geprüft im Interact-Hook, bevor das
   Gateway ein Kommando publisht.
4. **HA gibt nur frei, was du willst:** der `include`-Filter in Statestream + der
   Scope der Command-Automation bestimmen, welche Entitäten überhaupt
   exponiert/schaltbar sind.
5. **TLS:** verschlüsselt die Verbindung + authentifiziert den Broker (s. o.).
6. **Mehrere HA-Instanzen isoliert:** je Instanz eigener Namespace + eigene
   Broker-Credentials + `ha_instance`-Tag an den Objekten.

---

## Weg B — Node-Bridge

Der Agent läuft **lokal auf der Home-Assistant-Maschine**: spricht HA über
`localhost` an (der Token verlässt die Maschine nicht) und verbindet sich zum
Ajna-Server. Ein HA-WebSocket-Abo (`state_changed`) zieht den echten
Gerätezustand in Echtzeit in die Objekte nach.

### Home-Assistant-Token

In HA: **Profil → Sicherheit → Long-Lived Access Tokens → Token erstellen**. Als
`HA_TOKEN` in die `.env` legen (nie committen — `.env` ist gitignored).

### Konfiguration (`.env`)

| Variable | Pflicht | Default | Zweck |
|---|---|---|---|
| `AJNA_URL` | – | `http://127.0.0.1:8090` | Ajna-Server |
| `AJNA_USER` / `AJNA_PASS` | ✓ | – | Bridge-User (dedizierter Ajna-Account) |
| `HA_URL` | – | `http://127.0.0.1:8123` | Home-Assistant-URL |
| `HA_TOKEN` | ✓ | – | Long-Lived Access Token |
| `HA_LAT` / `HA_LON` | – | `50.3569` / `7.5890` | Controller-Koordinaten |
| `HA_DOMAINS` | – | alle steuerbaren | CSV: nur diese Domains (z. B. `light,switch`) |
| `HA_ENTITIES` | – | – | CSV-Allowlist konkreter `entity_id`s |
| `HA_REFRESH_S` | – | `300` | Entitätenliste alle N s neu einlesen |
| `HA_POLL_S` | – | `30` | Zustands-Poll als WS-Fallback |

```dotenv
AJNA_URL=https://ajna.example.com
AJNA_USER=ha-bridge@example.com
AJNA_PASS=…
HA_URL=http://127.0.0.1:8123
HA_TOKEN=eyJ…
HA_LAT=50.44658
HA_LON=7.59706
# optional eingrenzen:  HA_DOMAINS=light,switch,cover   HA_ENTITIES=light.deckenlicht
```

### Starten

Auf der HA-Maschine, im Ajna-Projektverzeichnis: `npm run ha-bridge`. Dauerbetrieb
am besten unter einem Prozessmanager **auf der HA-Maschine** (nicht im
Server-PM2, da anderer Host):

```bash
pm2 start agents/homeassistant-bridge.mjs --name ha-bridge --time && pm2 save
```

### Grenzen / Ausblick

- Das Controller-**Kontextmenü** wird bei sehr vielen Entitäten lang (es scrollt
  nicht). Mit `HA_DOMAINS` / `HA_ENTITIES` eingrenzen. Ein durchsuchbarer
  Entitäten-Picker-Dialog wäre die schönere UX (Client-Erweiterung, offen).
- Licht: `Heller`/`Dunkler` ändern die Helligkeit relativ um ±20 % (unter 0 % →
  aus, über 100 % gedeckelt). `climate` ändert die Zieltemperatur um ±0,5 °.
- Area-/Label-basierte Auswahl (statt Domains/Allowlist) bräuchte die
  HA-WebSocket-Registry-API — bewusst noch nicht umgesetzt.
