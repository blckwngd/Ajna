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

const TARGET_OBJECT_ID = "2kjikgp1pvkc4p5"     // Vanguard
// Same-Origin via Caddy. Falls der Agent gegen einen anderen Server laufen
// soll (z. B. cross-origin auf demo.example.com), hier einen Absolute-URL
// eintragen und im PB-Schema die Origin in `cors.allowed_origins` ergänzen.
const AJNA_URL = window.location.origin
const MOVE_STEP_DEG = 0.00001                  // ~1.1 m je nach Breite
const AUTO_PACE_INTERVAL_MS = 1500

// Aktion → Animation, mit der der Agent reagiert
const REACTION_MAP = {
  attack:   "Run",
  pet:    "Walk",
  examine:  "Survey"
}

const ajna = new AjnaManager(AJNA_URL)
const state = {
  object: null,
  objSub: null,
  interactSub: null,
  autoPaceTimer: null
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
  els.loginBtn      = document.getElementById("login-btn")
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

  const reaction = REACTION_MAP[action]
  if (!reaction) {
    log(`no reaction defined for "${action}"`)
    return
  }
  log(`→ reacting with animation "${reaction}"`)
  setAnimation(reaction)
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
    els.authStatus.textContent = `logged in as ${email}`
    els.authStatus.className = "ok"
    log(`✓ auth ok as ${email}`)

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
