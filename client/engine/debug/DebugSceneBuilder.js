import { GridMaterial } from "@babylonjs/materials"

export function buildDebugScene(scene) {

  // Großer Boden mit GridMaterial — wirkt "unendlich". Das Raster wird
  // shader-seitig gezeichnet, daher reicht eine flache Plane mit
  // subdivisions=1; Performance unabhängig von der Kantenlänge.
  // 5000 × 5000 m passen unter die Default-Far-Plane (10000) und sind
  // weit über dem, was der Anwender je sehen kann.
  const size = 5000

  const ground = BABYLON.MeshBuilder.CreateGround(
    "debugGround",
    { width: size, height: size, subdivisions: 1 },
    scene
  )
  ground.isPickable = false

  // GeoTransformer.toLocal liefert lokale Koordinaten in Metern,
  // d. h. 1 Babylon-Unit = 1 m. Damit ergibt:
  //   gridRatio = 1            → feines 1-m-Sub-Raster
  //   majorUnitFrequency = 10  → kräftige Linie alle 10 sub-units = 10 m
  const gridMat = new GridMaterial("debugGridMat", scene)
  gridMat.gridRatio = 1
  gridMat.majorUnitFrequency = 10
  gridMat.minorUnitVisibility = 0.3
  gridMat.mainColor = new BABYLON.Color3(0.04, 0.05, 0.08)
  gridMat.lineColor = new BABYLON.Color3(0.5, 0.7, 1.0)
  gridMat.opacity = 0.98
  gridMat.backFaceCulling = false

  ground.material = gridMat

  // Boden zieht der aktiven Kamera in X/Z hinterher — sonst läuft die
  // Plane (zentriert am Welt-Origin) bei größeren Sprüngen aus dem
  // Sichtfeld. Y bleibt fix, damit der Boden seine Höhe behält.
  //
  // GridMaterial zeichnet die Linien aus der LOKALEN Vertex-Position
  // (vPosition im Shader). Würden wir nur das Mesh verschieben, wandert
  // das gesamte Linien-Pattern visuell mit — Cam-Bewegung wirkt dann
  // wie eingefroren. Indem wir die Mesh-Verschiebung gleichzeitig in
  // gridOffset eintragen, hebt sich der Effekt auf: gridPos im Shader
  // ist (vPosition + gridOffset) und entspricht damit wieder der
  // Welt-Position des Vertex → Linien sitzen wieder fest in der Welt.
  scene.onBeforeRenderObservable.add(() => {
    const cam = scene.activeCamera
    if (!cam) return
    const pos = cam.globalPosition
    ground.position.x = pos.x
    ground.position.z = pos.z
    gridMat.gridOffset.x = pos.x
    gridMat.gridOffset.z = pos.z
  })

  // Achsen — verlängert auf 100 m, damit sie auf dem großen Ground
  // sichtbar bleiben, aber das 10-m-Raster nicht überstrahlen.
  const axisLength = 100

  const axisX = BABYLON.MeshBuilder.CreateLines("axisX", {
    points: [BABYLON.Vector3.Zero(), new BABYLON.Vector3(axisLength, 0, 0)]
  }, scene)
  axisX.color = new BABYLON.Color3(1, 0, 0)
  axisX.isPickable = false

  const axisY = BABYLON.MeshBuilder.CreateLines("axisY", {
    points: [BABYLON.Vector3.Zero(), new BABYLON.Vector3(0, axisLength, 0)]
  }, scene)
  axisY.color = new BABYLON.Color3(0, 1, 0)
  axisY.isPickable = false

  const axisZ = BABYLON.MeshBuilder.CreateLines("axisZ", {
    points: [BABYLON.Vector3.Zero(), new BABYLON.Vector3(0, 0, axisLength)]
  }, scene)
  axisZ.color = new BABYLON.Color3(0, 0, 1)
  axisZ.isPickable = false
}

export { Tiles3DManager, TILESET_URLS, createCommonTilesets } from "./Tiles3DManager.js"
export { Tiles3DUI } from "./Tiles3DUI.js"

export class TileManager {
  constructor(scene, geo, zoom = 18, radius = 2) {
    this.scene = scene
    this.geo = geo
    this.zoom = zoom
    this.radius = radius          // Anzahl Tiles um den Mittelpunkt
    this.tiles = new Map()        // key = `${x}_${y}` → {mesh,…}
  }

  // converts lat/lon → tile indices at current zoom
  latLonToTile(lat, lon) {
    const n = 1 << this.zoom
    const x = Math.floor((lon + 180) / 360 * n)
    const y = Math.floor(
      (1 - Math.log(Math.tan(lat * Math.PI/180) +
                     1/Math.cos(lat * Math.PI/180)) / Math.PI) / 2 * n
    )
    return {x, y}
  }

  // returns tile URL
  tileUrl(x, y) {
    return `https://tile.openstreetmap.org/${this.zoom}/${x}/${y}.png`
  }

  // create ground mesh for a single tile at (tx,ty)
  createTile(tx, ty) {
    const size = 200 // beliebig – gleiche Größe wie in buildSatelliteGround
    const ground = BABYLON.MeshBuilder.CreateGround(
      `tile_${tx}_${ty}`, {width: size, height: size}, this.scene
    )
    const mat = new BABYLON.StandardMaterial(`mat_${tx}_${ty}`, this.scene)
    mat.diffuseTexture = new BABYLON.Texture(this.tileUrl(tx, ty), this.scene)
    mat.diffuseTexture.uScale = 1
    mat.diffuseTexture.vScale = 1
    ground.material = mat
    ground.position.x = (tx - this.centerX) * size
    ground.position.z = (ty - this.centerY) * size
    return ground
  }

  // setzt den neuen Zentrumspunkt und aktualisiert Tile‑Set
  update() {
    const {lat, lon, altitude} = this.geo.toWorld(
      this.scene.activeCamera.position.x,
      this.scene.activeCamera.position.y,
      this.scene.activeCamera.position.z
    )
    const {x, y} = this.latLonToTile(lat, lon)

    // falls sich das Zentrum nicht geändert hat, nichts tun
    if (x === this.centerX && y === this.centerY) return

    this.centerX = x
    this.centerY = y

    const needed = new Set()
    for (let dx=-this.radius; dx<=this.radius; dx++) {
      for (let dy=-this.radius; dy<=this.radius; dy++) {
        needed.add(`${x+dx}_${y+dy}`)
        if (!this.tiles.has(`${x+dx}_${y+dy}`)) {
          const mesh = this.createTile(x+dx, y+dy)
          this.tiles.set(`${x+dx}_${y+dy}`, mesh)
        }
      }
    }

    // entferne nicht mehr benötigte
    for (const key of this.tiles.keys()) {
      if (!needed.has(key)) {
        const mesh = this.tiles.get(key)
        mesh.dispose()
        this.tiles.delete(key)
      }
    }
  }
}