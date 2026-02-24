export function buildEnvironment(scene) {

  // Licht
  const light = new BABYLON.HemisphericLight(
    "hemiLight",
    new BABYLON.Vector3(0, 1, 0),
    scene
  )
  light.intensity = 0.9

  // Boden
  /*
  const ground = BABYLON.MeshBuilder.CreateGround(
    "ground",
    { width: 200, height: 200 },
    scene
  )

  const groundMat = new BABYLON.StandardMaterial("groundMat", scene)
  groundMat.diffuseColor = new BABYLON.Color3(0.2, 0.2, 0.2)
  ground.material = groundMat
*/
  // Skybox
  const skybox = BABYLON.MeshBuilder.CreateBox(
    "skyBox",
    { size: 1000 },
    scene
  )

  const skyMat = new BABYLON.StandardMaterial("skyMat", scene)
  skyMat.backFaceCulling = false
  skyMat.disableLighting = true
  skyMat.reflectionTexture = new BABYLON.CubeTexture(
    "https://playground.babylonjs.com/textures/skybox",
    scene
  )
  skyMat.diffuseColor = new BABYLON.Color3(0.05, 0.05, 0.1)

  skybox.material = skyMat
}