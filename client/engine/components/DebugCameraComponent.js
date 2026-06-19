import { BaseComponent } from "../BaseComponent.js"

export class DebugCameraComponent extends BaseComponent {

  constructor(canvas, playerCameraComponent, debug = false, container = document.body) {
    super()
    this.canvas = canvas
    this.playerCameraComponent = playerCameraComponent
    this.debug = debug
    this.container = container   // mount the button in the AR view when embedded

    this.freeCamera = null
    this.activeMode = "player"
    this.button = null
  }

  init(gameObject) {
    super.init(gameObject)

    if (!this.debug) return

    this.#createFreeCamera()
    this.#createUI()

    // Im Debug-Modus startet der Anwender direkt in der freien Kamera —
    // sonst wäre ohne attachControl auf der Player-Kamera weder WASD
    // noch Pfeiltastenbewegung möglich.
    this.#activateFreeCamera()
  }

  #createFreeCamera() {
    this.freeCamera = new BABYLON.UniversalCamera(
      "debugFreeCamera",
      new BABYLON.Vector3(0, 10, -10),
      this.scene
    )

    this.freeCamera.setTarget(BABYLON.Vector3.Zero())

    // Sowohl WASD als auch Pfeiltasten als Movement-Keys binden.
    // (keyCodes: W=87 S=83 A=65 D=68 / Arrow Up=38 Down=40 Left=37 Right=39)
    this.freeCamera.keysUp    = [87, 38]
    this.freeCamera.keysDown  = [83, 40]
    this.freeCamera.keysLeft  = [65, 37]
    this.freeCamera.keysRight = [68, 39]

    this.freeCamera.speed = 2
  }

  #createUI() {
    this.button = document.createElement("button")
    this.button.innerText = "Switch Camera"
    // Bottom-right, damit das Debug-Panel oben rechts nicht überlappt.
    this.button.style.position = "absolute"
    this.button.style.bottom = "10px"
    this.button.style.right = "10px"
    this.button.style.zIndex = 1000
    this.button.style.padding = "6px 12px"
    this.button.style.background = "#2c5d8f"
    this.button.style.color = "#fff"
    this.button.style.border = "1px solid #3a78b6"
    this.button.style.borderRadius = "4px"
    this.button.style.cursor = "pointer"
    this.button.style.font = "12px ui-monospace, Menlo, Consolas, monospace"

    this.button.onclick = () => this.toggle()

    this.container.appendChild(this.button)
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