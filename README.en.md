# Ajna

> 🇩🇪 **Deutsch:** [README.md](README.md) — the German version is the one the
> maintainers keep closest to the code. Where the two disagree, it is right.

> **📖 Documentation:** the [wiki](wiki/Home.md) is the entry point for users,
> operators and developers, including the full reference for
> [Ajna-Library](wiki/Ajna-Library.md) and [Agent-Library](wiki/Agent-Library.md).
> **Those pages are in German.** This file is the English entry point; the pages
> a contributor really needs will follow as they are touched.
>
> The pages live under `wiki/`, versioned with the code, and are meant to be read
> in the repository — the table of contents is [wiki/Home.md](wiki/Home.md#inhalt).
> `node tools/wiki-nav.mjs` generates navigation from an outline; the same folder
> can optionally be mirrored to the GitHub wiki with `node tools/wiki-publish.mjs`.

## Vision

Ajna is a framework for location-based, persistent multiplayer AR/XR
applications. Real places and objects are augmented with digital content, state
and interaction — in the long run a digital twin of the real world with an
interactive layer on top.

It is not a game. It is a geospatial and realtime platform for mixed-reality
applications.

---

## The core idea

Real GPS coordinates are transformed client-side into local 3D world
coordinates. Objects live in PocketBase; every change is distributed to all
connected clients through realtime subscriptions. Agents (NPC logic, IoT
bridges) are ordinary PocketBase clients — they connect exactly like a game
client does and react to action events.

- **Object persistence**: PocketBase
- **Realtime**: PocketBase SSE subscriptions, plus a subscription broker for
  ephemeral interaction events (no database write)
- **Authoritative permissions**: server-side resolver (NTFS-like, with groups and
  implicit audiences). See [docs/permissions.md](docs/permissions.md).
- **Agents and custom clients**: go through the `AjnaManager` library. See
  [docs/agents.md](docs/agents.md).

---

## Components

Three web clients share the `AjnaManager` library and the PocketBase backend:

| Path | Purpose |
|---|---|
| `/index-ar.html` | BabylonJS scene, free debug camera (WASD + arrow keys), editor UI, hover tooltips, permission dialog |
| `/index-map.html` | Leaflet map with OSM tiles, GPS tracking, drag-and-drop object editing |
| `/index-agent.html` | Demo agent: controls one specific object, answers action events with animation changes |

Backend:

- **PocketBase** (`pocketbase/`) — collections, auth, realtime, JSVM hooks
  (`pb_hooks/`) for the resolver and custom routes under `/api/*`
  (`/api/objects/:id/interact`, `/api/objects/:id/effective-rights`,
  `/api/groups/:id/invite`, …).
- **Express server** (`server/`) — routes that cannot be expressed as a
  PocketBase hook, under `/ajnaapi/*` (a separate namespace, so nothing collides
  with PocketBase). Lightweight today, mainly an extension point.
- **Caddy** (reverse proxy + HTTPS frontend) — puts client, PocketBase and
  Express behind a single origin. Locally through its internal CA, publicly
  through Let's Encrypt. Template: `Caddyfile`; local changes go into
  `Caddyfile.prod` (gitignored).

---

## Architectural principles

Strict separation of layers:

- **Geo / world logic** — GPS acquisition, coordinate transformation
  (`GeoTransformer`; Z = north, Y = up, 1 Babylon unit = 1 m)
- **Rendering** — BabylonJS scene, cameras, materials
- **Networking** — PocketBase realtime, bundled in `AjnaManager`
- **Components / systems** — ECS-like, GameObjects with components
- **Debug** — kept apart under `/engine/debug/`

Backend data models never reach into components: a mapping layer translates
PocketBase records into engine state.

### The stack at a glance

**Frontend:** BabylonJS · WebXR · Webpack · ES modules · Leaflet · optional 3D
tiles
**Backend:** PocketBase · Express (`/ajnaapi/*`) · Caddy (HTTPS frontend and
reverse proxy)
**Library:** [`AjnaManager`](client/core/AjnaManager.js) — one API for auth,
object CRUD, realtime, interactions, permissions, groups, invitations and
**multi-server**

### Language

Code is English, the interface is German. The dividing line runs exactly where a
human reads the text: identifiers, keys in stored data and new comments are
English; strings passed to `t('…')` are German, because **the German sentence is
the translation key**. The rules are in [CLAUDE.md](CLAUDE.md), the reasoning in
[docs/mehrsprachigkeit.md](docs/mehrsprachigkeit.md) (German).

The existing code is still mixed. It is not being renamed in one sweep — whoever
touches a file renames it on the way out.

---

## Setup

### Prerequisites

| Tool | Installation |
|---|---|
| **Node.js 22+** (with npm) | [nodejs.org](https://nodejs.org/) |
| **PocketBase binary** at `pocketbase/pocketbase.exe` (Windows) or `pocketbase/pocketbase` (Linux/macOS) | [pocketbase.io/docs](https://pocketbase.io/docs/) |
| **Caddy** on `PATH` | Windows: `winget install CaddyServer.Caddy` · macOS: `brew install caddy` · Linux: [caddyserver.com/download](https://caddyserver.com/download) |

> **You do not need your own HTTPS certificates.** Caddy issues one for
> `localhost` from its internal CA and installs that CA into the system keystore
> once per machine (you get an admin prompt on first start).

### First-time setup

```bash
# 1. Clone the repository, install dependencies
git clone <repo-url> Ajna
cd Ajna
npm install

# 2. Create Caddyfile.prod from the template
#    Windows:     copy Caddyfile Caddyfile.prod
#    Linux/macOS: cp Caddyfile Caddyfile.prod
#    For a purely local setup the unchanged copy is enough.
#    For a public demo: adjust demo.example.com / admin@example.com / paths.
```

### Running the stack

```bash
npm run stack
```

Four processes in parallel — PocketBase, webpack watch, the Express API and
Caddy. Ctrl+C stops all of them. In **VS Code**: `F1` → "Tasks: Run Task" →
"Stack: Start All".

### URLs

Everything runs behind Caddy on the same origin (same-origin, so no mixed
content).

| URL | Purpose |
|---|---|
| `https://localhost/`                  | **Main client** — tabs for map / AR / objects / settings (all device settings live here) |
| `https://localhost/index-ar.html`     | AR client (BabylonJS + WebXR) |
| `https://localhost/index-map.html`    | Map client (Leaflet) |
| `https://localhost/index-agent.html`  | Demo agent (fox NPC) |
| `https://localhost/_/`                | PocketBase admin UI |
| `https://localhost/api/*`             | PocketBase REST + realtime + hooks |
| `https://localhost/ajnaapi/*`         | Ajna Express backend |

Devices on the LAN reach the stack at `https://<lan-ip>/...`. Caddy's internal CA
does not apply there — the test device must either trust Caddy's root
certificate, or you put a public hostname with a Let's Encrypt certificate in
front (see [docs/dev-setup.md](docs/dev-setup.md)).

### Multi-server

A client can connect to several Ajna servers at once (say "home" and "office").
Through the **Server** button in the editor panel you can:

- list known servers with their login and connection state
- add new servers by URL
- keep separate credentials and a separate token per server (in `localStorage`
  under `ajna_auth_<id>`)

Objects from all connected servers appear merged in the world; actions are routed
back to the server they came from.

### npm scripts

| Script | Purpose |
|---|---|
| `npm run stack`       | Full stack: PocketBase + webpack watch + Express + Caddy |
| `npm run pocketbase`  | PocketBase only, on `0.0.0.0:8090` |
| `npm run dev`         | Webpack in watch mode |
| `npm run start`       | Express backend only, on port 3000 |
| `npm run caddy`       | Caddy only, with `Caddyfile.prod` |
| `npm run build`       | One-off webpack production build |
| `npm test`            | All suites: unit, UI, geo, landing spots, quests, privacy |
| `npm run ais`         | Node agent: mirrors AIS ship positions (aisstream.io) into Ajna |
| `npm run poi`         | Node agent: turns OSM POIs in a bounding box into Ajna objects |
| `npm run start:dev`   | **Legacy** — Express plus the old static HTTPS server without Caddy (using `cert.pem`) |

> **PocketBase does NOT reload `pb_hooks/`** — restart the PocketBase process
> after every hook change. Caddy, on the other hand, reloads while running:
> `caddy reload --config Caddyfile.prod`.

> Two suites (`quests`, `privacy`) create throwaway accounts against the running
> stack. Signing up is rate-limited to 100 accounts per hour, and one full run
> uses about forty — running everything three times in a row will hit the limit.
> The suites say so explicitly when they do.

---

## Further reading

The entry point for all three audiences is the **[wiki](wiki/Home.md)** (German):

- Using it — [Erste Schritte](wiki/Erste-Schritte.md) · [Die App](wiki/Die-App.md) · [Privatsphäre](wiki/Privatsphaere.md)
- Operating it — [Server betreiben](wiki/Server-betreiben.md) · [Agents betreiben](wiki/Agents-betreiben.md) · [Berechtigungen](wiki/Berechtigungen.md)
- Developing — [Einen Agent bauen](wiki/Einen-Agent-bauen.md) · [Ajna-Library](wiki/Ajna-Library.md) · [Agent-Library](wiki/Agent-Library.md) · [Objektmodell](wiki/Objektmodell.md) · [Architektur](wiki/Architektur.md)

Topics that need their own hardware or setup stay under `docs/`:

- [**docs/permissions.md**](docs/permissions.md) — ACE model, schema, resolver, invitations, roadmap
- [**docs/dev-setup.md**](docs/dev-setup.md) — stack workflows, restart rules, troubleshooting
- [**docs/arbeitspakete.md**](docs/arbeitspakete.md) — what is open, in priority order
- [**docs/deployment.md**](docs/deployment.md) · [**docs/uwb.md**](docs/uwb.md) · [**docs/pointing.md**](docs/pointing.md) · [**docs/homeassistant.md**](docs/homeassistant.md) · [**docs/visual-tracking.md**](docs/visual-tracking.md)

---

## Where things stand

- ✅ GPS → local 3D coordinates (equirectangular approximation around a world origin)
- ✅ Object CRUD through PocketBase with realtime subscriptions
- ✅ Shared editor UI for AR and map, drag-and-drop on the map
- ✅ Dummy GPS for development (persisted in `localStorage`)
- ✅ Hover tooltips, highlighting and off-screen direction indicators in both clients
- ✅ Action pipeline: player click → `/api/objects/:id/interact` → permission check → broker broadcast → agent reacts → `animation_state` update → every client sees the new animation
- ✅ Demo agent (`/index-agent.html`) with action→animation mapping, manual triggers, stepwise movement
- ✅ Permission resolver (owner, groups with transitive subgroups, implicit audiences)
- ✅ `effective_permissions` cache with automatic invalidation through hooks
- ✅ Group management UI (owned groups and memberships, nested subgroups)
- ✅ Friends and invitations by e-mail OR display name (privacy-strict; `users.listRule` stays `id = @request.auth.id`)
- ✅ WebXR immersive mode with an in-world HUD, gaze focus, ESC to exit, multi-input (mouse / controller / touch)
- ✅ XR controller state machine (Daydream and other 3DOF devices) — touchpad cycles through objects, touchpad press or trigger confirms, an explicit "back" entry replaces the system back button that never reaches the page
- ✅ Multi-server (phases 1, 2 and 4): federation across N PocketBase clients, composite object IDs, server dialog, per-server auth, server badges in the editor, permission dialog and object actions
- ✅ Caddy as HTTPS frontend and reverse proxy (same origin for client, API and Express; local internal CA, optional Let's Encrypt)
- ✅ AIS bridge (Node agent): aisstream.io → Ajna objects (`type="ship"`), position, heading and vessel name, with cleanup when a ship leaves the bounding box
- ✅ POI bridge (Node agent): Overpass POIs → Ajna objects, idempotent sync with cleanup
- ✅ Right-click on the ground in AR or on the map → "new object…" at exact GPS coordinates, editor pre-filled
- ✅ POI and ship visibility for authenticated users through implicit-audience ACEs and `default_permissions` on the agent account
- 🚧 Default-permissions editor in the user profile
- 🚧 Inventory system (portable objects, items as keys or weapons)
- 🚧 Rule engine (predicate trees → effects; later: physical sensors as conditions)
- 🚧 Multi-server phase 5: token refresh, reconnect strategy, two-instance smoke test

### Medium term

- A send path for player positions (realtime multiplayer already works receive-side)
- Floating origin / origin rebase across large world distances
- WebXR session mode `immersive-ar` and device orientation
- IoT bridge (MQTT ↔ Ajna) for smart-home devices
- Interest management with many simultaneous objects

---

## Privacy strategy

Player positions are never persisted. Object positions are, but each object
carries its own permissions (smart-home devices are visible to the family, not to
strangers — see [docs/permissions.md](docs/permissions.md)).

`users.listRule` and `viewRule` are privacy-strict: a logged-in user sees only
themselves. Direct user-to-user visibility exists only where both belong to the
same group or have explicitly invited each other.

### Location sharing: four levels, per server

You connect to several servers and trust them differently — a single global
switch would inevitably be either the lowest common denominator or a leak to the
least trusted server. So the level applies **per server**
(`client/core/PrivacyPolicy.js`), and the default is **hidden**:

| Level | What reaches the server |
|---|---|
| **Hidden** | nothing |
| **Area** | a blurred region: centre rounded to a 100 m grid, with a 500 m box around it |
| **Proximity** | additionally "someone is near object Y" — as an object ID, never as a coordinate |
| **Exact** | the precise position |

The levels build on each other. They are enforced **in the fan-out**
(`AjnaManager.publishInterestArea` and `.reportProximity`), which is the only
place presence data leaves the client — so no future call can leak past them.
The setting is stored on the device: the default applies to *new* servers and
could hardly live on a server you have not met yet, and a rule that limits a
server does not belong to that server.

The asymmetry is deliberate: the level blocks `enter`, never `leave` — "I am
here" gives something away, "I am gone" takes something back. Otherwise
downgrading would leave your last known presence standing forever.

**A limit worth stating plainly:** the client is the only source of position, so
it can also claim proximity. Proximity triggers are good for bringing the world
to life (an agent reacts when someone arrives); they are **not proof** ("the
player was at place X" as a quest condition). That needs a second factor such as
a UWB anchor or signed sensor reports. And "exact" today mostly helps the server
itself: the aggregate for agents (`GET /ajnaapi/interest-areas`) still snaps to a
250 m grid.

---

## Project status

Ajna is experimental. The architectural decisions are made so that later
changes — a distributed or federated world, indoor positioning, tile streaming,
swapping the engine inside a subsystem — remain possible without deep
refactoring.
