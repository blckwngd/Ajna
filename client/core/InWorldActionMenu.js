// In-World-Aktionsmenü für den WebXR-Modus.
//
// **Camera-HUD-Layout**: Pro Action eine eigene Plane, horizontal
// nebeneinander im unteren Bildschirmbereich angeordnet. Die Planes
// werden pro Frame in Welt-Koordinaten vor die aktive Kamera positioniert
// (kein parent-Verhältnis, weil das mit XR-Camera-Rig und billboardMode
// schlecht harmoniert). Sie sitzen damit immer NÄHER an der Kamera als
// jedes Welt-Mesh — entscheidend für zuverlässige Mesh-Picks:
//
//   `scene.pick()` testet Ray-Distanz, NICHT `renderingGroupId`. Wenn ein
//   Button (am Objekt verankert) räumlich hinter Modell-Meshes liegt,
//   gewinnt das nähere Modell-Mesh, auch wenn der Button visuell darüber
//   gerendert wird. Indem das Menü strikt vor der Kamera schwebt, ist
//   der Button immer das nächste Mesh entlang des Pick-Rays.
//
// **Kein Header / Titel**: Der Kontextbezug zum gemeinten Objekt entsteht
// über das `HighlightLayer`-Outline am 3D-Modell (siehe Gaze-Loop in
// main.js). Damit bleibt das HUD klein und verdeckt den Blick aufs
// Modell nicht.
//
// **Auto-Hide nach Klick**: Jeder POINTERTAP schließt das Menü, egal ob
// er einen Button getroffen hat oder daneben. Die Gaze-Loop entscheidet
// danach selbst, ob das Menü beim nächsten Wechsel des fokussierten
// Objekts wieder aufgemacht wird — und ein Klick auf ein Game-Object
// öffnet es direkt für das geklickte Objekt (Logik in main.js).
//
// Marker-Metadata pro Button-Plane:
//   metadata.guiPanel       = true   → Gaze-Loop in main.js ignoriert das Mesh
//   metadata.isActionButton = true   → Click-Handler matcht es
//   metadata.actionKey      = "..."  → wird an onSelect übergeben

import * as GUI from "babylonjs-gui"

const BUTTON_WIDTH    = 0.20    // Meter — horizontal nebeneinander, kompakt
const BUTTON_HEIGHT   = 0.075
const BUTTON_SPACING  = 0.025   // horizontaler Abstand zwischen Planes

const TEX_W           = 256
const TEX_H           = 96

const FORWARD_DIST    = 0.7     // Meter vor der Kamera
const VERTICAL_DROP   = 0.32    // unter der Sichtlinie → unteres Drittel

const COLOR_BG_NORMAL = "#2c5d8f"
const COLOR_BG_HOVER  = "#356da6"
const COLOR_TEXT      = "#ffffff"
const FONT_STACK      = "ui-monospace, Menlo, Consolas, monospace"

export class InWorldActionMenu {
  constructor(scene) {
    this.scene = scene
    this._currentGo = null
    this._onSelect = null
    this._buttons = []
    this._visible = false
    this._focusedIdx = -1   // Controller-Fokus; -1 = kein Button fokussiert
    this._pointerObserver = this._installClickHandler()
    this._renderObserver = this._installPositionUpdater()
  }

  // Globaler POINTERTAP-Listener:
  //   • Hit auf Action-Button → Aktion triggern, skipNextObservers setzen
  //     (sonst klickt der GameObject-Picker in main.js "durch den Button
  //     hindurch" auf das dahinter liegende Objekt), Menü schließen.
  //   • Hit auf irgendetwas anderes (Mesh oder leer) → Menü schließen,
  //     ohne skipNextObservers — main.js darf danach für Game-Object-
  //     Klicks das Menü für das geklickte Objekt neu öffnen.
  _installClickHandler() {
    return this.scene.onPointerObservable.add((pi, ev) => {
      if (pi.type !== BABYLON.PointerEventTypes.POINTERTAP) return
      if (!this._visible) return

      const pick = pi.pickInfo
        || this.scene.pick(this.scene.pointerX, this.scene.pointerY)
      const mesh = pick?.pickedMesh

      if (mesh?.metadata?.isActionButton) {
        ev.skipNextObservers = true
        const key = mesh.metadata.actionKey
        const onSelect = this._onSelect
        this.hide()
        if (key && onSelect) onSelect(key)
        return
      }

      this.hide()
    })
  }

  // Pro Frame: Menü in Welt-Koordinaten vor die aktive Kamera setzen.
  // Forward kommt aus `getForwardRay()` — das respektiert die Handedness
  // der Szene und funktioniert sowohl für Free-/ArcRotateCamera als auch
  // für die WebXR-Kamera, die im XR-Modus zur scene.activeCamera wird.
  _installPositionUpdater() {
    return this.scene.onBeforeRenderObservable.add(() => this._updatePositions())
  }

  _updatePositions() {
    if (!this._visible) return
    const cam = this.scene.activeCamera
    if (!cam) return

    const camPos = cam.globalPosition
    const fwd    = cam.getForwardRay().direction.normalizeToNew()
    // Up aus rechtwinkligem Frame zur Forward-Richtung (cam.upVector kann
    // bei manchen Kameratypen rollen, das verzerrt das HUD). Frame relativ
    // zur Welt-Y, damit das Menü waagerecht bleibt, auch wenn die Kamera
    // den Kopf neigt.
    const worldUp = BABYLON.Axis.Y
    const right   = BABYLON.Vector3.Cross(worldUp, fwd).normalize()
    const up      = BABYLON.Vector3.Cross(fwd, right).normalize()

    const center = camPos
      .add(fwd.scale(FORWARD_DIST))
      .add(up.scale(-VERTICAL_DROP))

    // Buttons horizontal nebeneinander, zentriert um `center`.
    const n = this._buttons.length
    const stride = BUTTON_WIDTH + BUTTON_SPACING
    const leftX = -((n - 1) * stride) / 2

    for (let i = 0; i < n; i++) {
      const xOff = leftX + i * stride
      this._buttons[i].plane.position.copyFrom(center.add(right.scale(xOff)))
    }
  }

  /**
   * Zeigt das Menü an einem GameObject.
   * @param {GameObject} go
   * @param {string} title — wird nicht mehr angezeigt (Kontext via Highlight)
   * @param {Array<{key: string, label?: string}>} actions
   * @param {(actionKey: string) => void} onSelect
   */
  show(go, title, actions, onSelect) {
    if (!go || !go.root) return
    this._currentGo = go
    this._onSelect = onSelect
    this._focusedIdx = -1

    this._clearButtons()
    for (const action of actions) {
      this._buttons.push(this._createButton(action))
    }

    this._visible = true
    // Erste Position sofort setzen, damit das Menü nicht für einen Frame
    // bei (0,0,0) aufblitzt, bevor der onBeforeRender-Observer feuert.
    this._updatePositions()
  }

  // ───────────────────────────────────────────────────────────────────
  //  Programmatic Focus — vom XR-Controller getrieben (Touchpad-Cycle).
  //  Setzt visuell den Hover-Farbton auf den fokussierten Button und
  //  bietet `triggerFocused()` als Equivalent eines Maus-/Pick-Klicks.
  // ───────────────────────────────────────────────────────────────────

  /** Anzahl Buttons im aktuell sichtbaren Menü. */
  get buttonCount() { return this._buttons.length }

  /** Setzt programmatisch den Fokus auf Button[idx]. -1 hebt Fokus auf. */
  focusButton(idx) {
    this._focusedIdx = idx
    for (let i = 0; i < this._buttons.length; i++) {
      const b = this._buttons[i]
      b.texture.background = (i === idx) ? COLOR_BG_HOVER : COLOR_BG_NORMAL
    }
  }

  /** Cyclt den Fokus um delta (±1) mit Wraparound. */
  cycleFocus(delta) {
    if (!this._visible || this._buttons.length === 0) return
    const n = this._buttons.length
    let next = this._focusedIdx < 0
      ? (delta > 0 ? 0 : n - 1)
      : ((this._focusedIdx + delta) % n + n) % n
    this.focusButton(next)
  }

  /** Triggert die Aktion des fokussierten Buttons (analog Maus-Klick). */
  triggerFocused() {
    if (!this._visible) return
    const idx = this._focusedIdx >= 0 ? this._focusedIdx : 0
    const b = this._buttons[idx]
    if (!b) return
    const key = b.plane.metadata?.actionKey
    const onSelect = this._onSelect
    this.hide()
    if (key && onSelect) onSelect(key)
  }

  _createButton(action) {
    const plane = BABYLON.MeshBuilder.CreatePlane(
      `inworld-btn-${action.key}`,
      { width: BUTTON_WIDTH, height: BUTTON_HEIGHT },
      this.scene
    )
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
    plane.isPickable = true
    plane.metadata = {
      guiPanel: true,
      isActionButton: true,
      actionKey: action.key
    }
    plane.renderingGroupId = 1

    const texture = GUI.AdvancedDynamicTexture.CreateForMesh(plane, TEX_W, TEX_H)
    texture.background = COLOR_BG_NORMAL

    const text = new GUI.TextBlock()
    text.text = action.label || action.key
    text.color = COLOR_TEXT
    text.fontSize = 38
    text.fontFamily = FONT_STACK
    text.textHorizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_CENTER
    text.textVerticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_CENTER
    texture.addControl(text)

    // Hover-Feedback. ActionManager-Trigger werden sowohl von der Maus
    // als auch vom WebXR-Pointer-Selection (Controller-Laser) gefeuert.
    plane.actionManager = new BABYLON.ActionManager(this.scene)
    plane.actionManager.registerAction(
      new BABYLON.ExecuteCodeAction(
        BABYLON.ActionManager.OnPointerOverTrigger,
        () => { texture.background = COLOR_BG_HOVER }
      )
    )
    plane.actionManager.registerAction(
      new BABYLON.ExecuteCodeAction(
        BABYLON.ActionManager.OnPointerOutTrigger,
        () => { texture.background = COLOR_BG_NORMAL }
      )
    )

    return { plane, texture, text }
  }

  _clearButtons() {
    for (const b of this._buttons) {
      b.texture?.dispose()
      b.plane?.dispose()
    }
    this._buttons = []
  }

  hide() {
    this._visible = false
    this._clearButtons()
    this._currentGo = null
    this._onSelect = null
  }

  /** Aktuell fokussiertes GameObject (oder null) — für die Gaze-Loop. */
  get currentTarget() { return this._currentGo }

  dispose() {
    if (this._pointerObserver) {
      this.scene.onPointerObservable.remove(this._pointerObserver)
      this._pointerObserver = null
    }
    if (this._renderObserver) {
      this.scene.onBeforeRenderObservable.remove(this._renderObserver)
      this._renderObserver = null
    }
    this._clearButtons()
  }
}
