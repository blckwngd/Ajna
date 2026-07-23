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
    // Optionaler Callback (mode: 'free' | 'player'), den der Host (main.js)
    // setzt, um an den Moduswechsel den AR-Modus zu koppeln: Kamera-Passthrough
    // + Geräte-Kompass auf der Player-Kamera (siehe main.js setArMode).
    this.onModeChange = null
    // Optionaler Button-Callback: wird der Tap hierüber geleitet, kann der Host
    // den Wechsel selbst auslösen (z. B. iOS-Sensor-Permission vor dem Wechsel
    // anfordern). Ohne Callback bleibt der interne toggle().
    this.onToggle = null
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

    // Gleicher Far-Clip wie die Player-Kamera (CameraComponent), damit auch im
    // Free-Modus weit entfernte Flugzeuge nicht an der Default-10-km-Wand
    // abgeschnitten werden.
    this.freeCamera.maxZ = 200000

    // Sowohl WASD als auch Pfeiltasten als Movement-Keys binden.
    // (keyCodes: W=87 S=83 A=65 D=68 / Arrow Up=38 Down=40 Left=37 Right=39)
    this.freeCamera.keysUp    = [87, 38]
    this.freeCamera.keysDown  = [83, 40]
    this.freeCamera.keysLeft  = [65, 37]
    this.freeCamera.keysRight = [68, 39]

    this.freeCamera.speed = 2

    // Babylons FreeCameraTouchInput mappt vertikal = Vorwärtsbewegung und
    // horizontal = Gier-Drehung mit touchAngularSensibility-Default ~200000
    // (extrem langsam) — und kann gar nicht hoch/runter schauen. Das ist das
    // beschriebene "nur vorwärts/rückwärts und sehr langsam rotieren".
    //
    // Diesen Touch-Input entfernen; das Umschauen per Finger übernimmt ein
    // eigener Pointer-Handler (#attachTouchLook), weil der Maus/Pointer-Input
    // in der Android-WebView Touch-Pointer NICHT als Rotation abgreift (sonst
    // reagiert die Kamera gar nicht mehr). WASD/Maus bleiben fürs Desktop-Debug.
    this.freeCamera.inputs.removeByType("FreeCameraTouchInput")
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

    this.button.onclick = () => (this.onToggle ? this.onToggle() : this.toggle())

    this.container.appendChild(this.button)
  }

  toggle() {
    this.setMode(this.activeMode === "player" ? "free" : "player")
  }

  // Öffentlich: direkt einen Modus setzen (z. B. vom Editor-Toggle). Schaltet
  // die aktive Kamera um und meldet den Wechsel an onModeChange.
  setMode(mode) {
    if (mode === this.activeMode) return
    if (mode === "player") this.#activatePlayerCamera()
    else this.#activateFreeCamera()
  }

  #activateFreeCamera() {
    this.playerCameraComponent.camera.detachControl()

    this.scene.activeCamera = this.freeCamera
    this.freeCamera.attachControl(this.canvas, true)
    this.#attachTouchLook()

    this.activeMode = "free"
    this.onModeChange?.("free")
  }

  #activatePlayerCamera() {
    this.#detachTouchLook()
    this.freeCamera.detachControl()

    this.scene.activeCamera = this.playerCameraComponent.camera
    this.playerCameraComponent.camera.attachControl(this.canvas, true)

    this.activeMode = "player"
    this.onModeChange?.("player")
  }

  // Eigenes Touch-Umschauen: ein Finger ziehen → Gier (rotation.y) + Nick
  // (rotation.x), Sensibilität wie beim Maus-Look. Bewusst direkt auf den
  // Pointer-Events der Canvas, weil Babylons Input-Routing Touch in der
  // Android-WebView nicht zuverlässig als Kamerarotation behandelt.
  // Mehrfinger werden ignoriert (nur der erste Pointer steuert).
  #attachTouchLook() {
    if (this._touchLook) return                  // idempotent (init + toggle)
    const cam = this.freeCamera
    const el = this.canvas
    const SENS = 0.005                            // rad/Pixel (höher = schneller)
    const PITCH_LIMIT = Math.PI / 2 - 0.02        // kein Überschlagen nach oben/unten
    let pid = null, lastX = 0, lastY = 0

    const onDown = (e) => {
      if (e.pointerType !== "touch" || pid !== null) return
      pid = e.pointerId; lastX = e.clientX; lastY = e.clientY
    }
    const onMove = (e) => {
      if (e.pointerId !== pid) return
      const dx = e.clientX - lastX, dy = e.clientY - lastY
      lastX = e.clientX; lastY = e.clientY
      cam.rotation.y += dx * SENS                 // Finger rechts → Blick nach rechts
      cam.rotation.x += dy * SENS                 // Finger runter → Blick nach unten
      if (cam.rotation.x >  PITCH_LIMIT) cam.rotation.x =  PITCH_LIMIT
      if (cam.rotation.x < -PITCH_LIMIT) cam.rotation.x = -PITCH_LIMIT
      e.preventDefault()
    }
    const onUp = (e) => { if (e.pointerId === pid) pid = null }

    el.style.touchAction = "none"                 // Browser-Scroll/Gesten unterdrücken
    el.addEventListener("pointerdown", onDown)
    el.addEventListener("pointermove", onMove, { passive: false })
    el.addEventListener("pointerup", onUp)
    el.addEventListener("pointercancel", onUp)
    this._touchLook = () => {
      el.removeEventListener("pointerdown", onDown)
      el.removeEventListener("pointermove", onMove)
      el.removeEventListener("pointerup", onUp)
      el.removeEventListener("pointercancel", onUp)
    }
  }

  #detachTouchLook() {
    if (this._touchLook) { this._touchLook(); this._touchLook = null }
  }

  dispose() {
    this.#detachTouchLook()
    if (this.button) this.button.remove()
    if (this.freeCamera) this.freeCamera.dispose()
  }
}