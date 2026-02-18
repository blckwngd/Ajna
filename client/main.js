/*import * as BABYLON from "https://cdn.babylonjs.com/babylon.js"
import "https://cdn.babylonjs.com/loaders/babylonjs.loaders.min.js"
import { Engine } from "@babylonjs/core/Engines/engine"
import { Scene } from "@babylonjs/core/scene"
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera"
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight"
import { Vector3 } from "@babylonjs/core/Maths/math.vector"
*/
import PocketBase from "https://unpkg.com/pocketbase/dist/pocketbase.es.mjs"

const pb = new PocketBase("http://localhost:8090")

// ---------------- AUTH ----------------

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

// ---------------- BABYLON SETUP ----------------

const canvas = document.getElementById("renderCanvas")
const engine = new BABYLON.Engine(canvas, true)
const scene = new BABYLON.Scene(engine)

// Kamera
/*const xrSupported = await BABYLON.WebXRSessionManager.IsSessionSupportedAsync("immersive-vr")
if (xrSupported) {
  // xr available, session supported
  const sessionManager = new BABYLON.WebXRSessionManager(scene)
  const camera = new BABYLON.WebXRCamera("camera", scene, xrSessionManager)
} else {*/
  const camera = new BABYLON.ArcRotateCamera(
      "camera",
      Math.PI / 2,
      Math.PI / 3,
      50,
      new BABYLON.Vector3(0, 0, 20),
      scene
  )
//}

camera.attachControl(canvas, true)

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

// Skybox
const skybox = BABYLON.MeshBuilder.CreateBox(
    "skyBox",
    { size: 1000.0 },
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


// XR Support
scene.createDefaultXRExperienceAsync({})

// ---------------- POSITION PROVIDER ----------------

class GPSProvider {
  constructor(callback) {
    navigator.geolocation.watchPosition(pos => {
      callback({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        altitude: pos.coords.altitude || 0,
        accuracy: pos.coords.accuracy,
        source: "gps"
      })
    }, console.error, { enableHighAccuracy: true })
  }
}

// UWBProvider (Placeholder)
class UWBProvider {
  constructor(callback) {
    // später: Trilateration mit Ankerdaten
    // callback({lat, lon, altitude, source:"uwb"})
  }
}

// ---------------- GEO TRANSFORM ----------------

class GeoTransformer {
  constructor() {
    this.origin = null
  }

  setOrigin(lat, lon, altitude) {
    this.origin = { lat, lon, altitude }
  }

  toLocal(lat, lon, altitude) {
    if (!this.origin) return new BABYLON.Vector3.Zero()

    const metersPerDegLat = 111320
    const metersPerDegLon =
      111320 * Math.cos(this.origin.lat * Math.PI / 180)

    const dx = (lon - this.origin.lon) * metersPerDegLon
    const dz = (lat - this.origin.lat) * metersPerDegLat
    const dy = altitude - this.origin.altitude

    return new BABYLON.Vector3(dx, dy, -dz)
  }
}

const geo = new GeoTransformer()

// ---------------- LOAD OBJECTS ----------------

const objectMap = new Map()

async function loadObjects() {
  const objects = await pb.collection("objects").getFullList()

  objects.forEach(obj => {
    BABYLON.SceneLoader.ImportMesh(
      "",
      "",
      obj.model_url,
      scene,
      meshes => {
        const root = meshes[0]
        const pos = geo.toLocal(obj.lat, obj.lon, obj.altitude)
        root.position = pos

        root.rotation = new BABYLON.Vector3(
          obj.rotation.x,
          obj.rotation.y,
          obj.rotation.z
        )

        root.scaling = new BABYLON.Vector3(
          obj.scale.x,
          obj.scale.y,
          obj.scale.z
        )

        objectMap.set(obj.id, root)
      }
    )
  })
}

// ---------------- POSITION UPDATE ----------------

new GPSProvider(position => {

  if (!geo.origin) {
    geo.setOrigin(position.lat, position.lon, position.altitude)
    loadObjects()
  }

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

// ---------------- RENDER LOOP ----------------

engine.runRenderLoop(() => {
  scene.render()
})

window.addEventListener("resize", () => engine.resize())
