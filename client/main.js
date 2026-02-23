import PocketBase from "https://unpkg.com/pocketbase/dist/pocketbase.es.mjs"
import { GameObject } from "./GameObject.js"
import { GeospatialComponent } from "./GeospatialComponent.js"
import { TransformComponent } from "./TransformComponent.js"
import { RotationComponent } from "./RotationComponent.js"
import { CameraComponent } from "./CameraComponent.js"
import { DebugCameraComponent } from "./DebugCameraComponent.js"
import { PlayerGPSComponent } from "./PlayerGPSComponent.js"

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

  await setupScene(scene, engine, canvas, geo)

  // XR
  await scene.createDefaultXRExperienceAsync()

  engine.runRenderLoop(() => {
    const delta = engine.getDeltaTime() / 1000
    objectMap.forEach(go => go.update(delta))
    scene.render()
  })
}


// ==========================================================
// PHASE 2: SETUP SCENE
// ==========================================================

async function setupScene(scene, engine, canvas, geo) {

  const player = new GameObject(scene, "player")

  const cameraComponent = player.addComponent(
    new CameraComponent(canvas)
  )

  player.addComponent(new PlayerGPSComponent(geo))

  player.addComponent(
    new DebugCameraComponent(canvas, cameraComponent, DEBUG_WORLD)
  )

  objectMap.set("player", player)

  // Licht
  const light = new BABYLON.HemisphericLight(
    "light",
    new BABYLON.Vector3(0, 1, 0),
    scene
  )

  light.intensity = 0.9

  // Boden
  const ground = BABYLON.MeshBuilder.CreateGround(
    "ground",
    { width: 500, height: 500 },
    scene
  )

  const groundMat = new BABYLON.StandardMaterial("groundMat", scene)
  groundMat.diffuseColor = new BABYLON.Color3(0.2, 0.6, 0.2)
  ground.material = groundMat

  // Debug Grid + Achsen
  if (DEBUG_WORLD) {
    const gridMaterial = new BABYLON.GridMaterial("gridMat", scene)
    gridMaterial.majorUnitFrequency = 10
    gridMaterial.minorUnitVisibility = 0.45
    gridMaterial.gridRatio = 1
    gridMaterial.backFaceCulling = false

    const grid = BABYLON.MeshBuilder.CreateGround(
      "grid",
      { width: 500, height: 500 },
      scene
    )

    grid.material = gridMaterial
    grid.position.y = 0.01

    showWorldAxes(20, scene)
  }

  // Skybox
  const skybox = BABYLON.MeshBuilder.CreateBox(
    "skyBox",
    { size: 1000 },
    scene
  )

  const skyboxMaterial = new BABYLON.StandardMaterial("skyBox", scene)
  skyboxMaterial.backFaceCulling = false
  skyboxMaterial.disableLighting = true

  skyboxMaterial.reflectionTexture = new BABYLON.CubeTexture(
    "https://playground.babylonjs.com/textures/skybox",
    scene
  )

  skyboxMaterial.reflectionTexture.coordinatesMode =
    BABYLON.Texture.SKYBOX_MODE

  skybox.material = skyboxMaterial


  await loadObjects(scene, geo)
}


class GeoTransformer {
  constructor() {
    this.origin = null
    this.earthRadius = 6378137
  }

  setOrigin(lat, lon, altitude) {
    this.origin = { lat, lon, altitude }
  }

  toLocal(lat, lon, altitude = 0) {
    if (!this.origin) return BABYLON.Vector3.Zero()

    const dLat = (lat - this.origin.lat) * Math.PI / 180
    const dLon = (lon - this.origin.lon) * Math.PI / 180

    const meanLat =
      (lat + this.origin.lat) / 2 * Math.PI / 180

    const x = dLon * this.earthRadius * Math.cos(meanLat)
    const z = dLat * this.earthRadius
    const y = altitude - this.origin.altitude

    return new BABYLON.Vector3(x, y, z)
  }
}


// ==========================================================
// POSITION PROVIDER
// ==========================================================

class GPSProvider {
  constructor(callback) {
    navigator.geolocation.watchPosition(
      pos => {
        callback({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          altitude: pos.coords.altitude || 0,
          accuracy: pos.coords.accuracy,
          source: "gps"
        })
      },
      console.error,
      { enableHighAccuracy: true }
    )
  }
}

// ==========================================================
// OBJECT LOADING
// ==========================================================

const objectMap = new Map()

async function loadObjects(scene, geo) {

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

// ==========================================================
// GPS UPDATE FLOW
// ==========================================================

new GPSProvider(position => {

  // Erstes GPS Signal definiert Weltursprung
  if (!geo.origin) {
    geo.setOrigin(
      position.lat,
      position.lon,
      position.altitude
    )
    loadObjects()
  }

  // Spielerposition relativ zum Ursprung berechnen
/*  playerMesh.position = geo.toLocal(
    position.lat,
    position.lon,
    position.altitude
  )*/


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
})

// ==========================================================
// DEBUG AXES
// ==========================================================

function showWorldAxes(size, scene) {

  const axisX = BABYLON.MeshBuilder.CreateLines("axisX", {
    points: [
      BABYLON.Vector3.Zero(),
      new BABYLON.Vector3(size, 0, 0)
    ]
  }, scene)
  axisX.color = new BABYLON.Color3(1, 0, 0)

  const axisZ = BABYLON.MeshBuilder.CreateLines("axisZ", {
    points: [
      BABYLON.Vector3.Zero(),
      new BABYLON.Vector3(0, 0, size)
    ]
  }, scene)
  axisZ.color = new BABYLON.Color3(0, 0, 1)

  const axisY = BABYLON.MeshBuilder.CreateLines("axisY", {
    points: [
      BABYLON.Vector3.Zero(),
      new BABYLON.Vector3(0, size, 0)
    ]
  }, scene)
  axisY.color = new BABYLON.Color3(0, 1, 0)
}

window.addEventListener("resize", () => engine.resize())


const geo = new GeoTransformer()
init()