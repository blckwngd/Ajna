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
import { CameraComponent } from "./engine/components/CameraComponent.js"
import { DebugCameraComponent } from "./engine/components/DebugCameraComponent.js"
import { PlayerGPSComponent } from "./engine/components/PlayerGPSComponent.js"
import { TransformComponent } from "./engine/components/TransformComponent.js"
import { NetworkSyncComponent } from "./engine/components/NetworkSyncComponent.js"
import { buildDebugScene } from "./engine/debug/DebugSceneBuilder.js"
import { DebugUIManager } from "./engine/debug/DebugUIManager.js"
import { buildEnvironment } from "./engine/environment/EnvironmentBuilder.js"

const ajnaManager = new AjnaManager("http://localhost:8090")
const pb = ajnaManager.pb
const DEBUG_WORLD = true
window.GUI = GUI
window.GridMaterial = GridMaterial

// ==========================================================
// SHARED EDITOR UI
// ==========================================================

let editorUI = null

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

  const networkSystem = new NetworkSystem(pb, geo, objectMap)
  networkSystem.start()

  const player = await setupPlayer(scene, world, geo, canvas)

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

  if (DEBUG_WORLD) {
    new DebugUIManager({
      geo,
      gps,
      player,
      objectMap
    })
  }

  if (scene.createDefaultXRExperienceAsync) {
    await scene.createDefaultXRExperienceAsync()
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
  editorUI = new EditorUI({
    ajna: ajnaManager,
    container: uiContainer,
    mode: 'ar'
  })

  await editorUI.init()

  // GPS UPDATE FLOW
  gps.start()

  await waitForOrigin(geo, gps)

  // Szene-Reconcile erst aktivieren, wenn Origin steht — sonst würden
  // alle GameObjects auf (0,0,0) landen.
  ajnaManager.onObjectsChanged(objects => {
    syncSceneObjects(scene, world, geo, objects)
  })
  syncSceneObjects(scene, world, geo, ajnaManager.getObjectList())

  buildDebugScene(scene)

  gps.onPosition(position => {
    // Player-Update hier
  })
}


// ==========================================================
// OBJECT LOADING
// ==========================================================

const objectMap = new Map()

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
      go.dispose()
      objectMap.delete(id)
    }
  }

  // Neue Objekte anlegen (Updates an bestehenden Objekten kommen über
  // den Realtime-Pfad / NetworkSyncComponent, nicht hier)
  for (const obj of objects) {
    if (objectMap.has(obj.id)) continue
    const go = await GameObject.createFromPBData(scene, obj, geo, true)
    objectMap.set(obj.id, go)
  }
}

async function setupPlayer(scene, world, geo, canvas) {

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
  player.addComponent(new PlayerGPSComponent(geo))
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