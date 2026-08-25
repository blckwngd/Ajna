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

  // SCHATTENKARTE AN DIE KAMERA BINDEN.
  //
  // Ein gerichtetes Licht zeichnet seine Schatten in eine ORTHOGONALE Box um
  // seine Position. Die stand fest bei (60, 120, 50) — also um den Weltursprung.
  // Wer sich davon entfernte, lief aus der Box heraus, und der Schatten wurde
  // angeschnitten oder verschwand ganz. Genau das war als „Schatten nur
  // teilweise gezeichnet" zu sehen, und zwar unabhängig vom Untergrund.
  //
  // Die Box wandert deshalb mit und wird ausdrücklich bemessen: Sie muss den
  // Radius abdecken, in dem überhaupt Schatten geworfen werden
  // (ajnaPerf.shadowRadiusM, Vorgabe 40 m) — mit Zuschlag für hohe Figuren, die
  // von außerhalb hereinragen. Kleiner ist besser: Dieselben 1024 Pixel auf
  // weniger Fläche heißt schärferer Schatten.
  const SCHATTEN_R = 70
  sun.orthoLeft = -SCHATTEN_R
  sun.orthoRight = SCHATTEN_R
  sun.orthoTop = SCHATTEN_R
  sun.orthoBottom = -SCHATTEN_R
  const SONNE_VERSATZ = new BABYLON.Vector3(60, 120, 50)
  scene.onBeforeRenderObservable.add(() => {
    const cam = scene.activeCamera
    if (!cam) return
    const p = cam.globalPosition
    sun.position.set(p.x + SONNE_VERSATZ.x, p.y + SONNE_VERSATZ.y, p.z + SONNE_VERSATZ.z)
  })

  // PCF statt Blur-Exponential: komponiert zuverlässig mit ShadowOnlyMaterial
  // (Blur-ESM lässt den Schatten dort oft komplett verschwinden).
  const shadowGenerator = new BABYLON.ShadowGenerator(1024, sun)
  shadowGenerator.usePercentageCloserFiltering = true
  shadowGenerator.filteringQuality = BABYLON.ShadowGenerator.QUALITY_MEDIUM
  shadowGenerator.setDarkness(0.2)                     // deutlich sichtbar auf dem dunklen Grid

  // Unsichtbare Boden-Ebene bei y≈0, die NUR den Schatten zeigt
  // (ShadowOnlyMaterial) — funktioniert über dem Grid UND über Kamera-Passthrough
  // (nur der Schatten dunkelt das Bild ab). Folgt der Kamera in X/Z, damit der
  // Schatten auch nach größeren Sprüngen unter den Figuren bleibt.
  const shadowGround = BABYLON.MeshBuilder.CreateGround("shadowGround", { width: 2000, height: 2000 }, scene)
  shadowGround.position.y = 0.02     // knapp über dem Grid gegen z-fighting
  shadowGround.isPickable = false
  shadowGround.receiveShadows = true
  const som = new ShadowOnlyMaterial("shadowOnlyMat", scene)
  som.activeLight = sun
  som.alpha = 0.55                   // Transparenz des Schattens
  shadowGround.material = som
  scene.onBeforeRenderObservable.add(() => {
    const cam = scene.activeCamera
    if (cam) { shadowGround.position.x = cam.globalPosition.x; shadowGround.position.z = cam.globalPosition.z }
  })


  // Skybox
  //
  // Groß genug, dass ALLE Objekte hineinpassen: `infiniteDistance` zentriert die
  // Box zwar auf die Kamera, erzwingt aber KEINE Ferntiefe — die Innenflächen
  // verdecken alles, was weiter als die Halbkante entfernt ist. Mit den alten
  // 1000 (Halbkante 500 m) wurden ferne Flugzeuge (ADS-B, bis ~52 km) unten
  // abgeschnitten (halbe Kugel + Wolken dahinter). 180 km Kantenlänge → Halbkante
  // 90 km deckt den 50-km-Radius + Flughöhe ab; die Box-Ecken (~156 km) bleiben
  // innerhalb maxZ (200 km, siehe CameraComponent), damit sie nicht ihrerseits
  // wegge-clippt werden. Größe ist texturneutral (Cubemap ist richtungsbasiert).
  const skybox = BABYLON.MeshBuilder.CreateBox('skyBox', { size: 180000.0 }, scene);
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
