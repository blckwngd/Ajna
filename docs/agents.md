# Agenten bauen

Ein **Agent** ist in Ajna nichts Spezielles — es ist ein ganz normaler PocketBase-Client, der sich für die Aktions-Events seines zugewiesenen Objekts subscribed und mit Daten-Updates (z. B. `animation_state`-Wechseln) reagiert. Das gleiche Konzept funktioniert für NPC-Logik, IoT-Bridges, automatisierte Tests oder einfache Skript-Bots.

Alle Agent-Operationen laufen über die [`AjnaManager`](../client/core/AjnaManager.js)-Bibliothek. Sie funktioniert in beiden Welten:

- **Im Browser** (HTML-Agent-Seiten wie `/index-agent.html`) — direkt importierbar als ES-Modul, gebündelt via Webpack.
- **In Node.js** (für headless Worker, IoT-Bridges, Tests) — gleicher Code, plus `EventSource`-Polyfill bei älteren Node-Versionen.

---

## Konzept

Ein Agent macht typischerweise drei Dinge:

1. **Login** als regulärer User (kein Superuser nötig, sobald die Permissions sauber sitzen).
2. **Connect** — lädt initial alle sichtbaren Objekte und stellt die Realtime-Subscription auf `objects` her.
3. **Subscribe** — auf das eigene Objekt (`watchObject`) für State-Änderungen und auf die Aktions-Events (`onInteract`) für eingehende Trigger.

Dann läuft eine Event-Loop:
- Spieler klickt im AR-Client auf "Angreifen" → `POST /api/objects/:id/interact { action: "attack" }`.
- PocketBase prüft die Permission und broadcastet das Event an alle Subscriber von `interact:<id>`.
- Der Agent empfängt das Event, entscheidet anhand seiner Reaktions-Logik (z. B. eine `REACTION_MAP`), und ruft `setAnimation(id, "die")`.
- Das Update an `objects.animation_state` läuft via PocketBase-Realtime an alle Clients zurück — der Spieler sieht den Animations-Wechsel.

---

## Browser-Agent (HTML-Seite)

Minimales Beispiel — kein Build-Tool nötig, sofern du an die `dist/`-Bundles kommst, die der Repo-Webpack ohnehin baut:

```html
<!DOCTYPE html>
<html>
<head><title>My Agent</title></head>
<body>
  <pre id="log"></pre>
  <script type="module">
    import { AjnaManager } from "/path/to/AjnaManager.js"

    const ajna = new AjnaManager("http://" + location.hostname + ":8090")
    const TARGET = "<dein-objekt-id>"

    await ajna.login("agent@example.com", "secret")
    await ajna.connect()

    await ajna.onInteract(TARGET, ev => {
      log(`◀ ${ev.action} von ${ev.source}`)
      if (ev.action === "attack") ajna.setAnimation(TARGET, "die")
    })

    function log(t) {
      document.getElementById("log").textContent += t + "\n"
    }
  </script>
</body>
</html>
```

Ein vollständiger Beispiel-Agent mit UI, Login, manuellen Triggern und Step-Movement liegt unter [`client/agent.js`](../client/agent.js) (HTML: [`client/index-agent.html`](../client/index-agent.html)).

### Eigene Agent-Seite ins Build aufnehmen

Falls du den eigenen Agent als gebündelte Seite betreiben willst:

1. JS-Datei nach `client/<mein-agent>.js`.
2. HTML-Datei nach `client/index-<mein-agent>.html` (Script-Pfad: `/dist/<mein-agent>.bundle.js`).
3. Webpack-Entry in [`webpack.config.cjs`](../webpack.config.cjs) hinzufügen:
   ```js
   entry: {
     ar: "./client/main.js",
     map: "./client/map.js",
     agent: "./client/agent.js",
     "mein-agent": "./client/mein-agent.js"
   }
   ```
4. Webpack-Watch-Task neu starten (Config-Änderungen werden nicht automatisch gepickt).

---

## Node.js-Agent

Für headless Bots, IoT-Bridges oder Server-Side-NPCs:

### Voraussetzungen
- **Node 22+** hat `EventSource` und `fetch` nativ — keine Polyfills nötig.
- **Vor Node 22** brauchst du den `eventsource`-Polyfill (im Repo bereits als Dependency vorhanden).

### Minimal-Beispiel

```js
// agent.mjs
import { EventSource } from "eventsource"
globalThis.EventSource = EventSource    // nur bei Node < 22

import { AjnaManager } from "./client/core/AjnaManager.js"

const ajna = new AjnaManager("http://localhost:8090")
await ajna.login(process.env.AJNA_EMAIL, process.env.AJNA_PASSWORD)
await ajna.connect()

const TARGET = "2kjikgp1pvkc4p5"

await ajna.onInteract(TARGET, async ev => {
  console.log(`[${new Date().toISOString()}] ◀ ${ev.action} von ${ev.source}`)
  switch (ev.action) {
    case "attack":  await ajna.setAnimation(TARGET, "die"); break
    case "greet":   await ajna.setAnimation(TARGET, "wave"); break
    case "examine": await ajna.setAnimation(TARGET, "pose"); break
  }
})

// Halten — der Prozess soll nicht beendet werden
process.stdin.resume()
```

Starten mit:
```bash
node agent.mjs
```

### Imports im Node-Kontext

Da `AjnaManager.js` `import PocketBase from 'pocketbase'` verwendet, brauchst du `pocketbase` als npm-Dependency im Node-Projekt (im Repo schon installiert). Bei der Ausführung als ES-Modul muss entweder die Datei `.mjs` heißen oder das Projekt `"type": "module"` in seiner `package.json` haben (so wie unser Repo).

---

## Vorgefertigte Bridges (Referenz-Implementierungen)

Im Verzeichnis [`agents/`](../agents/) liegen mehrere produktionsreife Node-Agents, die als Vorlage für eigene Bridges dienen können:

### AIS-Bridge — [agents/ais-bridge.mjs](../agents/ais-bridge.mjs)

Spiegelt Schiffspositionen aus [aisstream.io](https://aisstream.io/) als Ajna-Objekte. WebSocket-Verbindung mit BoundingBox-Filter, Position/Heading-Updates pro Schiff drosselt-throttled, Stale-Cleanup wenn ein Schiff die Bbox verlässt. Ausschnitte aus der `.env`:

```ini
AISSTREAM_API_KEY=...
AIS_CENTER_LAT=53.5511   # Hamburger Hafen
AIS_CENTER_LON=9.9937
AIS_RADIUS_KM=10
AIS_UPDATE_INTERVAL_S=5
AIS_STALE_TIMEOUT_S=600
```

Start: `npm run ais`.

### ADS-B-Bridge — [agents/adsb-bridge.mjs](../agents/adsb-bridge.mjs)

Spiegelt **Flugzeuge** aus dem [OpenSky-Network](https://opensky-network.org/) (`type="aircraft"`). Analog zur AIS-Bridge, aber mit drei Besonderheiten, die als Muster für „schnelle, weit entfernte, hart rate-limitierte Quellen" taugen:

- **Große Sichtweite (~50 km)** und **großzügige Interest-Areas**: der kleine (~500 m) gefuzzte Spielerbereich wird auf einen 50-km-Radius um seine Mitte aufgeblasen.
- **Aggressive API-Drosselung**: OpenSky ist REST-Poll und limitiert (anonym 400 Credits/Tag, authentifiziert 4000). Gepollt wird **nur bei aktiven Interessensbereichen**; der Antwort-Header `X-Rate-Limit-Remaining` steuert die Drosselung, bei knappem Budget / HTTP 429 wird pausiert. Anonym per Default, optional **OAuth2 Client-Credentials** (`OPENSKY_CLIENT_ID/SECRET`) für das größere Budget.
- **Client-seitige Vorausberechnung (Dead-Reckoning)**: weil Polls selten sind (~30 s), aber Flugzeuge schnell (250 m/s → 7,5 km zwischen Polls), schreibt der Agent nur `state.adsb = {v, trk, vrate, t, lat0, lon0, alt0}`; der [`PositionSmoother`](../client/core/PositionSmoother.js) rechnet daraus **pro Frame** die aktuelle Position voraus (statt zu interpolieren). Gilt automatisch für Karte UND AR.

```ini
# leer = anonym; für mehr Budget OAuth2-Client anlegen
OPENSKY_CLIENT_ID=
OPENSKY_CLIENT_SECRET=
ADSB_CENTER_LAT=50.11    # Frankfurt (Fallback ohne Interessensbereiche)
ADSB_CENTER_LON=8.68
ADSB_RADIUS_KM=50
ADSB_POLL_S=30
ADSB_MAX_AIRCRAFT=200
ADSB_STALE_TIMEOUT_S=120
```

Start: `npm run adsb`.

### POI-Bridge — [agents/poi-bridge.mjs](../agents/poi-bridge.mjs)

Holt POIs (Bänke, Cafés, Brunnen etc.) via [`AjnaGeo.poisNear()`](../client/core/AjnaGeo.js) aus dem `/ajnaapi/geo/pois`-Endpoint (intern Overpass-gestützt, Server-Cache) und legt sie als Ajna-Objekte mit `type="poi"` an. Idempotent über `state.osm_id`, Cleanup für POIs, die aus dem aktuellen Overpass-Result rausfallen. Default-Lauf macht einen Sync und beendet; `POI_REFRESH_S>0` schaltet einen periodischen Refresh ein. Start: `npm run poi`.

### Gemeinsame Muster

Beide Bridges teilen sich:

- **`.env`-Loader** inline am Anfang (kein `dotenv`-package — kleiner JS-Parser, identisches Schema wie [`tools/ajna.mjs`](../tools/ajna.mjs)).
- **Re-exec mit `--use-system-ca`**: wenn `AJNA_URL` HTTPS ist (Caddy mit interner CA), spawnen sich die Agents selbst neu mit dem Flag, damit Node die Cert-Chain anerkennt.
- **`EventSource`-Polyfill aus npm** bei `import 'eventsource'` — PB-SDK öffnet beim ersten `refreshObjects()` automatisch eine Realtime-SSE.
- **`type`-Feld** im PB-Record markiert Objekte für den AR-Renderer (siehe [`GameObject.#createPlaceholder`](../client/engine/GameObject.js)) und für die Bridge-internen Filter (`type="ship"` / `"poi"`).
- **`state.source`-Feld** als Marker für "von dieser Bridge angelegt" — schützt User-eigene Objekte vor dem Cleanup.
- **`default_permissions` am Agent-User** (manuell in PB-Admin gesetzt, z. B. `[{subject_type: "authenticated", rights: ["view"]}]`) — sonst sehen andere Spieler die Objekte nicht.

Wenn du eine neue Bridge schreibst, kopier die `poi-bridge.mjs` als Ausgangspunkt — sie ist die kompaktere von beiden und zeigt den vollen `AjnaManager` + `AjnaGeo`-Pfad inklusive idempotent-create + Cleanup.

---

## AjnaManager — API-Referenz

Vollständige API der Bibliothek. Alle Methoden sind asynchron, wo nicht anders angegeben.

### Konstruktor

```js
new AjnaManager(urlOrOpts = "http://localhost:8090")
```

- **String** → wird als PocketBase-URL benutzt.
- **Objekt** `{ url?, pb? }` → optional eine vorkonfigurierte `PocketBase`-Instance mitgeben (z. B. mit Custom-Headers, vorab eingeloggt, eigenem `fetch`).

```js
const ajna = new AjnaManager("http://192.168.1.20:8090")
// oder
import PocketBase from "pocketbase"
const pb = new PocketBase("...")
const ajna = new AjnaManager({ pb })
```

### Auth

| Methode | Beschreibung |
|---|---|
| `login(email, password)` | Loggt als regulärer User ein |
| `logout()` *(sync)* | Verwirft Session-Token |
| `isLoggedIn()` *(sync)* | `true`/`false` |
| `currentUser()` *(sync)* | Aktuell eingeloggter User-Record oder `null` |
| `onAuthChanged(cb)` *(sync)* | Listener auf Login/Logout/Token-Refresh. Gibt unsubscribe zurück |

### Lifecycle

| Methode | Beschreibung |
|---|---|
| `connect()` | Lädt Objekt-Liste + aktiviert Realtime-Sub. Idempotent |
| `disconnect()` | Räumt alle Subs auf, leert Cache |

### Objekte — Lesen

| Methode | Beschreibung |
|---|---|
| `getObjects()` *(sync)* | Snapshot aller sichtbaren Objekte aus dem Cache |
| `getObjectById(id)` *(sync)* | Einzelnes Objekt aus dem Cache |
| `refreshObjects()` | Server-Re-Fetch, ersetzt Cache, feuert `onObjectsChanged` |

### Objekte — Schreiben

| Methode | Beschreibung |
|---|---|
| `createObject(data)` | Neues Objekt anlegen. `owner` wird serverseitig auto-gesetzt |
| `updateObject(id, patch)` | Beliebige Felder aktualisieren |
| `deleteObject(id)` | Objekt löschen |
| `setAnimation(id, state)` | Shortcut für `updateObject(id, { animation_state: state })` |
| `moveObject(id, lat, lon, alt?)` | Shortcut für reine Positions-Updates |

### Subscriptions

| Methode | Beschreibung |
|---|---|
| `onObjectsChanged(cb)` *(sync)* | Listener auf jede Änderung der Objekt-Liste. Callback erhält den vollständigen Cache-Snapshot |
| `watchObject(id, cb)` | Subscribe auf einzelnes Objekt. Callback: `(record, action)` mit action ∈ {create, update, delete} |

### Interaktionen

| Methode | Beschreibung |
|---|---|
| `interact(objectId, action, payload?)` | Server-Route, Permission-Check, Broker-Broadcast |
| `onInteract(objectId, cb)` | Subscribe auf `interact:<id>`. Callback erhält `{ action, source, ts, payload }` |

### Nähe (Näherungs-Auslöser)

| Methode | Beschreibung |
|---|---|
| `onProximity(objectId, cb)` | Subscribe auf `proximity:<id>`. Callback erhält `{ state: 'enter'\|'leave', source, ts }` |
| `reportProximity({enter, leave})` | Client-Seite — Agents brauchen das normalerweise nicht |

```js
// NPC wacht auf, wenn jemand kommt:
await ajna.onProximity(TARGET, async ev => {
  if (ev.state === 'enter') await ajna.setAnimation(TARGET, 'wave')
  if (ev.state === 'leave') await ajna.setAnimation(TARGET, 'idle')
})
```

Der Spieler-Client meldet nur Objekt-**IDs**, nie Koordinaten: er kennt seine Position, rechnet den Umkreis (50 m) selbst aus und schickt ausschließlich die Übergänge. Gemeldet wird nur an Server, für die der Spieler mindestens Stufe „Nähe" gesetzt hat, und nur für Objekte, die er **sehen** darf — ein unsichtbares Objekt spürt ihn nicht.

**Verlass dich nicht darauf als Nachweis.** Der Client ist die einzige Positionsquelle und kann Nähe behaupten. Für Belebung ideal, für „Spieler war nachweislich an Ort X" (z. B. als Quest-Bedingung) ungeeignet — dafür braucht es einen zweiten Faktor (UWB-Anker, signierter Sensor-Report). Ebenso: ein `leave` kann ausbleiben (App gekillt, Netz weg) — wer einen sauberen Zustand braucht, sollte die Anwesenheit nach einer Weile selbst verfallen lassen.

### Berechtigungen

| Methode | Beschreibung |
|---|---|
| `listPermissions(objectId)` | ACE-Liste eines Objekts (nur Owner darf) |
| `addPermission(objectId, ace)` | Neue ACE hinzufügen |
| `updatePermission(aceId, patch)` | Bestehende ACE ändern |
| `removePermission(aceId)` | ACE löschen |
| `getEffectiveRights(objectId)` | Effektive Rechte des aktuellen Users (inkl. impliziter Audiences) |

ACE-Format: `{ subject_type, subject?, rights, interact_actions }`. Siehe [docs/permissions.md](permissions.md).

### Gruppen

| Methode | Beschreibung |
|---|---|
| `listGroups()` | Alle für den User sichtbaren Gruppen |
| `createGroup(name, { members, subgroups })` | Neue Gruppe (User wird Owner) |
| `updateGroup(id, patch)` | Members/Subgroups/Name ändern |
| `deleteGroup(id)` | Gruppe löschen |

### User (Default-Permissions)

| Methode | Beschreibung |
|---|---|
| `getMyDefaultPermissions()` *(sync)* | ACE-Templates, die bei neuen Objekten automatisch übernommen werden |
| `setMyDefaultPermissions(aces)` | Templates speichern |
| `listUsers()` | User-Liste — wegen Privacy-Rule meist nur der eigene User sichtbar |

### Roh-Zugriff

`ajna.pb` ist die unter dem Manager liegende `PocketBase`-Instance — für Custom-Collections, File-Uploads oder andere low-level Operationen, die der Manager nicht direkt abdeckt.

---

## Demo-Agent als Vorlage

[`client/agent.js`](../client/agent.js) ist als Referenz gedacht. Übernehmenswerte Patterns:

- **`REACTION_MAP`**: ein einfaches Mapping von eingehender Action zu ausgehender Animation. Erweiterbar zur Logik beliebiger Komplexität (State-Machine, Wahrscheinlichkeiten, Cooldowns).
- **Logging via DOM-Panel**: nützlich für Browser-Agents; im Node entsprechend `console.log`.
- **Subscriptions schließen bei Login-Wechsel**: PB-Subscriptions hängen am Auth-Token. Vor `connect()` mit neuem Token alte Subs explizit closen, sonst doppelte Watcher.
- **Manuelle Triggers** für Tests: Auto-Pace, schrittweises Bewegen, manuelles `setAnimation`.

---

## Architektur-Hinweise

- **Permissions** des Agenten gelten wie für jeden anderen Client — der eingeloggte User muss `interact` auf seinem zugewiesenen Objekt haben (im Smart-Home-Fall: Owner). Siehe [docs/permissions.md](permissions.md).
- **Mehrere Agents auf dasselbe Objekt** sind möglich, aber unkoordiniert — bei race-conditions gewinnt der letzte `update`. Für autoritatives Verhalten "ein Agent pro Objekt" als Konvention.
- **IoT-Bridge**: ein Agent kann gleichzeitig MQTT-Client zum eigenen Smart-Home-Bus und Ajna-Client sein. Aktions-Events kommen aus Ajna, MQTT-Publishes gehen an das Gerät. Sensorwerte aus MQTT werden via `updateObject` zurück in Ajna geschrieben.
