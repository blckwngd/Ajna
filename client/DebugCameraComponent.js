import { BaseComponent } from "./BaseComponent.js"

export class DebugCameraComponent extends BaseComponent {

  constructor(canvas, playerCameraComponent, debug = false) {
    super()
    this.canvas = canvas
    this.playerCameraComponent = playerCameraComponent
    this.debug = debug

    this.freeCamera = null
    this.activeMode = "player"
    this.button = null
  }

  init(gameObject) {
    super.init(gameObject)

    if (!this.debug) return

    this.#createFreeCamera()
    this.#createUI()
  }

  #createFreeCamera() {
    this.freeCamera = new BABYLON.UniversalCamera(
      "debugFreeCamera",
      new BABYLON.Vector3(0, 10, -10),
      this.scene
    )

    this.freeCamera.setTarget(BABYLON.Vector3.Zero())
    this.freeCamera.attachControl(this.canvas, true)
    this.freeCamera.detachControl()

    this.freeCamera.speed = 2
  }

  #createUI() {
    this.button = document.createElement("button")
    this.button.innerText = "Switch Camera"
    this.button.style.position = "absolute"
    this.button.style.top = "10px"
    this.button.style.right = "10px"
    this.button.style.zIndex = 1000

    this.button.onclick = () => this.toggle()

    document.body.appendChild(this.button)
  }

  toggle() {
    if (this.activeMode === "player") {
      this.#activateFreeCamera()
    } else {
      this.#activatePlayerCamera()
    }
  }

  #activateFreeCamera() {
    this.playerCameraComponent.camera.detachControl()

    this.scene.activeCamera = this.freeCamera
    this.freeCamera.attachControl(this.canvas, true)

    this.activeMode = "free"
  }

  #activatePlayerCamera() {
    this.freeCamera.detachControl()

    this.scene.activeCamera = this.playerCameraComponent.camera
    this.playerCameraComponent.camera.attachControl(this.canvas, true)

    this.activeMode = "player"
  }

  dispose() {
    if (this.button) this.button.remove()
    if (this.freeCamera) this.freeCamera.dispose()
  }
}