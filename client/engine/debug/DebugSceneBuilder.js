export function buildDebugScene(scene) {

  const size = 50

  /*const grid = BABYLON.MeshBuilder.CreateGround(
    "debugGrid",
    { width: size, height: size },
    scene
  )*/

  const gridMaterial = new BABYLON.GridMaterial("gridMat", scene)
  gridMaterial.majorUnitFrequency = 5
  gridMaterial.minorUnitVisibility = 0.45
  gridMaterial.gridRatio = 1
  gridMaterial.backFaceCulling = false

  //grid.material = gridMaterial

  // Achsen
  const axisX = BABYLON.MeshBuilder.CreateLines("axisX", {
    points: [
      new BABYLON.Vector3(0, 0, 0),
      new BABYLON.Vector3(10, 0, 0)
    ]
  }, scene)

  axisX.color = new BABYLON.Color3(1, 0, 0)

  const axisY = BABYLON.MeshBuilder.CreateLines("axisY", {
    points: [
      new BABYLON.Vector3(0, 0, 0),
      new BABYLON.Vector3(0, 10, 0)
    ]
  }, scene)

  axisY.color = new BABYLON.Color3(0, 1, 0)

  const axisZ = BABYLON.MeshBuilder.CreateLines("axisZ", {
    points: [
      new BABYLON.Vector3(0, 0, 0),
      new BABYLON.Vector3(0, 0, 10)
    ]
  }, scene)

  axisZ.color = new BABYLON.Color3(0, 0, 1)
}

export function buildSatelliteGround(scene, lat, lon, zoom = 18) {

  const tileSize = 256
  const earthRadius = 6378137

  const tileManager = new TileManager(scene, geo, zoom, 2)
  
  scene.registerBeforeRender(() => {
    tileManager.update()
  })

  function lon2tile(lon, zoom) {
    return Math.floor((lon + 180) / 360 * Math.pow(2, zoom))
  }

  function lat2tile(lat, zoom) {
    return Math.floor(
      (1 - Math.log(Math.tan(lat * Math.PI/180) + 1 / Math.cos(lat * Math.PI/180)) / Math.PI) / 2
      * Math.pow(2, zoom)
    )
  }

  const x = lon2tile(lon, zoom)
  const y = lat2tile(lat, zoom)

  const url = `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`
  console.log(url)

  const ground = BABYLON.MeshBuilder.CreateGround(
    "satGround",
    { width: 200, height: 200 },
    scene
  )

  const mat = new BABYLON.StandardMaterial("satMat", scene)
  mat.diffuseTexture = new BABYLON.Texture(url, scene)
  mat.diffuseTexture.uScale = 1
  mat.diffuseTexture.vScale = 1

  ground.material = mat

  return ground
}

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