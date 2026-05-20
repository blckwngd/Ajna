# Ajna

## Vision

Ajna ist ein Framework für ortsbasierte, persistente Multiplayer-AR/XR-Anwendungen. Reale Orte und Objekte sollen durch digitale Inhalte, Zustände und Interaktionen erweitert werden — langfristig ein digitaler Zwilling der realen Welt mit einer interaktiven digitalen Ebene.

Es ist kein klassisches Spiel, sondern eine Geo- und Realtime-Plattform für Mixed-Reality-Anwendungen.

---

## Kernidee

Spielobjekte und Spielerpositionen basieren auf realen GPS-Koordinaten. Diese werden clientseitig erfasst und in lokale 3D-Weltkoordinaten transformiert.

- **GPS → Welt**: Equirectangulare Transformation um einen frei wählbaren Welt-Ursprung (`GeoTransformer`). Z zeigt Norden, Y ist Höhe. 1 Babylon-Unit = 1 Meter.
- **Objekt-Persistenz**: PocketBase als Backend, sowohl für CRUD als auch für Realtime-Synchronisation.
- **Multiplayer-fähig (in Arbeit)**: Realtime-Updates über `pb.collection().subscribe()` werden auf Engine-Components abgebildet (`NetworkSyncComponent`). Der Send-Pfad (eigene Position publishen) ist noch nicht implementiert.

---

## Architekturprinzipien

Strikte Trennung der Schichten:

- **Geo-/Weltlogik** — GPS-Erfassung, Koordinaten-Transformation
- **Rendering** — Babylon-Szene, Kameras, Materialien
- **Netzwerk** — PocketBase-Realtime
- **Debug** — getrennt unter `/engine/debug/`
- **Komponenten/Systeme** — ECS-ähnlich

Backend-Datenmodelle haben keinen direkten Zugriff auf Components — ein Mapping-Layer (`mapPocketBaseRecord`) übersetzt PocketBase-Records in Engine-States.

### Frontend
- **BabylonJS** als Haupt-Engine (Rendering, Kamera, WebXR)
- **Webpack** + ES Modules
- **Leaflet** für den 2D-Karten-Client
- Optionale 3D-Tiles (NASA / Cesium OSM Buildings / Google Photorealistic)

### Backend
- **PocketBase** — Objekt-CRUD, Auth, Realtime-Subscriptions
- **Express** (Node.js) — Static-Server für den Client und dünner Proxy für interaktive Endpunkte (`/api/interact`)

---

## Clients

Zwei einsetzbare Clients teilen sich Editor-UI, GPS-Schicht und Backend.

### AR-Client (`/index-ar.html`)
- BabylonJS-Szene mit Player-Avatar
- Im Debug-Modus: freie Kamera (WASD + Pfeiltasten), umschaltbar auf Player-Kamera
- Im Non-Debug-Modus: Kamera klebt fest am Spieler
- Editor-Fenster: Login, Objekt-CRUD, Liste der Backend-Objekte
- Debug-Panel: Live-GPS-Status, Dummy-GPS-Steuerung, Loaded-Objects-Liste mit Kamera-Sprung, 3D-Tiles-Sektion
- Unendliches Grid am Boden (10 m Hauptraster, 1 m Sub-Raster) als optischer Anhaltspunkt
- Hover-Tooltip mit Objekt-Namen am 3D-Objekt
- Gestrichelte Richtungslinie zu hervorgehobenen Objekten außerhalb des Sichtfelds

WebXR-Session-Mode (`immersive-ar`) ist als nächster Schritt vorgesehen, derzeit noch nicht verdrahtet.

### Map-Client (`/index-map.html`)
- Leaflet-Karte mit OSM-Tiles und GPS-Tracking-Control
- Drag-&-Drop-Bearbeitung von Objekten direkt auf der Karte
- Editor-UI identisch zum AR-Client (gemeinsamer Code)
- Hover-Tooltips an Markern, gestrichelte Polyline zu Markern außerhalb der Karten-Bounds

### GPS-Verhalten
- `GPSProvider` ist die einzige GPS-Quelle; alle Konsumenten subscriben über `gps.onPosition()`. Direkter `navigator.geolocation`-Zugriff in Components ist verboten.
- Dummy-GPS-Modus + persistierte Dummy-Position (`localStorage`) als schneller Boot-Fallback
- Backend-Load und GPS-Fix laufen beim Booten parallel — bei realem GPS spart das Sekunden

---

## Setup

### Voraussetzungen
- Node.js (mit npm)
- PocketBase-Binary unter `pocketbase/` (Datenverzeichnis: `pocketbase/pb_data/`)
- HTTPS-Zertifikate `cert.pem` und `key.pem` im Repo-Root — Pflicht für WebXR und für die Geolocation API

Selbstsignierte Zertifikate erzeugen:

```bash
openssl req -newkey rsa:2048 -new -nodes -x509 -days 3650 \
  -keyout key.pem -out cert.pem
```

### Stack starten

```bash
npm install
```

In drei Terminals (oder als Background-Jobs):

```bash
# 1) PocketBase auf 8090
cd pocketbase && ./pocketbase serve

# 2) Webpack im Watch-Modus
npm run dev

# 3) Dev-Server (Express + HTTPS http-server auf Port 443)
npm run start:dev
```

Browser:
- AR-Client: `https://localhost/index-ar.html`
- Map-Client: `https://localhost/index-map.html`
- PocketBase Admin: `http://localhost:8090/_/`

### npm-Scripts (`package.json`)

| Script | Zweck |
|---|---|
| `npm run build` | Einmaliger Webpack-Build |
| `npm run dev` | Webpack im Watch-Modus |
| `npm run start` | Express-Server (HTTP) |
| `npm run start:dev` | Express + HTTPS-Static-Server auf Port 443 |
| `npm run start:all` | Express + HTTP-Static-Server |

---

## Aktueller Stand

- GPS → lokale 3D-Koordinaten (`GeoTransformer`, equirectangulare Approximation)
- Objekt-CRUD über PocketBase mit Realtime-Subscriptions
- Geteilte Editor-UI für AR- und Map-Client
- Dummy-GPS für Entwicklung (persistiert)
- Debug-Tools: Free-Cam, Object-Liste mit Kamera-Sprung, GPS-Inspector
- Hover-Tooltips + Highlight + Off-Screen-Richtungsanzeiger in beiden Clients

### Offen / Roadmap

- Send-Pfad für Spieler-Positionen (Realtime-Multiplayer ist receive-side bereits funktionsfähig)
- Floating-Origin / Origin-Rebase bei großen Welt-Distanzen
- Interest Management bei vielen gleichzeitigen Objekten
- UWB Indoor Positioning
- WebXR-Session-Mode `immersive-ar` und Geräteorientierung
- Anti-Spoofing / Position-Validierung
- Tile-Streaming-Strategie für Karten- und Höhendaten

---

## Datenschutzstrategie

Die Architektur erlaubt es, exakte Positionsdaten ausschließlich clientseitig zu halten oder serverseitig nur Regionen/Aggregate zu persistieren. PocketBase persistiert aktuell nur Objekt-Positionen (lat / lon / altitude); Spieler-Positionen sind nicht persistiert.

Damit bleibt die Option offen, Ajna stärker privacy-by-design auszurichten.

---

## Projektstatus

Ajna ist im experimentellen Entwicklungsstadium. Architekturentscheidungen sind so getroffen, dass spätere Anpassungen — verteilte/föderierte Welt, Indoor-Positionierung, Tile-Streaming, Engine-Wechsel in Sub-Systemen — ohne tiefgreifende Refactorings möglich bleiben.
