// =====================================================================
// Ajna Agent (Demo)
//
// Kontrolliert ein konkretes Objekt im Ajna-Backend über die
// AjnaManager-Bibliothek:
//   - lädt initial den Datensatz beim connect()
//   - watchObject() für Live-Updates des Datensatzes
//   - onInteract() für Aktions-Events anderer Spieler
//   - reagiert mit setAnimation() — landet als animation_state im
//     Realtime-Stream und damit synchron in allen Clients.
//
// Plus Debug-UI: Status, Log, manuelle Animation/Bewegung/Triggers.
// =====================================================================

import { AjnaManager } from "./core/AjnaManager.js"
import { AjnaGeo } from "./core/AjnaGeo.js"

const TARGET_OBJECT_ID = "2kjikgp1pvkc4p5"     // Vanguard
// Same-Origin via Caddy. Falls der Agent gegen einen anderen Server laufen
// soll (z. B. cross-origin auf demo.example.com), hier einen Absolute-URL
// eintragen und im PB-Schema die Origin in `cors.allowed_origins` ergänzen.
const AJNA_URL = window.location.origin
const MOVE_STEP_DEG = 0.00001                  // ~1.1 m je nach Breite
const AUTO_PACE_INTERVAL_MS = 1500

// Walk-Parameter — Geschwindigkeiten in m/s, Tick-Frequenz 2 Hz.
// Die Client-Smoother (AR + Karte) interpolieren in der Lücke; höhere
// Raten würden PB + Realtime-Broker unnötig belasten, ohne sichtbaren
// Gewinn. Wenn du wieder feiner sampeln willst: TICK_INTERVAL_MS senken
// UND `MAX_INTERP_MS` im PositionSmoother an die neue Lücke anpassen.
const WALK_SPEED_MS = 1.4    // ~5 km/h
const RUN_SPEED_MS  = 3.5    // ~12 km/h
const TICK_INTERVAL_MS = 500
const WAY_SEARCH_RADIUS_M = 200

// Y-Rotation des Modells vs. Bewegungsrichtung. Bei der Fuchs-GLB
// stimmt `yaw = -bearing` (Modell zeigt nativ in +Z). Wenn ein anderes
// Modell rückwärts läuft: hier auf `bearing` oder `bearing + Math.PI`
// stellen.
const HEADING_TO_YAW = bearing => bearing - Math.PI/2

// Aktion → Animation, mit der der Agent reagiert (für einfache Reaktionen
// ohne Pfad-Verfolgung). gehen/laufen/anhalten haben eigene Behandlung.
const REACTION_MAP = {
  attack:   "Run",
  pet:    "Walk",
  examine:  "Survey"
}

const ajna = new AjnaManager(AJNA_URL)
const geo  = new AjnaGeo(ajna)
window.ajna = ajna   // damit Console-Tests wie `await geo.info()` greifen
window.geo  = geo
const state = {
  object: null,
  objSub: null,
  interactSub: null,
  autoPaceTimer: null,
  walk: null                // siehe startWalk()
}

const els = {}

window.addEventListener("DOMContentLoaded", init)

async function init() {
  els.status        = document.getElementById("status")
  els.objName       = document.getElementById("obj-name")
  els.objId         = document.getElementById("obj-id")
  els.objAnim       = document.getElementById("obj-anim")
  els.objCoords     = document.getElementById("obj-coords")
  els.log           = document.getElementById("log")
  els.email         = document.getElementById("auth-email")
  els.password      = document.getElementById("auth-password")
  els.emailRow      = document.getElementById("email-row")
  els.passwordRow   = document.getElementById("password-row")
  els.userDisplay   = document.getElementById("user-display")
  els.userDisplayRow = document.getElementById("user-display-row")
  els.loginBtn      = document.getElementById("login-btn")
  els.logoutBtn     = document.getElementById("logout-btn")
  els.authStatus    = document.getElementById("auth-status")
  els.animInput     = document.getElementById("anim-input")
  els.animSetBtn    = document.getElementById("anim-set-btn")
  els.interactSel   = document.getElementById("interact-select")
  els.interactBtn   = document.getElementById("interact-btn")
  els.autoPaceChk   = document.getElementById("autopace-chk")
  els.reactionList  = document.getElementById("reaction-list")

  for (const dir of ["n","s","e","w"]) {
    document.getElementById(`move-${dir}`)
      .addEventListener("click", () => stepMove(dir))
  }
  els.loginBtn   .addEventListener("click", doLogin)
  els.logoutBtn  .addEventListener("click", doLogout)
  els.animSetBtn .addEventListener("click", () => {
    const v = els.animInput.value.trim()
    if (v) setAnimation(v)
  })
  els.interactBtn.addEventListener("click", () => {
    triggerInteract(els.interactSel.value)
  })
  els.autoPaceChk.addEventListener("change", e => {
    toggleAutoPace(e.target.checked)
  })

  // Reaktions-Mapping (read-only) anzeigen
  els.reactionList.innerHTML = Object.entries(REACTION_MAP)
    .map(([a, r]) => `<li><code>${a}</code> → <code>${r}</code></li>`)
    .join("")

  // Auth-UI direkt am Anfang spiegeln (persistiertes PB-Token → eingeloggt).
  // onAuthChanged hält die Anzeige danach synchron, auch wenn andere
  // Komponenten (z. B. ServerDialog) Auth-Wechsel triggern.
  updateAuthUI()
  ajna.onAuthChanged(() => updateAuthUI())

  log(`agent boot, target: ${TARGET_OBJECT_ID}`)
  await connect()
}

async function connect() {
  try {
    await ajna.connect()

    state.object = ajna.getObjectById(TARGET_OBJECT_ID)
    if (!state.object) {
      log(`object ${TARGET_OBJECT_ID} not in visible set — likely a permission issue`, "warn")
      setConnected(false)
      return
    }
    log(`object loaded: ${state.object.name}`)
    updateObjectView()

    state.objSub = await ajna.watchObject(TARGET_OBJECT_ID, (rec, action) => {
      if (action === "delete") {
        log("object deleted on server", "warn")
        setConnected(false)
        return
      }
      state.object = rec
      log(`object update → anim=${rec.animation_state ?? "?"}`)
      updateObjectView()
    })
    log("subscribed: object updates")

    state.interactSub = await ajna.onInteract(TARGET_OBJECT_ID, data => {
      handleInteract(data)
    })
    log("subscribed: interact events")

    setConnected(true)
  } catch (err) {
    const msg = err?.message || String(err)
    log(`connect error: ${msg}`, "error")
    if (/auth/i.test(msg) || /token/i.test(msg)) {
      log("Hinweis: vor connect() einloggen.", "warn")
    }
    setConnected(false)
  }
}

function handleInteract(data) {
  const action = data.action || "?"
  const source = data.source || "anon"
  log(`◀ interact: ${action} from ${source}`)

  // Path-Following-Aktionen — eigene State-Machine (siehe startWalk/stopWalk)
  if (action === "gehen")    return startWalk(WALK_SPEED_MS, "Walk")
  if (action === "laufen")   return startWalk(RUN_SPEED_MS,  "Run")
  if (action === "anhalten") return stopWalk()

  const reaction = REACTION_MAP[action]
  if (!reaction) {
    log(`no reaction defined for "${action}"`)
    return
  }
  log(`→ reacting with animation "${reaction}"`)
  setAnimation(reaction)
}

// ─────────────────────────────────────────────────────────────────────
//  Walk-State-Machine — folgt einer OSM-Way-Polyline mit linearer
//  Interpolation. Ping-Pong an den Enden, damit die Demo nicht stehen
//  bleibt, wenn der Weg endet.
// ─────────────────────────────────────────────────────────────────────

async function startWalk(speed, animation) {
  if (!state.object) return log("no object loaded", "error")
  if (state.walk) stopWalk()

  log(`▶ fetching walkable ways around ${state.object.lat?.toFixed(5)}, ${state.object.lon?.toFixed(5)}`)
  let result
  try {
    result = await geo.waysNear(state.object.lat, state.object.lon, WAY_SEARCH_RADIUS_M, "walkable")
  } catch (err) {
    return log(`✗ geo.waysNear failed: ${err.message || err}`, "error")
  }

  const ways = (result.features || []).filter(f => Array.isArray(f.coordinates) && f.coordinates.length >= 2)
  if (ways.length === 0) {
    return log("Keine begehbaren Wege in der Umgebung", "warn")
  }

  // V1: ersten Way nehmen. Bessere Auswahl (kürzester Abstand zum
  // Objekt, längster Way, Wahrscheinlichkeit nach Tag) kommt später.
  const way = ways[0]
  log(`Pfad: "${way.name || way.id}" (${way.coordinates.length} Punkte)`)

  // Auf dem Way startet der Fuchs am nächstgelegenen Stützpunkt — sonst
  // teleportiert er sichtbar an Way[0].
  const startIdx = findClosestWaypointIdx(way.coordinates, state.object.lat, state.object.lon)

  state.walk = {
    speed,
    animation,
    path: way.coordinates,
    segIdx: startIdx,
    segT: 0,
    direction: 1,
    intervalId: null,
    lastTickAt: performance.now(),
    busy: false
  }

  await setAnimation(animation)

  // Debug-Pfad an PB schreiben, damit der AR-Client den gewählten Weg
  // als grüne Linie über die OSM-Wireframes legen kann. Merge mit
  // vorhandenem state, sonst verlieren wir andere Felder dort.
  try {
    const existingState = state.object?.state || {}
    state.object = await ajna.updateObject(state.object.id, {
      state: { ...existingState, walk_path: way.coordinates }
    })
  } catch (err) {
    log(`(walk_path nicht setzbar: ${err?.message || err})`, "warn")
  }

  state.walk.intervalId = setInterval(tickWalk, TICK_INTERVAL_MS)
  log(`▶ walk gestartet @ ${speed.toFixed(1)} m/s, Start-Segment ${startIdx}`)
}

function stopWalk() {
  const had = !!state.walk
  if (state.walk?.intervalId) clearInterval(state.walk.intervalId)
  state.walk = null
  setAnimation("Survey")
  if (had) {
    // Debug-Pfad clearen, damit der AR-Client die grüne Linie wieder entfernt.
    const existingState = state.object?.state || {}
    if (existingState.walk_path) {
      const cleared = { ...existingState }
      delete cleared.walk_path
      ajna.updateObject(state.object.id, { state: cleared }).catch(() => {})
    }
    log("◼ walk gestoppt")
  }
}

async function tickWalk() {
  const w = state.walk
  if (!w || !state.object) return
  // Re-entry-Schutz: PB-Round-Trips können > 200 ms dauern; ein zweiter
  // Tick darf nicht parallel schreiben (lat/lon-Race).
  if (w.busy) return
  w.busy = true

  try {
    const now = performance.now()
    const dt  = (now - w.lastTickAt) / 1000
    w.lastTickAt = now
    let stepDistance = w.speed * dt

    // Bis zum nächsten Stützpunkt vorrücken; ggf. überlaufende Distanz
    // im nächsten Segment fortsetzen (Mehrfach-Segment-Sprünge bei
    // großer dt oder hoher Geschwindigkeit).
    let lat = state.object.lat
    let lon = state.object.lon
    let headingFrom = null
    let headingTo   = null

    while (stepDistance > 0) {
      const from = w.path[w.segIdx]
      const to   = w.path[w.segIdx + w.direction]
      if (!to) {
        // Pfad-Ende → Richtung umkehren, im selben Tick weiter
        w.direction *= -1
        w.segT = 0
        if (!w.path[w.segIdx + w.direction]) break  // 1-Segment-Pfad
        continue
      }
      const segLen = haversineDistance(from[0], from[1], to[0], to[1])
      if (segLen < 0.001) {
        w.segIdx += w.direction
        w.segT = 0
        continue
      }
      const remainingOnSeg = (1 - w.segT) * segLen
      if (stepDistance >= remainingOnSeg) {
        // Zum nächsten Stützpunkt springen, Rest weitertragen
        lat = to[0]; lon = to[1]
        headingFrom = from; headingTo = to
        stepDistance -= remainingOnSeg
        w.segIdx += w.direction
        w.segT = 0
      } else {
        // Innerhalb des Segments interpolieren
        w.segT += stepDistance / segLen
        lat = from[0] + (to[0] - from[0]) * w.segT
        lon = from[1] + (to[1] - from[1]) * w.segT
        headingFrom = from; headingTo = to
        stepDistance = 0
      }
    }

    const heading = headingFrom && headingTo
      ? bearing(headingFrom[0], headingFrom[1], headingTo[0], headingTo[1])
      : 0
    const yaw = HEADING_TO_YAW(heading)

    state.object = await ajna.updateObject(state.object.id, {
      lat, lon,
      rotation: { x: 0, y: yaw, z: 0 }
    })
    updateObjectView()
  } catch (err) {
    log(`✗ walk tick failed: ${err.message || err}`, "error")
    stopWalk()
  } finally {
    if (state.walk) state.walk.busy = false
  }
}

function findClosestWaypointIdx(path, lat, lon) {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < path.length; i++) {
    const d = haversineDistance(lat, lon, path[i][0], path[i][1])
    if (d < bestDist) { bestDist = d; best = i }
  }
  return best
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000
  const phi1 = lat1 * Math.PI / 180
  const phi2 = lat2 * Math.PI / 180
  const dPhi = (lat2 - lat1) * Math.PI / 180
  const dLam = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dPhi / 2) ** 2 +
            Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Kompass-Bearing in Radianten: 0 = Nord, +π/2 = Ost (im Uhrzeigersinn).
function bearing(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * Math.PI / 180
  const phi2 = lat2 * Math.PI / 180
  const dLam = (lon2 - lon1) * Math.PI / 180
  const y = Math.sin(dLam) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) -
            Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam)
  return Math.atan2(y, x)
}

async function setAnimation(animState) {
  if (!state.object) { log("no object loaded", "error"); return }
  try {
    state.object = await ajna.setAnimation(TARGET_OBJECT_ID, animState)
    log(`✓ animation_state set to "${animState}"`)
    updateObjectView()
  } catch (err) {
    const detail = err?.data?.data?.animation_state?.message
                || err?.message
                || String(err)
    log(`✗ setAnimation failed: ${detail}`, "error")
    if (/animation_state/.test(detail) && /not found|unknown/i.test(detail)) {
      log("Hinweis: das Feld 'animation_state' (text) muss in der "
        + "objects-Collection angelegt sein.", "warn")
    }
  }
}

async function stepMove(dir) {
  if (!state.object) return
  const lat = (state.object.lat ?? 0) + (dir === "n" ? MOVE_STEP_DEG
                                       : dir === "s" ? -MOVE_STEP_DEG : 0)
  const lon = (state.object.lon ?? 0) + (dir === "e" ? MOVE_STEP_DEG
                                       : dir === "w" ? -MOVE_STEP_DEG : 0)
  try {
    state.object = await ajna.moveObject(TARGET_OBJECT_ID, lat, lon)
    log(`✓ moved ${dir.toUpperCase()} → lat=${lat.toFixed(6)} lon=${lon.toFixed(6)}`)
    updateObjectView()
  } catch (err) {
    log(`✗ move failed: ${err?.message || err}`, "error")
  }
}

function toggleAutoPace(on) {
  if (state.autoPaceTimer) {
    clearInterval(state.autoPaceTimer)
    state.autoPaceTimer = null
  }
  if (on) {
    log(`auto-pace on (every ${AUTO_PACE_INTERVAL_MS} ms, step N)`)
    state.autoPaceTimer = setInterval(() => stepMove("n"), AUTO_PACE_INTERVAL_MS)
  } else {
    log("auto-pace off")
  }
}

async function triggerInteract(action) {
  if (!action) return
  log(`▶ trigger interact: ${action}`)
  try {
    const res = await ajna.interact(TARGET_OBJECT_ID, action)
    log(`✓ interact dispatched, delivered=${res?.delivered}`)
  } catch (err) {
    const detail = err?.response?.data?.error || err?.message || String(err)
    log(`✗ interact failed: ${detail}`, "error")
  }
}

async function doLogin() {
  const email = els.email.value.trim()
  const pwd   = els.password.value
  if (!email || !pwd) return
  try {
    await ajna.login(email, pwd)
    els.authStatus.textContent = "Login erfolgreich"
    els.authStatus.className = "ok"
    log(`✓ auth ok as ${email}`)
    updateAuthUI()

    // Alte Subscriptions schließen, damit beim erneuten connect() keine
    // doppelten Watcher entstehen (PB-Subscriptions hängen am Auth-Token).
    if (state.objSub)     { try { state.objSub()     } catch {} state.objSub = null }
    if (state.interactSub){ try { state.interactSub()} catch {} state.interactSub = null }
    await ajna.disconnect()
    await connect()
  } catch (err) {
    els.authStatus.textContent = "auth failed: " + (err?.message || err)
    els.authStatus.className = "error"
    log(`✗ auth failed: ${err?.message || err}`, "error")
  }
}

async function doLogout() {
  try {
    if (state.objSub)      { try { state.objSub()      } catch {} state.objSub = null }
    if (state.interactSub) { try { state.interactSub() } catch {} state.interactSub = null }
    await ajna.disconnect()
  } catch {}
  ajna.logout()
  els.authStatus.textContent = "Abgemeldet"
  els.authStatus.className = ""
  log("◼ logout")
  updateAuthUI()
  setConnected(false)
}

// Synchronisiert die Auth-UI mit dem aktuellen ajna.authStore-Stand:
// eingeloggt → Benutzername sichtbar, Login-Felder versteckt, Logout-Btn da.
function updateAuthUI() {
  const loggedIn = ajna.isLoggedIn()
  const me = loggedIn ? ajna.currentUser() : null

  if (loggedIn) {
    els.emailRow.style.display = "none"
    els.passwordRow.style.display = "none"
    els.userDisplayRow.style.display = ""
    els.userDisplay.textContent =
      me?.name || me?.username || me?.email || "(eingeloggt)"
    els.loginBtn.style.display = "none"
    els.logoutBtn.style.display = "inline-block"
  } else {
    els.emailRow.style.display = ""
    els.passwordRow.style.display = ""
    els.userDisplayRow.style.display = "none"
    els.password.value = ""
    els.loginBtn.style.display = "inline-block"
    els.logoutBtn.style.display = "none"
  }
}

function setConnected(ok) {
  els.status.textContent = ok ? "CONNECTED" : "DISCONNECTED"
  els.status.className   = ok ? "ok" : "error"
}

function updateObjectView() {
  if (!state.object) return
  els.objName  .textContent = state.object.name || "(unnamed)"
  els.objId    .textContent = state.object.id
  els.objAnim  .textContent = state.object.animation_state || "—"
  els.objCoords.textContent =
    `${(state.object.lat ?? 0).toFixed(6)}, ${(state.object.lon ?? 0).toFixed(6)}`
}

function log(text, level = "info") {
  const ts = new Date().toLocaleTimeString()
  const row = document.createElement("div")
  row.className = "log-entry log-" + level
  row.textContent = `[${ts}] ${text}`
  els.log.appendChild(row)
  els.log.scrollTop = els.log.scrollHeight
}
