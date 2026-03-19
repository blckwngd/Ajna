//import PocketBase from "https://unpkg.com/pocketbase/dist/pocketbase.es.mjs"
import PocketBase  from 'pocketbase'
import { EventSource } from "eventsource";

import * as GUI from 'babylonjs-gui'
//import * as BABYLON from '@babylonjs/core/Legacy/legacy.js'

import { Engine, Scene, ArcRotateCamera, Vector3, HemisphericLight, Mesh, MeshBuilder, Shaders } from "@babylonjs/core"
import "@babylonjs/loaders"
import { ShowInspector } from "@babylonjs/inspector"
import { GridMaterial } from "@babylonjs/materials"

import { World } from "./engine/World.js"
import { GameObject } from "./engine/GameObject.js"
import { GeoTransformer } from "./core/GeoTransformer.js"
import { GPSProvider } from "./core/GPSProvider.js"
import { NetworkSystem } from "./core/NetworkSystem.js"
import { AjnaManager } from "./core/AjnaManager.js"
import { CameraComponent } from "./engine/components/CameraComponent.js"
import { DebugCameraComponent } from "./engine/components/DebugCameraComponent.js"
import { PlayerGPSComponent } from "./engine/components/PlayerGPSComponent.js"
import { TransformComponent } from "./engine/components/TransformComponent.js"
import { NetworkSyncComponent } from "./engine/components/NetworkSyncComponent.js"
import { buildDebugScene } from "./engine/debug/DebugSceneBuilder.js"
import { DebugUIManager } from "./engine/debug/DebugUIManager.js"
import { buildEnvironment } from "./engine/environment/EnvironmentBuilder.js"

const pb = new PocketBase("http://localhost:8090")
const ajnaManager = new AjnaManager("http://localhost:8090")
const DEBUG_WORLD = true
window.GUI = GUI
window.GridMaterial = GridMaterial

// ==========================================================
// AUTH
// ==========================================================

const status = document.getElementById("status")

document.getElementById("loginBtn").onclick = async () => {
  try {
    await pb.collection("users").authWithPassword(
      email.value,
      password.value
    )
    status.innerText = "Logged in"
  } catch {
    status.innerText = "Login failed"
  }
}

document.getElementById("logoutBtn").onclick = () => {
  pb.authStore.clear()
  status.innerText = "Logged out"
}


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
  
  ShowInspector(scene);

  // GPS UPDATE FLOW
  gps.start()

  await waitForOrigin(geo, gps)
  loadObjects(scene, world, geo)
  buildDebugScene(scene)

  gps.onPosition(position => {
    // Player-Update hier
  })
}


// ==========================================================
// OBJECT LOADING
// ==========================================================

const objectMap = new Map()

async function loadObjects(scene, world, geo) {

  const objects = await ajnaManager.loadObjects()

  // Alle Objekte initial laden
  for (const obj of objects) {
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

  const net = go.getComponent("NetworkSyncComponent")
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