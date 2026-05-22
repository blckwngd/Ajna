# Dev-Setup

## Voraussetzungen

- Node.js (Tests laufen mit Node 22+)
- PocketBase-Binary unter `pocketbase/pocketbase.exe` (Windows) bzw. `pocketbase/pocketbase` (Linux/macOS) — Download von [pocketbase.io](https://pocketbase.io/docs/)
- HTTPS-Zertifikate `cert.pem` und `key.pem` im Repo-Root — Pflicht für WebXR und Geolocation
- Optional: VS Code (für die vorbereiteten Tasks)

Zertifikate selbst signieren:
```bash
openssl req -newkey rsa:2048 -new -nodes -x509 -days 3650 \
  -keyout key.pem -out cert.pem
```

```bash
npm install
```

## Drei Wege, den Stack zu starten

### A — Komplett-Start

```bash
npm run stack
```

Startet alle drei Prozesse mit `concurrently`, farbig gelabelt (`pb`, `wp`, `web`). Strg+C in dem Terminal beendet alles. **Auf Windows** kann `concurrently` Children manchmal nicht zuverlässig killen — wenn Ports nach Ctrl+C noch belegt sind, siehe [Troubleshooting](#troubleshooting-ports-h%C3%A4ngen).

### B — VS Code Tasks

In VS Code: `F1` → `Tasks: Run Task` → eine der vier Tasks:

| Task | Effekt |
|---|---|
| Stack: PocketBase | nur PB |
| Stack: Webpack Watch | nur Webpack |
| Stack: Dev Server | nur Express + HTTPS-http-server |
| Stack: Start All | alle drei parallel |

`Strg+Shift+B` startet die Default-Build-Task (= "Stack: Start All").

Beenden: `F1` → `Tasks: Terminate Task`.

### C — Drei Terminals (volle Kontrolle)

```bash
# Terminal 1
npm run pocketbase

# Terminal 2
npm run dev

# Terminal 3
npm run start:dev
```

Beenden einzeln mit Ctrl+C. Hat den Vorteil, dass du einen Prozess neu starten kannst, ohne die anderen mitzureißen.

## URLs

| URL | Zweck |
|---|---|
| https://localhost/index-ar.html | AR-Client (BabylonJS) |
| https://localhost/index-map.html | Map-Client (Leaflet) |
| https://localhost/index-agent.html | Demo-Agent (Fox-NPC) |
| http://localhost:8090/_/ | PocketBase Admin-UI |
| http://localhost:8090/api/ | PocketBase REST-API |

Mobile / LAN-Geräte: PB läuft per Default auf `0.0.0.0:8090` (siehe `npm run pocketbase`). HTTPS-Dev-Server hört ebenfalls auf allen Interfaces. Auf dem Test-Gerät die LAN-IP des Dev-Hosts ansprechen. Beim ersten Mal akzeptiert man das self-signed cert.

## Restart-Regeln

| Was geändert | Aktion |
|---|---|
| `client/**/*.js`, `*.html` | Webpack-Watch baut automatisch — nur Browser-Reload |
| `webpack.config.cjs` | "Stack: Webpack Watch" neu starten |
| `server/index.js` (Express) | "Stack: Dev Server" neu starten |
| **`pocketbase/pb_hooks/*.js`, `*.pb.js`** | **"Stack: PocketBase" neu starten** — PB macht KEIN Auto-Reload |
| PocketBase-Schema (Collections, Rules, Fields) | Live, kein Restart |

PB loggt bei Hook-Datei-Änderungen ausdrücklich `File … changed, please restart the app manually` in seine Konsole. Wenn neue Hook-Logik nicht greift: das ist der Grund.

## Troubleshooting: Ports hängen

Wenn `concurrently` (auf Windows) seine Child-Prozesse nicht sauber killt, bleiben Ports 3000/443/8090 belegt und der nächste Start failt mit `EADDRINUSE`. Aufräumen:

```bash
# PIDs finden
netstat -ano | findstr ":3000 :443 :8090"

# Mit den PIDs aus der Spalte ganz rechts:
taskkill /F /PID <pid>
```

Auf Linux/macOS: `lsof -i :3000` plus `kill -9 <pid>`.

## Troubleshooting: PB-Hook-Fehler

PocketBase nutzt eine [Goja-basierte JSVM](https://github.com/dop251/goja) mit Pool — Modul-Scope-Variablen werden **nicht** zwischen Boot und Hook-Aufruf geteilt. Symptom: `ReferenceError: <funcName> is not defined at pb.js:1:…`.

Lösung: Helper-Funktionen entweder
1. inline im Callback definieren oder
2. aus einer separaten `.js`-Datei (kein `.pb.js`) per `require(\`${__hooks}/foo.js\`)` direkt im Callback laden.

Beispiel: [`pocketbase/pb_hooks/main.pb.js`](../pocketbase/pb_hooks/main.pb.js) holt Helper aus [`permissions.js`](../pocketbase/pb_hooks/permissions.js) im Callback.

## Troubleshooting: Tasks-Liste leer

Wenn VS Code keine Stack-Tasks anzeigt: Workspace-Trust prüfen — VS Code zeigt Tasks aus `.vscode/tasks.json` nur in "trusted" Workspaces an. Statusleiste unten links: "Restricted Mode" → "Trust Workspace".

## Bauen für Produktion

```bash
npm run build
```

Erzeugt `client/dist/*.bundle.js`. Die HTML-Files referenzieren sie über `/dist/<name>.bundle.js`, also einfach den ganzen `client/`-Ordner statisch ausliefern (Express oder beliebiger Static-Server).

PocketBase läuft in Produktion typischerweise unter einem Reverse-Proxy mit echtem TLS. Dann CORS und WebSocket-/SSE-Forwarding in der Proxy-Config nicht vergessen.
