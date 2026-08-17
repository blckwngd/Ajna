# Ajna

> **📖 Dokumentation:** [Wiki](wiki/Home.md) — Einstieg für Nutzer, Betreiber und Entwickler,
> inklusive vollständiger Referenz von [Ajna-Library](wiki/Ajna-Library.md) und
> [Agent-Library](wiki/Agent-Library.md).

## Vision

Ajna ist ein Framework für ortsbasierte, persistente Multiplayer-AR/XR-Anwendungen. Reale Orte und Objekte sollen durch digitale Inhalte, Zustände und Interaktionen erweitert werden — langfristig ein digitaler Zwilling der realen Welt mit einer interaktiven digitalen Ebene.

Es ist kein klassisches Spiel, sondern eine Geo- und Realtime-Plattform für Mixed-Reality-Anwendungen.

---

## Kernidee

Reale GPS-Koordinaten werden clientseitig in lokale 3D-Weltkoordinaten transformiert. Objekte liegen in PocketBase, jede Änderung wird über Realtime-Subscriptions an alle verbundenen Clients verteilt. Agenten (NPC-Logik, IoT-Bridges) sind reine PocketBase-Clients — sie verbinden sich genauso wie ein Game-Client und reagieren auf Aktions-Events.

- **Objekt-Persistenz**: PocketBase
- **Realtime**: PocketBase-SSE-Subscriptions, plus ein Subscriptions-Broker für ephemere Interaktions-Events (kein DB-Write)
- **Authoritative Permissions**: serverseitiges Resolver-System (NTFS-artig, mit Gruppen + impliziten Audiences). Siehe [docs/permissions.md](docs/permissions.md).
- **Agenten und Eigenbau-Clients**: gehen über die `AjnaManager`-Bibliothek. Siehe [docs/agents.md](docs/agents.md).

---

## Komponenten

Drei Web-Clients teilen sich die `AjnaManager`-Bibliothek und das PocketBase-Backend:

| Pfad | Zweck |
|---|---|
| `/index-ar.html` | BabylonJS-Szene, freie Debug-Cam (WASD + Pfeiltasten), Editor-UI, Hover-Tooltips, Berechtigungs-Dialog |
| `/index-map.html` | Leaflet-Karte mit OSM-Tiles, GPS-Tracking, Drag-&-Drop-Bearbeitung von Objekten |
| `/index-agent.html` | Demo-Agent: kontrolliert ein konkretes Objekt, reagiert auf Aktions-Events mit Animations-Wechseln |

Backend:
- **PocketBase** (`pocketbase/`) — Collections, Auth, Realtime, JSVM-Hooks (`pb_hooks/`) für Resolver und Custom-Routen unter `/api/*` (`/api/objects/:id/interact`, `/api/objects/:id/effective-rights`, `/api/groups/:id/invite`, …).
- **Express-Server** (`server/`) — Server-Routen, die nicht als PB-Hook umsetzbar sind, unter `/ajnaapi/*` (separater Namespace, damit kein Konflikt mit PocketBase). Aktuell leichtgewichtig, primär als Erweiterungsschiene.
- **Caddy** (Reverse-Proxy + HTTPS-Frontend) — bündelt Client, PB und Express unter einem Origin. Lokal via interne CA, public via Let's Encrypt. Config-Template: `Caddyfile`, lokale Anpassungen in `Caddyfile.prod` (gitignored).

---

## Architekturprinzipien

Strikte Schichtentrennung:

- **Geo-/Weltlogik** — GPS-Erfassung, Koordinaten-Transformation (`GeoTransformer`, Z=Nord, Y=Höhe, 1 Babylon-Unit = 1 m)
- **Rendering** — BabylonJS-Szene, Kameras, Materialien
- **Netzwerk** — PocketBase-Realtime, gebündelt im `AjnaManager`
- **Komponenten/Systeme** — ECS-ähnlich, GameObjects mit Components
- **Debug** — getrennt unter `/engine/debug/`

Backend-Datenmodelle haben keinen direkten Zugriff auf Components — ein Mapping-Layer übersetzt PocketBase-Records in Engine-States.

### Stack im Überblick

**Frontend:** BabylonJS · WebXR · Webpack · ES Modules · Leaflet · optional 3D-Tiles
**Backend:** PocketBase · Express (`/ajnaapi/*`) · Caddy (HTTPS-Frontend + Reverse-Proxy)
**Bibliothek:** [`AjnaManager`](client/core/AjnaManager.js) — eine API für Auth, Objekt-CRUD, Realtime, Interaktionen, Berechtigungen, Gruppen, Einladungen, **Multi-Server**

---

## Setup

### Voraussetzungen

| Tool | Installation |
|---|---|
| **Node.js 22+** (mit npm) | [nodejs.org](https://nodejs.org/) |
| **PocketBase-Binary** unter `pocketbase/pocketbase.exe` (Windows) bzw. `pocketbase/pocketbase` (Linux/macOS) | [pocketbase.io/docs](https://pocketbase.io/docs/) |
| **Caddy** auf `PATH` | Windows: `winget install CaddyServer.Caddy` · macOS: `brew install caddy` · Linux: [caddyserver.com/download](https://caddyserver.com/download) |

> **Keine eigenen HTTPS-Zertifikate nötig.** Caddy stellt für `localhost` automatisch ein Cert über seine interne CA aus und installiert die einmal pro Maschine ins System-Keystore (Admin-Prompt beim ersten Start).

### Erstes Mal einrichten

```bash
# 1. Repo klonen, Dependencies holen
git clone <repo-url> Ajna
cd Ajna
npm install

# 2. Caddyfile.prod aus dem Template anlegen
#    Windows:  copy Caddyfile Caddyfile.prod
#    Linux/macOS: cp Caddyfile Caddyfile.prod
#    Für rein lokales Setup reicht die unveränderte Kopie.
#    Für Public-Demo: demo.example.com / admin@example.com / Pfade anpassen.
```

### Stack starten

```bash
npm run stack
```

Vier Prozesse parallel — PB, Webpack-Watch, Express-API, Caddy. Strg+C beendet alles. Alternativ in **VS Code**: `F1` → "Tasks: Run Task" → "Stack: Start All".

### URLs

Alle Endpunkte laufen unter demselben Origin durch Caddy (Same-Origin → kein Mixed-Content).

| URL | Zweck |
|---|---|
| `https://localhost/`                  | **Haupt-Client** — Tabs Karte / AR / Objekte / Einstellungen (alle Geräte-Einstellungen liegen hier) |
| `https://localhost/index-ar.html`     | AR-Client (BabylonJS + WebXR) |
| `https://localhost/index-map.html`    | Map-Client (Leaflet) |
| `https://localhost/index-agent.html`  | Demo-Agent (Fox-NPC) |
| `https://localhost/_/`                | PocketBase Admin-UI |
| `https://localhost/api/*`             | PocketBase REST + Realtime + Hooks |
| `https://localhost/ajnaapi/*`         | Ajna-Express-Backend |

LAN-Geräte erreichen den Stack unter `https://<lan-ip>/...`. Caddys interne CA gilt dort nicht — das Test-Gerät muss entweder das Caddy-Root-Cert ins eigene Keystore übernehmen, oder ein Public-Hostname mit Let's-Encrypt-Cert wird vorgeschaltet (siehe [docs/dev-setup.md](docs/dev-setup.md)).

### Multi-Server

Der Client kann sich parallel zu mehreren Ajna-Servern verbinden (z. B. "Heim" + "Büro"). Über den **Server**-Button im Editor-Panel:

- bekannte Server listen mit Login-/Verbindungs-Status
- neue Server per URL hinzufügen
- pro Server eigene Credentials, eigener Token (in `localStorage` unter `ajna_auth_<id>`)
- Objekte aller verbundenen Server erscheinen gemerged in der Welt; Aktionen routen automatisch zum Origin-Server

### npm-Scripts

| Script | Zweck |
|---|---|
| `npm run stack`       | Vollständiger Stack: PB + Webpack-Watch + Express + Caddy |
| `npm run pocketbase`  | Nur PocketBase auf `0.0.0.0:8090` |
| `npm run dev`         | Webpack im Watch-Modus |
| `npm run start`       | Nur Express-Backend auf Port 3000 |
| `npm run caddy`       | Nur Caddy mit `Caddyfile.prod` |
| `npm run build`       | Einmaliger Webpack-Production-Build |
| `npm run ais`         | Node-Agent: spiegelt AIS-Schiffspositionen (aisstream.io) in Ajna |
| `npm run poi`         | Node-Agent: legt OSM-POIs aus dem Bbox-Bereich als Ajna-Objekte an |
| `npm run start:dev`   | **Legacy** — Express + altes HTTPS-Static-Server-Setup ohne Caddy (mit `cert.pem`) |

> **PocketBase macht KEIN Auto-Reload von `pb_hooks/`** — nach jeder Hook-Änderung manuell den PocketBase-Task neu starten. Caddy hingegen reloadest du im laufenden Betrieb mit `caddy reload --config Caddyfile.prod`.

---

## Vertiefende Dokumentation

Einstieg für alle drei Zielgruppen: **[Wiki](wiki/Home.md)**

- Benutzen — [Erste Schritte](wiki/Erste-Schritte.md) · [Die App](wiki/Die-App.md) · [Privatsphäre](wiki/Privatsphaere.md)
- Betreiben — [Server betreiben](wiki/Server-betreiben.md) · [Agents betreiben](wiki/Agents-betreiben.md) · [Berechtigungen](wiki/Berechtigungen.md)
- Entwickeln — [Einen Agent bauen](wiki/Einen-Agent-bauen.md) · [Ajna-Library](wiki/Ajna-Library.md) · [Agent-Library](wiki/Agent-Library.md) · [Objektmodell](wiki/Objektmodell.md) · [Architektur](wiki/Architektur.md)

Einzelthemen mit eigener Hardware oder eigenem Aufbau bleiben unter `docs/`:

- [**docs/permissions.md**](docs/permissions.md) — ACE-Modell, Schema, Resolver, Einladungen, Roadmap
- [**docs/dev-setup.md**](docs/dev-setup.md) — Stack-Workflows, Restart-Regeln, Troubleshooting
- [**docs/deployment.md**](docs/deployment.md) · [**docs/uwb.md**](docs/uwb.md) · [**docs/pointing.md**](docs/pointing.md) · [**docs/homeassistant.md**](docs/homeassistant.md) · [**docs/visual-tracking.md**](docs/visual-tracking.md)

---

## Aktueller Stand

- ✅ GPS → lokale 3D-Koordinaten (equirektangulare Approximation um Welt-Origin)
- ✅ Objekt-CRUD über PocketBase mit Realtime-Subscriptions
- ✅ Geteilte Editor-UI für AR und Map, Drag-&-Drop auf der Karte
- ✅ Dummy-GPS für Entwicklung (persistiert in localStorage)
- ✅ Hover-Tooltips, Highlight, Off-Screen-Richtungsanzeiger in beiden Clients
- ✅ Aktions-Pipeline: Spieler-Klick → `/api/objects/:id/interact` → Permission-Check → Broker-Broadcast → Agent reagiert → `animation_state`-Update → alle Clients sehen die neue Animation
- ✅ Demo-Agent (`/index-agent.html`) mit Action→Animation-Mapping, manuellen Triggern, schrittweisem Movement
- ✅ Berechtigungs-Resolver (Owner, Gruppen mit transitiven Sub-Gruppen, implizite Audiences)
- ✅ `effective_permissions`-Cache mit automatischer Invalidation via Hooks
- ✅ Group-Management-UI (GroupDialog mit Owned/Memberships, Subgroup-Verschachtelung)
- ✅ Friends-/Invitation-System per E-Mail ODER Anzeigename (privacy-strikt; users.listRule bleibt `id = @request.auth.id`)
- ✅ WebXR Immersive-Mode mit In-World-HUD, Gaze-Fokus, ESC-Exit, Multi-Input (Maus / Controller / Touch)
- ✅ XR-Controller-State-Machine (Daydream u. a. 3DOF) — Touchpad-Cycle durch Objekte, Touchpad-Press/Trigger = Confirm, "Zurück"-Eintrag im Menü ersetzt den nicht durchgereichten System-Back
- ✅ Multi-Server (Phase 1+2+4): Federation über N PocketBase-Clients, Composite-Object-IDs, ServerDialog, per-Server-Auth, Server-Badges in EditorUI / PermissionDialog / ObjectActions
- ✅ Caddy als HTTPS-Frontend + Reverse-Proxy (Same-Origin für Client/API/Express, lokale interne CA, optional Let's Encrypt)
- ✅ AIS-Bridge (Node-Agent): aisstream.io → Ajna-Objekte (`type="ship"`), Position + Heading + Schiffsname, Stale-Cleanup wenn Schiff die Bbox verlässt
- ✅ POI-Bridge (Node-Agent): Overpass-POIs → Ajna-Objekte (`type="poi"`, grüner Stab-Marker im AR, grünes 📍 auf der Karte), idempotenter Sync mit Cleanup
- ✅ Rechtsklick auf Boden in AR / Karte → "Neues Objekt…" an exakten GPS-Koords, Editor vorbefüllt
- ✅ POI-/Schiffs-Sichtbarkeit für authentifizierte User via implicit-audience-ACEs + `default_permissions` am Agent-User
- 🚧 Default-Permissions-Editor im User-Profil
- 🚧 Inventarsystem (portable Objekte, Items als Schlüssel/Waffe)
- 🚧 Rule-Engine (Predicate-Trees → Effekte; später: physische Sensoren als Bedingungen)
- 🚧 Multi-Server Phase 5: Token-Refresh, Reconnect-Strategie, 2-Instanzen-Smoketest

### Mittelfristig

- Send-Pfad für Spieler-Positionen (Realtime-Multiplayer ist receive-side bereits funktionsfähig)
- Floating-Origin / Origin-Rebase bei großen Welt-Distanzen
- WebXR-Session-Mode `immersive-ar` und Geräteorientierung
- IoT-Bridge (MQTT ↔ Ajna) für Smart-Home-Geräte
- Interest Management bei vielen gleichzeitigen Objekten

---

## Datenschutzstrategie

Spieler-Positionen werden nicht persistiert. Objekt-Positionen schon, aber pro Objekt mit eigenen Berechtigungen (Smart-Home-Geräte sind für Familie sichtbar, nicht für Fremde — siehe [docs/permissions.md](docs/permissions.md)).

`users.listRule` / `viewRule` sind privacy-strikt: jeder eingeloggte User sieht nur sich selbst. Direkte User-zu-User-Sichtbarkeit gibt es nur, wenn beide einer Gruppe angehören oder explizit eingeladen wurden (geplantes Friends-System).

### Standort-Freigabe: vier Stufen, pro Server

Man verbindet sich zu mehreren Servern und vertraut ihnen unterschiedlich — ein globaler Schalter wäre zwangsläufig der kleinste gemeinsame Nenner oder ein Leck zum unvertrauenswürdigsten Server. Deshalb gilt die Stufe **pro Server** (`client/core/PrivacyPolicy.js`), Standard ist **Verborgen**:

| Stufe | Was den Server erreicht |
|---|---|
| **Verborgen** | nichts |
| **Gegend** | ein unscharfer Bereich: Zentrum aufs 100-m-Raster gerundet, 500-m-Box darum |
| **Nähe** | zusätzlich „jemand ist bei Objekt Y" — als Objekt-ID, nie als Koordinate |
| **Genau** | die exakte Position |

Die Stufen bauen aufeinander auf. Durchgesetzt wird **im Fan-out** (`AjnaManager.publishInterestArea` / `.reportProximity`) — das ist die einzige Stelle, an der Präsenzdaten den Client verlassen, also kann kein künftiger Aufruf daran vorbeilecken. Gespeichert wird gerätelokal: der Standard gilt für *neue* Server und kann schlecht auf einem Server liegen, den man noch nicht kennt; und die Regel, die einen Server begrenzt, gehört nicht auf diesen Server.

Asymmetrie mit Absicht: die Stufe blockiert nur `enter`, nie `leave` — „ich bin da" verrät etwas, „ich bin weg" nimmt etwas zurück. Andernfalls bliebe beim Herunterstufen die letzte Anwesenheit für immer stehen.

**Grenze, offen gesagt:** der Client ist die einzige Positionsquelle, kann Nähe also auch behaupten. Näherungs-Auslöser taugen zur Belebung (ein Agent reagiert, wenn jemand kommt), **nicht als Nachweis** („Spieler war an Ort X" als Quest-Bedingung) — dafür braucht es einen zweiten Faktor wie UWB-Anker oder signierte Sensor-Reports. Und „Genau" nützt heute dem Server selbst: das Agent-Aggregat (`GET /ajnaapi/interest-areas`) rastert weiterhin auf 250 m.

---

## Projektstatus

Ajna ist im experimentellen Entwicklungsstadium. Architekturentscheidungen sind so getroffen, dass spätere Anpassungen — verteilte/föderierte Welt, Indoor-Positionierung, Tile-Streaming, Engine-Wechsel in Sub-Systemen — ohne tiefgreifende Refactorings möglich bleiben.
