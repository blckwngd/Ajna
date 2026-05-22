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

## WebXR im AR-Client

Der AR-Client setzt Babylon's `createDefaultXRExperienceAsync` mit `immersive-vr` als Default-Mode auf. Der "Enter XR"-Button wird automatisch ins DOM injiziert (sichtbar in der unteren Ecke), sobald der Browser WebXR unterstützt.

**Aktivierte Features:**
- **Pointer-Selection** auf allen Controllern: Trigger feuert einen `POINTERTAP` — unser Mesh-Klick-Handler reagiert genauso wie beim Desktop-Maus-Klick.
- **Teleportation**: Pointing-Gesture auf den Debug-Boden + Trigger-Loslassen versetzt den Benutzer dorthin. Reference-Space ist `local-floor`.
- **Controller-Profile**: WebXR-Input-Sources werden über die Standard-Profile geladen. Daydream-Controller, Quest-Controller, generische 3DOF-Geräte funktionieren mit Trigger=Select.

**Was im immersive Mode anders ist:**
- Das DOM-basierte Kontextmenü ("Bearbeiten/Berechtigungen/…") ist im immersiven Mode unsichtbar. Stattdessen erscheint ein **kompaktes Camera-HUD im unteren Bildschirmbereich** — pro Action eine kleine 3D-Plane (~20 cm × 7,5 cm), horizontal nebeneinander, ca. 70 cm vor der Kamera. Die Planes werden pro Frame in Welt-Koordinaten vor die aktive Kamera positioniert, mit `BillboardMode_ALL` ausgerichtet. Hintergrund: Anchoring am Modell führte zu unzuverlässigen Klicks, weil `scene.pick()` Ray-Distanz testet, nicht `renderingGroupId` — überlagernde Modell-Meshes "gewinnen" das Picking. Als HUD ist der Button immer das nächste Mesh entlang des Picks.
- **Kein Titel-Header**: Der Bezug zum gemeinten Objekt entsteht über das `HighlightLayer`-Outline am 3D-Modell, das die Gaze-Loop bei Fokus setzt — das hält das HUD klein und lässt die Sicht aufs Modell frei.
- **Gaze-Fokus**: Der Blick auf ein Objekt (Kamera-Forward-Ray, gegen GameObject-Meshes gepickt) markiert es als fokussiert — Highlight + Menü erscheinen automatisch. Schaut man weg, verschwindet beides. Die Loop drosselt sich auf ~10 Hz Pick-Frequenz.
- **Klick** (Maus / Controller-Trigger / Touch) auf ein Objekt-Mesh öffnet ebenfalls das Menü — ein zweiter Weg, falls Gaze nicht greift.
- **Klick auf einen Menü-Button** läuft über Mesh-Picking (nicht GUI-intern) und funktioniert deshalb gleichermaßen mit Maus (auch im WebXR-Browser-Emulator), Controller-Trigger und Touch. Hover-Feedback (Farbwechsel) kommt vom `ActionManager`. Aktion-Trigger: `ajna.interact(record.id, actionKey)` → läuft die ganze Berechtigungs-/Broker-Kette wie ein Spieler-Klick im Desktop-Modus.
- **Auto-Hide nach Klick**: Jeder Tap schließt das HUD — egal ob er einen Button oder daneben getroffen hat. Erst beim nächsten Wechsel des Gaze-Fokus (oder bei einem expliziten Objekt-Klick) erscheint es wieder.
- **ESC** verlässt die XR-Session ohne Seiten-Reload — wichtig im WebXR-Browser-Emulator, wo es keine Headset-Geste zum Verlassen gibt.
- Hover-Tooltips am Cursor (DOM-basiert) erscheinen nicht — das `HighlightLayer`-Verhalten am gefokussierten Objekt ist der visuelle Indikator.

**State-Logging:** in der Browser-Konsole erscheinen `[xr] state → ENTERING_XR / IN_XR / EXITING_XR / NOT_IN_XR`-Zeilen, sowie `[xr] trigger <action> on <name>` beim Controller-Klick. Hilfreich zum Debuggen ohne Headset.

**AR statt VR**: Wenn der Browser `immersive-ar` unterstützt (Quest 3, einige Mobile-Browser), kann der Default-Mode auf `'immersive-ar'` umgestellt werden. Floor/Teleportation funktionieren dort eingeschränkter, weil der echte Boden über die Kamera kommt. Für Smart-Home-Demo mit realer Welt im Hintergrund ist das der Zielmodus.

---

## Bauen für Produktion

```bash
npm run build
```

Erzeugt `client/dist/*.bundle.js`. Die HTML-Files referenzieren sie über `/dist/<name>.bundle.js`, also einfach den ganzen `client/`-Ordner statisch ausliefern (Express oder beliebiger Static-Server).

PocketBase läuft in Produktion typischerweise unter einem Reverse-Proxy mit echtem TLS. Dann CORS und WebSocket-/SSE-Forwarding in der Proxy-Config nicht vergessen.
