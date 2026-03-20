export function buildEnvironment(scene) {

  // Licht
  const light = new BABYLON.HemisphericLight(
    "hemiLight",
    new BABYLON.Vector3(1, 1, 0),
    scene
  )
  light.intensity = 0.9


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

  // Damit sich die Skybox mit der jeweils aktiven Kamera bewegt (auch im Debug Modus):
  skybox.infiniteDistance = true;
  skybox.isPickable = false;

  scene.registerBeforeRender(() => {
    const activeCam = scene.activeCamera;
    if (activeCam) {
    }
  });
}
