import { BaseComponent } from "./BaseComponent.js"

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

    this.camera.attachControl(this.canvas, true)

    // Kamera folgt dem Player-Root
    this.camera.parent = this.gameObject.root
  }
}