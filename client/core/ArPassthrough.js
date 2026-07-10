// Schaltet die AR-Ansicht zwischen echtem AR und XR um.
//
//   • Echtes AR: die Geräte-Kamera läuft als Passthrough in einem <video>
//     HINTER dem Babylon-Canvas. Die Szene rendert mit transparentem
//     clearColor (Alpha 0) und ausgeblendeter Skybox, sodass die Kamera
//     durchscheint. 3D-Inhalte (Gebäude, Pfade, Objekte) bleiben sichtbar.
//   • XR: Kamera aus, Skybox an (bisheriges Verhalten).
//
// Der Zustand wird in localStorage gemerkt (über AR-/Map-Seiten hinweg). Kein
// BABYLON-Import nötig — wir mutieren nur scene.clearColor (Color4.set).

const STORAGE_KEY = 'ajna_ar_passthrough'

// Rückkamera bevorzugt (ideal, damit ein Gerät ohne Rückkamera trotzdem die
// Frontkamera liefert statt zu scheitern). Geteilt von enable() und resume().
const CAMERA_CONSTRAINTS = { video: { facingMode: { ideal: 'environment' } }, audio: false }

export class ArPassthrough {
  /** @param {{scene:object, skybox?:object, canvas?:HTMLCanvasElement}} opts */
  constructor({ scene, skybox, canvas }) {
    this.scene = scene
    this.skybox = skybox || null
    this.canvas = canvas || null
    this._enabled = false
    this._stream = null
    this._video = null
    // Ursprüngliche Hintergrundfarbe sichern, um XR sauber wiederherzustellen.
    const c = scene.clearColor
    this._origClear = c ? { r: c.r, g: c.g, b: c.b, a: c.a } : null
  }

  /** Persistierter Wunschzustand (für die initiale Toggle-Stellung). */
  static isPersistedOn() {
    try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
  }

  get enabled() { return this._enabled }
  /** Das <video>-Element (für FOV-Kalibrierung: videoWidth/Height). */
  get video() { return this._video }

  _ensureVideo() {
    if (this._video) return this._video
    const v = document.createElement('video')
    v.id = 'ar-passthrough-video'
    v.autoplay = true
    v.muted = true
    v.playsInline = true
    v.setAttribute('playsinline', '')   // iOS-Inline statt Vollbild
    // position:absolute (NICHT fixed) + Einhängen in den Canvas-Container, damit
    // das Video genau hinter dem AR-Canvas liegt und mit ihm versteckt wird,
    // wenn der AR-Tab (.shell-view) inaktiv/display:none ist. DOM-Reihenfolge
    // VOR dem Canvas → der (transparente) Canvas rendert darüber, das Editor-UI
    // (höherer z-index) bleibt oben.
    Object.assign(v.style, {
      position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
      objectFit: 'cover', background: '#000', display: 'none', zIndex: '0'
    })
    const parent = this.canvas?.parentElement || document.body
    if (this.canvas && this.canvas.parentElement === parent) {
      parent.insertBefore(v, this.canvas)
      // Der Canvas MUSS über dem Video liegen, sonst verdeckt das (positionierte)
      // Video die transparent gerenderten 3D-Objekte. Ein statischer Canvas wird
      // von einem positionierten Geschwister immer überzeichnet → Canvas selbst
      // positionieren + höheren z-index geben. (Editor-#ui hat z-index 10, bleibt
      // oben.)
      if (getComputedStyle(this.canvas).position === 'static') {
        this.canvas.style.position = 'relative'
      }
      this.canvas.style.zIndex = '1'
    } else {
      parent.appendChild(v)
    }
    this._video = v
    return v
  }

  /** @param {boolean} on */
  async setEnabled(on) { return on ? this.enable() : this.disable() }
  async toggle() { return this.setEnabled(!this._enabled) }

  async enable() {
    if (this._enabled) return
    const video = this._ensureVideo()
    try {
      this._stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS)
    } catch (err) {
      console.warn('[ar] Kamera-Zugriff fehlgeschlagen:', err?.message || err)
      throw new Error('Kamera nicht verfügbar (Berechtigung erteilt?)')
    }
    video.srcObject = this._stream
    video.style.display = 'block'
    try { await video.play() } catch {}
    if (this.skybox) this.skybox.setEnabled(false)
    this.scene.clearColor?.set?.(0, 0, 0, 0)   // transparent → Kamera scheint durch
    this._enabled = true
    this._persist(true)
  }

  disable() {
    if (this._stream) {
      this._stream.getTracks().forEach(t => { try { t.stop() } catch {} })
      this._stream = null
    }
    if (this._video) { this._video.srcObject = null; this._video.style.display = 'none' }
    if (this.skybox) this.skybox.setEnabled(true)
    const o = this._origClear
    if (o) this.scene.clearColor?.set?.(o.r, o.g, o.b, o.a)
    this._enabled = false
    this._persist(false)
  }

  /**
   * Kamerabild wieder anwerfen, nachdem der AR-Tab versteckt war oder die App
   * im Hintergrund lag. Zwei Fälle:
   *   • Tab-Wechsel: der Stream lebt noch, aber das <video> wurde pausiert
   *     (Browser stoppt Wiedergabe in einem display:none-Subtree) → play().
   *   • App minimiert/wieder geöffnet: Android gibt die Kamera frei, der Track
   *     ENDET (stream.active=false / readyState='ended') → play() bringt nichts,
   *     der Stream muss frisch geholt werden.
   * No-op, wenn AR-Passthrough nicht aktiv ist. Reentrancy-geschützt, damit ein
   * gleichzeitiges arResume + visibilitychange nicht zwei getUserMedia auslöst.
   */
  async resume() {
    if (!this._enabled || !this._video || this._resuming) return
    this._resuming = true
    try {
      const track = this._stream?.getVideoTracks?.()[0]
      const dead = !this._stream || !this._stream.active || !track || track.readyState === 'ended'
      if (dead) {
        try { this._stream?.getTracks().forEach(t => { try { t.stop() } catch {} }) } catch {}
        this._stream = null
        try {
          this._stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS)
          this._video.srcObject = this._stream
        } catch (err) {
          console.warn('[ar] Kamera-Reaktivierung fehlgeschlagen:', err?.message || err)
          return
        }
      }
      try { await this._video.play() } catch {}
    } finally {
      this._resuming = false
    }
  }

  _persist(on) {
    try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0') } catch {}
  }
}
