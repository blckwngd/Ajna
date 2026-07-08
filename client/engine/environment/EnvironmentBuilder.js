import { ShadowOnlyMaterial } from "@babylonjs/materials"

export function buildEnvironment(scene) {

  // Umgebungslicht (weich, wirft keine Schatten)
  const light = new BABYLON.HemisphericLight(
    "hemiLight",
    new BABYLON.Vector3(1, 1, 0),
    scene
  )
  light.intensity = 0.9

  // Sonne: gerichtetes Licht für ECHTEN Schattenwurf (leicht schräg → natürlicher
  // Versatz). Bei fliegenden Kreaturen projiziert der ShadowGenerator den Schatten
  // korrekt auf den Boden (y=0), nicht direkt unter die Figur.
  const sun = new BABYLON.DirectionalLight("arSun", new BABYLON.Vector3(-0.4, -1, -0.35), scene)
  sun.position = new BABYLON.Vector3(60, 120, 50)
  sun.intensity = 0.5
  sun.autoCalcShadowZBounds = true

  const shadowGenerator = new BABYLON.ShadowGenerator(1024, sun)
  shadowGenerator.useBlurExponentialShadowMap = true   // weiche Kanten
  shadowGenerator.blurKernel = 16
  shadowGenerator.setDarkness(0.5)                      // halbtransparenter Schatten

  // Unsichtbare Boden-Ebene bei y≈0, die NUR den Schatten zeigt
  // (ShadowOnlyMaterial) — funktioniert über dem Grid UND über Kamera-Passthrough
  // (nur der Schatten dunkelt das Bild ab).
  const shadowGround = BABYLON.MeshBuilder.CreateGround("shadowGround", { width: 1000, height: 1000 }, scene)
  shadowGround.position.y = 0.01     // knapp über dem Grid gegen z-fighting
  shadowGround.isPickable = false
  shadowGround.receiveShadows = true
  const som = new ShadowOnlyMaterial("shadowOnlyMat", scene)
  som.activeLight = sun
  som.alpha = 0.5                    // Halbtransparenz des Schattens
  shadowGround.material = som


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

  // Skybox + Licht + Schatten-Setup zurückgeben. sun/shadowGenerator nutzt der
  // AR-Client, um den Schatten nach dem realen Sonnenstand auszurichten und
  // Figuren als Schattenwerfer zu registrieren.
  return { skybox, light, sun, shadowGenerator, shadowGround };
}
