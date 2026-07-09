import express from "express"
import PocketBase from "pocketbase"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { mountGeoRoutes } from "./geo.js"
import { mountPresenceRoutes } from "./presence.js"

// .env aus dem CWD nachladen (nur Keys, die NICHT schon in der Umgebung stehen —
// Shell-Export gewinnt). Damit wirken AJNA_CORS_ORIGINS / AJNA_PRESENCE_DEBUG u. Ä.
// auch ohne manuellen Export. Bewusst minimal, keine Abhängigkeit.
try {
  for (const line of readFileSync(resolve(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
  }
} catch { /* keine .env — ok */ }

// Ajna-Express-Backend für Server-Logik, die nicht als PocketBase-Hook
// abgebildet werden kann oder soll (z. B. Aggregations-Queries, Upload-
// Preprocessing, Notification-Fan-out, externe API-Aufbereitung).
//
// **Namespace-Konvention**: Alle Routen dieses Backends liegen unter
// `/ajnaapi/*`. Damit kollidieren sie nicht mit dem `/api/*`-Namespace
// von PocketBase (eingebaute REST-Calls + PB-Hooks unter pb_hooks/),
// wenn beides hinter demselben Caddy-Reverse-Proxy auf einem Origin
// erreichbar gemacht wird.

const app = express()

// CORS: /ajnaapi muss CROSS-ORIGIN erreichbar sein, damit ein Ajna-Viewer auf
// Origin A (z. B. https://localhost) einen Server B (z. B. https://ajna.example)
// für Interest-Areas/Geo nutzen kann (Multi-Server). PocketBase (/api) macht
// CORS selbst — dieses Backend muss es ergänzen, sonst scheitern Cross-Origin-
// Calls am Preflight (kein Access-Control-Allow-Origin).
//
// Sicherheit: Der Origin wird gespiegelt (keine Wildcard, da Authorization-
// Header geschickt werden). Das ist unbedenklich, weil /ajnaapi ein Bearer-Token
// verlangt — der Browser sendet diesen NICHT automatisch cross-site (kein Cookie,
// kein CSRF). Optional auf eine Allowlist (AJNA_CORS_ORIGINS, kommasepariert)
// einschränkbar.
const CORS_ALLOW = (process.env.AJNA_CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean)
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && (CORS_ALLOW.length === 0 || CORS_ALLOW.includes(origin))) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Vary', 'Origin')
    res.set('Access-Control-Allow-Credentials', 'true')
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.set('Access-Control-Max-Age', '600')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.use(express.json())

// Geo-Kontext-Endpoints (OSM via Overpass).
mountGeoRoutes(app)

// Interest-Areas (datenschutzfreundliche Präsenz; in-memory, anonymisiert).
mountPresenceRoutes(app)

const pb = new PocketBase("http://127.0.0.1:8090")

// Optional: User Token weiterreichen
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1]
  if (token) {
    pb.authStore.save(token, null)
  } else {
    pb.authStore.clear()
  }
  next()
}

app.post("/ajnaapi/interact", authMiddleware, async (req, res) => {
  const { objectId, action } = req.body

  if (!pb.authStore.isValid) {
    return res.status(401).json({ error: "login required" })
  }

  const object = await pb.collection("objects").getOne(objectId)

  if (object.type === "lamp" && action === "toggle") {
    await pb.collection("objects").update(objectId, {
      state: { on: !object.state?.on }
    })
    return res.json({ ok: true })
  }

  res.status(400).json({ error: "invalid action" })
})

app.post("/ajnaapi/update-position", authMiddleware, async (req, res) => {
  if (!pb.authStore.isValid) {
    return res.status(401).json({ error: "login required" })
  }

  const { lat, lon, altitude, source } = req.body

  await pb.collection("players").update(
    pb.authStore.model.player_id,
    { lat, lon, altitude, source }
  )

  res.json({ ok: true })
})

app.listen(3000)
