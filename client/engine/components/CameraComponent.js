import { BaseComponent } from "../BaseComponent.js"

export class CameraComponent extends BaseComponent {

  constructor(canvas) {
    super()
    this.canvas = canvas
    this.camera = null
  }

  init(gameObject) {
    super.init(gameObject)

    this.camera = new BABYLON.UniversalCamera(
      "playerCamera",
      new BABYLON.Vector3(0, 1.7, 0),
      this.scene
    )

    // Bewusst KEIN attachControl: im Non-Debug-Betrieb soll die Kamera
    // fest am Player kleben. Der Debug-Modus aktiviert via Switch-Button
    // bei Bedarf selbst attachControl auf der Player-Kamera.
    this.camera.parent = this.gameObject.root
  }
}