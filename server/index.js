import express from "express"
import PocketBase from "pocketbase"

const app = express()
app.use(express.json())

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

app.post("/api/interact", authMiddleware, async (req, res) => {
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

app.post("/api/update-position", authMiddleware, async (req, res) => {
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
