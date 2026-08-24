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
import { ServerProfile } from './core/ServerProfile.js'
import { ProfileDialog } from "./core/ProfileDialog.js"
import { FilterDialog } from "./core/FilterDialog.js"
import { AgentFilters } from "./core/AgentFilters.js"
import { InterestArea } from "./core/InterestArea.js"
import { ProximityReporter } from "./core/ProximityReporter.js"
import { AjnaGeo } from "./core/AjnaGeo.js"
import { ObjectActions } from "./core/ObjectActions.js"
import { InWorldActionMenu } from "./core/InWorldActionMenu.js"
import { Toast } from "./core/Toast.js"
import { interactionReply, isCollectAction } from "./core/InteractionReply.js"
import { InventoryUI, DRAG_MIME } from "./core/InventoryUI.js"
import { Minimap } from "./core/Minimap.js"
import { isMultiServer, serverLabelFor } from './core/ServerBadge.js'
import { readAllRanges, effectiveTerrain, RANGE_EVENT, readRange, animRadiusFuer } from "./core/renderRange.js"
import { PresenceService, PRESENCE_TYPE, zeigeAnwesenheit } from "./core/PresenceService.js"
import { inventoryDevices } from "./core/inventoryDevices.js"
import { spawnRandomAndEdit, directorSpawnItems } from "./core/SpawnHere.js"
import { CameraComponent } from "./engine/components/CameraComponent.js"
import { DebugCameraComponent } from "./engine/components/DebugCameraComponent.js"
import { PlayerGPSComponent } from "./engine/components/PlayerGPSComponent.js"
import { GeospatialComponent } from "./engine/components/GeospatialComponent.js"
import { TransformComponent } from "./engine/components/TransformComponent.js"
import { NetworkSyncComponent } from "./engine/components/NetworkSyncComponent.js"
import { buildDebugScene } from "./engine/debug/DebugSceneBuilder.js"
import { DebugUIManager } from "./engine/debug/DebugUIManager.js"
import { buildEnvironment } from "./engine/environment/EnvironmentBuilder.js"
import { sunPosition } from "./core/solarPosition.js"
import { ArPassthrough } from "./core/ArPassthrough.js"
import { WorldTracker } from "./core/WorldTracker.js"
import { MarkerPreview } from "./core/MarkerPreview.js"
import { MarkerTracking } from "./core/MarkerTracking.js"
import { ArFovCalibration } from "./core/ArFovCalibration.js"
import { CompassCalibration } from "./core/CompassCalibration.js"
import { HeadingStabilizer } from "./core/headingStabilizer.js"
import { compassHeadingDeg } from "./core/compassHeading.js"
import { ObjectAura } from "./core/ObjectAura.js"
import { QuickActions } from "./core/QuickActions.js"
import { UwbAnchorOverlay } from "./core/UwbAnchorOverlay.js"
import { OSMContext } from "./engine/environment/OSMContext.js"
import { Terrain } from "./engine/environment/Terrain.js"
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

  setupPositionSourceHud(positionSource, arRoot, gps)

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
  
  window.addEventListener("resize", () => { engine.resize(); if (arPassthrough.enabled) arFov?.apply() })
  
  const arEnv = buildEnvironment(scene)

  // Schattenwerfer-Registry: GameObjects registrieren ihre Modell-Meshes hier
  // (siehe GameObject.#loadModel → scene._ajnaShadowGenerator).
  scene._ajnaShadowGenerator = arEnv.shadowGenerator

  // Schatten nach dem REALEN Sonnenstand ausrichten (geo-orientiert): aus der
  // Spieler-Position (geo.origin) + Uhrzeit Höhe/Azimut berechnen und die
  // Sonnen-Lichtrichtung setzen. Nord/Ost-Basis kommt aus dem GeoTransformer
  // (respektiert dessen Invert-Flags automatisch). Unter dem Horizont (Nacht)
  // wird die Höhe flach geclampt, damit der Schatten plausibel bleibt.
  const _sunUp = new BABYLON.Vector3(0, 1, 0)
  const _updateSun = () => {
    const o = geo.origin
    if (!o || !arEnv.sun) return
    const { altitude, azimuth } = sunPosition(new Date(), o.lat, o.lon)
    const elev = Math.max(altitude, 8 * Math.PI / 180)
    const north = geo.toLocal(o.lat + 0.0015, o.lon).normalize()   // Scene-Nord (mit Vorzeichen)
    const east  = geo.toLocal(o.lat, o.lon + 0.0015).normalize()   // Scene-Ost
    const toward = north.scale(Math.cos(elev) * Math.cos(azimuth))
      .add(east.scale(Math.cos(elev) * Math.sin(azimuth)))
      .add(_sunUp.scale(Math.sin(elev)))
    arEnv.sun.direction = toward.scale(-1).normalize()   // Licht fällt von der Sonne herab
  }
  _updateSun()
  setInterval(_updateSun, 60000)   // Sonne wandert langsam

  // Umschalter echtes AR (Kamera-Passthrough) ↔ XR (Skybox). Toggle sitzt im
  // Editor neben "Kamera auf Spieler". Start je Session in XR (Skybox); der
  // Kamerazugriff erfolgt erst beim bewussten Umschalten (Nutzergeste +
  // Berechtigungs-Prompt).
  const arPassthrough = new ArPassthrough({ scene, skybox: arEnv?.skybox, canvas })

  // ── SLAM-WorldTracker (Nah-Interaktion, OPT-IN) ──────────────────────────
  // Default AUS. Einschalten: localStorage 'ajna.slam' = '1'. Wenn an, liefert in
  // AR SLAM das Kamerabild und die (ruhige) Kamera-ROTATION statt Kompass-Jitter
  // (Anti-Swim); ArPassthrough bleibt dann aus (nur einer hält die Kamera).
  // Absolute Position bleibt GPS/UWB (SLAM ist kein metrischer Odometer).
  // ── SLAM-Konfiguration ───────────────────────────────────────────────────
  // Jeder Wert per URL (?slam=1&slam.scale=1.5&…) ODER localStorage 'ajna.slam.*';
  // URL setzt + merkt sich. Zur Laufzeit tunebar über window.ajnaSlam.
  const _cfg = (key, def) => {
    try {
      const u = new URLSearchParams(location.search)
      if (u.has(key)) { try { localStorage.setItem('ajna.' + key, u.get(key)) } catch {}; return u.get(key) }
      const ls = localStorage.getItem('ajna.' + key)
      if (ls != null) return ls
    } catch {}
    return def
  }
  let SLAM_ENABLED = _cfg('slam', '0') === '1'
  const slamCfg = {
    // SLAM-Translation ist auf diesem Gerät NICHT metrisch verlässlich (responsive
    // reskaliert dynamisch) → Default AUS. Rotation allein verankert die Objekte
    // stabil am Kamerabild (Anti-Swim); Position bleibt GPS. translation=1 nur zum
    // Experimentieren / später mit UWB/Marker als absoluter Metrik-Referenz.
    translation: _cfg('slam.translation', '0') === '1',
    scale: parseFloat(_cfg('slam.scale', '1')) || 1,    // Translations-Skala (metrische Kalibrierung, per Gerät)
    maxOffsetM: parseFloat(_cfg('slam.max', '15')) || 0,// Reichweite: SLAM-Versatz auf N m begrenzen (0=unbegrenzt)
    strength: Math.min(1, Math.max(0, parseFloat(_cfg('slam.strength', '1')) || 1)), // 0..1 Mischung SLAM↔GPS
    fovScale: parseFloat(_cfg('slam.fovscale', '2.5')) || 2.5, // FOV-Feinabgleich aufs Kamerabild (Gerät-kalibriert)
    rollScale: parseFloat(_cfg('slam.rollscale', '0.8')) || 0.8, // Roll-Trim (Gerät-kalibriert)
    range: parseFloat(_cfg('slam.range', '40')) || 0,       // Nah-Gating: SLAM nur < N m vom nächsten Objekt (0=immer an)
    dpr: parseFloat(_cfg('slam.dpr', '1.5')) || 1.5,        // Kamera-Canvas-Auflösung (GPU-Last; 1.0 = Perf-Test)
  }
  window.ajnaSlam = slamCfg   // Live in der Konsole: ajnaSlam.scale = 1.5 / ajnaSlam.translation = false …
  const SLAM_DEBUG = _cfg('slam.debug', '0') === '1'   // Debug-HUD + Diagnose-Toast nur mit ?slam.debug=1
  // Marker-Tracking UNABHÄNGIG schaltbar (Lastdiagnose + Marker-only-Betrieb):
  //   ?marker=1 → Marker erzwingen: Engine läuft auch ohne SLAM, aber mit
  //               disableWorldTracking (VIO AUS → misst die reine Marker-Last;
  //               zugleich der Modus für Browser ohne Sensoren, s. Doku)
  //   ?marker=0 → Marker aus, auch bei slam=1 (misst die reine SLAM-Last)
  //   (unset)   → Marker an, wenn SLAM an (Standard)
  const MARKER_MODE = _cfg('marker', '')
  let MARKERS_ENABLED = MARKER_MODE === '1' || (MARKER_MODE !== '0' && SLAM_ENABLED)
  let ENGINE_ENABLED = SLAM_ENABLED || MARKER_MODE === '1'   // 8th-Wall-Engine überhaupt starten?
  // Laufzeit-Modi (Einstellungen → „Tracking: SLAM/Marker"): gespeicherte Werte
  // überstimmen die URL-Defaults, außer die URL nennt den Parameter explizit
  // (dann gewinnt sie und wird als neuer Modus gespeichert).
  try {
    const storedSlam = localStorage.getItem('ajna.track.slam')
    if (storedSlam && !/[?&]slam=/.test(location.search)) {
      SLAM_ENABLED = storedSlam !== 'off'
      slamCfg.translation = storedSlam === 'full'
    } else {
      localStorage.setItem('ajna.track.slam', SLAM_ENABLED ? (slamCfg.translation ? 'full' : 'rotation') : 'off')
    }
    const storedMarker = localStorage.getItem('ajna.track.marker')
    if (storedMarker != null && !/[?&]marker=/.test(location.search)) MARKERS_ENABLED = storedMarker === '1'
    else localStorage.setItem('ajna.track.marker', MARKERS_ENABLED ? '1' : '0')
    ENGINE_ENABLED = SLAM_ENABLED || MARKERS_ENABLED
  } catch {}
  const worldTracker = new WorldTracker({ scene, appCanvas: canvas, skybox: arEnv?.skybox, dpr: slamCfg.dpr })
  let _slamTheta = null, _slamOrigin = null, _slamIntrLogged = false   // Nord-Alignment + Ursprung + Diag
  let markerTracking = null   // wird nach player/geo-Setup instanziiert (braucht Spieler-Position)
  // Anker der marker-verankerten Koppelnavigation: letzter Snap (Geo-Position der
  // Kamera, SLAM-Position, gemessene Skala u/m, Zeitstempel). SLAM trägt die
  // Bewegung davon weiter, bis Zeit-/Distanz-Budget erschöpft ist.
  let _markerAnchor = null
  window.addEventListener('ajna:slam-realign', () => { _slamTheta = null; _slamOrigin = null })   // Nord + Ursprung neu
  // SLAM-Debug-HUD (on-screen, da DevTools gerade schwierig): rohe SLAM-Δ pro Achse
  // (zeigt welche Achse bei Vorwärts/Seitwärts reagiert), angewandter Offset, θ/Konfig,
  // und Distanz zum nächsten Objekt (für die Skala-Kalibrierung).
  let _slamHud = null, _slamHudTxt = null, _slamHudTimer = null
  function _ensureSlamHud() {
    if (_slamHud) return _slamHud
    const d = document.createElement('div'); d.id = 'slam-hud'
    Object.assign(d.style, { position: 'fixed', left: '6px', top: '6px', zIndex: '9', padding: '6px 8px',
      font: '11px/1.35 ui-monospace,Menlo,Consolas,monospace', color: '#cfe8ff', background: 'rgba(0,0,0,0.6)',
      border: '1px solid #2b4a66', borderRadius: '6px', whiteSpace: 'pre' })
    const txt = document.createElement('div')
    const bar = document.createElement('div'); Object.assign(bar.style, { marginTop: '5px', display: 'flex', gap: '5px' })
    const mk = (label, fn) => { const b = document.createElement('button'); b.textContent = label
      Object.assign(b.style, { flex: '1', padding: '7px 4px', font: 'inherit', color: '#cfe8ff', background: 'rgba(40,80,120,0.95)', border: '1px solid #2b4a66', borderRadius: '5px' })
      b.addEventListener('click', fn); return b }
    // Live-Tuning OHNE Reload (bleibt in DERSELBEN SLAM-Session, ×/÷ 0.9 pro Klick).
    bar.appendChild(mk('scale −', () => { slamCfg.scale = +(slamCfg.scale * 0.9).toFixed(3) }))
    bar.appendChild(mk('scale +', () => { slamCfg.scale = +(slamCfg.scale / 0.9).toFixed(3) }))
    d.appendChild(txt); d.appendChild(bar)
    document.body.appendChild(d); _slamHud = d; _slamHudTxt = txt; return d
  }
  function _updateSlamHud() {
    const r = worldTracker.reality
    if (!r || !_slamOrigin || !_playerCam) return
    const dx = r.position.x - _slamOrigin.x, dy = r.position.y - _slamOrigin.y, dz = r.position.z - _slamOrigin.z
    const cb = _playerCam._slamCamBase || _playerCam.position
    const ox = _playerCam.position.x - cb.x, oy = _playerCam.position.y - cb.y, oz = _playerCam.position.z - cb.z
    let nd = Infinity; const cp = _playerCam.globalPosition
    objectMap.forEach(go => { const p = go && go.root && go.root.getAbsolutePosition && go.root.getAbsolutePosition()
      if (p) { const dd = BABYLON.Vector3.Distance(cp, p); if (dd < nd) nd = dd } })
    _ensureSlamHud()
    _slamHudTxt.textContent =
      `θ ${((_slamTheta || 0) * 180 / Math.PI).toFixed(0)}°  scale ${slamCfg.scale}  fov ${slamCfg.fovScale}\n` +
      `Δslam  x ${dx.toFixed(2)}  y ${dy.toFixed(2)}  z ${dz.toFixed(2)}\n` +
      `offset x ${ox.toFixed(2)}  y ${oy.toFixed(2)}  z ${oz.toFixed(2)}\n` +
      `nächstes Objekt: ${nd === Infinity ? '—' : nd.toFixed(1) + ' m'}`
  }

  // ── SLAM an/aus (Kamera-Hand-off macht der Aufrufer via ArPassthrough) ──
  let _slamGateTimer = null
  function _slamOn() {
    if (worldTracker.active || worldTracker._starting) return
    _slamTheta = null; _slamOrigin = null; _slamIntrLogged = false
    if (slamCfg.translation) { const pg = player.getComponent(PlayerGPSComponent); if (pg) pg.paused = true }
    worldTracker.start({ worldTracking: SLAM_ENABLED }).catch(err => {
      console.warn('[slam] Start fehlgeschlagen, Fallback Kompass:', err?.message || err)
      const pg = player.getComponent(PlayerGPSComponent); if (pg) pg.paused = false
      try { if (!_toast) _toast = new Toast(); _toast.show('SLAM nicht verfügbar — Kompass', { title: 'AR' }) } catch {}
      arPassthrough.enable().catch(() => {})
    })
    markerTracking?.startOverlay()   // Umriss+Name erkannter Marker im Kamerabild
    if (SLAM_DEBUG) {
      setTimeout(() => { if (!_slamIntrLogged) { try { if (!_toast) _toast = new Toast(); _toast.show('KEINE Intrinsics → Default-FOV (zu eng)', { title: 'SLAM' }) } catch {} } }, 3000)
      _ensureSlamHud().style.display = 'block'
      if (_slamHudTimer) clearInterval(_slamHudTimer); _slamHudTimer = setInterval(_updateSlamHud, 200)
    }
  }
  function _slamOff() {
    markerTracking?.stopOverlay()
    _markerAnchor = null
    if (_slamHudTimer) { clearInterval(_slamHudTimer); _slamHudTimer = null }
    if (_slamHud) _slamHud.style.display = 'none'
    if (worldTracker.active) worldTracker.stop()
    const pg = player.getComponent(PlayerGPSComponent); if (pg) pg.paused = false
    try { _playerCam && _playerCam.unfreezeProjectionMatrix() } catch {}
    if (_playerCam && _playerCam._slamCamBase) _playerCam.position.copyFrom(_playerCam._slamCamBase)
  }
  function _nearestObjDist() {
    const cp = _playerCam && _playerCam.globalPosition; if (!cp) return Infinity
    let nd = Infinity
    objectMap.forEach(go => { const p = go && go.root && go.root.getAbsolutePosition && go.root.getAbsolutePosition()
      if (p) { const d = BABYLON.Vector3.Distance(cp, p); if (d < nd) nd = d } })
    return nd
  }
  // Nah-Gating: SLAM nur < range m vom nächsten Objekt (Akku sparen), mit Hysterese
  // (verlässt erst bei range×1.3), damit es an der Grenze nicht flattert.
  function _startSlamGate() {
    if (_slamGateTimer) clearInterval(_slamGateTimer)
    _slamGateTimer = setInterval(() => {
      const d = _nearestObjDist()
      if (!worldTracker.active && !worldTracker._starting && d < slamCfg.range) { arPassthrough.disable(); _slamOn() }
      else if (worldTracker.active && d > slamCfg.range * 1.3) { _slamOff(); arPassthrough.enable().catch(() => {}) }
    }, 1500)
  }
  function _stopSlamGate() { if (_slamGateTimer) { clearInterval(_slamGateTimer); _slamGateTimer = null } }

  // ── AR-Modus an "Switch Camera" koppeln ──────────────────────────────────
  // VOR Switch Camera (Free-Modus): frei bewegen + Skybox, kein Kompass.
  // NACH Switch Camera (Player-Modus): an die GPS-Position fixiert, Kamera-
  // Passthrough + Geräte-Kompass für möglichst realitätsnahes "Magic-Window"-AR.
  // Die Kompass-Orientierung liefert Babylons integrierter DeviceOrientation-
  // Input auf der (am Player-Root hängenden) Kamera. iOS verlangt eine
  // Permission-Geste (der Button-Tap deckt das ab), Android nicht.
  const _debugCam = player.getComponent(DebugCameraComponent)
  const _playerCam = player.getComponent(CameraComponent)?.camera
  let _compassActive = false
  // AR-Nord-Offset (Grad→rad), pro Gerät. Korrigiert einen Heading-Frame-Versatz
  // zwischen Geräte-Kompass und Daten-Nordframe (manche Geräte zeigen die Welt um
  // 180° gedreht — Süd erscheint als Nord). Live über das Einstellungs-Feld.
  let _arNorthRad = (parseFloat(localStorage.getItem('ajna.ar.north_offset')) || 0) * Math.PI / 180
  window.addEventListener('ajna:ar-north', ev => {
    _arNorthRad = (parseFloat(ev.detail) || 0) * Math.PI / 180
  })
  // Augenhöhe live geändert (CameraComponent passt die Kamera an) → SLAM-Basis
  // mitziehen, sonst addiert der Translations-Offset auf die alte Höhe.
  window.addEventListener('ajna:ar-eye-height', ev => {
    const v = parseFloat(ev.detail)
    if (Number.isFinite(v) && _playerCam?._slamCamBase) _playerCam._slamCamBase.y = v
  })
  // Gyro-Stabilisierung des Headings (siehe Hook unten). _smoothedHeadingQ hält
  // den geglätteten Zustand; null = neu ansetzen (nach Modus-Aus/An kein Lerp aus
  // einer veralteten Orientierung).
  const _headingStab = new HeadingStabilizer()
  let _smoothedHeadingQ = null

  // ── Absolute Yaw-Referenz ────────────────────────────────────────────────
  // Babylons DeviceOrientation-Input hört auf RELATIVE Events (Chrome/Android:
  // Nullpunkt = Gerätelage beim Sensor-Start) → der Nord-Offset wäre pro
  // Sitzung anders. Deshalb Komplementärfilter: der relative Sensor liefert
  // die GLATTE Hochfrequenz-Drehung, der absolute Kompass (deviceorientation-
  // absolute / webkitCompassHeading) referenziert den Yaw LANGSAM auf echtes
  // Nord. Der Nord-Offset in den Einstellungen bleibt als Fein-Trim (Geräte-
  // Kompassfehler + Deklination) — aber sessionSTABIL. Abschaltbar
  // (Einstellung 'ajna.ar.abs_yaw'; Default an). Ohne absolute Events
  // (Desktop/Brave) greift automatisch das bisherige Verhalten.
  let _absYawOn = (() => { try { return localStorage.getItem('ajna.ar.abs_yaw') !== '0' } catch { return true } })()
  window.addEventListener('ajna:ar-abs-yaw', ev => { _absYawOn = !!ev.detail; _absYawOffset = null })
  let _absHeadingRad = null, _absHeadingAt = 0, _absYawOffset = null
  const _onAbsOrient = (ev) => {
    // Tilt-kompensiert (compassHeading.js) — in AR wird das Gerät aufrecht
    // gehalten, genau dort war die Flach-Näherung instabil (Gimbal-Springen).
    const h = compassHeadingDeg(ev)
    if (h == null) return
    _absHeadingRad = h * Math.PI / 180
    _absHeadingAt = performance.now()
  }
  try {
    window.addEventListener('deviceorientationabsolute', _onAbsOrient, true)
    window.addEventListener('deviceorientation', _onAbsOrient, true)   // iOS-Pfad (webkitCompassHeading)
  } catch {}
  const _lerpAngleG = (a, b, k) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * k }
  // Frame-Konvention: Nord = −Z (invertNorthSouth), RH-Yaw dreht gen Westen →
  // Ziel-Yaw = −Kompass-Heading. Liefert den langsam nachgeführten Offset
  // relativ zum rohen Babylon-Yaw (oder null, wenn keine frische Referenz).
  const _absYawCorrection = (rawYaw) => {
    if (!_absYawOn || _absHeadingRad == null || performance.now() - _absHeadingAt > 3000) return _absYawOffset
    const want = -_absHeadingRad - rawYaw
    _absYawOffset = (_absYawOffset == null) ? want : _lerpAngleG(_absYawOffset, want, 0.02)
    return _absYawOffset
  }
  if (_playerCam) {
    // Kompass-Input EINMAL einrichten: die Player-Kamera bekommt ausschließlich
    // Babylons DeviceOrientation-Input (kein Maus/Touch/Tastatur). Bewusst NICHT
    // bei jedem Moduswechsel neu klären/anlegen — dabei blieb der Input beim
    // zweiten Aktivieren tot. Das Attach/Detach übernimmt der Kamerawechsel
    // (DebugCameraComponent); dieselbe Input-Instanz bleibt erhalten.
    try {
      _playerCam.inputs.clear()
      _playerCam.inputs.addDeviceOrientation()
    } catch (e) { console.warn("[ar] Kompass-Setup fehlgeschlagen:", e?.message || e) }
    // Handedness-Korrektur: rechtshändige Szene (useRightHandedSystem) invertiert
    // Pitch (oben/unten) UND Roll (Neigen) — beide Euler-Anteile (x,z) negieren,
    // Yaw (links/rechts) bleibt. Nur bei aktivem Kompass, nach dem Input-Check.
    // Scratch für die SLAM→RH-Kamera-Abbildung (keine Allokation pro Frame).
    const _slamQuat = new BABYLON.Quaternion()
    const _eul = new BABYLON.Vector3()
    const _off = new BABYLON.Vector3(), _rotM = new BABYLON.Matrix()
    const _camBase = _playerCam.position.clone()   // Augenhöhe (0,1.7,0) — SLAM-Offset kommt drauf
    const _lerpAngle = (a, b, k) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * k }
    // Kamera-Zielposition aus einem Marker-Snap: MarkerGeo − R_q·relCam (Meter).
    // q = AKTUELLE Szenen-Kamera-Rotation → virtueller und realer Marker werden
    // deckungsgleich, egal ob die Rotation aus SLAM oder Kompass stammt.
    const _snapM = new BABYLON.Matrix()
    const _markerSnapTarget = (q, snap) => {
      BABYLON.Matrix.FromQuaternionToRef(q, _snapM)
      BABYLON.Vector3.TransformNormalToRef(snap.relCamM, _snapM, _off)
      return new BABYLON.Vector3(snap.markerLocal.x - _off.x, snap.markerLocal.y - _off.y, snap.markerLocal.z - _off.z)
    }
    let _compassSnapAt = 0   // letzter Marker-Snap im Kompass-Pfad (GPS-Resume)
    // Bildet die rohe SLAM-Pose auf die rechtshändige App-Kamera ab: Rotation +
    // (optional) Translation, einmaliges Nord-Alignment (θ) am Kompass, Intrinsics-FOV.
    const _applySlamPose = (q, r) => {
      // --- Rotation: SLAM-Pose ist bei Pitch/Roll bereits RH-korrekt (anders als der
      //     DeviceOrientation-Input des Kompass-Hooks, der -x/-z negiert). Also NICHT
      //     negieren; nur den Yaw um θ nach Nord ausrichten. Äquivalent zu Ry(θ)·slam. ---
      _slamQuat.set(r.rotation.x, r.rotation.y, r.rotation.z, r.rotation.w)
      _slamQuat.toEulerAnglesToRef(_eul)
      if (_slamTheta == null) {
        // θ = Kompass-Yaw (q frisch vom DeviceOrientation-Input, vor dem Über-
        // schreiben) − SLAM-Yaw. Inkl. Absolut-Korrektur, falls vorhanden.
        const compassYaw = q.toEulerAngles().y + (_absYawOffset ?? 0) + _arNorthRad
        _slamTheta = compassYaw - _eul.y
        _slamOrigin = { x: r.position.x, y: r.position.y, z: r.position.z }   // Positions-Ursprung merken
        console.log('[slam] Nord-Alignment θ =', (_slamTheta * 180 / Math.PI).toFixed(1), '°')
      }
      // --- Marker-Snap: exakte, frame-lokale Metrik-Referenz. Überstimmt das
      //     Kompass-θ (Marker-Ausrichtung ist präziser) und setzt die Kamera-
      //     Position cm-genau (GPS pausiert währenddessen). ---
      const snap = markerTracking && markerTracking.computeSnap(r)
      if (snap) _slamTheta = _lerpAngle(_slamTheta, snap.theta, 0.15)
      BABYLON.Quaternion.RotationYawPitchRollToRef(_eul.y + _slamTheta, _eul.x, _eul.z * slamCfg.rollScale, q)
      if (snap) {
        const pg = player.getComponent(PlayerGPSComponent); if (pg) pg.paused = true
        // Kamera-relative Platzierung: Kamera = MarkerGeo − R_q·relCam. Damit
        // liegen virtueller und realer Marker DECKUNGSGLEICH — unabhängig davon,
        // woher die Rotation stammt. Geglättet gegen Detektions-Jitter.
        const target = _markerSnapTarget(q, snap)
        // Anker für die Koppelnavigation: Geo-Ziel + SLAM-Position + GEMESSENE
        // Skala dieses Frames (der Marker misst die SLAM-Einheiten!).
        _markerAnchor = {
          cam: target.clone(),
          slam: { x: r.position.x, y: r.position.y, z: r.position.z },
          upm: snap.upm, at: performance.now(),
        }
        const rp = player.root.position
        rp.x += (target.x - _camBase.x - rp.x) * 0.2
        rp.y += (target.y - _camBase.y - rp.y) * 0.2
        rp.z += (target.z - _camBase.z - rp.z) * 0.2
      } else if (_markerAnchor) {
        // --- Marker-verankerte Koppelnavigation: SLAM trägt die Bewegung vom
        //     letzten Snap weiter — mit dort gemessener Skala (u/m) und Marker-θ.
        //     Budgetiert (ajnaMarkerCfg.drTimeS/drMaxM), denn die responsive-
        //     Skala driftet über Zeit/Strecke; danach übernimmt wieder GPS. ---
        const a = _markerAnchor
        const mcfg = markerTracking?.cfg || {}
        const du = { x: r.position.x - a.slam.x, y: r.position.y - a.slam.y, z: r.position.z - a.slam.z }
        const distM = Math.hypot(du.x, du.y, du.z) / a.upm
        if (performance.now() - a.at <= (mcfg.drTimeS ?? 30) * 1000 && distM <= (mcfg.drMaxM ?? 15)) {
          _off.set(du.x / a.upm, du.y / a.upm, du.z / a.upm)   // Meter im SLAM-Frame (RH, verifiziert)
          BABYLON.Matrix.RotationYToRef(_slamTheta, _rotM)
          BABYLON.Vector3.TransformCoordinatesToRef(_off, _rotM, _off)
          const rp = player.root.position
          rp.x += (a.cam.x + _off.x - _camBase.x - rp.x) * 0.25
          rp.y += (a.cam.y + _off.y - _camBase.y - rp.y) * 0.25
          rp.z += (a.cam.z + _off.z - _camBase.z - rp.z) * 0.25
        } else {
          // Budget erschöpft → Anker verwerfen, GPS wieder aktiv (außer die
          // generische SLAM-Translation ist eingeschaltet, die pausiert selbst).
          _markerAnchor = null
          if (!slamCfg.translation) { const pg = player.getComponent(PlayerGPSComponent); if (pg) pg.paused = false }
        }
      }
      // --- Translation (Phase 2): SLAM-Versatz seit Start, RH-gemappt, nord-
      //     gedreht, skaliert, auf Reichweite begrenzt, gemischt → auf Augenhöhe.
      //     Pausiert, solange Marker-Snap/Koppelnavigation aktiv ist (präziser). ---
      if (slamCfg.translation && _slamOrigin && !snap && !_markerAnchor) {
        // SLAM-Position ist bereits Babylon-RH (vorwärts −Z, rechts +X) → KEINE
        // (-x,-z)-Negation (die invertierte vor/zurück UND links/rechts). Nur
        // den (willkürlichen) SLAM-Yaw per θ nach Nord drehen, dann skalieren.
        _off.set(r.position.x - _slamOrigin.x, r.position.y - _slamOrigin.y, r.position.z - _slamOrigin.z)
        BABYLON.Matrix.RotationYToRef(_slamTheta, _rotM)
        BABYLON.Vector3.TransformCoordinatesToRef(_off, _rotM, _off)
        _off.scaleInPlace(slamCfg.scale)
        const len = _off.length()
        if (slamCfg.maxOffsetM > 0 && len > slamCfg.maxOffsetM) _off.scaleInPlace(slamCfg.maxOffsetM / len)
        if (slamCfg.strength !== 1) _off.scaleInPlace(slamCfg.strength)
        _playerCam.position.set(_camBase.x + _off.x, _camBase.y + _off.y, _camBase.z + _off.z)
      }
      // FOV an das echte Kamerabild: Projektion aus Intrinsics (RH → KEIN [10]/[11]-Flip).
      if (r.intrinsics && Math.abs(r.intrinsics[0]) > 1e-4) {
        if (!_slamIntrLogged) {
          _slamIntrLogged = true; const i = r.intrinsics
          const fx = (2 * Math.atan(1 / Math.abs(i[0])) * 180 / Math.PI).toFixed(0)
          const fy = (2 * Math.atan(1 / Math.abs(i[5])) * 180 / Math.PI).toFixed(0)
          console.log('[slam] intrinsics DA · m00=%s m11=%s → fovX≈%s° fovY≈%s°', i[0].toFixed(3), i[5].toFixed(3), fx, fy)
          if (SLAM_DEBUG) { try { if (!_toast) _toast = new Toast(); _toast.show(`Intrinsics DA · FOV ≈ ${fx}°/${fy}° (m00 ${i[0].toFixed(2)} m11 ${i[5].toFixed(2)})`, { title: 'SLAM' }) } catch {} }
        }
        // FOV-Feinabgleich aufs Kamerabild: m00/m11 gleich skalieren (Aspekt bleibt).
        const m = r.intrinsics.slice(0)
        if (slamCfg.fovScale !== 1) { m[0] /= slamCfg.fovScale; m[5] /= slamCfg.fovScale }
        _playerCam.freezeProjectionMatrix(BABYLON.Matrix.FromArray(m))
      }
    }
    _playerCam._slamCamBase = _camBase   // für Restore beim Modus-Aus

    _playerCam.onAfterCheckInputsObservable.add(() => {
      const q = _playerCam.rotationQuaternion
      if (!_compassActive || !q) { _smoothedHeadingQ = null; return }
      // SLAM-Übernahme: ruhige, weltfeste Rotation aus visuellem Tracking statt
      // Kompass-Jitter. Bei (noch) schlechtem Tracking Fallback auf Kompass unten.
      if (SLAM_ENABLED && worldTracker.active) {
        const r = worldTracker.reality
        const ts = r && r.trackingStatus
        if (r && r.rotation && (ts === 'NORMAL' || ts == null)) { _applySlamPose(q, r); return }
      }
      const e = q.toEulerAngles()
      // Yaw = roher (relativer) Sensor + langsam nachgeführte Absolut-Korrektur
      // (sessionstabil) + Nord-Offset als Fein-Trim. Ohne absolute Referenz
      // bleibt es beim bisherigen Verhalten (nur Offset).
      const corr = _absYawCorrection(e.y)
      BABYLON.Quaternion.RotationYawPitchRollToRef(e.y + (corr ?? 0) + _arNorthRad, -e.x, -e.z, q)
      // Gyro-adaptive Glättung (headingStabilizer): bei Ruhe stark (Objekte
      // schwimmen nicht mehr), bei echter Drehung ohne spürbaren Lag. q ist das
      // Ziel; wir slerpen den gehaltenen Zustand darauf zu und schreiben zurück.
      const t = _headingStab.factor()
      if (!_smoothedHeadingQ) _smoothedHeadingQ = q.clone()
      else { BABYLON.Quaternion.SlerpToRef(_smoothedHeadingQ, q, t, _smoothedHeadingQ); q.copyFrom(_smoothedHeadingQ) }

      // Marker-Snap auch OHNE SLAM (Marker-only/Kompass-Modus): die Engine
      // liefert die kamera-relative Marker-Pose, die Rotation kommt vom Kompass.
      // Solange ein Marker sichtbar ist, wird die Kamera deckungsgleich platziert;
      // 2 s nach Verlust übernimmt wieder GPS (ohne VIO keine Koppelnavigation).
      if (worldTracker.active && markerTracking && markerTracking.enabled) {
        const mr = worldTracker.reality
        const msnap = mr ? markerTracking.computeSnap(mr) : null
        if (msnap) {
          _compassSnapAt = performance.now()
          const pg = player.getComponent(PlayerGPSComponent); if (pg) pg.paused = true
          const target = _markerSnapTarget(q, msnap)
          const rp = player.root.position
          rp.x += (target.x - _camBase.x - rp.x) * 0.2
          rp.y += (target.y - _camBase.y - rp.y) * 0.2
          rp.z += (target.z - _camBase.z - rp.z) * 0.2
        } else if (_compassSnapAt && performance.now() - _compassSnapAt > 2000) {
          _compassSnapAt = 0
          const pg = player.getComponent(PlayerGPSComponent); if (pg) pg.paused = false
        }
      }
    })
  }
  // FOV-Kalibrierung der AR-Kamera an das reale Kamerabild (Pitch-Mismatch):
  // Auto-Schätzung aus den Video-Maßen + Feinjustier-Slider (per Gerät gemerkt).
  const arFov = _playerCam
    ? new ArFovCalibration({
        camera: _playerCam,
        getVideo: () => arPassthrough.video,
        getCanvas: () => canvas,
        parent: arRoot
      })
    : null
  window.arFovCalibration = arFov   // für den Regler im Einstellungs-Menü (MobileShell)
  // Einstellungs-Toggle „Live-Regler in AR anzeigen": schaltet den Slider live an/aus.
  window.addEventListener('ajna:ar-fov-slider', ev => arFov?.setSliderVisible(!!ev.detail))

  // Kompass-Kalibrier-/Drift-Indikator (liest Geräte-Kompass mit, bewertet Güte).
  const compass = new CompassCalibration({ parent: arRoot })
  window.arCompass = compass
  window.addEventListener('ajna:ar-compass', ev => compass.setVisible(!!ev.detail))

  // Objekt-Aura („Call-Out") — schwebende Identität/Metadaten des fokussierten
  // Objekts in der AR (D-Raum-Vorbild). Fokus liefert der Gaze-Loop unten.
  const objectAura = new ObjectAura({
    parent: arRoot,
    getMe: () => ajnaManager.currentUser?.(),
    getFilters: () => _agentFilters,
  })
  window.arAura = objectAura
  window.addEventListener('ajna:ar-aura', ev => objectAura.setVisible(!!ev.detail))
  // Callout-Reichweite (Meter), pro Gerät + live über das Einstellungs-Slider.
  let _auraRangeM = (() => { const v = parseFloat(localStorage.getItem('ajna.ar.aura_range')); return Number.isFinite(v) && v > 0 ? v : 100 })()
  window.addEventListener('ajna:ar-aura-range', ev => { const v = parseFloat(ev.detail); if (Number.isFinite(v) && v > 0) _auraRangeM = v })

  async function _ensureOrientationPermission() {
    const D = window.DeviceOrientationEvent
    if (D && typeof D.requestPermission === "function") {
      try { await D.requestPermission() } catch {}
    }
    // Der Kompass-Drift-Indikator nutzt zusätzlich devicemotion (Gyro) — auf iOS
    // eigene Permission (dieselbe Nutzergeste deckt beide ab).
    const M = window.DeviceMotionEvent
    if (M && typeof M.requestPermission === "function") {
      try { await M.requestPermission() } catch {}
    }
  }
  // Tracking-Aufbau für den AR-Modus — auch bei LAUFZEIT-Umschaltung der Modi
  // (Einstellungen) erneut aufgerufen: räumt den alten Zustand ab und baut den
  // gewünschten (Kompass / Engine mit-ohne VIO / Nah-Gating) neu auf.
  function _applyArTracking() {
    _stopSlamGate()
    if (worldTracker.active || worldTracker._starting) _slamOff()
    if (ENGINE_ENABLED && slamCfg.range > 0) {
      // Nah-Gating: zunächst Kamera-Passthrough + Kompass; Engine schaltet sich
      // je nach Objekt-Nähe selbst zu/ab (Akku sparen, nur einer hält die Kamera).
      arPassthrough.enable().catch(err => { try { if (!_toast) _toast = new Toast(); _toast.show(err?.message || "Kamera nicht verfügbar", { title: "AR" }) } catch {} })
      arFov?.activate()
      _startSlamGate()
    } else if (ENGINE_ENABLED) {
      arPassthrough.disable()   // range=0 → Engine immer an; Kamera frei → Engine übernimmt
      _slamOn()
    } else {
      arPassthrough.enable().catch(err => { if (!_toast) _toast = new Toast(); _toast.show(err?.message || "Kamera nicht verfügbar", { title: "AR" }) })
      arFov?.activate()   // FOV an Kamerabild angleichen
    }
  }

  // Laufzeit-Umschaltung der Tracking-Modi (Einstellungen → Dropdowns).
  window.addEventListener('ajna:tracking-mode', ev => {
    const d = ev.detail || {}
    const mode = d.slam || 'off'
    SLAM_ENABLED = mode !== 'off'
    slamCfg.translation = mode === 'full'
    MARKERS_ENABLED = !!d.marker
    ENGINE_ENABLED = SLAM_ENABLED || MARKERS_ENABLED
    markerTracking?.setEnabled(MARKERS_ENABLED)
    console.log(`[tracking] SLAM=${mode} Marker=${MARKERS_ENABLED ? 'an' : 'aus'}`)
    if (_debugCam?.activeMode !== 'player') return   // greift beim nächsten AR-Start
    // Engine-Neustart nur wenn nötig (an/aus oder VIO-Modus geändert);
    // rotation↔voll geht live (nur GPS-Pause nachziehen).
    const engineRunning = worldTracker.active || worldTracker._starting
    const sameEngine = engineRunning && ENGINE_ENABLED && worldTracker.worldTracking === SLAM_ENABLED
    if (sameEngine) {
      const pg = player.getComponent(PlayerGPSComponent)
      if (pg) pg.paused = slamCfg.translation || !!_markerAnchor
    } else {
      _applyArTracking()
    }
  })

  // Auf den Kamerawechsel reagieren: Player-Modus = AR (GPS-fix + Kompass +
  // Passthrough), Free-Modus = frei + Skybox. Die Kamera + den Kompass-Input-
  // Attach schaltet DebugCameraComponent selbst.
  function _onCameraMode(mode) {
    const ar = mode === "player"
    _compassActive = ar
    console.log(`[ar] Kamera-Modus → ${ar ? "AR (GPS-fix + Kompass)" : "Free-Fly"}`)
    if (ar) {
      _applyArTracking()
      compass.activate()  // Kompass-Güte-Indikator (nur wenn in Einstellungen aktiviert)
      objectAura.activate() // Fokus-Reticle + Call-Out-Karte (nur wenn eingeschaltet)
    } else {
      _stopSlamGate()
      _slamOff()            // SLAM aus + Kamera/GPS/Projektion wiederherstellen (idempotent)
      arPassthrough.disable()
      arFov?.deactivate() // XR/Skybox: virtuelle Kamera auf Default-FOV, Slider aus
      compass.deactivate()
      objectAura.deactivate()
    }
    try { editorUI?.setArModeToggle?.(ar) } catch {}   // Editor-Checkbox synchron
  }
  if (_debugCam) _debugCam.onModeChange = _onCameraMode
  // Einheitlicher Auslöser für Button UND Editor-Toggle; iOS-Sensor-Permission
  // vor dem Wechsel (Geste). DebugCam-Modus ist die Wahrheit.
  async function setArMode(on) {
    if (on) await _ensureOrientationPermission()
    _debugCam?.setMode(on ? "player" : "free")
  }
  if (_debugCam) _debugCam.onToggle = () => setArMode(_debugCam.activeMode !== "player")

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
    // Player mit-updaten: er liegt in `world`, nicht in objectMap. Ohne diesen
    // Aufruf lief PlayerGPSComponent.update() nie → die AR-Kamera blieb am
    // Boot-Origin kleben und folgte weder GPS-Wechsel noch Bewegung (Karte
    // stimmte, weil sie positionSource direkt liest).
    player.update(delta)
    scene.render()
  }
  engine.runRenderLoop(renderLoop)
  // Embedded in the shell, the AR view is hidden behind other tabs; let the
  // shell pause/resume the render loop to save battery (no-op standalone).
  // arResume wirft AUCH das Kamerabild wieder an — nach einem Tab-Wechsel
  // pausiert das <video> im versteckten Subtree (sonst eingefrorenes Bild).
  window.arPause = () => engine.stopRenderLoop()
  // Kamera zum Spieler holen, wenn sie weit weg steht: Beim Wechsel aus der
  // Karte parkt die freie Kamera oft noch am Boot-Origin (Dummy-Position),
  // während der Spieler längst am echten GPS-Fix ist. Der Distanz-Guard
  // verhindert Rucke bei bloßem Tab-Geflacker; im AR-Player-Modus (Kamera
  // hat parent) ist nichts zu tun.
  const snapCameraToPlayerIfFar = (minM = 25) => {
    try {
      const cam = scene?.activeCamera
      if (!player?.root || !cam || cam.parent) return
      player.root.computeWorldMatrix(true)
      if (BABYLON.Vector3.Distance(cam.position, player.root.absolutePosition) > minM) {
        focusCameraOn(scene, player)
      }
    } catch { /* Komfort-Feature — nie fatal */ }
  }
  // Erster ECHTER Fix (weder Dummy noch die gemerkte Startposition): der
  // Spieler springt vom Boot-Origin zur GPS-Position — die Kamera einmalig
  // hinterher (kurz verzögert, damit die Spieler-Position schon angewendet ist).
  const BOOT_QUELLEN = new Set(['dummy', 'last'])
  let _snappedToRealFix = false
  positionSource.onPosition?.((p) => {
    if (_snappedToRealFix || !p || BOOT_QUELLEN.has(p.source)) return
    _snappedToRealFix = true
    setTimeout(() => snapCameraToPlayerIfFar(), 500)
  })
  window.arResume = () => {
    engine.runRenderLoop(renderLoop); engine.resize()
    arPassthrough.resume?.().catch(() => {})
    snapCameraToPlayerIfFar()   // Ansichtswechsel: Kamera übernimmt die Karten-/GPS-Position
  }
  // App minimiert + wieder geöffnet: Android gibt die Kamera im Hintergrund frei
  // (Track endet). Beim Zurückkehren die Kamera neu holen — greift auch für die
  // Standalone-AR-Seite (Chrome-Tab versteckt/aktiv), da resume() sonst no-op ist.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) arPassthrough.resume?.().catch(() => {})
  })
  
  // Shared Editor UI im AR-Modus.
  // Kein onObjectsUpdated-Callback — die Szene wird über einen eigenen
  // ajnaManager-Listener weiter unten gepflegt, damit hier keine
  // Re-Entry-Schleife über EditorUI -> loadObjects -> emitObjectsChanged
  // entsteht.
  const uiContainer = document.getElementById('ui')
  const groupDialog = new GroupDialog({ ajna: ajnaManager })
  // Server-Profil: Karma, Standort-Freigabe und Verwaltung eines Servers.
    const serverProfile = new ServerProfile({
    ajna: ajnaManager,
  })
  const serverDialog = new ServerDialog({ ajna: ajnaManager , onDetails: (id) => serverProfile.open(id) })
  const profileDialog = new ProfileDialog({ ajna: ajnaManager })
  // Reuse the shell's shared AgentFilters when embedded (consistent layer
  // selection across map + AR); create one only when standalone.
  const agentFilters = window.agentFilters || new AgentFilters(ajnaManager)
  const filterDialog = new FilterDialog({ ajna: ajnaManager, filters: agentFilters })
  _agentFilters = agentFilters       // sichtbar für syncSceneObjects
  window.agentFilters = agentFilters  // für Console-Debugging

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
    positionSource,   // Event-getriebenes Publishing (Erst-Fix / große Änderung / Dummy↔Live)
    getPosition: () => positionSource?.getWorldPosition?.() || null,
    getSources: () => agentFilters.getSources().map(s => s.source).filter(src => {
      const sel = agentFilters.getSelection(src)
      return sel === undefined || (Array.isArray(sel) && sel.length > 0)
    })
  })
  interestArea.start()

  // Stufe „Nähe": meldet Agents die Anwesenheit an ihrem Objekt — per Objekt-ID,
  // nie per Koordinate. Der Manager entscheidet pro Server, ob überhaupt etwas
  // rausgeht; der Reporter läuft unabhängig davon mit.
  const proximityReporter = new ProximityReporter({
    ajna: ajnaManager,
    positionSource,
    getPosition: () => positionSource?.getWorldPosition?.() || null
  })
  proximityReporter.start()

  // Stufe „Genau": eigene Anwesenheit als Objekt in der Welt, damit andere
  // Spieler einen sehen. Bewusst NUR bei „Genau" — die gröberen Stufen liefern
  // absichtlich keine Position, die man als Figur zeichnen könnte, ohne genau
  // das preiszugeben, was sie zurückhalten. Siehe core/PresenceService.js.
  const presence = new PresenceService({
    ajna: ajnaManager,
    getPosition: () => positionSource?.getWorldPosition?.() || null,
    getHeading: () => (typeof window.ajnaHeadingRad === 'number' ? window.ajnaHeadingRad : null),
  })
  presence.start()
  window.ajnaPresence = presence
  // Beim Verlassen der Seite aufräumen: Ohne das bliebe die letzte Position
  // stehen, bis sie veraltet — und das ist genau die Stelle, an der jemand
  // gesehen wird, der sich längst abgemeldet hat.
  window.addEventListener('pagehide', () => { try { presence.stop() } catch {} })
  // Manifeste selbst aktuell halten (Erst-Load deckt persistierte Session ab, wo
  // onAuthChanged nicht feuert) und die Area neu publishen, sobald die Quellen
  // geladen/geändert sind — sonst ginge sie ohne Quellen raus (Agents sehen sie nicht).
  agentFilters.onChange(() => interestArea.publishNow())
  agentFilters.startAutoRefresh()

  // Set after setupArOverlayControls below; called when the editor is engaged
  // (edit/create) so a minimized editor panel pops open.
  let _openArEditor = () => {}

  editorUI = new EditorUI({
    // Auftrags-Editor gehört der Mobile-Shell (sie hält das Quest-Panel). Ohne
    // Shell bleibt der Knopf im Editor verborgen.
    onQuestEditor: (rec) => window.ajnaQuestEditor?.(rec),
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
    onSaved: (obj, err) => {
      if (!_toast) _toast = new Toast()
      if (obj) _toast.show('Änderungen übernommen', { title: obj.name || 'Objekt' })
      else if (err) _toast.show('Speichern fehlgeschlagen', { title: 'Editor' })
    },
    // Open the editor panel when editing or creating an object (if minimized).
    onEditorActivate: () => _openArEditor(),
    onObjectSelected: obj => {
      // PB-Record → zugehöriges GameObject. Wenn die Szene das Objekt
      // noch nicht angelegt hat (z. B. vor abgeschlossenem syncSceneObjects),
      // ist focusCameraOn no-op — kein Crash, keine Fehlermeldung.
      const go = objectMap.get(obj.id)
      if (go) { focusCameraOn(scene, go); _toggleObjectGizmo(go) }
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

  // ── Editor-Gizmos: Objekt in 3D verschieben/drehen (Babylon GizmoManager) ──
  // Auswahl einer Objektzeile im Editor heftet Verschiebe-Pfeile + Y-Rotations-
  // Ring an das Objekt; dieselbe Zeile erneut wählen (oder Esc) löst sie wieder.
  // Während der Manipulation pausiert die Geo-Verankerung (sonst überschreibt
  // sie die Drag-Position pro Frame); am Drag-Ende wird die Pose in echte
  // Koordinaten zurückgerechnet und gespeichert (lat/lon/altitude/rotation).
  let _gizmoMgr = null, _gizmoGo = null
  const _gizmoSave = (kind) => {
    const go = _gizmoGo; if (!go) return
    const p = go.root.position
    const w = geo.toWorld(p.x, 0, p.z)
    const gc = go.getComponent?.(GeospatialComponent)
    const ref = gc?.altitudeRef || 'ground'
    // Umkehrung von GeoTransformer.toLocalRef — beide Richtungen müssen exakt
    // zueinander passen, sonst wandert das Objekt bei jedem Speichern:
    //   ground: y = Geländehöhe(lat,lon) + altitude   → altitude = y − Geländehöhe
    //   msl:    y = altitude − Bodenhöhe              → altitude = y + Bodenhöhe
    // Die Geländehöhe wird am ZIEL geholt, nicht am Ausgangspunkt: wer ein
    // Objekt einen Hang hinauf schiebt, ändert damit auch den Boden darunter.
    // Ohne diesen Abzug wurde die Geländehöhe bei jedem Speichern erneut
    // aufaddiert — im Tal sank das Objekt unter den Boden, am Hang stieg es auf.
    const alt = ref === 'msl'
      ? (Number.isFinite(geo.groundAltitude) ? geo.groundAltitude : (geo.origin?.altitude || 0)) + p.y
      : p.y - geo.terrainHeightAt(w.lat, w.lon)
    const rq = go.root.rotationQuaternion
    const e = rq ? rq.toEulerAngles() : go.root.rotation
    const rot = { x: e.x, y: e.y, z: e.z }
    const s = go.root.scaling
    const scl = { x: s.x, y: s.y, z: s.z }
    // Lokal sofort übernehmen (kein Zurückschnappen nach dem Lösen, bis das
    // Server-Echo eintrifft): Geo-Anker + Smoother mit der neuen Pose füttern.
    gc?.setCoordinates?.(w.lat, w.lon, alt, ref)
    go._smoother?.feed?.({ lat: w.lat, lon: w.lon, altitude: alt, rotation: rot })
    ajnaManager.updateObject(go.id, { lat: w.lat, lon: w.lon, altitude: alt, rotation: rot, scale: scl })
      .then(() => { if (!_toast) _toast = new Toast(); _toast.show(`${kind} gespeichert`, { title: go.name || 'Objekt' }) })
      .catch(err => { if (!_toast) _toast = new Toast(); _toast.show('Speichern fehlgeschlagen: ' + (err?.message || err), { title: 'Editor' }) })
  }
  const _detachGizmo = () => {
    if (!_gizmoMgr || !_gizmoGo) return
    const r = _gizmoGo.root
    // RotationGizmo arbeitet auf rotationQuaternion; danach zurück auf Euler,
    // sonst ignoriert Babylon künftige .rotation-Schreiber (Server-Updates).
    if (r.rotationQuaternion) { r.rotation.copyFrom(r.rotationQuaternion.toEulerAngles()); r.rotationQuaternion = null }
    _gizmoGo.transformPaused = false
    const gc = _gizmoGo.getComponent?.(GeospatialComponent); if (gc) gc.paused = false
    _gizmoMgr.attachToNode(null)
    _gizmoGo = null
  }
  const _toggleObjectGizmo = async (go) => {
    if (!go) return
    if (_gizmoGo === go) { _detachGizmo(); return }   // dasselbe Objekt erneut → fertig
    // Berechtigung VOR dem Einblenden prüfen: Besitzer ODER User-/Gruppen-ACE
    // mit edit/move/owner-Recht (myRights fragt den effective_permissions-
    // Cache — dieselben Fälle, die die Server-Regel objects.updateRule erlaubt).
    const rec = ajnaManager.objectMap.get(go.id) || ajnaManager.getObjectById?.(go.id)
    const cli = ajnaManager.clients?.get(rec?._origin) || ajnaManager.defaultClient
    const me = cli?.currentUser?.()
    let allowed = !!(me && rec?.owner && me.id === rec.owner)
    if (!allowed && me && rec) {
      const r = await ajnaManager.myRights?.(go.id)?.catch?.(() => null)
      allowed = !!(r?.rights || []).some(x => x === 'edit' || x === 'move' || x === 'owner')
    }
    if (!allowed) {
      if (!_toast) _toast = new Toast()
      _toast.show(!me ? 'Bitte einloggen — Objekt-Werkzeuge erfordern Bearbeitungsrechte.'
        : 'Keine Berechtigung: Verschieben erfordert Besitz oder ein edit/move-Recht.', { title: go.name || 'Objekt' })
      return
    }
    if (!_gizmoMgr) {
      _gizmoMgr = new BABYLON.GizmoManager(scene)
      _gizmoMgr.usePointerToAttachGizmos = false      // nur explizit (Editor/STRG+Klick/Menü)
      _gizmoMgr.positionGizmoEnabled = true
      _gizmoMgr.rotationGizmoEnabled = true
      _gizmoMgr.scaleGizmoEnabled = true              // Achsen-Griffe = je Achse, Zentrum-Würfel = proportional
      const gz = _gizmoMgr.gizmos
      if (gz.rotationGizmo) { gz.rotationGizmo.xGizmo.isEnabled = false; gz.rotationGizmo.zGizmo.isEnabled = false }  // nur Yaw
      gz.positionGizmo?.onDragEndObservable.add(() => _gizmoSave('Position'))
      gz.rotationGizmo?.onDragEndObservable.add(() => _gizmoSave('Rotation'))
      gz.scaleGizmo?.onDragEndObservable.add(() => _gizmoSave('Skalierung'))
      window.addEventListener('keydown', ev => { if (ev.key === 'Escape') _detachGizmo() })
    }
    _detachGizmo()
    // Live-Anzeige während des Drags: Smoother pausieren (er würde root.rotation
    // pro Frame mit dem alten Wert überschreiben) + Quaternion-Modus erzwingen
    // (der Ring arbeitet darauf; ohne Quaternion griffe er ins Leere).
    go.transformPaused = true
    const gc = go.getComponent?.(GeospatialComponent); if (gc) gc.paused = true
    if (!go.root.rotationQuaternion) go.root.rotationQuaternion = BABYLON.Quaternion.FromEulerVector(go.root.rotation)
    _gizmoMgr.attachToNode(go.root)
    _gizmoGo = go
    if (!_toast) _toast = new Toast()
    _toast.show('Pfeile = verschieben · Ring = drehen · Würfel außen = Achse skalieren, Mitte = proportional. Daneben klicken/Esc = fertig.', { title: go.name || 'Objekt' })
  }

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
  // removed when no orientation/origin (e.g. pointing mode 'disabled'). 5-m-
  // Zeiger (kurz, reicht zur Richtungsanzeige); färbt sich GRÜN, sobald ein
  // Objekt anvisiert wird (zusätzlich zum Objekt-Highlight via onTarget oben).
  const WAND_RAY_M = 5
  let _wandRay = null
  wand.onOrientation(() => {
    const dir = wand.getPointingDirection()
    const origin = wand.getOrigin?.()
    if (!dir || !origin || !Number.isFinite(origin.lat) || !geo.origin) {
      if (_wandRay) { _wandRay.dispose(); _wandRay = null }
      return
    }
    const end = rayEndpointWgs84(origin, dir, WAND_RAY_M)
    const pts = [
      geo.toLocalRef(origin.lat, origin.lon, origin.altitude || 0, 'msl'),
      geo.toLocalRef(end.lat, end.lon, end.altitude, 'msl')
    ]
    _wandRay = BABYLON.MeshBuilder.CreateLines('wandRay',
      { points: pts, updatable: true, instance: _wandRay || undefined }, scene)
    _wandRay.color = _wandHiId
      ? new BABYLON.Color3(0.2, 1.0, 0.4)   // Treffer → grün
      : new BABYLON.Color3(0.3, 0.8, 1.0)   // kein Treffer → cyan
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
    // Kontextmenü „Verschieben/Drehen" → Gizmo an das Objekt heften.
    onGizmo: (record) => {
      const go = objectMap.get(record.id)
      if (go) { focusCameraOn(scene, go); _toggleObjectGizmo(go) }
    },
    // „Sprechen" öffnet den Privatchat im Verlaufsfenster. Das Panel gehört der
    // Mobile-Shell; dieses Bündel erreicht es über den Haken window.ajnaTalkTo.
    // Ohne Shell (eigenständige Seite) passiert nichts — die Figur antwortet
    // trotzdem, das Panel übernimmt das Gespräch dann beim ersten Satz.
    onTalk: (record) => window.ajnaTalkTo?.(record),
    // Für Aktionen wie „Rufen": exakte Position, die ObjectActions je nach
    // Privatsphäre-Stufe vergröbert oder gar nicht mitschickt.
    getPosition: () => positionSource?.getWorldPosition?.() || null,
    // Tap-Menü-Interaktion → gleiches Feedback wie der XR-/Wand-Pfad
    // (Reply-Toast + Highlight-Puls + TTS-Ansage).
    onInteract: (record, key) => _showInteractFeedback(record.id, key),
    // Server hat die Wirkung abgelehnt → Grund zeigen statt Erfolg vortäuschen.
    onInteractError: (record, key, message) => {
      if (!_toast) _toast = new Toast()
      _toast.show(message || 'Aktion nicht möglich', { title: record?.name || 'Aktion' })
    }
  })

  // Quick-Actions: die ersten drei Interaktionen des anvisierten ODER gelockten
  // Objekts als Knöpfe am rechten Rand (3D + AR). Aktionsliste und Auslösen
  // kommen aus ObjectActions — dieselbe Quelle wie das Kontextmenü.
  const quickActions = new QuickActions({
    parent: arRoot,
    getActions: (rec) => objectActions.actionsFor(rec),
    onAction: (rec, key) => objectActions.trigger(rec, key),
  })
  // Ein gelocktes Objekt hat Vorrang und bleibt stehen, auch wenn der Blick
  // weiterwandert — genau dafür ist der Lock da.
  let _qaLocked = null
  const _quickFocus = (record) => { if (!_qaLocked) quickActions.setTarget(record || null) }

  // Desktop-3D (Freiflug): Maus-Hover ist dort das „Anvisieren" — der Gaze-Pfad
  // greift nur in AR/XR. Touch/Drag liefert das Hover-System bewusst nichts.
  _onHoverFocus = (go) => _quickFocus(go?.id ? (ajnaManager.getObjectById?.(go.id) || null) : null)

  // Fokus-Quellen: Zauberstab-Ziel + Lock. Die Gaze-Pfade (immersives XR und
  // Handy-AR) speisen weiter unten zusätzlich ein.
  wand.onTarget((t) => _quickFocus(t?.id ? ajnaManager.getObjectById?.(t.id) : null))
  wand.onLock((o) => {
    _qaLocked = o?.id ? (ajnaManager.getObjectById?.(o.id) || null) : null
    // Beim Entsperren übernimmt wieder der Blick (nächster Gaze-/Ziel-Tick).
    quickActions.setTarget(_qaLocked)
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
  // Touch-Selektion mit Toleranz (analog zum Stab-Zeigemodus): weit entfernte
  // Objekte projizieren winzig, ein exakter Ray-Pick geht daneben. Fällt der
  // exakte Pick aus, wählen wir das Objekt, dessen projiziertes Zentrum dem Tap
  // am nächsten liegt (innerhalb eines Fingerradius). Tie-Break: klar näher am
  // Tap gewinnt; bei ~gleicher Bildschirm-Nähe das dem Spieler nähere Objekt.
  const TOUCH_TOLERANCE_CSS = 44   // Fingerradius in CSS-Pixeln
  const SCREEN_TIE_BAND = 14       // "gleich nah am Tap" (CSS-px) → Weltnähe entscheidet

  const objectWorldCenter = (root) => {
    try {
      const { min, max } = root.getHierarchyBoundingVectors(true)
      if (min && max && Number.isFinite(min.x) && Number.isFinite(max.x)) {
        return BABYLON.Vector3.Center(min, max)
      }
    } catch { /* leere Hierarchie → Fallback unten */ }
    return root.getAbsolutePosition ? root.getAbsolutePosition() : root.position
  }

  const pickGameObjectTolerant = (px, py) => {
    const cam = scene.activeCamera
    if (!cam) return null
    const rw = engine.getRenderWidth(), rh = engine.getRenderHeight()
    // pointerX/Y + Vector3.Project liegen im Render-Pixel-Raum; Toleranz in
    // CSS-px → mit dem Render/CSS-Verhältnis skalieren (DPI-unabhängig).
    const dpr = rw / (canvas.clientWidth || rw)
    const tol = TOUCH_TOLERANCE_CSS * dpr
    const band = SCREEN_TIE_BAND * dpr
    const vp = cam.viewport.toGlobal(rw, rh)
    const transform = scene.getTransformMatrix()
    const camPos = cam.globalPosition
    const fwd = cam.getForwardRay().direction
    const hits = []
    objectMap.forEach(go => {
      const root = go?.root
      if (!root || (root.isEnabled && !root.isEnabled())) return
      const pos = objectWorldCenter(root)
      if (!pos) return
      if (BABYLON.Vector3.Dot(pos.subtract(camPos), fwd) <= 0) return   // hinter der Kamera
      const proj = BABYLON.Vector3.Project(pos, BABYLON.Matrix.Identity(), transform, vp)
      if (!Number.isFinite(proj.x) || !Number.isFinite(proj.y)) return
      const screenDist = Math.hypot(proj.x - px, proj.y - py)
      if (screenDist > tol) return
      hits.push({ go, screenDist, worldDist: BABYLON.Vector3.Distance(camPos, pos) })
    })
    if (!hits.length) return null
    hits.sort((a, b) =>
      Math.abs(a.screenDist - b.screenDist) > band
        ? a.screenDist - b.screenDist    // klar näher am Tap gewinnt (exakter getroffen)
        : a.worldDist - b.worldDist)      // ~gleich nah → das dem Spieler nähere
    return hits[0].go
  }

  // Bildschirmpunkt → Boden-GPS (Ray gegen die y=0-Ebene). Für Inventar-
  // Platzieren (Tipp) und Drag&Drop.
  const _groundGeoAt = (px, py) => {
    if (!geo.origin) return null
    const ray = scene.createPickingRay(px, py, BABYLON.Matrix.Identity(), scene.activeCamera)
    const groundPlane = BABYLON.Plane.FromPositionAndNormal(BABYLON.Vector3.Zero(), new BABYLON.Vector3(0, 1, 0))
    const dist = ray.intersectsPlane(groundPlane)
    if (dist === null || dist < 0) return null
    const point = ray.origin.add(ray.direction.scale(dist))
    return geo.toWorld(point.x, point.y, point.z)
  }

  // Inventar-Platzieren: Tipp-Modus (nächster Tap legt das gewählte Objekt ab).
  let _placingRecord = null
  const _placeRecordAt = async (rec, geoPos) => {
    if (!rec || !geoPos) return
    try { await ajnaManager.place(rec.id, { lat: geoPos.lat, lon: geoPos.lon, altitude: 0 }) }
    catch (err) {
      if (!_toast) _toast = new Toast()
      _toast.show('Platzieren fehlgeschlagen: ' + (err?.response?.error || err?.message || err), { title: 'Platzieren' })
    }
  }

  // In der Mobile-Shell stellt map.js bereits ein GLOBALES Inventar (body-FAB,
  // in allen Tabs sichtbar) — dort kein zweites erzeugen, sonst überlappen zwei
  // identische Buttons. Nur die Standalone-AR-Seite braucht ein eigenes.
  const _inShell = !!document.querySelector('.shell-tabbar')
  const inventory = _inShell ? null : new InventoryUI({
    ajna: ajnaManager,
    editorUI,
    container: document.querySelector('.shell-view[data-view="ar"]') || document.body,
    onExamine: (rec) => {
      if (!_toast) _toast = new Toast()
      _toast.show(interactionReply(rec, 'examine', rec.name), { title: rec.name || 'Objekt' })
      _announcer?.interaction(rec, 'examine')
    },
    onPlace: (rec) => {
      _placingRecord = rec
      if (!_toast) _toast = new Toast()
      _toast.show(`Tippe in die Szene, um „${rec.name || 'Objekt'}" abzulegen`, { title: 'Platzieren' })
    },
    getDevices: () => inventoryDevices(accessories),
  })
  accessories.wand?.onStatusChange?.(() => inventory?.refresh())
  accessories.uwb?.onStatusChange?.(() => inventory?.refresh())

  // ── Minimap ──────────────────────────────────────────────────────────────
  // Anders als das Inventar wird sie IMMER hier erzeugt (auch in der Shell):
  // sie gehört ausschließlich zur 3D-Ansicht und hängt deshalb in arRoot — in
  // der Kartenansicht ist der Container ausgeblendet, damit auch die Minimap.
  //
  // Blickrichtung als echter Kompasskurs: statt aus den lokalen Achsen
  // zurückzurechnen, projizieren wir Kameraposition UND einen Punkt 50 m
  // davor durch DIESELBE Geo-Transformation. Damit stimmt der Kurs auch mit
  // `invertNorthSouth`/`invertEastWest` (der AR-Client läuft nord-süd-gespiegelt).
  // Läuft im Bildtakt der Minimap → wiederverwendeter Ray statt einer neuen
  // Allokation pro Bild.
  const _mmRay = new BABYLON.Ray(BABYLON.Vector3.Zero(), BABYLON.Vector3.Zero(), 1)
  const _minimapView = () => {
    const cam = scene.activeCamera
    if (!cam || !geo.origin) return null
    const p = cam.globalPosition
    const here = geo.toWorld(p.x, 0, p.z)
    let heading
    const dir = cam.getForwardRayToRef ? cam.getForwardRayToRef(_mmRay, 1).direction
      : cam.getForwardRay?.(1)?.direction
    if (dir && Math.hypot(dir.x, dir.z) > 1e-4) {   // nicht senkrecht nach oben/unten
      const ahead = geo.toWorld(p.x + dir.x * 50, 0, p.z + dir.z * 50)
      const lat = here.lat * Math.PI / 180
      heading = (Math.atan2((ahead.lon - here.lon) * Math.cos(lat), ahead.lat - here.lat)
        * 180 / Math.PI + 360) % 360
    }
    // Höhe ÜBER GRUND, nicht über dem Geo-Ursprung: die Minimap leitet daraus
    // ihre Zoomstufe ab, und über einem Berg soll sie nicht weiter aufziehen
    // als über der Ebene. Ohne Gelände ist terrainHeightAt 0 — dann ist es
    // schlicht die Kamerahöhe.
    const grund = geo.terrainHeightAt?.(here.lat, here.lon) ?? 0
    const hoehe = Math.max(0, p.y - (Number.isFinite(grund) ? grund : 0))
    return { lat: here.lat, lon: here.lon, heading, hoehe }
  }
  // Kamerablick für die Minimap bereitstellen. In der Shell GEHÖRT die Minimap
  // nicht mehr hierher: sie soll auch im Objekte-Tab erscheinen, und der lädt
  // dieses Bündel womöglich nie. Dort baut MobileShell sie und holt sich den
  // Blick über diesen Haken — sobald die 3D-Szene existiert, folgt die Karte
  // der Kamera, vorher der GPS-Position.
  window.ajnaCameraView = _minimapView
  const minimap = _inShell ? null : new Minimap({
    container: arRoot,
    getView: _minimapView,
    getObjects: () => ajnaManager.getObjects(),
    filters: agentFilters,
    serverNameFor: (rec) => isMultiServer(ajnaManager)
      ? serverLabelFor(ajnaManager, rec?._origin) : null,
  })

  // ── Diagnose ───────────────────────────────────────────────────────────
  // `ajnaDiag()` in der Browser-Konsole vergleicht, was die 3D-Szene ZEIGT,
  // mit dem, was der Datensatz SAGT. Gedacht für den Fall „Figur heisst in AR
  // anders als auf der Karte": die Antwort ist entweder „die Szene stellt
  // Objekte versetzt dar" (Abstand > 0) oder „die Szene ist korrekt, es sind
  // schlicht zwei verschiedene Objekte" (alle Abstände ≈ 0).
  window.ajnaDiag = (maxZeilen = 20) => {
    const raus = []
    for (const [id, go] of objectMap) {
      const rec = ajnaManager.getObjectById(id)
      const p = go?.root?.position
      if (!rec || !p) { raus.push({ id, name: go?.name, hinweis: rec ? 'keine Position' : 'kein Datensatz' }); continue }
      const gezeigt = geo.toWorld(p.x, p.y, p.z)
      const dLat = (gezeigt.lat - rec.lat) * 111320
      const dLon = (gezeigt.lon - rec.lon) * 111320 * Math.cos(rec.lat * Math.PI / 180)
      raus.push({
        id, szene: go.name, datensatz: rec.name,
        nameGleich: go.name === rec.name,
        versatzM: +Math.hypot(dLat, dLon).toFixed(1),
        nordM: +dLat.toFixed(1), ostM: +dLon.toFixed(1),
      })
    }
    raus.sort((a, b) => (b.versatzM || 0) - (a.versatzM || 0))
    const schief = raus.filter(r => r.versatzM > 5 || r.nameGleich === false)
    console.log(`[ajnaDiag] ${raus.length} Objekte in der Szene, ${schief.length} auffällig`)
    console.table((schief.length ? schief : raus).slice(0, maxZeilen))
    const cam = scene.activeCamera?.globalPosition
    if (cam) console.log('[ajnaDiag] Kamera:', geo.toWorld(cam.x, cam.y, cam.z), 'Ursprung:', geo.origin)
    return raus
  }

  // Drag&Drop (Desktop): Item aus dem Inventar auf die AR-Szene ablegen.
  canvas.addEventListener('dragover', (e) => {
    if (Array.from(e.dataTransfer?.types || []).includes(DRAG_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }
  })
  canvas.addEventListener('drop', (e) => {
    const id = e.dataTransfer?.getData(DRAG_MIME)
    if (!id) return
    e.preventDefault()
    const rect = canvas.getBoundingClientRect()
    const geoPos = _groundGeoAt(e.clientX - rect.left, e.clientY - rect.top)
    const rec = ajnaManager.getObjectById(id)
    if (rec && geoPos) _placeRecordAt(rec, geoPos)
  })

  scene.onPointerObservable.add(eventData => {
    if (eventData.type !== BABYLON.PointerEventTypes.POINTERTAP) return

    // Inventar-Platzieren aktiv? Nächster Tap legt das Objekt auf den Boden.
    if (_placingRecord) {
      const geoPos = _groundGeoAt(scene.pointerX, scene.pointerY)
      const rec = _placingRecord
      _placingRecord = null
      if (geoPos) _placeRecordAt(rec, geoPos)
      return
    }

    // Wenn der Tap einen In-World-Button getroffen hat: hier nichts mehr
    // tun. InWorldActionMenu setzt skipNextObservers, aber wir prüfen
    // zusätzlich den raw-Pick, falls Observer-Reihenfolge mal wechselt.
    const rawPick = scene.pick(scene.pointerX, scene.pointerY)
    if (rawPick?.pickedMesh?.metadata?.isActionButton) return

    // UWB-Anker-Beacon angetippt (Debug-Overlay sichtbar)? → Editor öffnen
    // (präzise Position/Node-ID/mm-Koords bearbeiten).
    const anchorMesh = scene.pick(scene.pointerX, scene.pointerY, m => !!m.metadata?.uwbAnchorId)?.pickedMesh
    if (anchorMesh?.metadata?.uwbAnchorId) {
      const rec = ajnaManager.getObjectById(anchorMesh.metadata.uwbAnchorId)
      if (rec) { editorUI?.fillEditor(rec); return }
    }

    // Nur GameObject-Meshes — GUI-Panel selbst aussortieren, sonst klickt
    // ein Button im Menü auf "sein eigenes" Objekt-Mesh und öffnet erneut.
    const pickInfo = scene.pick(scene.pointerX, scene.pointerY,
      mesh => !!mesh.metadata?.gameObject
    )
    let go = pickInfo?.hit ? pickInfo.pickedMesh?.metadata?.gameObject : null
    // Exakter Pick daneben (kleines/fernes Objekt)? → toleranter Fallback.
    if (!go) go = pickGameObjectTolerant(scene.pointerX, scene.pointerY)

    // Gizmo-Abwahl: Klick auf Luft/Boden/ein ANDERES Objekt löst die Auswahl.
    if (_gizmoGo && go !== _gizmoGo) _detachGizmo()
    if (!go?.name) return

    const record = ajnaManager.objectMap.get(go.id)
    if (!record) return

    // STRG+Klick: Objekt fokussieren + Gizmo anheften (statt Menü/Aktionen).
    if (eventData.event?.ctrlKey) { focusCameraOn(scene, go); _toggleObjectGizmo(go); return }

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
    // Zuerst gegen das GELÄNDE picken (isPickable=true) — am Hang liegt der
    // getroffene Punkt sonst meterweit daneben, weil die gedachte Ebene y=0
    // den Boden dort gar nicht trifft. Ohne Relief: Ebene wie bisher.
    let point = null
    const terrainHit = terrain.mesh
      ? scene.pickWithRay(ray, m => m === terrain.mesh)
      : null
    if (terrainHit?.hit && terrainHit.pickedPoint) {
      point = terrainHit.pickedPoint
    } else {
      const groundPlane = BABYLON.Plane.FromPositionAndNormal(
        BABYLON.Vector3.Zero(), new BABYLON.Vector3(0, 1, 0)
      )
      const dist = ray.intersectsPlane(groundPlane)
      if (dist === null || dist < 0) return
      point = ray.origin.add(ray.direction.scale(dist))
    }
    const geoPos = geo.toWorld(point.x, point.y, point.z)
    // Höhe für neue Objekte: 0 = AUF dem Boden. Seit das Relief die
    // AGL-Referenz stellt (GeoTransformer.toLocalRef), setzt der Renderer das
    // Objekt damit automatisch auf die reale Geländehöhe an dieser Stelle.
    const spawnAlt = 0

    contextMenu.show({
      x: ev.clientX,
      y: ev.clientY,
      title: `${geoPos.lat.toFixed(5)}, ${geoPos.lon.toFixed(5)}`,
      items: [
        {
          label: 'Neues Objekt…',
          disabled: !ajnaManager.isLoggedIn(),
          onClick: () => editorUI.startNewObjectAt(geoPos.lat, geoPos.lon, spawnAlt)
        },
        {
          label: 'Zufälliges Objekt (mir gehörend)…',
          disabled: !ajnaManager.isLoggedIn(),
          onClick: () => spawnRandomAndEdit({
            ajna: ajnaManager, editorUI, announcer: _announcer,
            position: { lat: geoPos.lat, lon: geoPos.lon, altitude: spawnAlt }
          }).catch(err => {
            if (!_toast) _toast = new Toast()
            _toast.show(err?.message || 'Spawn fehlgeschlagen', { title: 'Spawn' })
          })
        },
        // Vom World-Director erzeugen lassen → gehört ihm, bewegt sich auch.
        ...directorSpawnItems({
          ajna: ajnaManager, position: { lat: geoPos.lat, lon: geoPos.lon },
          enabled: ajnaManager.isLoggedIn(),
          notify: msg => { if (!_toast) _toast = new Toast(); _toast.show(msg, { title: 'Spawn' }) }
        })
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
    // Weit reichender Gaze-Ray (200 km statt 100 m), damit auch ferne Flugzeuge
    // anvisierbar sind. pickWithRay liefert den NÄCHSTEN Treffer — nahe Objekte
    // gewinnen also weiterhin; die größere Länge kostet nichts.
    const ray = cam.getForwardRay(200000)
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
      _quickFocus(record || null)
    } else {
      _announcer?.target(null)
      inWorldMenu.hide()
      _quickFocus(null)
    }
  })

  // Magic-Window-AR (Handy, KEIN immersives XR): Fokus per Kamera-Forward-Ray →
  // Objekt-Aura (Call-Out) + Zielansage. Getrennt vom Tap (der öffnet Aktionen).
  // Immersives XR nutzt oben das In-World-Menü; darum hier auf !inXR beschränkt.
  // Drosselt sich selbst (pickWithRay ist O(meshes)); Reticle zeigt den Fokuspunkt.
  let _auraGO = null
  let _auraTick = 0
  scene.onBeforeRenderObservable.add(() => {
    const inXR = _xrExperience?.baseExperience?.state === BABYLON.WebXRState.IN_XR
    if (inXR || !_compassActive) {
      if (_auraGO) { setHighlight(_auraGO, false); _auraGO = null; objectAura.setTarget(null); _announcer?.target(null) }
      return
    }
    if (++_auraTick % 10 !== 0) return
    const cam = scene.activeCamera
    if (!cam) return
    // Fokus: erst exakter Forward-Ray, dann DERSELBE tolerante Screen-Pick wie
    // beim Tap — um die Bildmitte (Reticle). So greift unscharfes Zielen genauso
    // (gleiche TOUCH_TOLERANCE_CSS, gleiche „näher gewinnt"-Logik).
    const pick = scene.pickWithRay(cam.getForwardRay(100), m => !!m.metadata?.gameObject)
    let next = (pick?.hit && pick.pickedMesh?.metadata?.gameObject?.name)
      ? pick.pickedMesh.metadata.gameObject : null
    if (!next) {
      const vp = cam.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight())
      next = pickGameObjectTolerant(vp.x + vp.width / 2, vp.y + vp.height / 2)
    }
    if (next && !next.name) next = null
    // Reichweite: nur Objekte innerhalb _auraRangeM (Meter) fokussieren —
    // AUSSER Flugzeuge (ADS-B). Die sind naturgemäß weit oben/weg; man zielt
    // bewusst in den Himmel, um eines zu greifen, darum kein Nah-Reichweitentor.
    if (next) {
      const rec = ajnaManager.objectMap.get(next.id)
      const farOk = rec?.type === 'aircraft' || !!rec?.state?.adsb
      const c = objectWorldCenter(next.root)
      if (!c || (!farOk && BABYLON.Vector3.Distance(cam.globalPosition, c) > _auraRangeM)) next = null
    }
    // Fokuswechsel: Highlight + Zielansage nur bei Wechsel umschalten.
    if (next !== _auraGO) {
      if (_auraGO) setHighlight(_auraGO, false)
      _auraGO = next
      if (_auraGO) {
        setHighlight(_auraGO, true)
        _announcer?.target(ajnaManager.objectMap.get(_auraGO.id) || _auraGO.id)
      } else {
        _announcer?.target(null)
      }
    }
    // Aura JEDEN Tick mit dem Live-Record speisen (Signatur-Dedup in setTarget
    // verhindert Rebuilds) → Status-Wechsel am fokussierten Call wird sofort sichtbar.
    const liveRec = _auraGO ? (ajnaManager.objectMap.get(_auraGO.id) || null) : null
    objectAura.setTarget(liveRec)
    _quickFocus(liveRec)   // Quick-Actions am rechten Rand (gleiche Dedup-Logik)
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
  }, 1000))

  // Fast-Path für den HÄUFIGEN Fall: reine Transform-Updates (Position/Rotation/
  // Animation) eines bereits gerenderten Objekts gehen DIREKT in dessen Smoother —
  // ohne den vollen syncSceneObjects-Reconcile (O(N) über alle Objekte: Filter +
  // Budget-Culling + applyData). Der Director schreibt ~32 solcher Updates/s; ein
  // voller Reconcile pro Update sättigte den Main-Thread ('objects/*' handler bis
  // 1147ms). Strukturelle Änderungen (neu/gelöscht/Appearance/getragen) übernimmt
  // der gedrosselte Reconcile oben (jetzt 1s statt 250ms, da Transforms hier laufen).
  ajnaManager.onObjectEvent((rec, action) => {
    if (action !== 'update' || rec.carried_by) return
    const go = objectMap.get(rec.id)
    if (go && go._appearanceSig === JSON.stringify(rec.appearance ?? null)) {
      try { go.applyData(rec, geo) } catch { /* Reconcile fängt es */ }
    }
  })
  // Erstes Reconcile awaiten → Objekt-Platzhalter stehen, bevor der Ladescreen
  // weicht (Modelle tauschen sich danach unauffällig an Ort und Stelle ein).
  await syncSceneObjects(scene, world, geo, ajnaManager.getObjectList())

  // UWB-Anker-Debug-Overlay: 3D-Marker (Beacon + Höhen-Pfeiler + Label) an der
  // echten Anker-Position. Umschaltbar (Einstellungen). refresh() ist strukturell
  // gegated (Signatur), daher pro onObjectsChanged günstig.
  const uwbAnchors = new UwbAnchorOverlay({ scene, geo, ajna: ajnaManager })
  window.uwbAnchorOverlay = uwbAnchors
  ajnaManager.onObjectsChanged(() => uwbAnchors.refresh())
  uwbAnchors.refresh()
  window.addEventListener('ajna:uwb-anchors', e => uwbAnchors.setVisible(!!e.detail))

  // Marker-Vorschau: Bild-Marker (Datum am Ajna-Objekt: obj.marker = {image,
  // widthM, heightM?, headingDeg?, alt?}) als originalgetreue Fläche an ihrer
  // realen Geo-Pose. Umschaltbar (Event 'ajna:markers' / ?markers=0). window.ajnaMarkers
  // erlaubt Test-Marker ohne Objekt/Backend.
  // Objekt-Marker (state.marker) rendern jetzt direkt als Objekt-Platzhalter
  // (flacher texturierter Quader, siehe GameObject.#createPlaceholder). MarkerPreview
  // bleibt nur für Test-Marker OHNE Objekt (window.ajnaMarkers) — z. B. ohne Backend.
  const markerPreview = new MarkerPreview({ scene, geo })
  window.markerPreview = markerPreview
  const _refreshMarkers = () => markerPreview.set(Array.isArray(window.ajnaMarkers) ? window.ajnaMarkers : [])
  _refreshMarkers()
  window.addEventListener('ajna:markers', e => markerPreview.setVisible(!!e.detail))
  window.setAjnaMarkers = (arr) => { window.ajnaMarkers = arr; _refreshMarkers() }   // Test-Helfer
  markerPreview.setVisible(!/[?&]markers=0\b/.test(location.search))

  // Marker-Tracking: registriert state.marker-Objekte im Umkreis als Bild-
  // Targets (25 m, Hysterese, max 8 — siehe MarkerTracking.js), zeichnet das
  // Erkennungs-Overlay und liefert den frame-lokalen Metrik-Snap. Unabhängig
  // von SLAM schaltbar (?marker=0/1) — für Lastdiagnose + Marker-only-Betrieb.
  // Immer instanziieren (Laufzeit-Umschaltung braucht die Instanz); enabled
  // spiegelt den aktuellen „Tracking: Marker"-Modus.
  markerTracking = new MarkerTracking({
    worldTracker, geo, appCanvas: canvas,
    getPlayerLocal: () => player?.root?.position || null,
    getRecordName: (id) => ajnaManager.getObjectById?.(id)?.name || id,
  })
  markerTracking.enabled = MARKERS_ENABLED
  window.markerTracking = markerTracking   // Konsole: ajnaMarkerCfg.radiusM etc.
  ajnaManager.onObjectsChanged(() => markerTracking.refresh(ajnaManager.getObjectList()))
  markerTracking.refresh(ajnaManager.getObjectList())

  // ── Distanz-basierter Perf-Pass („LOD light") ────────────────────────────
  // Alle 2 s: Schattenwurf und Skelett-Animationen nur für NAHE Objekte —
  // beides sind die teuersten Posten pro Figur (Shadow-Map-Renderpass bzw.
  // Bone-Matrizen pro Frame). Ferne Objekte bleiben sichtbar, werfen aber
  // keinen Schatten und stehen still (fällt jenseits der Radien nicht auf).
  // Live tunebar: ajnaPerf.shadowRadiusM (0 = aus). Die Animations-Distanz
  // kommt aus den Einstellungen (RANGE_DEFS.anim) und wird zusätzlich mit der
  // Größe der Figur gestreckt — ein Drache in 200 m ist noch bildfüllend,
  // ein Fuchs dort ein Punkt.
  const perfCfg = { shadowRadiusM: 40 }
  window.ajnaPerf = perfCfg

  // Höhe einer Figur, einmal gemessen und am Objekt gemerkt: Die Bounding-Box
  // je Objekt alle 2 s neu zu berechnen waere teurer als das, was der LOD-Pass
  // einspart.
  const figurHoehe = (go) => {
    if (Number.isFinite(go._hoeheM)) return go._hoeheM
    try {
      const { min, max } = go.root.getHierarchyBoundingVectors(true)
      const h = max.y - min.y
      if (Number.isFinite(h) && h > 0) { go._hoeheM = h; return h }
    } catch {}
    return 1.8
  }
  let animBasis = readRange('anim')
  window.addEventListener(RANGE_EVENT, () => { animBasis = readRange('anim') })
  setInterval(() => {
    const cam = scene.activeCamera
    if (!cam) return
    const cp = cam.globalPosition
    const sg = scene._ajnaShadowGenerator
    objectMap.forEach(go => {
      const p = go?.root?.getAbsolutePosition?.()
      if (!p) return
      const d = BABYLON.Vector3.Distance(cp, p)
      // Schatten nur nah (Caster aus der Shadow-Map nehmen, Mesh bleibt sichtbar).
      if (sg && go._castsShadow && go.meshes?.length && perfCfg.shadowRadiusM > 0) {
        const want = d <= perfCfg.shadowRadiusM
        const on = go._shadowOn !== false   // initial true (beim Load registriert)
        if (want && !on) { go.meshes.forEach(m => { try { sg.addShadowCaster(m) } catch {} }); go._shadowOn = true }
        else if (!want && on) { go.meshes.forEach(m => { try { sg.removeShadowCaster(m) } catch {} }); go._shadowOn = false }
      }
      // Animationen nur nah — NUR die gerade laufenden Groups pausieren und
      // exakt diese später fortsetzen (nicht alle starten: sonst liefen
      // plötzlich mehrere Clips gleichzeitig).
      if (go.animationGroups?.length && animBasis > 0) {
        const want = d <= animRadiusFuer(animBasis, figurHoehe(go))
        if (!want && !go._pausedAnims) {
          go._pausedAnims = go.animationGroups.filter(g => g.isPlaying)
          go._pausedAnims.forEach(g => { try { g.pause() } catch {} })
        } else if (want && go._pausedAnims) {
          go._pausedAnims.forEach(g => { try { g.play(true) } catch {} })
          go._pausedAnims = null
        }
      }
    })
  }, 2000)

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
  // Sichtweiten (gerätelokal, über die Einstellungen live änderbar).
  let _ranges = readAllRanges()
  _objectRangeM = _ranges.objects
  const osmContext = new OSMContext(scene, geo, window.ajnaGeo, { radius: _ranges.scenery })
  window.osm = osmContext

  // Geländerelief aus offenen Höhenkacheln — legt die Landschaft unter die
  // Szene (Rheintal, Hänge). Rein visuelle Kulisse: Objekte behalten ihre
  // eigene Höhe. Abschaltbar über die Debug-Ebene „Geländerelief".
  // Geladen wird zusammen mit der OSM-Kulisse (siehe _loadOSM), sobald der
  // Geo-Origin steht — die Kacheln brauchen selbst keinen Login.
  const terrain = new Terrain(scene, geo)
  terrain.setRadius(effectiveTerrain(_ranges))
  window.terrain = terrain

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
  const _loadOSM = async (lat = geo.origin?.lat, lon = geo.origin?.lon, { force = false } = {}) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
    // Relief ZUERST: Straßenbänder und Gebäudegrundrisse setzen darauf auf
    // (GeoTransformer.terrainHeightAt). Käme die Kulisse zuerst, klebte sie
    // auf der ebenen Startfläche und würde in Hänge schneiden.
    const c = terrain.center
    const moved = !c || Math.abs(c.lat - lat) > 1e-6 || Math.abs(c.lon - lon) > 1e-6
    const hadTerrain = terrain.isLoaded
    if (!hadTerrain || moved || force) {
      await terrain.load(lat, lon)
        .catch(err => console.warn('[terrain] load failed:', err?.message || err))
      // Bereits platzierte Objekte auf die neue Höhenreferenz nachziehen —
      // sie stünden sonst bis zu ihrem nächsten Realtime-Update in der Luft.
      if (terrain.isLoaded) {
        Promise.resolve(syncSceneObjects(scene, world, geo, ajnaManager.getObjectList()))
          .catch(() => {})
      }
    }
    // Die Drapierung steckt fest in den Kulissen-Vertices. Sie neu zu zeichnen,
    // nur weil das Relief umgezogen ist, wäre trotzdem verschwendet: der
    // Kachelsatz der Kulisse ist IMMER eine Teilmenge dessen des Reliefs —
    // gleiches z14-Raster, lon2tile ist monoton, und der Reliefradius wird über
    // `effectiveTerrain()` nie kleiner als der Kulissenradius gesetzt (siehe
    // core/renderRange.js). Die Höhen unter der Kulisse stehen beim Zeichnen
    // also bereits vollständig im Kachel-Cache. (Gilt, solange
    // TILE_Z === TERRAIN_Z.) Erzwungen wird nur der eine Fall, den das nicht
    // abdeckt: die Kulisse wurde flach gezeichnet, weil das Relief damals gar
    // nicht da war.
    // Fehler werden hier geloggt UND zurückgegeben: die meisten Aufrufer
    // interessiert nur, dass es weitergeht — die Kamera-Nachführung meldet einen
    // Ausfall dagegen an den Spieler, sonst steht er ratlos auf leerer Ebene.
    let fehler = null
    await osmContext.load(lat, lon, { force: force || (!hadTerrain && terrain.isLoaded) })
      .catch(err => { fehler = err; console.warn('[osm] load failed:', err?.message || err) })
    return { ok: !fehler, error: fehler }
  }

  // Aktuelle Kameraposition in WGS84 — Bezugspunkt für einen erzwungenen
  // Kulissen-/Relief-Neubau (die Kamera ist weiter als der Origin gewandert).
  const _sceneryCenter = () => {
    const p = scene.activeCamera?.globalPosition
    if (p && geo.origin) { const w = geo.toWorld(p.x, 0, p.z); if (Number.isFinite(w.lat)) return w }
    return terrain.center || osmContext.center || geo.origin || null
  }

  // Sichtweiten-Regler aus den Einstellungen — wirken sofort, ohne Neuladen.
  let _rangeReload = Promise.resolve()
  window.addEventListener(RANGE_EVENT, () => {
    const next = readAllRanges()
    const objektGrenzeNeu = next.objects !== _ranges.objects
    const kulisseNeu = next.scenery !== _ranges.scenery
    const reliefNeu = effectiveTerrain(next) !== effectiveTerrain(_ranges)
    _ranges = next
    _objectRangeM = next.objects

    if (objektGrenzeNeu) {
      Promise.resolve(syncSceneObjects(scene, world, geo, ajnaManager.getObjectList())).catch(() => {})
    }
    if (kulisseNeu || reliefNeu) {
      osmContext.radius = next.scenery
      terrain.setRadius(effectiveTerrain(next))
      const c = _sceneryCenter()
      // Serialisiert: zwei gleichzeitige Neubauten würden sich beim Abräumen
      // der Meshes in die Quere kommen.
      if (c) _rangeReload = _rangeReload
        .then(() => _loadOSM(c.lat, c.lon, { force: true }))
        .catch(err => console.warn('[range] Neuaufbau fehlgeschlagen:', err?.message || err))
    }
  })
  _loadOSM()
  ajnaManager.onAuthChanged(user => {
    if (user && !osmContext.isLoaded) _loadOSM(osmContext.center?.lat, osmContext.center?.lon)
  })

  // ── Kulisse folgt der Kamera ────────────────────────────────────────────
  // Ohne das hängen Relief und Kulisse für immer am Geo-Origin: 300 m Radius
  // Kulisse, 1200 m Relief — wer weiter fährt, schwebt über einer leeren
  // Ebene. Gleiches Muster wie die Interest-Areas der Agents, nur an die
  // Kamera gekoppelt statt an GPS (in XR ist die Kamera ohnehin der Spieler).
  //
  // Hysterese statt Dauer-Nachführung: ein Neuaufbau kostet ~230 ms Kulisse
  // plus Relief-Mesh, das darf nicht bei jedem Schritt passieren. Kein
  // Origin-Rebasing nötig — Babylon rechnet die Vertices in float32, bei
  // 10 km Abstand sind das noch ~1 mm Auflösung.
  const SCENERY_STEP_M = 400
  const SCENERY_POLL_MS = 2000
  // Darüber ist es kein Gehen mehr, sondern ein ORTSWECHSEL: typisch der
  // Moment beim Start, wenn der letzte bekannte Standort durch den ersten
  // echten GPS-Fix ersetzt wird. Dann darf die alte Kulisse nicht stehen
  // bleiben, bis irgendwann ein Nachbau fertig ist — sie zeigt sonst die
  // Häuser des vorigen Ortes an der Stelle des neuen.
  const SCENERY_JUMP_M = 1500
  let _sceneryAt = { x: 0, z: 0 }     // lokale Position des letzten Aufbaus
  let _sceneryBusy = false
  let _sceneryFehler = 0              // Fehlschläge in Folge (für EINE Meldung)

  const _followScenery = () => {
    if (_sceneryBusy || !geo.origin) return
    const cam = scene.activeCamera
    if (!cam) return
    const p = cam.globalPosition
    // Kamera steht bereits in lokalen Metern → Distanz ohne Geo-Mathematik.
    const weg = _sceneryAt ? Math.hypot(p.x - _sceneryAt.x, p.z - _sceneryAt.z) : Infinity
    if (weg < SCENERY_STEP_M) return
    const sprung = weg >= SCENERY_JUMP_M
    _sceneryAt = { x: p.x, z: p.z }
    const w = geo.toWorld(p.x, 0, p.z)
    _sceneryBusy = true
    console.log(`[scenery] Kamera ${Math.round(Math.hypot(p.x, p.z))} m vom Origin`
      + ` → Kulisse nach ${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}`
      + (sprung ? ` (Ortswechsel um ${Math.round(weg)} m — alte Kulisse wird sofort abgeräumt)` : ''))
    if (sprung) {
      // Lieber leer als falsch: erst weg, dann neu holen. Der Neuaufbau kann
      // dauern (oder scheitern, wenn die OSM-Quelle gerade nicht antwortet).
      try { osmContext.dispose() } catch (err) { console.warn('[scenery] Abräumen:', err?.message || err) }
    }
    _loadOSM(w.lat, w.lon, { force: sprung })
      .then(({ ok, error } = {}) => {
        if (ok) {
          if (_sceneryFehler) { _sceneryFehler = 0; window.ajnaLog?.push('Kulisse wieder da.', 'system') }
          return
        }
        // Ohne Meldung sieht der Spieler nur eine leere Ebene und hält die App
        // für kaputt. Nur die ERSTE Meldung je Störung — sonst Dauerfeuer.
        if (_sceneryFehler++ === 0) {
          const grund = /overpass|502|timeout|erreichbar/i.test(String(error?.message || error))
            ? 'Kartendaten (OpenStreetMap) gerade nicht erreichbar'
            : (error?.message || String(error))
          window.ajnaLog?.push(`Gebäude und Straßen fehlen — ${grund}.`, 'system')
        }
      })
      .finally(() => { _sceneryBusy = false })
  }

  // Objekt-Sichtweite ist kameraabhängig, der Reconcile hängt aber an
  // DATEN-Änderungen. Ohne das hier bliebe ein Objekt stehen, bis der nächste
  // Realtime-Event kommt — bei ruhigen Beständen beliebig lange. Nur aktiv,
  // wenn überhaupt eine Grenze gesetzt ist.
  const RANGE_RESYNC_M = 25
  let _rangeSyncAt = null
  const _followObjectRange = () => {
    if (!Number.isFinite(_objectRangeM) || !geo.origin) return
    const p = scene.activeCamera?.globalPosition
    if (!p) return
    if (_rangeSyncAt && Math.hypot(p.x - _rangeSyncAt.x, p.z - _rangeSyncAt.z) < RANGE_RESYNC_M) return
    _rangeSyncAt = { x: p.x, z: p.z }
    Promise.resolve(syncSceneObjects(scene, world, geo, ajnaManager.getObjectList())).catch(() => {})
  }

  setInterval(() => { _followScenery(); _followObjectRange() }, SCENERY_POLL_MS)

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
// IDs, für die gerade ein GameObject gebaut wird. Verhindert, dass zwei
// gleichzeitig laufende syncSceneObjects-Durchläufe dasselbe Objekt doppelt
// erzeugen (siehe „Geister-Schutz" in syncSceneObjects).
const _creating = new Set()

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

// Objekt-Sichtweite in Metern (Einstellungen → „Sichtweite"). Infinity = aus.
// Modulweit, weil syncSceneObjects keine Closure über init() hat.
let _objectRangeM = Infinity

// Harte Distanzgrenze für Objekte — ergänzt das Agenten-Budget (Anzahl je
// Source) um eine Grenze in Metern, die für ALLE Objekte gilt, auch für selbst
// angelegte. HORIZONTAL gemessen: ein Flugzeug in 11 km Höhe direkt über dem
// Kopf ist gefühlt „hier" und soll nicht an seiner Flughöhe scheitern.
function _capByObjectRange(objects, geo, camera) {
  if (!Number.isFinite(_objectRangeM)) return objects
  const cam = camera?.globalPosition
  if (!cam) return objects
  const r2 = _objectRangeM * _objectRangeM
  return objects.filter(o => {
    if (!Number.isFinite(o.lat) || !Number.isFinite(o.lon)) return true   // fängt der Reconcile ab
    const p = geo.toLocal(o.lat, o.lon, 0)
    const dx = p.x - cam.x, dz = p.z - cam.z
    return dx * dx + dz * dz <= r2
  })
}

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

  // Getragene Objekte (im Inventar) gehören nicht in die Welt, dann der
  // Agent-Filter: aus der vollen Objekt-Liste nur das behalten, was gemäß
  // User-Setting sichtbar sein soll. Default = alles sichtbar.
  // UWB-Anker sind Infrastruktur — nicht als Spielobjekte rendern (das übernimmt
  // das UwbAnchorOverlay als umschaltbares Debug-Overlay mit 3D-Höhen-Marker).
  // Anwesenheiten anderer Spieler laufen als gewöhnliche Objekte durch —
  // ausgeblendet werden nur die EIGENE (stünde im eigenen Kopf) und veraltete
  // (Gespenster von geschlossenen Apps). Siehe core/PresenceService.js.
  const _ich = ajnaManager.currentUser()?.id || ''
  const worldObjects = objects.filter(o =>
    !o.carried_by
    && (o.type || '').toLowerCase() !== 'uwb_anchor'
    && (o.type !== PRESENCE_TYPE || zeigeAnwesenheit(o, _ich)))
  const filteredObjects = _agentFilters
    ? worldObjects.filter(o => _agentFilters.matches(o))
    : worldObjects

  // Sichtweiten-Begrenzung: je Agent (Source) nur die X kamera-nächsten
  // Objekte rendern (X = render_budget der Source). Dichte Agents (WiGLE)
  // werden stark vereinfacht, dünne (AIS) bleiben komplett sichtbar.
  const visibleObjects = _capByObjectRange(
    _capByAgentBudget(filteredObjects, geo, scene.activeCamera, _agentFilters),
    geo, scene.activeCamera)

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
      const sig = JSON.stringify(obj.appearance ?? null)
      if (existing && existing._appearanceSig === sig) {
        existing.applyData(obj, geo)
      } else {
        // Neu ODER Darstellung geändert (Farbe/Modell/Symbol/Größe) → (neu)
        // aufbauen, damit Appearance-Änderungen SOFORT wirken (Modell-Reload).
        // Position/Rotation liefen sonst über applyData.
        //
        // GEISTER-SCHUTZ: createFromPBData wartet auf das Modell (Netz!), und
        // dieser Reconcile läuft aus fünf Stellen (Daten-Throttle, Kamera-
        // Bewegung, Sichtweiten-Regler, Boot). Zwei Durchläufe konnten so
        // dasselbe Objekt gleichzeitig bauen: der zweite überschrieb die Map,
        // der erste blieb als NIE aktualisiertes, NIE entsorgtes GameObject in
        // der Szene stehen — mit dem Namen, dem Typ und der Position von damals.
        // Genau das sah man als „Figur heisst in AR anders als auf der Karte".
        // Deshalb den Platz VOR dem await reservieren.
        if (_creating.has(obj.id)) continue
        _creating.add(obj.id)
        let go
        try {
          if (existing) { unsubscribeInteract(obj.id); existing.dispose(); objectMap.delete(obj.id) }
          go = await GameObject.createFromPBData(scene, obj, geo, true)
        } finally { _creating.delete(obj.id) }
        // Zweiter Riegel: hat in der Zwischenzeit doch jemand eines gesetzt,
        // gewinnt das bestehende — unseres wandert sofort wieder raus.
        const inzwischen = objectMap.get(obj.id)
        if (inzwischen && inzwischen !== go) { go.dispose(); continue }
        go._appearanceSig = sig
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
  // Reaktions-Animation der Figur (wave/hit …), falls das Modell eine hat.
  go?.playInteractionAnimation?.(action)
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
// Desktop-3D hat kein Reticle: dort ist der Maus-Hover das „Anvisieren" für die
// Quick-Actions. Gleiche Closure-Bridge, weil das Hover-System vor ihnen entsteht.
let _onHoverFocus = null
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
  let _hoverPickAt = 0
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

    // Drosseln: ein voller Raycast pro pointermove (60-120 Hz) sättigt den
    // Main-Thread (Haupt-FPS-Killer im Profil). Der Tooltip braucht keine 60 Hz.
    const now = performance.now()
    if (now - _hoverPickAt < 100) return
    _hoverPickAt = now

    // Nur Objekt-Meshes testen (Skybox/Boden/Schatten/Wand/Player überspringen) —
    // deutlich weniger Kandidaten pro Raycast.
    const pickInfo = scene.pick(scene.pointerX, scene.pointerY, m => !!m.metadata?.gameObject)
    const go = pickInfo?.hit ? pickInfo.pickedMesh?.metadata?.gameObject : null

    // Nur "echte" Objekte mit Namen (Player-Mesh hat keinen .metadata.gameObject)
    if (!go?.name) {
      tooltip.style.display = 'none'
      _onHoverFocus?.(null)
      return
    }
    _onHoverFocus?.(go)

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
function setupPositionSourceHud(positionSource, arRoot = document.body, gps = null) {
  const el = document.createElement('div')
  el.id = 'posSourceHud'
  Object.assign(el.style, {
    // Below the Android status bar (safe-area inset) so the clock doesn't cover it.
    position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 10px)', left: '10px', zIndex: 1000,
    font: '12px/1.4 system-ui, sans-serif', padding: '3px 8px',
    borderRadius: '6px', color: '#fff', background: 'rgba(0,0,0,0.55)',
    // Tippbar, um zwischen echtem GPS und Dummy umzuschalten (nur das Badge
    // fängt Taps; der Rest der AR-Ansicht bleibt durchlässig).
    pointerEvents: gps ? 'auto' : 'none', cursor: gps ? 'pointer' : 'default', userSelect: 'none'
  })
  if (gps) {
    el.title = 'Tippen: GPS-Quelle umschalten (Echt ↔ Dummy)'
    el.addEventListener('click', () => {
      if (!gps.isDummyMode()) {
        // Echt → Dummy: an der AKTUELLEN Position einfrieren (kein Default-Sprung).
        const p = positionSource.getWorldPosition?.() || gps.data
        if (p && Number.isFinite(p.lat)) gps.setDummyPosition(p.lat, p.lon, p.altitude || 0)
        gps.enableDummyMode(true)
        if (!_toast) _toast = new Toast()
        _toast.show('Dummy-Position aktiv (hier eingefroren).', { title: 'GPS' })
      } else {
        // Dummy → echtes GPS.
        gps.enableDummyMode(false)
        if (!_toast) _toast = new Toast()
        _toast.show('Echtes GPS aktiviert — warte auf Fix …', { title: 'GPS' })
      }
      render()
    })
  }
  arRoot.appendChild(el)

  const render = () => {
    // activeSource: 'uwb' | 'real' | 'dummy' | 'last' | 'gps' | null. Der
    // GPSProvider liefert 'real' (echtes GPS), 'dummy' (von Hand gesetzt) bzw.
    // 'last' (zuletzt gemerkte echte Position beim Start), NICHT 'gps' —
    // deshalb hier alle echten Quellen behandeln, sonst stünde dauerhaft
    // "kein Fix" trotz aktivem GPS.
    const src = positionSource.activeSource
    if (src === 'uwb') {
      const q = positionSource.quality
      el.style.background = 'rgba(20,120,40,0.75)'
      el.textContent = `UWB${Number.isFinite(q) ? ` · q${q}` : ''}`
    } else if (src === 'dummy') {
      el.style.background = 'rgba(120,80,0,0.7)'
      el.textContent = 'GPS (Dummy)'
    } else if (src === 'last') {
      el.style.background = 'rgba(120,80,0,0.7)'
      el.textContent = 'GPS (zuletzt)'
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