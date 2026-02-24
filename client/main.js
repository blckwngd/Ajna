import PocketBase from "https://unpkg.com/pocketbase/dist/pocketbase.es.mjs"
import { World } from "./engine/World.js"
import { GameObject } from "./engine/GameObject.js"
import { GeoTransformer } from "./core/GeoTransformer.js"
import { GPSProvider } from "./core/GPSProvider.js"
import { GeospatialComponent } from "./engine/components/GeospatialComponent.js"
import { TransformComponent } from "./engine/components/TransformComponent.js"
import { RotationComponent } from "./engine/components/RotationComponent.js"
import { CameraComponent } from "./engine/components/CameraComponent.js"
import { DebugCameraComponent } from "./engine/components/DebugCameraComponent.js"
import { PlayerGPSComponent } from "./engine/components/PlayerGPSComponent.js"
import { buildDebugScene } from "./engine/debug/DebugSceneBuilder.js"
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

  for (const obj of objects) {

    const go = new GameObject(scene, obj.id)
    await go.loadFromData(obj, geo)

    // Geospatial Component
    go.addComponent(
      new GeospatialComponent(
        geo,
        obj.lat,
        obj.lon,
        obj.altitude ?? 0
      )
    )

    // Transform Component
    go.addComponent(
      new TransformComponent(
        new BABYLON.Vector3(
          obj.rotation?.x ?? 0,
          obj.rotation?.y ?? 0,
          obj.rotation?.z ?? 0
        ),
        new BABYLON.Vector3(
          obj.scale?.x ?? 1,
          obj.scale?.y ?? 1,
          obj.scale?.z ?? 1
        )
      )
    )

    // Optional: Debug Rotation
    // go.addComponent(new RotationComponent(0.3))

    objectMap.set(obj.id, go)
  }
}

async function setupPlayer(scene, world, geo, canvas) {

  const player = new GameObject(scene, "player")

  const cameraComponent = player.addComponent(
    new CameraComponent(canvas)
  )

  player.addComponent(new PlayerGPSComponent(geo))

  player.addComponent(
    new DebugCameraComponent(canvas, cameraComponent, DEBUG_WORLD)
  )

  world.add(player)
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