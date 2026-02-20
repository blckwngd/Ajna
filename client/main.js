import PocketBase from "https://unpkg.com/pocketbase/dist/pocketbase.es.mjs"

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
// BABYLON SETUP
// ==========================================================

const canvas = document.getElementById("renderCanvas")
const engine = new BABYLON.Engine(canvas, true)
const scene = new BABYLON.Scene(engine)

// Kamera (Z+ = Norden, X+ = Osten)
const camera = new BABYLON.ArcRotateCamera(
  "camera",
  Math.PI / 2,
  Math.PI / 3,
  50,
  new BABYLON.Vector3(0, 0, 0),
  scene
)

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

  showWorldAxes(20)
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

// Player Mesh
const playerMesh = BABYLON.MeshBuilder.CreateSphere(
  "player",
  { diameter: 2 },
  scene
)

const playerMat = new BABYLON.StandardMaterial("playerMat", scene)
playerMat.diffuseColor = new BABYLON.Color3(1, 0, 0)
playerMesh.material = playerMat

// XR
scene.createDefaultXRExperienceAsync({})

// ==========================================================
// GEO TRANSFORMER
// ==========================================================

/*
  Transformiert GPS Koordinaten in lokale Weltkoordinaten.
  Z+ = Norden
  X+ = Osten
  Y+ = Höhe
*/

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

const geo = new GeoTransformer()

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

async function loadObjects() {
  const objects = await pb.collection("objects").getFullList()

  objects.forEach(obj => {

    const position = geo.toLocal(
      obj.lat,
      obj.lon,
      obj.altitude ?? 0
    )

    // Fallback Werte
    const rotation = obj.rotation
      ? new BABYLON.Vector3(
          obj.rotation.x ?? 0,
          obj.rotation.y ?? 0,
          obj.rotation.z ?? 0
        )
      : BABYLON.Vector3.Zero()

    const scaling = obj.scale
      ? new BABYLON.Vector3(
          obj.scale.x ?? 1,
          obj.scale.y ?? 1,
          obj.scale.z ?? 1
        )
      : new BABYLON.Vector3(1, 1, 1)

    // Wenn Model URL existiert → laden
    if (obj.model_url) {

      BABYLON.SceneLoader.ImportMesh(
        "",
        "",
        obj.model_url,
        scene,
        meshes => {

          const root = meshes[0]

          root.position = position
          root.rotation = rotation
          root.scaling = scaling

          objectMap.set(obj.id, root)
        }
      )

    } else {

      // Fallback: 1x1x1 Würfel
      const cube = BABYLON.MeshBuilder.CreateBox(
        `placeholder_${obj.id}`,
        { size: 1 },
        scene
      )

      const mat = new BABYLON.StandardMaterial(
        `mat_${obj.id}`,
        scene
      )
      mat.diffuseColor = new BABYLON.Color3(0.8, 0.2, 0.2)
      cube.material = mat

      cube.position = position
      cube.rotation = rotation
      cube.scaling = scaling

      objectMap.set(obj.id, cube)
    }
  })
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
  playerMesh.position = geo.toLocal(
    position.lat,
    position.lon,
    position.altitude
  )

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

function showWorldAxes(size) {

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

// ==========================================================
// RENDER LOOP
// ==========================================================

engine.runRenderLoop(() => {
  scene.render()
})

window.addEventListener("resize", () => engine.resize())