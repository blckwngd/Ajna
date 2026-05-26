import express from "express"
import PocketBase from "pocketbase"
import { mountGeoRoutes } from "./geo.js"

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
app.use(express.json())

// Geo-Kontext-Endpoints (OSM via Overpass).
mountGeoRoutes(app)

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
