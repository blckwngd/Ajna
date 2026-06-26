//import PocketBase from "https://unpkg.com/pocketbase/dist/pocketbase.es.mjs"
import PocketBase  from 'pocketbase'
import { EventSource } from "eventsource";

import * as GUI from 'babylonjs-gui'

import * as BABYLON from "@babylonjs/core"
import "@babylonjs/loaders"
import { ShowInspector } from "@babylonjs/inspector"
import { GridMaterial } from "@babylonjs/materials"

// BABYLON als globalen Namespace exponieren.
// Hintergrund: der Client greift in Components, GameObject, GeoTransformer
// usw. weiterhin per `BABYLON.X` zu. Bis das schrittweise auf named imports
// umgestellt ist, machen wir den Namespace hier einmal explizit global.
// Muss VOR `init()` passieren — die Komponenten-Klassen referenzieren
// BABYLON erst in ihren Methoden, also reicht das Setzen im Modul-Body.
window.BABYLON = BABYLON

import { World } from "./engine/World.js"
import { GameObject } from "./engine/GameObject.js"
import { GeoTransformer } from "./core/GeoTransformer.js"
import { UwbManager } from "./core/UwbManager.js"
import { WandManager } from "./core/WandManager.js"
import { WandAudioFeedback } from "./core/WandAudioFeedback.js"
import { getAccessoryHub } from "./core/AccessoryHub.js"
import { rayEndpointWgs84 } from "./core/PointingResolver.js"
import { NetworkSystem } from "./core/NetworkSystem.js"
import { AjnaManager } from "./core/AjnaManager.js"
import { EditorUI } from "./core/EditorUI.js"
import { ContextMenu } from "./core/ContextMenu.js"
import { PermissionDialog } from "./core/PermissionDialog.js"
import { GroupDialog } from "./core/GroupDialog.js"
import { ServerDialog } from "./core/ServerDialog.js"
import { ProfileDialog } from "./core/ProfileDialog.js"
import { FilterDialog } from "./core/FilterDialog.js"
import { AgentFilters } from "./core/AgentFilters.js"
import { InterestArea } from "./core/InterestArea.js"
import { AjnaGeo } from "./core/AjnaGeo.js"
import { ObjectActions } from "./core/ObjectActions.js"
import { InWorldActionMenu } from "./core/InWorldActionMenu.js"
import { Toast } from "./core/Toast.js"
import { interactionReply, isCollectAction } from "./core/InteractionReply.js"
import { spawnRandomAndEdit } from "./core/SpawnHere.js"
import { CameraComponent } from "./engine/components/CameraComponent.js"
import { DebugCameraComponent } from "./engine/components/DebugCameraComponent.js"
import { PlayerGPSComponent } from "./engine/components/PlayerGPSComponent.js"
import { TransformComponent } from "./engine/components/TransformComponent.js"
import { NetworkSyncComponent } from "./engine/components/NetworkSyncComponent.js"
import { buildDebugScene } from "./engine/debug/DebugSceneBuilder.js"
import { DebugUIManager } from "./engine/debug/DebugUIManager.js"
import { buildEnvironment } from "./engine/environment/EnvironmentBuilder.js"
import { ArPassthrough } from "./core/ArPassthrough.js"
import { OSMContext } from "./engine/environment/OSMContext.js"
import { PathOverlay } from "./engine/debug/PathOverlay.js"

// Same-Origin: Client und PocketBase laufen hinter Caddy auf demselben
// Host/Port. Vermeidet Mixed-Content und Cross-Origin-Cookies. Falls du
// Caddy nicht nutzt und PB direkt auf :8090 ansprichst, setze hier
// stattdessen "http://" + window.location.hostname + ":8090".
// Seamless handoff from the Capacitor app: when opened in Chrome for immersive
// XR, the deep link carries the full server registry + every server's auth blob
// + filter config in the URL fragment. Ingest it BEFORE AjnaManager/AgentFilters
// are created so ALL connected servers + logins + filters apply transparently.
const _handoff = ingestHandoffFragment()

// Reuse the shell's shared AjnaManager when embedded in the Capacitor shell
// (map.js sets window.ajna first); only create one when running standalone
// (index-ar.html). With a handoff, the (now-populated) ServerRegistry is the
// source of truth, so all carried servers are instantiated with their tokens.
const ajnaManager = window.ajna || new AjnaManager(_handoff?.base || window.location.origin)
const DEBUG_WORLD = true
window.GUI = GUI
window.GridMaterial = GridMaterial
window.ajna = ajnaManager
// `window.ajnaGeo` (nicht `window.geo`) — innerhalb von init() heißt der
// GeoTransformer lokal `geo`, und der DEBUG-Block exponiert ihn als
// `window.geo`. Wir vermeiden den Namens-Clash, indem die OSM/Geo-Helper-
// Instanz unter einem eigenen Namen lebt.
window.ajnaGeo = window.ajnaGeo || new AjnaGeo(ajnaManager)

// Parse the `#ajna=<base64url(JSON)>` handoff fragment written by the Capacitor
// shell when opening this page in Chrome, and restore the carried state into
// localStorage BEFORE AjnaManager/AgentFilters read it: the full server registry
// (`ajna.servers.v1`), every per-server auth blob (`ajna_auth_<id>`), and the
// filter/alignment config. Returns the parsed payload or null.
function ingestHandoffFragment() {
  try {
    const m = (location.hash || '').match(/[#&]ajna=([^&]+)/)
    if (!m) return null
    let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4) b64 += '='
    const data = JSON.parse(decodeURIComponent(escape(atob(b64))))

    // All servers + their logins (verbatim blobs).
    if (data.registry) localStorage.setItem('ajna.servers.v1', data.registry)
    if (data.auth && typeof data.auth === 'object') {
      for (const [k, v] of Object.entries(data.auth)) {
        if (typeof k === 'string' && k.startsWith('ajna_auth_') && typeof v === 'string') {
          localStorage.setItem(k, v)
        }
      }
    }
    if (data.filters) localStorage.setItem('ajna.layer_filters', data.filters)
    if (data.align) localStorage.setItem('ajna_wand_alignment', data.align)

    // Strip the token-bearing fragment from the URL + history immediately.
    history.replaceState(null, '', location.pathname + location.search)
    const n = data.auth ? Object.keys(data.auth).length : 0
    console.log(`[handoff] restored ${n} server login(s) + filters from deep link`)
    return data
  } catch (err) {
    console.warn('[handoff] parse failed:', err?.message || err)
    return null
  }
}

// ==========================================================
// SHARED EDITOR UI
// ==========================================================

let editorUI = null
let _xrExperience = null  // gesetzt nach erfolgreichem WebXR-Setup

// ==========================================================
// PHASE 1: INITIALIZATION
// ==========================================================

// Voll deckender Ladescreen für den AR-Kaltstart. Verbirgt die verwirrende
// Anlaufphase (leere Szene, vor dem GPS-Fix springende Position, nach und nach
// eintrudelnde Objekte/Gitter/Gebäude) hinter einem ruhigen Overlay mit
// Statuszeile. Wird in den Canvas-Container gehängt → scoped zur AR-Ansicht
// (verschwindet beim Tab-Wechsel) und funktioniert auch standalone in Chrome.
function createLoadingOverlay(arRoot) {
  const ov = document.createElement("div")
  ov.id = "ar-loading-overlay"
  Object.assign(ov.style, {
    position: "fixed", top: "0", left: "0", right: "0", bottom: "0", zIndex: "50",
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    gap: "18px", background: "#0b0b12", color: "#e8e8ef",
    font: "500 16px/1.4 system-ui, sans-serif", textAlign: "center", padding: "24px",
    transition: "opacity 0.45s ease", opacity: "1"
  })
  ov.innerHTML = `
    <div style="width:46px;height:46px;border-radius:50%;
      border:4px solid rgba(255,255,255,0.15);border-top-color:#4a90d9;
      animation:arl-spin 0.9s linear infinite;"></div>
    <div data-role="arl-status">AR wird gestartet…</div>
    <style>@keyframes arl-spin{to{transform:rotate(360deg)}}</style>`
  ;(arRoot || document.body).appendChild(ov)
  const statusEl = ov.querySelector('[data-role="arl-status"]')
  let done = false
  return {
    setStatus(text) { if (!done && statusEl) statusEl.textContent = text },
    hide() {
      if (done) return
      done = true
      ov.style.opacity = "0"
      setTimeout(() => ov.remove(), 500)
    }
  }
}

async function init() {

  // Babylon Setup
  const canvas = document.getElementById("renderCanvas")
  // All AR overlays mount into the canvas's parent (the AR view when embedded
  // in the shell, or <body> standalone) so they stay scoped to the AR view and
  // vanish with it on tab switch.
  const arRoot = canvas.parentElement || document.body
  // Ladescreen so früh wie möglich hoch (vor dem Render-Loop), damit der leere/
  // springende Kaltstart verborgen bleibt. Sicherheits-Timeout, falls ein
  // Schritt (z. B. GPS) hängt — lieber die Szene zeigen als den Nutzer einsperren.
  const loadingOverlay = createLoadingOverlay(arRoot)
  const _loadingSafety = setTimeout(() => loadingOverlay.hide(), 25000)
  // preserveDrawingBuffer bewusst NICHT gesetzt: kostet Performance (Treiber
  // muss den Buffer halten) und wird nirgends gebraucht (keine Screenshots).
  const engine = new BABYLON.Engine(canvas, true, { stencil: true })
  // The AR view may have just become visible (display toggled) when this runs;
  // the canvas can briefly report 0×0. Resize once layout settles so the scene
  // actually renders (otherwise the image looks static/empty).
  requestAnimationFrame(() => engine.resize())
  const scene = new BABYLON.Scene(engine)
  scene.useRightHandedSystem = true

  // ── Performance #1: kein automatisches Pointer-Move-Picking ──────────────
  // Babylon raycastet sonst bei JEDER Pointer-Bewegung gegen die ganze Szene
  // (setzt meshUnderPointer, feuert OnPointerOver). Das ist die Hauptursache
  // fürs Ruckeln beim Touch-Umschauen — schon bei wenigen Objekten. Tap-Picks
  // (Objekt-Interaktion) laufen weiter, die sind hiervon unberührt.
  scene.skipPointerMovePicking = true
  scene.constantlyUpdateMeshUnderPointer = false

  // ── Performance #2: adaptive interne Render-Auflösung ────────────────────
  // FPS ~1×/s messen; bei Einbrüchen die Auflösung senken (Fill-Rate-Schutz auf
  // schwachen Phones), bei Reserve wieder anheben. Desktop bleibt bei Scale 1
  // (volle Auflösung). setHardwareScalingLevel(>1) = weniger Pixel.
  // Schärfer als zuvor: max Scale 1.5 (war 2 = ¼ Pixel, sichtbar pixelig) und
  // erst bei deutlichem FPS-Einbruch (<45) herunterregeln. Bei Reserve (>55)
  // wieder Richtung volle Auflösung (Scale 1).
  let _renderScale = 1, _fpsAccum = 0, _fpsFrames = 0
  const MAX_SCALE = 1.5
  scene.onAfterRenderObservable.add(() => {
    const fps = engine.getFps()
    if (Number.isFinite(fps)) { _fpsAccum += fps; _fpsFrames++ }
    if (_fpsFrames < 60) return                       // ~1× pro Sekunde auswerten
    const avg = _fpsAccum / _fpsFrames
    _fpsAccum = 0; _fpsFrames = 0
    if (avg < 45 && _renderScale < MAX_SCALE) {
      _renderScale = Math.min(MAX_SCALE, _renderScale + 0.25)
      engine.setHardwareScalingLevel(_renderScale)
    } else if (avg > 55 && _renderScale > 1) {
      _renderScale = Math.max(1, _renderScale - 0.25)
      engine.setHardwareScalingLevel(_renderScale)
    }
  })

  const world = new World(scene)
  // Nord/Süd geflippt: gleicht die Default-Blickrichtung der Babylon-Kamera
  // (-Z = "in den Bildschirm hinein") gegen das Ajna-Daten-Convention
  // (+Z = Nord) aus. Ohne den Flip empfindet der Anwender beim Abgleich
  // mit der Karte die AR-Welt als nord-süd gespiegelt.
  // Bei Bedarf später analog `invertEastWest: true`.
  const geo = new GeoTransformer({ invertNorthSouth: true })

  // Shared client-session layer (one GPS + UWB + wand + audio + position source
  // per page, bundle-safe). UWB ('viewer' role) overrides GPS when fresh; with
  // no UWB node it is a pure GPS passthrough. UWB/wand are not auto-connected.
  const accessories = getAccessoryHub({ ajna: ajnaManager })
  const gps = accessories.gps
  const uwb = accessories.uwb
  const positionSource = accessories.positionSource
  _announcer = accessories.announcer   // geteilter TTS-Announcer (Gaze/Tap/Spawn)

  // Realtime-Updates laufen jetzt zentral über AjnaManager (subscribt
  // auf 'objects' und feuert emitObjectsChanged). Damit reagieren Liste,
  // Map und 3D-Szene synchron — kein separater NetworkSystem-Pfad nötig.
  // Die Klasse bleibt für zukünftige hochfrequente Engine-Sync-Use-Cases
  // (NetworkSyncComponent mit Lerp/Velocity) bestehen.

  const player = await setupPlayer(scene, world, geo, positionSource, canvas)

  // GPS-Stream starten, sobald der Player als Subscriber registriert ist.
  // Bei persistiertem Dummy broadcastet start() die Dummy-Position sofort
  // — waitForOrigin weiter unten resolvt damit ohne Wartezeit.
  gps.start()

  // Bind/unbind a UWB node for cm-precise positioning (native app only).
  // Anchors must exist in Ajna (npm run uwb-anchors). Safe no-op on the web.
  window.ajnaUwbConnect = async (opts = {}) => {
    if (!(await UwbManager.isAvailable())) { console.warn('[uwb] only available in the native app'); return }
    return uwb.connect({ role: 'viewer', name: 'DW', ...opts })
  }
  window.ajnaUwbDisconnect = (role = 'viewer') => uwb.disconnect(role)

  setupPositionSourceHud(positionSource, arRoot)

  if (DEBUG_WORLD) {
    window.engine= engine
    window.scene = scene
    window.world = world
    window.geo = geo
    window.gps = gps
    window.uwb = uwb
    window.positionSource = positionSource
    window.player = player
    window.objectMap = objectMap
  }
  
  window.addEventListener("resize", () => engine.resize())
  
  const arEnv = buildEnvironment(scene)

  // Umschalter echtes AR (Kamera-Passthrough) ↔ XR (Skybox). Toggle sitzt im
  // Editor neben "Kamera auf Spieler". Start je Session in XR (Skybox); der
  // Kamerazugriff erfolgt erst beim bewussten Umschalten (Nutzergeste +
  // Berechtigungs-Prompt).
  const arPassthrough = new ArPassthrough({ scene, skybox: arEnv?.skybox, canvas })

  // ── AR-Modus an "Switch Camera" koppeln ──────────────────────────────────
  // VOR Switch Camera (Free-Modus): frei bewegen + Skybox, kein Kompass.
  // NACH Switch Camera (Player-Modus): an die GPS-Position fixiert, Kamera-
  // Passthrough + Geräte-Kompass für möglichst realitätsnahes "Magic-Window"-AR.
  // Die Kompass-Orientierung liefert Babylons integrierter DeviceOrientation-
  // Input auf der (am Player-Root hängenden) Kamera. iOS verlangt eine
  // Permission-Geste (der Button-Tap deckt das ab), Android nicht.
  const _debugCam = player.getComponent(DebugCameraComponent)
  const _playerCam = player.getComponent(CameraComponent)?.camera
  // Pitch-Korrektur: Babylons DeviceOrientation-Input invertiert in einer
  // rechtshändigen Szene (useRightHandedSystem) oben/unten. Nach dem Input-Check
  // den Pitch (Euler-x) negieren — nur solange der Kompass aktiv ist (AR-Modus).
  let _compassActive = false
  if (_playerCam) {
    _playerCam.onAfterCheckInputsObservable.add(() => {
      const q = _playerCam.rotationQuaternion
      if (!_compassActive || !q) return
      const e = q.toEulerAngles()
      BABYLON.Quaternion.RotationYawPitchRollToRef(e.y, -e.x, e.z, q)
    })
  }
  async function _ensureOrientationPermission() {
    const D = window.DeviceOrientationEvent
    if (D && typeof D.requestPermission === "function") {
      try { await D.requestPermission() } catch {}
    }
  }
  async function _onCameraMode(mode) {
    const ar = mode === "player"
    _compassActive = ar   // Pitch-Korrektur nur bei aktivem Kompass
    if (ar && _playerCam) {
      try {
        await _ensureOrientationPermission()
        _playerCam.detachControl()
        _playerCam.inputs.clear()              // nur Kompass steuert die Blickrichtung
        _playerCam.inputs.addDeviceOrientation()
        _playerCam.attachControl(canvas, true)
      } catch (e) { console.warn("[ar] Kompass-Input fehlgeschlagen:", e?.message || e) }
    } else if (_playerCam) {
      try { _playerCam.detachControl() } catch {}
    }
    if (ar) {
      arPassthrough.enable().catch(err => {
        if (!_toast) _toast = new Toast()
        _toast.show(err?.message || "Kamera nicht verfügbar", { title: "AR" })
      })
    } else {
      arPassthrough.disable()
    }
    try { editorUI?.setArModeToggle?.(ar) } catch {}   // Editor-Checkbox synchron
  }
  if (_debugCam) _debugCam.onModeChange = _onCameraMode
  // Einheitlicher Auslöser für Button UND Editor-Toggle (DebugCam ist Wahrheit).
  function setArMode(on) { _debugCam?.setMode(on ? "player" : "free") }

  // Hover-System: Mesh-Tooltip beim Pointer-Move, Highlight + Off-Screen-
  // Linie wenn aus den Listen heraus angefragt. Setzt DOM-Overlays an,
  // also nach Babylon-Setup und vor den UI-Managern (die den highlight-
  // Callback brauchen).
  const setHighlight = setupHoverSystem(scene, engine, canvas)
  _arHighlight = setHighlight  // damit interact-Events visuell pulsen können

  let debugManager = null
  if (DEBUG_WORLD) {
    debugManager = new DebugUIManager({
      scene,
      geo,
      gps,
      player,
      objectMap,
      onObjectHover: setHighlight,
      container: arRoot
    })
  }

  const renderLoop = () => {
    const delta = engine.getDeltaTime() / 1000
    objectMap.forEach(go => go.update(delta))
    scene.render()
  }
  engine.runRenderLoop(renderLoop)
  // Embedded in the shell, the AR view is hidden behind other tabs; let the
  // shell pause/resume the render loop to save battery (no-op standalone).
  window.arPause = () => engine.stopRenderLoop()
  window.arResume = () => { engine.runRenderLoop(renderLoop); engine.resize() }
  
  // Shared Editor UI im AR-Modus.
  // Kein onObjectsUpdated-Callback — die Szene wird über einen eigenen
  // ajnaManager-Listener weiter unten gepflegt, damit hier keine
  // Re-Entry-Schleife über EditorUI -> loadObjects -> emitObjectsChanged
  // entsteht.
  const uiContainer = document.getElementById('ui')
  const groupDialog = new GroupDialog({ ajna: ajnaManager })
  const serverDialog = new ServerDialog({ ajna: ajnaManager })
  const profileDialog = new ProfileDialog({ ajna: ajnaManager })
  // Reuse the shell's shared AgentFilters when embedded (consistent layer
  // selection across map + AR); create one only when standalone.
  const agentFilters = window.agentFilters || new AgentFilters(ajnaManager)
  const filterDialog = new FilterDialog({ ajna: ajnaManager, filters: agentFilters })
  _agentFilters = agentFilters       // sichtbar für syncSceneObjects
  window.agentFilters = agentFilters  // für Console-Debugging

  // Manifests beim Login + bei Auth-Wechsel neu laden.
  ajnaManager.onAuthChanged(user => {
    if (user) agentFilters.refreshManifests().catch(() => {})
  })

  // Filter-Änderungen → bestehende Szene neu reconcilen + Editor-Liste mitziehen.
  agentFilters.onChange(() => {
    syncSceneObjects(scene, world, geo, ajnaManager.getObjectList())
    editorUI?.renderObjectList()
  })

  // Interest-Area-Publisher (Opt-in, Default aus): teilt einen UNSCHARFEN
  // Bereich, damit Agents Inhalte in der Nähe liefern. Der Schalter sitzt im
  // Profil-Dialog (aus jeder Ansicht erreichbar); der Publisher prüft das Flag
  // dynamisch. Position aus der geteilten GPS/UWB-Quelle, Quellen aus dem Filter.
  const interestArea = new InterestArea({
    ajna: ajnaManager,
    getPosition: () => positionSource?.getWorldPosition?.() || null,
    getSources: () => agentFilters.getSources().map(s => s.source).filter(src => {
      const sel = agentFilters.getSelection(src)
      return sel === undefined || (Array.isArray(sel) && sel.length > 0)
    })
  })
  interestArea.start()
  profileDialog.interestArea = interestArea

  // Set after setupArOverlayControls below; called when the editor is engaged
  // (edit/create) so a minimized editor panel pops open.
  let _openArEditor = () => {}

  editorUI = new EditorUI({
    ajna: ajnaManager,
    container: uiContainer,
    mode: 'ar',
    onFocusPlayer: () => focusCameraOn(scene, player),
    // Echtes AR (Kamera) ↔ XR (Skybox) umschalten; Wurf bei fehlender Kamera
    // wird im EditorUI gefangen (Toggle springt zurück + Statusmeldung).
    onToggleArMode: (on) => setArMode(on),
    getArMode: () => _debugCam?.activeMode === "player",
    onManageGroups: () => groupDialog.open(),
    onManageServers: () => serverDialog.open(),
    onManageProfile: () => profileDialog.open(),
    onManageFilters: () => filterDialog.open(),
    // Open the editor panel when editing or creating an object (if minimized).
    onEditorActivate: () => _openArEditor(),
    onObjectSelected: obj => {
      // PB-Record → zugehöriges GameObject. Wenn die Szene das Objekt
      // noch nicht angelegt hat (z. B. vor abgeschlossenem syncSceneObjects),
      // ist focusCameraOn no-op — kein Crash, keine Fehlermeldung.
      const go = objectMap.get(obj.id)
      if (go) focusCameraOn(scene, go)
    },
    onObjectHover: (obj, hovering) => {
      const go = objectMap.get(obj.id)
      if (go) setHighlight(go, hovering)
    },
    objectFilter: obj => agentFilters.matches(obj)
  })

  // Editor + Debug start hidden (editor open by default on wide screens),
  // opened on demand from a small AR toolbar; each panel has its own close
  // button. Keeps the AR view unobstructed.
  const _arOverlay = setupArOverlayControls(arRoot, uiContainer, debugManager)
  _openArEditor = _arOverlay.openEditor

  // ── Wand pointing → AR highlight (audio cues handled by the hub) ──────
  // The wand lives in the shared hub; here we attach AR-specific context:
  // visibility (only filter-visible objects), name lookup, and scene highlight.
  // Ray origin + audio are wired by the hub. Not auto-connected.
  const wand = accessories.wand
  wand.isVisible = (o) => agentFilters.matches(o)
  wand.getName = (id) => objectMap.get(id)?.name || ajnaManager.getObjectById?.(id)?.name || null
  let _wandHiId = null
  wand.onTarget((target) => {
    if (_wandHiId && _wandHiId !== target?.id) {
      const prev = objectMap.get(_wandHiId); if (prev) setHighlight(prev, false)
    }
    if (target?.id) { const go = objectMap.get(target.id); if (go) setHighlight(go, true) }
    _wandHiId = target?.id || null
  })

  // Visual pointing ray (origin → direction). Updated each orientation frame;
  // removed when no orientation/origin (e.g. pointing mode 'disabled').
  let _wandRay = null
  wand.onOrientation(() => {
    const dir = wand.getPointingDirection()
    const origin = wand.getOrigin?.()
    if (!dir || !origin || !Number.isFinite(origin.lat) || !geo.origin) {
      if (_wandRay) { _wandRay.dispose(); _wandRay = null }
      return
    }
    const end = rayEndpointWgs84(origin, dir, wand.maxRangeM)
    const pts = [
      geo.toLocal(origin.lat, origin.lon, origin.altitude || 0),
      geo.toLocal(end.lat, end.lon, end.altitude)
    ]
    _wandRay = BABYLON.MeshBuilder.CreateLines('wandRay',
      { points: pts, updatable: true, instance: _wandRay || undefined }, scene)
    _wandRay.color = new BABYLON.Color3(0.3, 0.8, 1)
    _wandRay.isPickable = false
  })

  window.ajnaWandConnect = async (opts = {}) => {
    if (!(await WandManager.isAvailable())) { console.warn('[wand] only in the native app'); return }
    return wand.start({ name: 'WizardStaff', ...opts })
  }
  window.ajnaWandDisconnect = () => wand.stop()
  window.ajnaWandAudio = (on) => WandAudioFeedback.setEnabled(on)
  if (DEBUG_WORLD) window.wand = wand

  // Kontextmenü + Berechtigungs-Dialog. Beides UI-Singletons; die
  // konkrete Action-Verdrahtung läuft über ObjectActions, damit AR und
  // Map dasselbe Menü zeigen.
  const contextMenu = new ContextMenu()
  const permissionDialog = new PermissionDialog({ ajna: ajnaManager })
  const objectActions = new ObjectActions({
    ajna: ajnaManager,
    editorUI,
    contextMenu,
    permissionDialog,
    // Tap-Menü-Interaktion → gleiches Feedback wie der XR-/Wand-Pfad
    // (Reply-Toast + Highlight-Puls + TTS-Ansage).
    onInteract: (record, key) => _showInteractFeedback(record.id, key)
  })

  // In-World-Menü für den XR-Modus. Sichtbar nur, wenn ein Objekt
  // fokussiert ist (Gaze oder XR-Klick).
  const inWorldMenu = new InWorldActionMenu(scene)

  function _triggerInteract(record, actionKey) {
    console.log(`[xr] trigger ${actionKey} on ${record.name || record.id}`)
    ajnaManager.interact(record.id, actionKey)
      .then(() => {
        _showInteractFeedback(record.id, actionKey)   // sofortiges Eigen-Feedback
        // „Einsammeln" → Objekt entfernen (falls berechtigt).
        if (isCollectAction(actionKey)) {
          ajnaManager.deleteObject(record.id).catch(err =>
            console.warn("[xr] Einsammeln/Löschen fehlgeschlagen:", err?.message || err))
        }
      })
      .catch(err => console.warn("[xr] interact failed:", err?.message || err))
  }

  function _showInWorldMenuFor(go, record) {
    const actions = Array.isArray(record.actions) && record.actions.length > 0
      ? record.actions
      : [{ key: "examine", label: "Untersuchen" }]
    inWorldMenu.show(
      go,
      record.name || record.id,
      actions,
      key => _triggerInteract(record, key)
    )
  }

  // Klick auf ein 3D-Objekt:
  //   • Desktop → DOM-Kontextmenü an Cursor-Position (wie gehabt)
  //   • XR     → In-World-Menü (DOM ist unsichtbar)
  scene.onPointerObservable.add(eventData => {
    if (eventData.type !== BABYLON.PointerEventTypes.POINTERTAP) return

    // Wenn der Tap einen In-World-Button getroffen hat: hier nichts mehr
    // tun. InWorldActionMenu setzt skipNextObservers, aber wir prüfen
    // zusätzlich den raw-Pick, falls Observer-Reihenfolge mal wechselt.
    const rawPick = scene.pick(scene.pointerX, scene.pointerY)
    if (rawPick?.pickedMesh?.metadata?.isActionButton) return

    // Nur GameObject-Meshes — GUI-Panel selbst aussortieren, sonst klickt
    // ein Button im Menü auf "sein eigenes" Objekt-Mesh und öffnet erneut.
    const pickInfo = scene.pick(scene.pointerX, scene.pointerY,
      mesh => !!mesh.metadata?.gameObject
    )
    const go = pickInfo?.hit ? pickInfo.pickedMesh?.metadata?.gameObject : null
    if (!go?.name) return

    const record = ajnaManager.objectMap.get(go.id)
    if (!record) return

    _announcer?.target(record)   // "Zeigen": Tap sagt "<Typ> <Name>" an (gegated)

    const inXR = _xrExperience?.baseExperience?.state === BABYLON.WebXRState.IN_XR
    if (inXR) {
      _showInWorldMenuFor(go, record)
      return
    }

    const rect = canvas.getBoundingClientRect()
    objectActions.showFor(
      record,
      rect.left + scene.pointerX,
      rect.top + scene.pointerY
    )
  })

  // Rechtsklick auf den Boden → "Neues Objekt…" an den dort getroffenen
  // GPS-Koordinaten. Wir schneiden den Picking-Ray mit der Boden-Ebene
  // (y=0) statt gegen die Ground-Mesh zu picken — die ist isPickable=false
  // und folgt der Kamera. geo.toWorld() liefert lat/lon/altitude des Punkts.
  canvas.addEventListener('contextmenu', ev => {
    ev.preventDefault()
    if (!geo.origin) return
    // Im immersiven XR-Modus gibt es keinen DOM-Cursor — Handler ist
    // damit ohnehin nur im Desktop-Modus aktiv.
    const ray = scene.createPickingRay(
      scene.pointerX, scene.pointerY, BABYLON.Matrix.Identity(), scene.activeCamera
    )
    const groundPlane = BABYLON.Plane.FromPositionAndNormal(
      BABYLON.Vector3.Zero(), new BABYLON.Vector3(0, 1, 0)
    )
    const dist = ray.intersectsPlane(groundPlane)
    if (dist === null || dist < 0) return
    const point = ray.origin.add(ray.direction.scale(dist))
    const geoPos = geo.toWorld(point.x, point.y, point.z)

    contextMenu.show({
      x: ev.clientX,
      y: ev.clientY,
      title: `${geoPos.lat.toFixed(5)}, ${geoPos.lon.toFixed(5)}`,
      items: [
        {
          label: 'Neues Objekt…',
          disabled: !ajnaManager.isLoggedIn(),
          onClick: () => editorUI.startNewObjectAt(geoPos.lat, geoPos.lon, geoPos.altitude)
        },
        {
          label: 'Zufälliges Objekt…',
          disabled: !ajnaManager.isLoggedIn(),
          onClick: () => spawnRandomAndEdit({
            ajna: ajnaManager, editorUI, announcer: _announcer,
            position: { lat: geoPos.lat, lon: geoPos.lon, altitude: geoPos.altitude }
          }).catch(err => {
            if (!_toast) _toast = new Toast()
            _toast.show(err?.message || 'Spawn fehlgeschlagen', { title: 'Spawn' })
          })
        }
      ]
    })
  })

  // Gaze-Loop: pro Frame Ray vom Kamera-Forward, Pick-Test gegen
  // GameObject-Meshes. Wechselt der Fokus, wird Highlight + Menü
  // entsprechend nachgezogen. Drosselt sich selbst, weil pickWithRay
  // O(meshes) ist — alle ~6 Frames reicht für UX.
  //
  // GUI-Panels werden über das Predicate ausgefiltert, damit das Menü
  // nicht den Blick auf "sein eigenes" Objekt verdeckt.
  //
  // Bei aktiv verbundenem 3DOF-/6DOF-Controller (Daydream etc.) übernimmt
  // die explizite Touchpad-/Trigger-Logik unten den Fokus-Cycle —
  // dann pausiert der Gaze-Pfad, sonst kämpfen beide um _gazedGO.
  let _gazedGO = null
  let _gazeTick = 0
  let _xrControllerMode = false
  scene.onBeforeRenderObservable.add(() => {
    // WebXR may be unavailable (e.g. Android WebView): createDefaultXRExperience
    // can resolve with baseExperience === undefined. Guard with optional chaining
    // so this per-frame observer never throws (which would freeze the render loop).
    if (_xrExperience?.baseExperience?.state !== BABYLON.WebXRState.IN_XR) {
      if (_gazedGO) {
        setHighlight(_gazedGO, false)
        inWorldMenu.hide()
        _gazedGO = null
      }
      return
    }
    if (_xrControllerMode) return     // Controller treibt Fokus + Menü
    if (++_gazeTick % 6 !== 0) return

    const cam = scene.activeCamera
    if (!cam) return
    const ray = cam.getForwardRay(100)
    const pickInfo = scene.pickWithRay(ray,
      mesh => !!mesh.metadata?.gameObject
    )
    const next = (pickInfo?.hit && pickInfo.pickedMesh?.metadata?.gameObject?.name)
      ? pickInfo.pickedMesh.metadata.gameObject
      : null

    if (next === _gazedGO) return

    if (_gazedGO) setHighlight(_gazedGO, false)
    _gazedGO = next

    if (_gazedGO) {
      setHighlight(_gazedGO, true)
      _announcer?.target(_gazedGO.id)   // Ansage "<Typ> <Name>" (gegated)
      const record = ajnaManager.objectMap.get(_gazedGO.id)
      if (record) _showInWorldMenuFor(_gazedGO, record)
    } else {
      _announcer?.target(null)
      inWorldMenu.hide()
    }
  })

  // EditorUI-Backend-Load und GPS-Fix parallelisieren — bei realem GPS
  // spart das mehrere Sekunden, weil PocketBase-Load und Geolocation-
  // Wartezeit nicht hintereinander, sondern nebeneinander laufen.
  loadingOverlay.setStatus("Warte auf Standort (GPS)…")
  await Promise.all([
    editorUI.init(),
    waitForOrigin(geo, positionSource)
  ])
  loadingOverlay.setStatus("Welt wird aufgebaut…")

  // Szene-Reconcile erst aktivieren, wenn Origin steht — sonst würden
  // alle GameObjects auf (0,0,0) landen.
  //
  // Gethrottlet (wie die Karte): der Director tickt alle 500 ms und schreibt
  // pro Figur ein Update; ungethrottlet liefe pro Tick ein Schwung voller
  // Reconciles → periodisches Ruckeln. Max ~4×/s, immer mit der zuletzt
  // gelieferten Objekt-Liste. PositionSmoother hält die Bewegung flüssig.
  ajnaManager.onObjectsChanged(throttleLatest(objects => {
    syncSceneObjects(scene, world, geo, objects)
  }, 250))
  // Erstes Reconcile awaiten → Objekt-Platzhalter stehen, bevor der Ladescreen
  // weicht (Modelle tauschen sich danach unauffällig an Ort und Stelle ein).
  await syncSceneObjects(scene, world, geo, ajnaManager.getObjectList())

  // Re-Capping bei Kamerabewegung: die "nächsten X je Agent" hängen von der
  // Kameraposition ab. syncSceneObjects feuert sonst nur bei Datenänderung —
  // beim Laufen/Fliegen würde die Auswahl veralten. Daher ~alle 1.5 s prüfen,
  // ob die Kamera sich > RE_CAP_DIST bewegt hat, und dann neu reconcilen.
  // Guard verhindert überlappende (async) Reconcile-Läufe.
  let _lastCapPos = null, _lastCapT = 0, _recapRunning = false
  const RE_CAP_DIST2 = 25 * 25      // 25 m (quadriert)
  scene.onBeforeRenderObservable.add(() => {
    const cam = scene.activeCamera?.globalPosition
    if (!cam || _recapRunning) return
    const now = performance.now()
    if (now - _lastCapT < 1500) return
    if (_lastCapPos) {
      const dx = cam.x - _lastCapPos.x, dy = cam.y - _lastCapPos.y, dz = cam.z - _lastCapPos.z
      if (dx * dx + dy * dy + dz * dz < RE_CAP_DIST2) return
    }
    _lastCapT = now
    _lastCapPos = cam.clone()
    _recapRunning = true
    Promise.resolve(syncSceneObjects(scene, world, geo, ajnaManager.getObjectList()))
      .finally(() => { _recapRunning = false })
  })

  // OSM-Kontext (Straßen + Gebäude) als Wireframe um den Origin zeichnen.
  // Die Geo-API ist standardmäßig authenticated-only — wenn beim Boot
  // noch nicht eingeloggt: stiller 401, erneuter Versuch beim Login.
  const osmContext = new OSMContext(scene, geo, window.ajnaGeo)
  window.osm = osmContext

  // Debug-Overlay: zeichnet `state.walk_path` jedes Objekts als grüne Linie.
  // Standardmäßig AUS — update() iteriert die KOMPLETTE (ungecappte) Objektliste
  // bei jedem Realtime-Update; bei vielen Objekten (eingeblendete WLANs) war das
  // der teure objects/*-Listener (~150 ms). Zum Debuggen der Director-Routen in
  // der Konsole `window.ajnaShowPaths = true` setzen und neu laden, oder manuell
  // `window.pathOverlay.update(ajna.getObjectList())` aufrufen.
  const pathOverlay = new PathOverlay(scene, geo)
  window.pathOverlay = pathOverlay
  if (window.ajnaShowPaths) {
    ajnaManager.onObjectsChanged(throttleLatest(objects => pathOverlay.update(objects), 200))
    pathOverlay.update(ajnaManager.getObjectList())
  }
  const _loadOSM = () => {
    if (!geo.origin) return
    osmContext.load(geo.origin.lat, geo.origin.lon).catch(err =>
      console.warn('[osm] load failed:', err?.message || err)
    )
  }
  _loadOSM()
  ajnaManager.onAuthChanged(user => {
    if (user && !osmContext.isLoaded) _loadOSM()
  })

  const debugScene = buildDebugScene(scene)

  // Szene ist sichtbar bereit (GPS-Origin steht, Objekt-Platzhalter + Gitter
  // gezeichnet) → Ladescreen ausblenden. OSM-Gebäude trudeln gleich async nach.
  clearTimeout(_loadingSafety)
  loadingOverlay.hide()

  // WebXR — nach buildDebugScene, damit die Ground-Mesh als Floor für
  // die Teleportation verfügbar ist.
  //
  // Session-Modus: bevorzugt `immersive-ar` (Kamera-Passthrough kommt vom
  // XR-Compositor über ARCore), sonst Fallback `immersive-vr`. WICHTIG:
  // immersive-VR hat KEIN Kamerabild — mit ausgeschalteter Skybox (z. B. via
  // Kamera-Toggle) bliebe in VR nur ein schwarzer Hintergrund. Die Babylon-
  // Default-Experience baut den "Enter XR"-Button ins DOM, Pointer-Selection
  // (Controller-Trigger → pointer-events, die unser POINTERTAP-Handler
  // aufgreift) und Teleportation.
  let xrMode = "immersive-vr"
  try {
    if (await navigator.xr?.isSessionSupported?.("immersive-ar")) xrMode = "immersive-ar"
  } catch {}
  // AR-Session bewusst MINIMAL + tolerant konfigurieren: Kamera kommt vom
  // Compositor, daher KEINE Teleportation (VR-Konzept, bräuchte Floor-Mesh) und
  // optionale Features NICHT als Pflicht anfordern — sonst scheitert
  // requestSession an einem Feature/Reference-Space, den die ARCore-Runtime
  // nicht als „required" liefert ("session configuration is not supported").
  // Reference-Space `local` (kein Floor-Detect) ist am breitesten unterstützt.
  const xrOptions = xrMode === "immersive-ar"
    ? {
        uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local" },
        disableTeleportation: true,
        optionalFeatures: true
      }
    : {
        floorMeshes: [debugScene.ground],
        uiOptions: { sessionMode: "immersive-vr", referenceSpaceType: "local-floor" },
        pointerSelectionOptions: { enablePointerSelectionOnAllControllers: true },
        teleportationOptions: { floorMeshes: [debugScene.ground] }
      }
  try {
    _xrExperience = await scene.createDefaultXRExperienceAsync(xrOptions)
    console.log(`[xr] ready (${xrMode}) — Enter-XR button is in the DOM`)

    // In AR liefert der XR-Compositor das Kamerabild → Szene transparent +
    // Skybox aus, solange die AR-Session läuft. Beim Verlassen Skybox wieder an
    // (außer der DOM-Kamera-Passthrough ist gerade aktiv), Alpha zurück.
    if (xrMode === "immersive-ar") {
      _xrExperience.baseExperience?.onStateChangedObservable.add(state => {
        const inXR = state === BABYLON.WebXRState.IN_XR
        const transparent = inXR || arPassthrough.enabled
        if (arEnv?.skybox) arEnv.skybox.setEnabled(!transparent)
        if (scene.clearColor) scene.clearColor.a = transparent ? 0 : 1
      })
    }

    // Enter-XR-Button + Fehlerbehandlung: Auf Geräten ohne ARCore (z. B.
    // Fairphone 5) scheitert das Betreten der AR-Session ("runtime could not be
    // installed"). Statt kryptischer Konsolenfehler einen Hinweis zeigen und den
    // Button ausblenden + merken — dann bleibt der Kamera-Modus ("Switch Camera").
    const _xrOverlay = _xrExperience.enterExitUI?.overlay
    const _hideXrButton = () => { try { if (_xrOverlay) _xrOverlay.style.display = "none" } catch {} }
    let _xrAttempting = false, _xrFailHandled = false
    const _onXrEnterFailed = () => {
      if (_xrFailHandled) return
      _xrFailHandled = true
      if (!_toast) _toast = new Toast()
      _toast.show('Dieses Gerät unterstützt kein immersives WebXR-AR. Nutze „Switch Camera" für den Kamera-Modus.',
        { title: "WebXR nicht verfügbar" })
      _hideXrButton()
      try { localStorage.setItem("ajna_xr_unsupported", "1") } catch {}
    }
    // Schon als nicht unterstützt bekannt → Button gar nicht erst anbieten.
    try { if (localStorage.getItem("ajna_xr_unsupported") === "1") _hideXrButton() } catch {}
    // Ein Klick startet einen Versuch; erreichen wir IN_XR nicht, ist er
    // gescheitert (capture-Phase → läuft vor Babylons eigenem Handler).
    if (_xrOverlay) _xrOverlay.addEventListener("click", () => { _xrAttempting = true }, true)
    _xrExperience.baseExperience?.onStateChangedObservable.add(state => {
      if (state === BABYLON.WebXRState.IN_XR) { _xrAttempting = false; return }
      if ((state === BABYLON.WebXRState.NOT_IN_XR || state === BABYLON.WebXRState.EXITING_XR) && _xrAttempting) {
        _xrAttempting = false
        _onXrEnterFailed()
      }
    })
    window.ajnaResetXR = () => { try { localStorage.removeItem("ajna_xr_unsupported") } catch {}; location.reload() }

    _xrExperience.baseExperience?.onStateChangedObservable.add(state => {
      const name = ({
        0: "NOT_IN_XR",
        1: "ENTERING_XR",
        2: "IN_XR",
        3: "EXITING_XR"
      })[state] || state
      console.log(`[xr] state → ${name}`)
      if (state !== BABYLON.WebXRState.IN_XR) {
        inWorldMenu.hide()
      }
    })

    // ESC verlässt die XR-Session, ohne dass die Seite neu geladen werden
    // muss. Hilft im WebXR-Browser-Emulator, wo es keine Headset-Geste
    // zum Verlassen gibt.
    window.addEventListener("keydown", ev => {
      if (ev.key !== "Escape") return
      if (_xrExperience?.baseExperience?.state === BABYLON.WebXRState.IN_XR) {
        _xrExperience.baseExperience.exitXRAsync().catch(err =>
          console.warn("[xr] exit failed:", err?.message || err)
        )
      }
    })

    // ─────────────────────────────────────────────────────────────────
    //  Controller-getriebene Interaktion (Daydream + andere 3DOF/6DOF)
    //
    //  Zustands-Modell:
    //    BROWSE: Touchpad-Achse cyclt fokussiertes GameObject; Confirm
    //            (Touchpad-Press oder Trigger) öffnet das InWorldMenu.
    //    MENU:   Touchpad-Achse cyclt Button-Fokus; Confirm triggert die
    //            Aktion. Der letzte Eintrag ist immer "Zurück" (System-
    //            Back-Button ist OS-reserviert und nicht in WebXR
    //            durchgereicht).
    //
    //  Gaze-Loop pausiert solange Controller verbunden ist (_xrControllerMode).
    // ─────────────────────────────────────────────────────────────────
    setupXrControllerInteraction()
  } catch (err) {
    console.warn("[xr] init failed (browser likely lacks WebXR):", err?.message || err)
  }

  // Closure-zugriff auf alle lokalen init()-Variablen (ajnaManager, scene,
  // _xrExperience, inWorldMenu, setHighlight, objectMap, _gazedGO via
  // closure-Read). Kapselt die State-Machine.
  function setupXrControllerInteraction() {
    if (!_xrExperience?.input) return

    let mode = 'BROWSE'              // 'BROWSE' | 'MENU'
    let focusedGo = null

    const visibleObjects = () => Array.from(objectMap.values()).filter(go => go?.name)

    function clearFocus() {
      if (focusedGo) setHighlight(focusedGo, false)
      focusedGo = null
    }

    function setFocusByIdx(idx) {
      const list = visibleObjects()
      if (list.length === 0) { clearFocus(); return }
      const i = ((idx % list.length) + list.length) % list.length
      const next = list[i]
      if (next === focusedGo) return
      if (focusedGo) setHighlight(focusedGo, false)
      focusedGo = next
      setHighlight(focusedGo, true)
    }

    function cycleObjects(delta) {
      const list = visibleObjects()
      if (list.length === 0) return
      const idx = focusedGo ? list.indexOf(focusedGo) : -1
      setFocusByIdx(idx < 0 ? 0 : idx + delta)
    }

    function enterMenu() {
      if (!focusedGo) return
      const record = ajnaManager.objectMap.get(focusedGo.id)
      if (!record) return
      const base = Array.isArray(record.actions) && record.actions.length > 0
        ? record.actions
        : [{ key: 'examine', label: 'Untersuchen' }]
      // "Zurück" als letzter Eintrag — System-Back ist in WebXR nicht
      // durchgereicht, deshalb hier explizit.
      const actions = [...base, { key: '__back', label: 'Zurück' }]
      inWorldMenu.show(focusedGo, record.name || record.id, actions, key => {
        if (key === '__back') return  // Menü ist beim trigger schon hidden
        _triggerInteract(record, key)
      })
      inWorldMenu.focusButton(0)
      mode = 'MENU'
    }

    function exitMenu() {
      if (mode !== 'MENU') return
      inWorldMenu.hide()
      mode = 'BROWSE'
    }

    function onConfirm() {
      if (mode === 'BROWSE') enterMenu()
      else                   inWorldMenu.triggerFocused()  // hide() läuft drin
      if (mode === 'MENU') mode = 'BROWSE'  // nach triggerFocused
    }

    function attachController(controller) {
      controller.onMotionControllerInitObservable.add(mc => {
        _xrControllerMode = true
        // Beim Wechsel in den Controller-Modus den evtl. Gaze-Stand
        // zurücksetzen, damit der erste Touchpad-Tick definiert startet.
        if (_gazedGO) { setHighlight(_gazedGO, false); _gazedGO = null }
        inWorldMenu.hide()
        setFocusByIdx(0)

        const touchpad = mc.getComponent('xr-standard-touchpad')
                      || mc.getComponent('xr-standard-thumbstick')
        const trigger  = mc.getComponent('xr-standard-trigger')

        // Touchpad-Achse: Edge-Detect — erst beim Crossen der Schwelle
        // wird ein Step gefeuert; Touchpad zurück in die Mitte → reset.
        if (touchpad) {
          let lastDir = null
          touchpad.onAxisValueChangedObservable.add(v => {
            const TH = 0.5
            let dir = null
            if (v.x > TH) dir = 'right'
            else if (v.x < -TH) dir = 'left'
            if (dir === lastDir) return
            lastDir = dir
            if (!dir) return
            const step = dir === 'right' ? +1 : -1
            if (mode === 'BROWSE') cycleObjects(step)
            else                   inWorldMenu.cycleFocus(step)
          })

          // Touchpad-Klick zählt als Confirm.
          let lastPressed = false
          touchpad.onButtonStateChangedObservable.add(() => {
            if (touchpad.pressed && !lastPressed) onConfirm()
            lastPressed = touchpad.pressed
          })
        }

        // Manche Daydream-Profile mappen den Hauptbutton als Trigger —
        // dann läuft Confirm darüber.
        if (trigger) {
          let lastPressed = false
          trigger.onButtonStateChangedObservable.add(() => {
            if (trigger.pressed && !lastPressed) onConfirm()
            lastPressed = trigger.pressed
          })
        }
      })
    }

    _xrExperience.input.onControllerAddedObservable.add(attachController)
    for (const c of _xrExperience.input.controllers) attachController(c)

    _xrExperience.input.onControllerRemovedObservable.add(() => {
      // Letzter Controller raus → Gaze übernimmt wieder, State zurücksetzen.
      if (_xrExperience.input.controllers.length === 0) {
        _xrControllerMode = false
        clearFocus()
        inWorldMenu.hide()
        mode = 'BROWSE'
      }
    })

    _xrExperience.baseExperience?.onStateChangedObservable.add(state => {
      if (state !== BABYLON.WebXRState.IN_XR) {
        clearFocus()
        mode = 'BROWSE'
      }
    })
  }
}


// ==========================================================
// OBJECT LOADING
// ==========================================================

const objectMap = new Map()

// Pro Objekt eine Realtime-Subscription auf "interact:<id>". Die Federation
// (AjnaManager) routet die Subscription an den richtigen PB-Server anhand
// der Composite-ID. Map hält die Unsubscribe-Functions.
const interactSubs = new Map()
let _toast = null

function subscribeInteract(manager, objectId, onEvent) {
  if (interactSubs.has(objectId)) return
  // Slot reservieren, damit zwei parallel laufende syncSceneObjects-Aufrufe
  // nicht doppelt subscriben.
  interactSubs.set(objectId, null)
  manager.subscribeInteract(objectId, onEvent).then(unsub => {
    interactSubs.set(objectId, unsub)
  }).catch(err => {
    interactSubs.delete(objectId)
    console.warn("interact subscribe failed", objectId, err?.message || err)
  })
}

function unsubscribeInteract(objectId) {
  const unsub = interactSubs.get(objectId)
  if (typeof unsub === "function") {
    try { unsub() } catch {}
  }
  interactSubs.delete(objectId)
}

// Leading+Trailing-Throttle: führt sofort aus, danach höchstens alle `ms` —
// immer mit den ZULETZT übergebenen Argumenten. Bündelt die Director-Tick-
// Bursts (mehrere Figur-Updates je 500-ms-Tick) zu einem Reconcile.
function throttleLatest(fn, ms) {
  let last = 0, timer = null, lastArgs = null
  return (...args) => {
    lastArgs = args
    const wait = ms - (Date.now() - last)
    if (wait <= 0) {
      if (timer) { clearTimeout(timer); timer = null }
      last = Date.now()
      fn(...lastArgs)
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; last = Date.now(); fn(...lastArgs) }, wait)
    }
  }
}

// Cap-Cache: Position der letzten Cap-Berechnung + je Source die gewählten IDs.
// So muss die teure Distanz-Sortierung NICHT bei jedem (500-ms-)Daten-Reconcile
// laufen — nur wenn die Kamera sich seit der letzten Berechnung > Schwelle
// bewegt hat. Verhindert das periodische Ruckeln durch Mesh-Churn (die nächste-X-
// Auswahl bleibt zwischen Kamerabewegungen stabil → keine dispose/create-Welle).
let _capCamPos = null
const _capKeep = new Map()                          // source → Set<id>
const CAP_RECOMPUTE_DIST2 = 15 * 15                 // 15 m (quadriert)

// Sichtweiten-Begrenzung pro Agent: gruppiert die Objekte nach Source und
// behält je Source nur die `render_budget` kamera-nächsten. Objekte ohne
// Source (user-created) bleiben immer. Distanz im lokalen Meter-Raum
// (geo.toLocal vs. Kamera-Weltposition); Quadrat-Distanz spart die Wurzel.
function _capByAgentBudget(objects, geo, camera, filters) {
  const cam = camera?.globalPosition
  if (!cam || !filters) return objects

  // Cache wiederverwenden, solange die Kamera quasi steht (Daten-Reconciles
  // des Directors alle 500 ms sollen NICHT neu cappen).
  let recompute = true
  if (_capCamPos) {
    const dx = cam.x - _capCamPos.x, dy = cam.y - _capCamPos.y, dz = cam.z - _capCamPos.z
    if (dx * dx + dy * dy + dz * dz < CAP_RECOMPUTE_DIST2) recompute = false
  }

  const bySource = new Map()
  const keep = []
  for (const o of objects) {
    const src = o?.state?.source
    if (!src) { keep.push(o); continue }            // Nicht-Agent-Objekte immer rendern
    let list = bySource.get(src)
    if (!list) bySource.set(src, list = [])
    list.push(o)
  }

  for (const [src, list] of bySource) {
    const budget = filters.getRenderBudget(src)
    if (!Number.isFinite(budget) || list.length <= budget) {
      keep.push(...list)                            // unbegrenzt oder unter Budget → alle
      continue
    }
    // Steht die Kamera + haben wir eine gültige Auswahl: wiederverwenden
    // (nur noch existierende Objekte) → keine Distanzrechnung, kein Churn.
    if (!recompute && _capKeep.has(src)) {
      const cached = _capKeep.get(src)
      const kept = list.filter(o => cached.has(o.id))
      if (kept.length) { keep.push(...kept); continue }
    }
    // Neu berechnen: nach Distanz zur Kamera sortieren, die nächsten `budget`.
    const scored = list.map(o => {
      const p = geo.toLocal(o.lat, o.lon, o.altitude || 0)
      const dx = p.x - cam.x, dy = p.y - cam.y, dz = p.z - cam.z
      return { o, d2: dx * dx + dy * dy + dz * dz }
    })
    scored.sort((a, b) => a.d2 - b.d2)
    const chosen = scored.slice(0, budget).map(s => s.o)
    keep.push(...chosen)
    _capKeep.set(src, new Set(chosen.map(o => o.id)))
  }

  if (recompute) _capCamPos = cam.clone()
  return keep
}

// Reconcile-Schritt: bringt die Szene mit einer Objekt-Liste vom AjnaManager
// in Übereinstimmung, ohne selbst eine Backend-Abfrage auszulösen. Wird vom
// onObjectsChanged-Listener gefeuert; ein erneuter Backend-Roundtrip würde
// emitObjectsChanged und damit diesen Handler wieder triggern — Schleife.
async function syncSceneObjects(scene, world, geo, objects) {

  if (!geo.origin) return

  // Agent-Filter: aus der vollen Objekt-Liste nur das behalten, was
  // gemäß User-Setting sichtbar sein soll. Default = alles sichtbar.
  const filteredObjects = _agentFilters
    ? objects.filter(o => _agentFilters.matches(o))
    : objects

  // Sichtweiten-Begrenzung: je Agent (Source) nur die X kamera-nächsten
  // Objekte rendern (X = render_budget der Source). Dichte Agents (WiGLE)
  // werden stark vereinfacht, dünne (AIS) bleiben komplett sichtbar.
  const visibleObjects = _capByAgentBudget(filteredObjects, geo, scene.activeCamera, _agentFilters)

  const incomingIds = new Set(visibleObjects.map(o => o.id))

  // Entfernen, was nicht mehr Teil der sichtbaren Welt ist (Filter
  // oder echtes Verschwinden aus der Liste).
  for (const [id, go] of objectMap) {
    if (!incomingIds.has(id)) {
      unsubscribeInteract(id)
      go.dispose()
      objectMap.delete(id)
    }
  }

  // Ab hier nur noch sichtbare Objekte verarbeiten — durch das gefilterte
  // `visibleObjects` ersetzt der Loop unten den ursprünglichen `objects`.
  const objectsToProcess = visibleObjects

  // Neue Objekte anlegen, bestehende mit aktuellen Daten überschreiben.
  // Realtime-Events (PocketBase) landen über AjnaManager → emitObjectsChanged
  // hier mit der frischen Objekt-Liste; applyData zieht Name, Position,
  // Rotation und Scale nach, ohne das GameObject neu zu erzeugen.
  //
  // Defensive: ein einzelner Record mit fehlerhaften Daten darf nicht den
  // gesamten Reconcile-Loop killen, sonst tauchen nachfolgende Objekte nie
  // in der Szene auf (analog zum Map-Issue).
  for (const obj of objectsToProcess) {
    try {
      if (!Number.isFinite(obj.lat) || !Number.isFinite(obj.lon)) {
        console.warn(`syncSceneObjects: skip ${obj.id} (${obj.name || 'unnamed'}) — invalid lat/lon`,
          { lat: obj.lat, lon: obj.lon })
        continue
      }
      const existing = objectMap.get(obj.id)
      if (existing) {
        existing.applyData(obj, geo)
      } else {
        const go = await GameObject.createFromPBData(scene, obj, geo, true)
        objectMap.set(obj.id, go)
        // Stehendes Realtime-Abo nur für als realtime markierte Objekte (z. B.
        // interaktive NPCs), um Interaktionen ANDERER zu sehen. Sonst öffnete
        // jedes Objekt ein Abo → bei Cap-/Viewport-Churn ständige
        // submitSubscriptions-POSTs an /api/realtime = periodisches Ruckeln.
        // EIGENE Interaktionen zeigen ihr Feedback ohnehin lokal am Aufrufort.
        if (obj.state?.realtime === true) {
          subscribeInteract(ajnaManager, obj.id, data => _handleInteractAR(go, data))
        }
      }
    } catch (err) {
      console.warn(`syncSceneObjects: GameObject für ${obj.id} fehlgeschlagen`, err)
    }
  }
}

// Lokales Interact-Feedback (Toast + Highlight-Pulse) aus dem gecachten Record.
// Der Reply-Text wird ohnehin client-seitig abgeleitet (der Server broadcastet
// nur {action,source,ts}), daher kann das Feedback für EIGENE Aktionen sofort
// am Aufrufort gezeigt werden — ohne stehendes Realtime-Abo auf das Objekt.
function _showInteractFeedback(objectId, action) {
  if (!_toast) _toast = new Toast()
  const go = objectMap.get(objectId)
  const rec = ajnaManager.getObjectById(objectId)
  const name = go?.name || rec?.name || objectId
  // Reply-Text aus dem gecachten Record ableiten (examine/talk/attack/feed/…).
  _toast.show(interactionReply(rec, action, name), { title: name })
  // Akustische Ansage ("<Aktion> - <Ergebnis>"), gegated über Audio-Schalter.
  _announcer?.interaction(rec || objectId, action)
  if (_arHighlight && go) {
    _arHighlight(go, true)
    setTimeout(() => _arHighlight(go, false), 280)
  }
}

// Reagiert auf eingehende Broker-Events (Interaktionen ANDERER Spieler auf
// Objekten, die als realtime markiert sind). Eigene Aktionen kommen hier als
// Echo zurück — die überspringen wir, weil das Feedback schon am Aufrufort lief.
function _handleInteractAR(go, data) {
  if (data?.source && data.source === ajnaManager.currentUser()?.id) return
  _showInteractFeedback(go.id, data.action)
}
let _arHighlight = null  // wird in init() befüllt — Closure-Bridge auf setHighlight
let _agentFilters = null // wird in init() gesetzt — Closure-Bridge für syncSceneObjects
let _announcer = null    // wird in init() gesetzt — geteilter TTS-Announcer (Hub)

// Baut das Hover-/Highlight-System für den AR-Modus auf:
//   - DOM-Tooltip am Mauszeiger, sobald die Maus über einem GameObject-Mesh hängt
//   - HighlightLayer-Outline für das Objekt, das gerade aus einer Liste
//     gehovert wird (EditorUI oder DebugUI rufen den zurückgegebenen
//     Callback)
//   - Gestrichelte SVG-Linie von der Bildschirmmitte zum (geclippten) Rand
//     in Richtung des hervorgehobenen Objekts, wenn dieses außerhalb des
//     Sichtfelds liegt
//
// Rückgabe: setHighlight(gameObject, hovering: boolean) — wird an
// EditorUI/DebugUI als onObjectHover durchgereicht.
function setupHoverSystem(scene, engine, canvas) {

  const arRoot = canvas.parentElement || document.body

  // ---- DOM-Tooltip für Pointer-Hover über Meshes ----
  const tooltip = document.createElement('div')
  Object.assign(tooltip.style, {
    position: 'absolute',
    background: 'rgba(18,18,22,0.95)',
    color: '#eaeaea',
    border: '1px solid #3a3a44',
    borderRadius: '4px',
    padding: '4px 8px',
    font: '12px ui-monospace, Menlo, Consolas, monospace',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    zIndex: '30',
    display: 'none'
  })
  arRoot.appendChild(tooltip)

  // ---- SVG-Overlay mit Richtungs-Linie ----
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(SVG_NS, 'svg')
  Object.assign(svg.style, {
    position: 'absolute', top: '0', left: '0',
    width: '100%', height: '100%',
    pointerEvents: 'none', zIndex: '25', display: 'none'
  })
  const line = document.createElementNS(SVG_NS, 'line')
  line.setAttribute('stroke', '#f1c40f')
  line.setAttribute('stroke-width', '2')
  line.setAttribute('stroke-dasharray', '6 6')
  svg.appendChild(line)
  arRoot.appendChild(svg)

  // ---- HighlightLayer für Listen-Hover ----
  const highlightLayer = new BABYLON.HighlightLayer('hover-hl', scene)
  highlightLayer.innerGlow = false
  highlightLayer.outerGlow = true
  const highlightColor = new BABYLON.Color3(1, 0.78, 0.1)

  let highlightedGO = null

  function applyHighlight(go, on) {
    if (!go?.meshes) return
    for (const mesh of go.meshes) {
      // HighlightLayer braucht echte Meshes mit Geometrie
      if (!(mesh instanceof BABYLON.Mesh)) continue
      if (on) highlightLayer.addMesh(mesh, highlightColor)
      else highlightLayer.removeMesh(mesh)
    }
  }

  function setHighlight(go, hovering) {
    // Vorigen Highlight ggf. abräumen (auch wenn ein anderes Objekt kommt)
    if (highlightedGO && (!hovering || highlightedGO !== go)) {
      applyHighlight(highlightedGO, false)
      highlightedGO = null
    }
    if (hovering && go) {
      applyHighlight(go, true)
      highlightedGO = go
    }
  }

  // ---- Off-Screen-Indicator: pro Frame Richtung aktualisieren ----
  scene.onBeforeRenderObservable.add(() => {
    if (!highlightedGO?.root) {
      svg.style.display = 'none'
      return
    }
    const cam = scene.activeCamera
    if (!cam) return

    const w = engine.getRenderWidth()
    const h = engine.getRenderHeight()
    const cx = w / 2
    const cy = h / 2

    const worldPos = highlightedGO.root.absolutePosition
    const forward = cam.getForwardRay().direction
    const camToObj = worldPos.subtract(cam.globalPosition)
    const dot = BABYLON.Vector3.Dot(forward, camToObj)

    const projected = BABYLON.Vector3.Project(
      worldPos,
      BABYLON.Matrix.IdentityReadOnly,
      scene.getTransformMatrix(),
      new BABYLON.Viewport(0, 0, w, h)
    )

    let projX = projected.x
    let projY = projected.y

    // Hinter der Kamera: Vector3.Project liefert irreführende Koord.
    // Richtung manuell durch Spiegelung um das Bildschirmzentrum.
    if (dot <= 0) {
      projX = cx - (projected.x - cx)
      projY = cy - (projected.y - cy)
    }

    const onScreen = dot > 0
      && projX >= 0 && projX <= w
      && projY >= 0 && projY <= h

    if (onScreen) {
      svg.style.display = 'none'
      return
    }

    // Linie verläuft von der Bildschirmmitte bis exakt zur projizierten
    // Objekt-Position. Liegt diese außerhalb der Canvas-Fläche, wird die
    // Linie vom Browser am Rand geclippt — visuell sieht der Anwender
    // einen Strich, der "hinter dem Rand verschwindet" Richtung Objekt.
    // Vorher endete die Linie am Rand selbst, was fälschlich suggerierte,
    // dass das Objekt dort sitzt.
    line.setAttribute('x1', cx)
    line.setAttribute('y1', cy)
    line.setAttribute('x2', projX)
    line.setAttribute('y2', projY)
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    svg.style.display = ''
  })

  // ---- Pointer-Hover über Mesh → Tooltip an Cursor-Position ----
  scene.onPointerObservable.add(eventData => {
    if (eventData.type !== BABYLON.PointerEventTypes.POINTERMOVE) return

    // Hover-Tooltip ist eine Desktop-Affordance. Auf Touch gibt es keinen
    // echten Hover — der scene.pick würde nur pro Drag-Frame das Umschauen
    // ausbremsen (zweite Picking-Quelle neben skipPointerMovePicking).
    if (eventData.event?.pointerType === 'touch') {
      tooltip.style.display = 'none'
      return
    }

    // Während eines Drags (Maustaste gedrückt = Kamera-Umschauen) KEINEN
    // Hover-Pick: ein scene.pick (Raycast) pro pointermove bremst das Umschauen
    // massiv aus — genau der pointermove-Block im Performance-Profil.
    if (eventData.event?.buttons) {
      tooltip.style.display = 'none'
      return
    }

    const pickInfo = scene.pick(scene.pointerX, scene.pointerY)
    const go = pickInfo?.hit ? pickInfo.pickedMesh?.metadata?.gameObject : null

    // Nur "echte" Objekte mit Namen (Player-Mesh hat keinen .metadata.gameObject)
    if (!go?.name) {
      tooltip.style.display = 'none'
      return
    }

    tooltip.textContent = go.name
    const rect = canvas.getBoundingClientRect()
    tooltip.style.left = `${rect.left + scene.pointerX + 12}px`
    tooltip.style.top = `${rect.top + scene.pointerY + 12}px`
    tooltip.style.display = 'block'
  })

  return setHighlight
}

// Bewegt die aktuell aktive Kamera so, dass sie auf das übergebene
// GameObject blickt. Spiegelt die Logik in DebugUIManager._focusOn:
// - Kamera ohne Parent (z. B. Debug-FreeCam) wird repositioniert.
// - Kamera mit Parent (z. B. Player-Cam, die an player.root hängt)
//   bekommt nur ein neues setTarget; bei Fokus auf den Player selbst
//   wäre das ein No-Op, was semantisch passt.
// Small on-screen badge showing the active position source (UWB / GPS) and the
// UWB quality factor, so it is obvious which source the AR camera is following.
function setupPositionSourceHud(positionSource, arRoot = document.body) {
  const el = document.createElement('div')
  el.id = 'posSourceHud'
  Object.assign(el.style, {
    // Below the Android status bar (safe-area inset) so the clock doesn't cover it.
    position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 10px)', left: '10px', zIndex: 1000,
    font: '12px/1.4 system-ui, sans-serif', padding: '3px 8px',
    borderRadius: '6px', color: '#fff', background: 'rgba(0,0,0,0.55)',
    pointerEvents: 'none', userSelect: 'none'
  })
  arRoot.appendChild(el)

  const render = () => {
    // activeSource: 'uwb' | 'real' | 'dummy' | 'gps' | null. Der GPSProvider
    // liefert 'real' (echtes GPS) bzw. 'dummy' (Fallback-Position), NICHT 'gps'
    // — deshalb hier alle echten Quellen behandeln, sonst stünde dauerhaft
    // "kein Fix" trotz aktivem GPS.
    const src = positionSource.activeSource
    if (src === 'uwb') {
      const q = positionSource.quality
      el.style.background = 'rgba(20,120,40,0.75)'
      el.textContent = `UWB${Number.isFinite(q) ? ` · q${q}` : ''}`
    } else if (src === 'dummy') {
      el.style.background = 'rgba(120,80,0,0.7)'
      el.textContent = 'GPS (Dummy)'
    } else if (src) {
      el.style.background = 'rgba(0,0,0,0.55)'
      el.textContent = 'GPS'
    } else {
      el.style.background = 'rgba(120,80,0,0.7)'
      el.textContent = '… kein Fix'
    }
  }
  render()
  setInterval(render, 400)
}

// Hide the Editor (#ui) and Debug panels by default and provide a small AR
// toolbar to open them on demand; each panel gets its own close button. Keeps
// the AR view unobstructed. Works embedded (arRoot = AR view) and standalone.
function setupArOverlayControls(arRoot, uiEl, debugManager) {
  if (!document.getElementById('arOverlayStyles')) {
    const s = document.createElement('style')
    s.id = 'arOverlayStyles'
    s.textContent = `
      .ar-toolbar { position:absolute; bottom:10px; left:10px; z-index:1000; display:flex; gap:6px; }
      .ar-toolbar button { background:rgba(20,24,30,0.85); color:#eaeaea; border:1px solid #2a2f37;
        border-radius:6px; padding:6px 10px; font:12px ui-sans-serif,system-ui,sans-serif; cursor:pointer; }
      .ar-toolbar button.active { background:#2c5d8f; border-color:#3a78b6; color:#fff; }
      .ar-panel-close { position:absolute; top:4px; right:6px; z-index:5;
        background:transparent; border:none; color:#aab; font-size:20px; line-height:1; cursor:pointer; }
      .ar-panel-close:hover { color:#fff; }
    `
    document.head.appendChild(s)
  }

  // Editor open by default on wide screens (>= 1024px), minimized otherwise.
  const wideScreen = window.innerWidth >= 1024
  if (uiEl) uiEl.style.display = wideScreen ? 'block' : 'none'
  debugManager?.hide?.()

  let syncActive = () => {}

  if (uiEl) {
    // EditorUI sets #ui's innerHTML once at construction, so this close button
    // (appended afterwards) survives later partial updates.
    const x = document.createElement('button')
    x.className = 'ar-panel-close'
    x.textContent = '×'
    x.title = 'Schließen'
    x.onclick = () => { uiEl.style.display = 'none'; syncActive() }
    uiEl.appendChild(x)
    if (getComputedStyle(uiEl).position === 'static') uiEl.style.position = 'absolute'
  }

  const bar = document.createElement('div')
  bar.className = 'ar-toolbar'
  const mkBtn = (label) => { const b = document.createElement('button'); b.textContent = label; bar.appendChild(b); return b }
  const editorBtn = uiEl ? mkBtn('Editor') : null
  const debugBtn = debugManager ? mkBtn('Debug') : null
  arRoot.appendChild(bar)

  syncActive = () => {
    if (editorBtn) editorBtn.classList.toggle('active', uiEl.style.display !== 'none')
    if (debugBtn) debugBtn.classList.toggle('active', !!debugManager.isOpen?.())
  }
  if (editorBtn) editorBtn.onclick = () => { uiEl.style.display = (uiEl.style.display === 'none') ? 'block' : 'none'; syncActive() }
  if (debugBtn) debugBtn.onclick = () => { debugManager.toggle(); syncActive() }
  syncActive()

  // Expose a way to force the editor open (e.g. when editing / creating an
  // object while it is minimized).
  const openEditor = () => { if (uiEl) { uiEl.style.display = 'block'; syncActive() } }
  return { openEditor }
}

function focusCameraOn(scene, gameObject) {
  const cam = scene?.activeCamera
  if (!cam || !gameObject?.root) return

  gameObject.root.computeWorldMatrix(true)
  const target = gameObject.root.absolutePosition.clone()

  if (cam.parent) {
    cam.setTarget?.(target)
    return
  }

  const offset = new BABYLON.Vector3(0, 3, -5)
  cam.position.copyFrom(target.add(offset))
  cam.setTarget?.(target)
}

async function setupPlayer(scene, world, geo, gps, canvas) {

  const player = new GameObject(scene, "player")

  // Player-Avatar erstellen
  const sphere = BABYLON.MeshBuilder.CreateSphere(
    "playerAvatar",
    { diameter: 0.5 },
    scene
  )
  const mat = new BABYLON.StandardMaterial("playerMat", scene)
  mat.diffuseColor = new BABYLON.Color3(0.2, 0.8, 0.2)
  sphere.material = mat
  sphere.parent = player.root
  player.meshes = [sphere]

  const cameraComponent = player.addComponent(
    new CameraComponent(canvas)
  )
  player.addComponent(new PlayerGPSComponent(gps, geo))
  player.addComponent(new TransformComponent())

  player.addComponent(
    new DebugCameraComponent(canvas, cameraComponent, DEBUG_WORLD, canvas.parentElement || document.body)
  )

  world.add(player)

  return player
}

function handleRealtimeEvent(e) {

  const go = objectMap.get(e.record.id)

  if (!go) return

  const net = go.getComponent(NetworkSyncComponent)
  if (!net) return

  net.applyNetworkState(e.record)
}

async function waitForOrigin(geo, gps) {
  // GPSProvider bietet waitForFirstFix() selbst an.
  // Falls bereits fix verfügbar, nutzen wir diese Position.
  if (!geo.origin) {
    const firstPosition = gps.getWorldPosition?.() || await gps.waitForFirstFix()

    if (firstPosition && !geo.origin) {
      geo.setOrigin(
        firstPosition.lat,
        firstPosition.lon,
        firstPosition.altitude || 0
      )
    }
  }

  return geo.origin
}

init()