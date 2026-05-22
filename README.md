# Ajna

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
- **PocketBase** (`pocketbase/`) — Collections, Auth, Realtime, JSVM-Hooks (`pb_hooks/`) für Resolver und Custom-Routen (`/api/objects/:id/interact`, `/api/objects/:id/effective-rights`).
- **Express-Server** (`server/`) — Static-Server für die Client-Bundles über HTTPS.

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
**Backend:** PocketBase · Express (Static-Serving)
**Bibliothek:** [`AjnaManager`](client/core/AjnaManager.js) — eine API für Auth, Objekt-CRUD, Realtime, Interaktionen, Berechtigungen

---

## Setup

### Voraussetzungen
- Node.js (mit npm)
- PocketBase-Binary unter `pocketbase/pocketbase.exe` (Windows) bzw. `pocketbase/pocketbase` (Linux/macOS)
- HTTPS-Zertifikate `cert.pem` und `key.pem` im Repo-Root — Pflicht für WebXR und die Geolocation API

Selbstsignierte Zertifikate erzeugen:

```bash
openssl req -newkey rsa:2048 -new -nodes -x509 -days 3650 \
  -keyout key.pem -out cert.pem
```

### Stack starten

```bash
npm install
npm run stack       # alle drei Prozesse parallel
```

Browser:
- AR-Client: `https://localhost/index-ar.html`
- Map-Client: `https://localhost/index-map.html`
- Agent-Demo: `https://localhost/index-agent.html`
- PocketBase Admin: `http://localhost:8090/_/`

Alternativ in **VS Code** über die Tasks (`F1` → "Tasks: Run Task" → "Stack: Start All").
Oder drei Terminals — siehe [docs/dev-setup.md](docs/dev-setup.md).

### npm-Scripts

| Script | Zweck |
|---|---|
| `npm run stack` | Alle drei Prozesse parallel (PocketBase + Webpack-Watch + Dev-Server) |
| `npm run pocketbase` | Nur PocketBase auf `0.0.0.0:8090` (LAN-erreichbar) |
| `npm run dev` | Webpack im Watch-Modus |
| `npm run start:dev` | Express + HTTPS-Static-Server auf Port 443 |
| `npm run build` | Einmaliger Webpack-Build |

> **PocketBase macht KEIN Auto-Reload von `pb_hooks/`** — nach jeder Hook-Änderung manuell den PocketBase-Task neu starten.

---

## Vertiefende Dokumentation

- [**docs/agents.md**](docs/agents.md) — Agenten bauen mit `AjnaManager`, Browser und Node, vollständige API-Referenz, Beispiele.
- [**docs/permissions.md**](docs/permissions.md) — ACE-Modell, Schema, Resolver, UI-Workflow, Stand und Roadmap.
- [**docs/dev-setup.md**](docs/dev-setup.md) — Stack-Workflows, Restart-Regeln, Troubleshooting.

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
- 🚧 Group-Management-UI (folgt unmittelbar)
- 🚧 Default-Permissions-Editor im User-Profil
- 🚧 Friends-/Invitation-System für direkte User-zu-User-Sichtbarkeit

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

---

## Projektstatus

Ajna ist im experimentellen Entwicklungsstadium. Architekturentscheidungen sind so getroffen, dass spätere Anpassungen — verteilte/föderierte Welt, Indoor-Positionierung, Tile-Streaming, Engine-Wechsel in Sub-Systemen — ohne tiefgreifende Refactorings möglich bleiben.
