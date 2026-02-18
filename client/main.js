import * as BABYLON from "https://cdn.babylonjs.com/babylon.js"
import "https://cdn.babylonjs.com/loaders/babylonjs.loaders.min.js"
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

const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 1.6, 0), scene)
camera.attachControl(canvas, true)

const light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0,1,0), scene)

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
