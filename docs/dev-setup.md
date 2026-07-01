# Dev-Setup

> **Server-Deployment?** Für das automatisierte Ausrollen auf dem Server (PM2:
> `git pull` → build → Prozesse neu laden) siehe [deployment.md](deployment.md).

## Voraussetzungen

| Tool | Hinweis |
|---|---|
| **Node.js 22+** (mit npm) | [nodejs.org](https://nodejs.org/) |
| **PocketBase-Binary** unter `pocketbase/pocketbase.exe` (Windows) bzw. `pocketbase/pocketbase` (Linux/macOS) | [pocketbase.io/docs](https://pocketbase.io/docs/) |
| **Caddy** auf `PATH` | Windows: `winget install CaddyServer.Caddy` oder `scoop install caddy` · macOS: `brew install caddy` · Linux: [caddyserver.com/download](https://caddyserver.com/download) |
| Optional: VS Code | für die vorbereiteten Tasks (siehe Variante B) |

> **Keine eigenen HTTPS-Zertifikate nötig.** Caddy stellt für `localhost` / `*.localhost` automatisch Certs über seine interne CA aus und installiert die einmal pro Maschine ins System-Keystore (Admin-Prompt beim ersten Start). Der frühere `openssl`-Schritt mit `cert.pem`/`key.pem` ist nur noch nötig, wenn du den Legacy-Pfad `npm run start:dev` ohne Caddy nutzen willst.

## Erstes Mal einrichten

```bash
npm install

# Caddyfile.prod aus dem Template anlegen — ist gitignored, also
# umgebungsspezifische Anpassungen bleiben lokal.
# Windows:
copy Caddyfile Caddyfile.prod
# Linux/macOS:
cp Caddyfile Caddyfile.prod
```

Für rein lokales Testen reicht die unveränderte Kopie. Für ein Public-Demo-Deployment den `demo.example.com`-Block in `Caddyfile.prod` auf deine echte Domain umstellen, ebenso die `email`-Direktive (Let's-Encrypt-Recovery).

## Drei Wege, den Stack zu starten

### A — Komplett-Start

```bash
npm run stack
```

Startet vier Prozesse mit `concurrently`, farbig gelabelt (`pb`, `wp`, `api`, `caddy`): PocketBase, Webpack-Watch, Express-Backend, Caddy. Strg+C beendet alles. **Auf Windows** kann `concurrently` Children manchmal nicht zuverlässig killen — wenn Ports nach Ctrl+C noch belegt sind, siehe [Troubleshooting](#troubleshooting-ports-h%C3%A4ngen).

### B — VS Code Tasks

In VS Code: `F1` → `Tasks: Run Task` → eine der Tasks aus `.vscode/tasks.json`:

| Task | Effekt |
|---|---|
| Stack: PocketBase   | nur PB auf `:8090` |
| Stack: Webpack Watch | nur Webpack |
| Stack: Express API   | nur das Ajna-Backend auf `:3000` (`/ajnaapi/*`) |
| Stack: Caddy         | nur Caddy mit `Caddyfile.prod` |
| Stack: Start All     | alle vier parallel |
| Stack: Dev Server    | **Legacy** — Express + alter `http-server` ohne Caddy (mit `cert.pem`) |

`Strg+Shift+B` startet die Default-Build-Task (= "Stack: Start All"). Beenden: `F1` → `Tasks: Terminate Task`.

> Hinweis: `.vscode/tasks.json` ist nicht im Repo (gitignored), damit jede Entwickler-Maschine eigene Anpassungen behalten kann. Wer keine eigene `tasks.json` anlegen will, nimmt Variante A.

### C — Vier Terminals (volle Kontrolle)

```bash
# Terminal 1
npm run pocketbase

# Terminal 2
npm run dev

# Terminal 3
npm run start          # Express-Backend auf :3000

# Terminal 4
npm run caddy          # Caddy mit Caddyfile.prod
```

Beenden einzeln mit Ctrl+C. Vorteil: einen Prozess neu starten, ohne die anderen mitzureißen.

## URLs

Alle Endpunkte laufen unter **demselben Origin** über Caddy. Same-Origin → kein Mixed-Content, eine Cookie-/Storage-Domäne, simpler Browser-State.

| URL | Zweck |
|---|---|
| https://localhost/index-ar.html    | AR-Client (BabylonJS + WebXR) |
| https://localhost/index-map.html   | Map-Client (Leaflet) |
| https://localhost/index-agent.html | Demo-Agent (Fox-NPC) |
| https://localhost/_/               | PocketBase Admin-UI |
| https://localhost/api/             | PocketBase REST + Realtime + Hooks |
| https://localhost/ajnaapi/         | Ajna-Express-Backend |

`https://ajna.localhost/...` funktioniert genauso — der Browser löst `*.localhost` automatisch auf 127.0.0.1 auf, ohne `hosts`-Datei-Eintrag.

### Mobile / LAN-Geräte

Caddys interne CA gilt nur auf der Maschine, auf der Caddy läuft. Auf einem zweiten Gerät hast du drei Optionen:

1. **Caddy-Root-Cert kopieren**: `caddy storage list-certificates` → das Root-Cert auf das Test-Gerät übertragen und dort als vertrauenswürdig markieren.
2. **Public Hostname mit echtem Cert**: über DNS einen Namen auf den Dev-Host zeigen lassen, im `Caddyfile.prod` als zweite Site eintragen, Caddy holt das Let's-Encrypt-Cert (braucht öffentliche Erreichbarkeit auf 80/443).
3. **Cert-Warnung akzeptieren**: für Quick-and-Dirty-Tests einmalig im Browser bestätigen.

PB selbst läuft nur auf `127.0.0.1:8090` und ist von außen nicht direkt erreichbar — alles geht über Caddy.

## Restart-Regeln

| Was geändert | Aktion |
|---|---|
| `client/**/*.js`, `*.html` | Webpack-Watch baut automatisch — nur Browser-Reload |
| `webpack.config.cjs` | "Stack: Webpack Watch" neu starten |
| `server/index.js` (Express) | "Stack: Express API" neu starten |
| `Caddyfile.prod` | `caddy reload --config Caddyfile.prod` (Caddy bleibt up) |
| **`pocketbase/pb_hooks/*.js`, `*.pb.js`** | **"Stack: PocketBase" neu starten** — PB macht KEIN Auto-Reload |
| PocketBase-Schema (Collections, Rules, Fields) | Live, kein Restart |

PB loggt bei Hook-Datei-Änderungen ausdrücklich `File … changed, please restart the app manually` in seine Konsole. Wenn neue Hook-Logik nicht greift: das ist der Grund.

## Troubleshooting: Ports hängen

Wenn `concurrently` (auf Windows) seine Child-Prozesse nicht sauber killt, bleiben Ports 443/3000/8090 belegt und der nächste Start failt mit `EADDRINUSE`. Aufräumen:

```powershell
# PIDs finden
netstat -ano | findstr ":443 :3000 :8090"

# Mit den PIDs aus der Spalte ganz rechts:
taskkill /F /PID <pid>
```

Auf Linux/macOS: `lsof -i :3000` plus `kill -9 <pid>`. Bei Caddy hilft alternativ `caddy stop`.

## Troubleshooting: Caddy-Cert-Probleme

- **Browser warnt trotz Caddys interner CA**: Caddys Root-Cert wurde nicht installiert oder zwischendurch gelöscht. `caddy run` neu starten, Admin-Prompt akzeptieren. Auf Windows manuell prüfen: `certmgr.msc` → "Vertrauenswürdige Stammzertifizierungsstellen" → Eintrag "Caddy Local Authority".
- **Public-Block schlägt fehl, weil DNS nicht passt**: Caddy versucht beim Start, Let's-Encrypt-Certs für alle Hostnames zu holen. Wenn `demo.example.com` (oder dein Custom-Name) nicht öffentlich auflöst, gibt es Retry-Loops im Log. Lösung: den `demo.example.com`-Block in `Caddyfile.prod` auskommentieren, solange du nicht öffentlich deployst.

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

### Controller-State-Machine (3DOF-/6DOF-Controller)

Sobald ein WebXR-Controller verbunden ist (Daydream-Touchpad-Variante, Quest etc.), übernimmt eine explizite State-Machine den Fokus-Cycle und pausiert die Gaze-Loop. Hintergrund: Daydream-typische Pads haben nur Touchpad + Trigger und keinen System-Back, der durch WebXR durchgereicht wird.

| Zustand | Touchpad-Achse links / rechts | Confirm (Touchpad-Press oder Trigger) |
|---|---|---|
| **BROWSE** | Cycle durch alle sichtbaren GameObjects (Highlight) | Öffnet das In-World-HUD am fokussierten Objekt |
| **MENU** | Cycle durch die Buttons des Menüs | Triggert die Aktion; `Zurück` bricht ohne Action ab |

Implementierung: `setupXrControllerInteraction()` in [client/main.js](../client/main.js), das auf `xrExperience.input.onControllerAddedObservable` lauscht und je Controller die Components `xr-standard-touchpad` und `xr-standard-trigger` verkabelt. Edge-Detect auf der Touchpad-Achse (`x > 0.5` / `x < -0.5`) → ein Schritt pro Wischrichtungs-Wechsel. Sobald der letzte Controller wieder disconnected, übernimmt die Gaze-Loop. Die InWorldActionMenu-Methoden `focusButton`/`cycleFocus`/`triggerFocused` bilden die Programmatic-Equivalents der Maus-Hover-/Click-Logik.

**Zurück-Button**: bei `mode='MENU'` wird automatisch am Ende der Action-Liste ein `{key: '__back', label: 'Zurück'}` angehängt. Trigger darauf = Menü zu, zurück nach BROWSE. Notwendig, weil der System-Home-Button des Controllers vom Browser/OS reserviert ist und nicht via WebXR-Input-Source angeliefert wird.

**AR statt VR**: Wenn der Browser `immersive-ar` unterstützt (Quest 3, einige Mobile-Browser), kann der Default-Mode auf `'immersive-ar'` umgestellt werden. Floor/Teleportation funktionieren dort eingeschränkter, weil der echte Boden über die Kamera kommt. Für Smart-Home-Demo mit realer Welt im Hintergrund ist das der Zielmodus.

---

## Bauen für Produktion

```bash
npm run build
```

Erzeugt `client/dist/*.bundle.js`. Die HTML-Files referenzieren sie über `/dist/<name>.bundle.js`, also einfach den ganzen `client/`-Ordner statisch ausliefern (Express oder beliebiger Static-Server).

PocketBase läuft in Produktion typischerweise unter einem Reverse-Proxy mit echtem TLS. Dann CORS und WebSocket-/SSE-Forwarding in der Proxy-Config nicht vergessen.
