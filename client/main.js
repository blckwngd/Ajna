import PocketBase from "https://unpkg.com/pocketbase/dist/pocketbase.es.mjs"
import { World } from "./engine/World.js"
import { GameObject } from "./engine/GameObject.js"
import { GeoTransformer } from "./core/GeoTransformer.js"
import { GPSProvider } from "./core/GPSProvider.js"
import { NetworkSystem } from "./core/NetworkSystem.js"
import { CameraComponent } from "./engine/components/CameraComponent.js"
import { DebugCameraComponent } from "./engine/components/DebugCameraComponent.js"
import { PlayerGPSComponent } from "./engine/components/PlayerGPSComponent.js"
import { NetworkSyncComponent } from "./engine/components/NetworkSyncComponent.js"
import { buildDebugScene, buildSatelliteGround } from "./engine/debug/DebugSceneBuilder.js"
import { DebugUIManager } from "./engine/debug/DebugUIManager.js"
import { buildEnvironment } from "./engine/environment/EnvironmentBuilder.js"

const pb = new PocketBase("http://localhost:8090")
const DEBUG_WORLD = true

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
  const engine = new BABYLON.Engine(canvas, true)
  const scene = new BABYLON.Scene(engine)
  
  const world = new World(scene)
  const geo = new GeoTransformer()
  const gps = new GPSProvider()

  const networkSystem = new NetworkSystem(pb, geo, objectMap)
  networkSystem.start()

  await setupPlayer(scene, world, geo, canvas)

  window.addEventListener("resize", () => engine.resize())


  // Server Update nur bei Login
  if (pb.authStore.isValid) {
    fetch("http://localhost:3000/api/update-position", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${pb.authStore.token}`
      },
      body: JSON.stringify(position)
    })
  }
  
  buildEnvironment(scene)

  if (DEBUG_WORLD) {
    buildDebugScene(scene)
    let player = objectMap.get("player")
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

  // GPS UPDATE FLOW
  gps.start()

  const firstPosition = await gps.waitForFirstFix()

  geo.setOrigin(
    firstPosition.lat,
    firstPosition.lon,
    firstPosition.altitude
  )
  loadObjects(scene, world, geo)

  gps.onPosition(position => {
    // Player-Update hier
  })

  if (DEBUG_WORLD) {
    buildSatelliteGround(scene, geo.origin.lat, geo.origin.lon)
  }
}


// ==========================================================
// OBJECT LOADING
// ==========================================================

const objectMap = new Map()

async function loadObjects(scene, world, geo) {

  const objects = await pb.collection("objects").getFullList()

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

  player.addComponent(
    new DebugCameraComponent(canvas, cameraComponent, DEBUG_WORLD)
  )

  world.add(player)
}

function handleRealtimeEvent(e) {

  const go = objectMap.get(e.record.id)

  if (!go) return

  const net = go.getComponent("NetworkSyncComponent")
  if (!net) return

  net.applyNetworkState(e.record)
}

function waitForOrigin(geo) {
  return new Promise(resolve => {

    new GPSProvider(position => {

      if (!geo.origin) {
        geo.setOrigin(
          position.lat,
          position.lon,
          position.altitude
        )
        resolve()
      }

    })

  })
}

init()