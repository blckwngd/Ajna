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
import { GPSProvider } from "./core/GPSProvider.js"
import { NetworkSystem } from "./core/NetworkSystem.js"
import { AjnaManager } from "./core/AjnaManager.js"
import { EditorUI } from "./core/EditorUI.js"
import { ContextMenu } from "./core/ContextMenu.js"
import { PermissionDialog } from "./core/PermissionDialog.js"
import { GroupDialog } from "./core/GroupDialog.js"
import { ServerDialog } from "./core/ServerDialog.js"
import { ObjectActions } from "./core/ObjectActions.js"
import { InWorldActionMenu } from "./core/InWorldActionMenu.js"
import { Toast } from "./core/Toast.js"
import { CameraComponent } from "./engine/components/CameraComponent.js"
import { DebugCameraComponent } from "./engine/components/DebugCameraComponent.js"
import { PlayerGPSComponent } from "./engine/components/PlayerGPSComponent.js"
import { TransformComponent } from "./engine/components/TransformComponent.js"
import { NetworkSyncComponent } from "./engine/components/NetworkSyncComponent.js"
import { buildDebugScene } from "./engine/debug/DebugSceneBuilder.js"
import { DebugUIManager } from "./engine/debug/DebugUIManager.js"
import { buildEnvironment } from "./engine/environment/EnvironmentBuilder.js"

const ajnaManager = new AjnaManager("http://" + window.location.hostname + ":8090")
const DEBUG_WORLD = true
window.GUI = GUI
window.GridMaterial = GridMaterial
window.ajna = ajnaManager

// ==========================================================
// SHARED EDITOR UI
// ==========================================================

let editorUI = null
let _xrExperience = null  // gesetzt nach erfolgreichem WebXR-Setup

// ==========================================================
// PHASE 1: INITIALIZATION
// ==========================================================

async function init() {

  // Babylon Setup
  const canvas = document.getElementById("renderCanvas")
  const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true })
  const scene = new BABYLON.Scene(engine)
  scene.useRightHandedSystem = true
  
  const world = new World(scene)
  const geo = new GeoTransformer()
  const gps = new GPSProvider()

  // Realtime-Updates laufen jetzt zentral über AjnaManager (subscribt
  // auf 'objects' und feuert emitObjectsChanged). Damit reagieren Liste,
  // Map und 3D-Szene synchron — kein separater NetworkSystem-Pfad nötig.
  // Die Klasse bleibt für zukünftige hochfrequente Engine-Sync-Use-Cases
  // (NetworkSyncComponent mit Lerp/Velocity) bestehen.

  const player = await setupPlayer(scene, world, geo, gps, canvas)

  // GPS-Stream starten, sobald der Player als Subscriber registriert ist.
  // Bei persistiertem Dummy broadcastet start() die Dummy-Position sofort
  // — waitForOrigin weiter unten resolvt damit ohne Wartezeit.
  gps.start()

  if (DEBUG_WORLD) { 
    window.engine= engine
    window.scene = scene
    window.world = world
    window.geo = geo
    window.gps = gps
    window.player = player
    window.objectMap = objectMap
  }
  
  window.addEventListener("resize", () => engine.resize())
  
  buildEnvironment(scene)

  // Hover-System: Mesh-Tooltip beim Pointer-Move, Highlight + Off-Screen-
  // Linie wenn aus den Listen heraus angefragt. Setzt DOM-Overlays an,
  // also nach Babylon-Setup und vor den UI-Managern (die den highlight-
  // Callback brauchen).
  const setHighlight = setupHoverSystem(scene, engine, canvas)
  _arHighlight = setHighlight  // damit interact-Events visuell pulsen können

  if (DEBUG_WORLD) {
    new DebugUIManager({
      scene,
      geo,
      gps,
      player,
      objectMap,
      onObjectHover: setHighlight
    })
  }

  engine.runRenderLoop(() => {
    const delta = engine.getDeltaTime() / 1000
    objectMap.forEach(go => go.update(delta))
    scene.render()
  })
  
  // Shared Editor UI im AR-Modus.
  // Kein onObjectsUpdated-Callback — die Szene wird über einen eigenen
  // ajnaManager-Listener weiter unten gepflegt, damit hier keine
  // Re-Entry-Schleife über EditorUI -> loadObjects -> emitObjectsChanged
  // entsteht.
  const uiContainer = document.getElementById('ui')
  const groupDialog = new GroupDialog({ ajna: ajnaManager })
  const serverDialog = new ServerDialog({ ajna: ajnaManager })

  editorUI = new EditorUI({
    ajna: ajnaManager,
    container: uiContainer,
    mode: 'ar',
    onFocusPlayer: () => focusCameraOn(scene, player),
    onManageGroups: () => groupDialog.open(),
    onManageServers: () => serverDialog.open(),
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
    }
  })

  // Kontextmenü + Berechtigungs-Dialog. Beides UI-Singletons; die
  // konkrete Action-Verdrahtung läuft über ObjectActions, damit AR und
  // Map dasselbe Menü zeigen.
  const contextMenu = new ContextMenu()
  const permissionDialog = new PermissionDialog({ ajna: ajnaManager })
  const objectActions = new ObjectActions({
    ajna: ajnaManager,
    editorUI,
    contextMenu,
    permissionDialog
  })

  // In-World-Menü für den XR-Modus. Sichtbar nur, wenn ein Objekt
  // fokussiert ist (Gaze oder XR-Klick).
  const inWorldMenu = new InWorldActionMenu(scene)

  function _triggerInteract(record, actionKey) {
    console.log(`[xr] trigger ${actionKey} on ${record.name || record.id}`)
    ajnaManager.interact(record.id, actionKey).catch(err =>
      console.warn("[xr] interact failed:", err?.message || err)
    )
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

  // Gaze-Loop: pro Frame Ray vom Kamera-Forward, Pick-Test gegen
  // GameObject-Meshes. Wechselt der Fokus, wird Highlight + Menü
  // entsprechend nachgezogen. Drosselt sich selbst, weil pickWithRay
  // O(meshes) ist — alle ~6 Frames reicht für UX.
  //
  // GUI-Panels werden über das Predicate ausgefiltert, damit das Menü
  // nicht den Blick auf "sein eigenes" Objekt verdeckt.
  let _gazedGO = null
  let _gazeTick = 0
  scene.onBeforeRenderObservable.add(() => {
    if (!_xrExperience || _xrExperience.baseExperience.state !== BABYLON.WebXRState.IN_XR) {
      if (_gazedGO) {
        setHighlight(_gazedGO, false)
        inWorldMenu.hide()
        _gazedGO = null
      }
      return
    }
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
      const record = ajnaManager.objectMap.get(_gazedGO.id)
      if (record) _showInWorldMenuFor(_gazedGO, record)
    } else {
      inWorldMenu.hide()
    }
  })

  // EditorUI-Backend-Load und GPS-Fix parallelisieren — bei realem GPS
  // spart das mehrere Sekunden, weil PocketBase-Load und Geolocation-
  // Wartezeit nicht hintereinander, sondern nebeneinander laufen.
  await Promise.all([
    editorUI.init(),
    waitForOrigin(geo, gps)
  ])

  // Szene-Reconcile erst aktivieren, wenn Origin steht — sonst würden
  // alle GameObjects auf (0,0,0) landen.
  ajnaManager.onObjectsChanged(objects => {
    syncSceneObjects(scene, world, geo, objects)
  })
  syncSceneObjects(scene, world, geo, ajnaManager.getObjectList())

  const debugScene = buildDebugScene(scene)

  // WebXR — nach buildDebugScene, damit die Ground-Mesh als Floor für
  // die Teleportation verfügbar ist.
  //
  // Default Mode ist `immersive-vr`. Die Babylon-Default-Experience baut
  // automatisch einen "Enter XR"-Button ins DOM und aktiviert
  // Pointer-Selection (Controller-Trigger feuert pointer-events, die
  // unser bestehender POINTERTAP-Handler oben aufgreift) sowie
  // Teleportation (Pointing-Gesture auf den Boden + Loslassen).
  //
  // Daydream-Controller und andere generische 3DOF-Controller werden
  // über das Standard-WebXR-Profil mitgenommen.
  try {
    _xrExperience = await scene.createDefaultXRExperienceAsync({
      floorMeshes: [debugScene.ground],
      uiOptions: {
        sessionMode: "immersive-vr",
        referenceSpaceType: "local-floor"
      },
      pointerSelectionOptions: {
        enablePointerSelectionOnAllControllers: true
      },
      teleportationOptions: {
        floorMeshes: [debugScene.ground]
      }
    })
    console.log("[xr] ready — Enter-XR button is in the DOM")

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
  } catch (err) {
    console.warn("[xr] init failed (browser likely lacks WebXR):", err?.message || err)
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

// Reconcile-Schritt: bringt die Szene mit einer Objekt-Liste vom AjnaManager
// in Übereinstimmung, ohne selbst eine Backend-Abfrage auszulösen. Wird vom
// onObjectsChanged-Listener gefeuert; ein erneuter Backend-Roundtrip würde
// emitObjectsChanged und damit diesen Handler wieder triggern — Schleife.
async function syncSceneObjects(scene, world, geo, objects) {

  if (!geo.origin) return

  const incomingIds = new Set(objects.map(o => o.id))

  // Entfernen, was nicht mehr Teil der Welt ist
  for (const [id, go] of objectMap) {
    if (!incomingIds.has(id)) {
      unsubscribeInteract(id)
      go.dispose()
      objectMap.delete(id)
    }
  }

  // Neue Objekte anlegen, bestehende mit aktuellen Daten überschreiben.
  // Realtime-Events (PocketBase) landen über AjnaManager → emitObjectsChanged
  // hier mit der frischen Objekt-Liste; applyData zieht Name, Position,
  // Rotation und Scale nach, ohne das GameObject neu zu erzeugen.
  for (const obj of objects) {
    const existing = objectMap.get(obj.id)
    if (existing) {
      existing.applyData(obj, geo)
    } else {
      const go = await GameObject.createFromPBData(scene, obj, geo, true)
      objectMap.set(obj.id, go)
      subscribeInteract(ajnaManager, obj.id, data => _handleInteractAR(go, data))
    }
  }
}

// Reagiert auf eingehende Broker-Events. Im AR-Modus zeigen wir einen
// Toast plus einen kurzen Highlight-Pulse am betroffenen GameObject.
function _handleInteractAR(go, data) {
  if (!_toast) _toast = new Toast()
  _toast.show(`${data.action} → ${go.name || go.id}`, { title: "INTERACT" })
  if (_arHighlight) {
    _arHighlight(go, true)
    setTimeout(() => _arHighlight(go, false), 280)
  }
}
let _arHighlight = null  // wird in init() befüllt — Closure-Bridge auf setHighlight

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
  document.body.appendChild(tooltip)

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
  document.body.appendChild(svg)

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
    new DebugCameraComponent(canvas, cameraComponent, DEBUG_WORLD)
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