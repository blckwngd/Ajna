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