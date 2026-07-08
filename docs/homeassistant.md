# Home-Assistant-Bridge

Der Agent [`agents/homeassistant-bridge.mjs`](../agents/homeassistant-bridge.mjs)
macht Smart-Home-Geräte aus Home Assistant (HA) in Ajna sichtbar und steuerbar.

Er läuft **lokal auf der Home-Assistant-Maschine** (spricht HA über `localhost`
an, der Token verlässt die Maschine nicht) und verbindet sich zum Ajna-Server.

## Funktionsweise

1. **Controller-Objekt** an `HA_LAT`/`HA_LON`: Sein Kontextmenü (`state.actions`)
   listet alle nutzbaren HA-Entitäten.
2. **Entität hinzufügen:** Klick auf eine Entität im Controller-Menü → der Agent
   legt ein Geräte-Objekt in der Szene an (z. B. „Deckenlicht" 💡 mit den
   Aktionen *Einschalten / Ausschalten / Heller / Dunkler*) — mit dem aktuellen HA-Zustand.
   Das Objekt ist danach frei verschieb- und bearbeitbar.
3. **Steuern:** Interaktion auf einem Geräte-Objekt → HA-Service-Call
   (`light.turn_on`, `cover.open_cover`, …).
4. **Live-Sync (zwei-Wege):** Ein HA-WebSocket-Abo (`state_changed`) zieht den
   echten Gerätezustand in Echtzeit in die Objekte nach — auch bei EXTERNEN
   Änderungen (Licht per Wandschalter an → Objekt zeigt „an").

Steuerbare Domains: `light`, `switch`, `input_boolean`, `fan`, `cover`, `lock`,
`climate`, `media_player`, `scene`, `script`. Mehrfaches Anlegen derselben
Entität ist erlaubt (dieselbe Entität kann an mehreren Orten liegen).

## Berechtigungen

Es werden **keine** Rechte hartcodiert. Controller und Geräte-Objekte werden mit
den **Standardrechten des Bridge-Users** angelegt (Server-Hook, aus
`users.default_permissions`) und sind danach **pro Objekt frei anpassbar**
(Kontextmenü → Berechtigungen).

> **Wichtig:** Damit andere Nutzer die Geräte sehen und schalten dürfen, muss das
> **Profil des Bridge-Users** unter „Standardrechte" der gewünschten Zielgruppe
> (z. B. eine Gruppe oder „authenticated") `view` **und** `interact` = `*`
> geben. Ist kein Default gesetzt, gehören die Objekte nur dem Bridge-User und
> sind für andere unsichtbar — der Agent warnt beim Start entsprechend.

## Home-Assistant-Token

In HA: **Profil → Sicherheit → Long-Lived Access Tokens → Token erstellen**.
Den Token als `HA_TOKEN` in die `.env` legen (nie committen — `.env` ist
gitignored).

## Konfiguration (`.env`)

| Variable | Pflicht | Default | Zweck |
|---|---|---|---|
| `AJNA_URL` | – | `http://127.0.0.1:8090` | Ajna-Server (PocketBase/Caddy) |
| `AJNA_USER` / `AJNA_PASS` | ✓ | – | Bridge-User (dedizierter Ajna-Account) |
| `HA_URL` | – | `http://127.0.0.1:8123` | Home-Assistant-URL |
| `HA_TOKEN` | ✓ | – | Long-Lived Access Token |
| `HA_LAT` / `HA_LON` | – | `50.3569` / `7.5890` | Controller-Koordinaten |
| `HA_DOMAINS` | – | alle steuerbaren | CSV: nur diese Domains (z. B. `light,switch`) |
| `HA_ENTITIES` | – | – | CSV-Allowlist konkreter `entity_id`s |
| `HA_REFRESH_S` | – | `300` | Entitätenliste alle N s neu einlesen |
| `HA_POLL_S` | – | `30` | Zustands-Poll als WS-Fallback |

Beispiel:

```dotenv
AJNA_URL=https://ajna.example.com
AJNA_USER=ha-bridge@example.com
AJNA_PASS=…
HA_URL=http://127.0.0.1:8123
HA_TOKEN=eyJ…
HA_LAT=50.44658
HA_LON=7.59706
# optional eingrenzen:
# HA_DOMAINS=light,switch,cover
# HA_ENTITIES=light.deckenlicht,cover.rollo_wohnzimmer
```

## Starten

Auf der HA-Maschine, im Ajna-Projektverzeichnis:

```bash
npm run ha-bridge
```

Dauerbetrieb am besten unter einem Prozessmanager **auf der HA-Maschine** (nicht
im Server-PM2, da anderer Host). Beispiel PM2:

```bash
pm2 start agents/homeassistant-bridge.mjs --name ha-bridge --time
pm2 save
```

## Grenzen / Ausblick

- Das Controller-**Kontextmenü** wird bei sehr vielen Entitäten lang (es scrollt
  nicht). Mit `HA_DOMAINS` / `HA_ENTITIES` eingrenzen. Ein durchsuchbarer
  Entitäten-Picker-Dialog wäre die schönere UX (Client-Erweiterung, offen).
- Licht: `Heller`/`Dunkler` ändern die Helligkeit relativ um ±20 % (unter 0 % →
  aus, über 100 % gedeckelt). `climate` ändert die Zieltemperatur um ±0,5 °.
- Area-/Label-basierte Auswahl (statt Domains/Allowlist) bräuchte die
  HA-WebSocket-Registry-API — bewusst noch nicht umgesetzt.
