export function buildEnvironment(scene) {

  // Licht
  const light = new BABYLON.HemisphericLight(
    "hemiLight",
    new BABYLON.Vector3(1, 1, 0),
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

const skybox = BABYLON.MeshBuilder.CreateBox('skyBox', { size: 1000.0 }, scene);
const skyMat = new BABYLON.StandardMaterial('skyBoxMaterial', scene);
skyMat.backFaceCulling = false;
skyMat.disableLighting = true;
skyMat.reflectionTexture = new BABYLON.CubeTexture('https://playground.babylonjs.com/textures/skybox', scene);
skyMat.reflectionTexture.coordinatesMode = BABYLON.Texture.SKYBOX_MODE;
skyMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
skyMat.specularColor = new BABYLON.Color3(0, 0, 0);
skybox.material = skyMat;

}