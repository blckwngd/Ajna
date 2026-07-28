// WorldTracker — visuelles Tracking (8th Wall SLAM) für den Nah-Interaktions-Modus.
//
// Zweck (siehe docs/visual-tracking.md, Spike bestanden): Steht der Spieler nah
// vor einem geo-verankerten Objekt, driftet/schwimmt es, weil GPS Sub-Meter-
// Bewegung nicht sieht und der Kompass jittert. SLAM liefert eine ruhige,
// parallaxen-korrekte Kamera-Pose im Nahbereich. Absolute Position/Meter kommen
// weiter aus GPS/UWB — SLAM taugt NICHT als metrischer Odometer (Spike-Befund).
//
// Architektur (im PoC bewiesen, coexist.html: >45 fps beide Kontexte):
//   • 8th Wall bekommt eine EIGENE Canvas HINTER der App-Babylon-Canvas und
//     zeichnet dort das Kamerabild (GlTextureRenderer) + rechnet SLAM (XrController).
//   • Die App-Szene rendert transparent darüber (wie ArPassthrough).
//   • Dieses Modul liefert nur die rohe Pose (`reality`); die Abbildung auf die
//     rechtshändige App-Kamera macht der Aufrufer (main.js), inkl. Nord-Alignment.
//
// 8th Wall kann KEINEN externen Kamera-Stream übernehmen (im Binary verifiziert) →
// es hält die Kamera selbst. Deshalb Hand-off: ArPassthrough AUS, solange dieser
// Tracker läuft (nur einer darf getUserMedia halten).
//
// Sensor-Voraussetzung: echte IMU-Daten (devicemotion/deviceorientation). Der
// Android-System-WebView und stock Chrome liefern sie; Brave/Firefox blockieren.

const ENGINE_URL = '/poc/slam/engine/xr.js'   // self-hosted; Chunk xr-slam.js liegt daneben

let _enginePromise = null
// xr.js einmal laden (Framework-Loader), auf window.XR8 warten, SLAM-Chunk nachziehen.
function loadEngine() {
  if (_enginePromise) return _enginePromise
  _enginePromise = new Promise((resolve, reject) => {
    const onReady = async () => {
      try {
        // XR8 wird ASYNC gesetzt; kurz pollen, dann SLAM-Chunk laden (setzt XrController).
        for (let i = 0; i < 120 && typeof window.XR8 === 'undefined'; i++) await new Promise(r => setTimeout(r, 50))
        if (typeof window.XR8 === 'undefined') return reject(new Error('XR8 nie definiert'))
        if (!window.XR8.XrController) await window.XR8.loadChunk('slam')
        if (!window.XR8.XrController || !window.XR8.GlTextureRenderer) return reject(new Error('Engine-Module fehlen'))
        resolve(window.XR8)
      } catch (e) { reject(e) }
    }
    if (typeof window.XR8 !== 'undefined') { onReady(); return }
    window.addEventListener('XRloaded', onReady, { once: true })
    window.addEventListener('xrloaded', onReady, { once: true })
    const s = document.createElement('script')
    s.src = ENGINE_URL
    s.crossOrigin = 'anonymous'
    s.onerror = () => reject(new Error('Engine-Script konnte nicht geladen werden: ' + ENGINE_URL))
    document.head.appendChild(s)   // Muster wie MobileShell._ensureAr()
  })
  return _enginePromise
}

export class WorldTracker {
  /** @param {{scene:object, appCanvas:HTMLCanvasElement, skybox?:object}} opts */
  constructor({ scene, appCanvas, skybox }) {
    this.scene = scene
    this.appCanvas = appCanvas
    this.skybox = skybox || null
    this._active = false
    this._starting = false
    this._reality = null      // letzte rohe Pose {position, rotation, intrinsics, trackingStatus}
    this._canvas = null       // 8th-Wall-Kamera-Canvas
    this._origClear = null
    this._onResize = () => this._size()
  }

  get active() { return this._active }
  /** Rohe SLAM-Pose des letzten Frames (oder null). Abbildung macht der Aufrufer. */
  get reality() { return this._reality }
  get trackingStatus() { return this._reality?.trackingStatus || null }

  /** Erkannte Bild-Marker (Image Targets) des letzten Frames: [{name, position,
   *  rotation, scale, …}]. Leer, bis Targets via configureImageTargets() registriert
   *  UND im Bild sind. Liefert die EXAKTE 6DoF-Pose des Markers → Basis für den
   *  metrischen Snap (Marker/UWB > GPS), siehe docs/realworld-remote.md. */
  get detectedImages() { return (this._reality && this._reality.detectedImages) || null }

  /** Bild-Marker registrieren. GERÜST: Die genaue Registrierungs-API des OSS-Builds
   *  ist noch am Gerät zu verifizieren (klassisch XR8.XrController.configure({imageTargets:[…]});
   *  der OSS-Build verarbeitet Ziel-Bilder zur Laufzeit clientseitig). Snap-Logik folgt. */
  configureImageTargets(targets) {
    try { window.XR8 && window.XR8.XrController && window.XR8.XrController.configure({ imageTargets: targets }) }
    catch (e) { console.warn('[worldtracker] configureImageTargets:', e && e.message) }
  }

  _size() {
    if (!this._canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr)
    if (this._canvas.width !== w || this._canvas.height !== h) { this._canvas.width = w; this._canvas.height = h }
  }

  // 8th-Wall-Canvas HINTER die App-Canvas hängen (analog ArPassthrough._ensureVideo).
  _ensureCanvas() {
    if (this._canvas) return this._canvas
    const c = document.createElement('canvas')
    c.id = 'slam-camerafeed'
    Object.assign(c.style, { position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', zIndex: '0' })
    const parent = this.appCanvas?.parentElement || document.body
    if (this.appCanvas && this.appCanvas.parentElement === parent) {
      parent.insertBefore(c, this.appCanvas)               // DOM-Reihenfolge VOR der App-Canvas
      if (getComputedStyle(this.appCanvas).position === 'static') this.appCanvas.style.position = 'relative'
      this.appCanvas.style.zIndex = '1'                    // transparente 3D-Szene darüber
    } else {
      parent.appendChild(c)
    }
    this._canvas = c
    this._size()
    return c
  }

  /**
   * Startet Kamera + SLAM. Löst KEINEN getUserMedia-Konflikt selbst — der
   * Aufrufer muss ArPassthrough vorher deaktiviert haben.
   * @returns {Promise<void>}
   */
  async start() {
    if (this._active || this._starting) return
    this._starting = true
    try {
      const XR8 = await loadEngine()
      const canvas = this._ensureCanvas()
      // Szene transparent + Skybox aus, damit das Kamerabild durchscheint.
      const cc = this.scene.clearColor
      this._origClear = cc ? { r: cc.r, g: cc.g, b: cc.b, a: cc.a } : null
      this.skybox?.setEnabled?.(false)
      this.scene.clearColor?.set?.(0, 0, 0, 0)

      // RH-Szene → leftHandedAxes:false. responsive (relatives Tracking gut; Metrik
      // ist nicht SLAMs Job hier). disableWorldTracking NICHT setzen (Default an).
      XR8.XrController.configure({ leftHandedAxes: false, scale: 'responsive' })
      XR8.addCameraPipelineModules([
        XR8.GlTextureRenderer.pipelineModule(),   // Kamerabild → slam-camerafeed
        XR8.XrController.pipelineModule(),         // SLAM
        {
          name: 'ajna-worldtracker-pose',
          // Kamera-Projektion setzen → reality.intrinsics wird gültig befüllt. Erst
          // damit kann main.js die App-Kamera-Projektion EXAKT aufs Kamerabild
          // freezen (FOV + Hauptpunkt + Aspekt). Ohne das: ferne Objekte driften
          // beim Drehen gegen den Hintergrund (FOV-Mismatch).
          onStart: () => {
            try {
              XR8.XrController.updateCameraProjectionMatrix({
                cam: { pixelRectWidth: canvas.width, pixelRectHeight: canvas.height, nearClipPlane: 0.01, farClipPlane: 200000 },
              })
            } catch {}
          },
          onUpdate: ({ processCpuResult }) => {
            const r = processCpuResult && processCpuResult.reality
            if (r && r.position && r.rotation) this._reality = r
          },
        },
      ])
      window.addEventListener('resize', this._onResize)
      window.addEventListener('orientationchange', this._onResize)
      XR8.run({ canvas })
      this._active = true
    } finally {
      this._starting = false
    }
  }

  /** Stoppt SLAM, gibt die Kamera frei, stellt Szene/Skybox wieder her. */
  stop() {
    if (!this._active) return
    try { window.XR8?.stop?.() } catch {}
    try { window.XR8?.clearCameraPipelineModules?.() } catch {}
    window.removeEventListener('resize', this._onResize)
    window.removeEventListener('orientationchange', this._onResize)
    if (this._canvas) { this._canvas.remove(); this._canvas = null }
    this.skybox?.setEnabled?.(true)
    if (this._origClear) this.scene.clearColor?.set?.(this._origClear.r, this._origClear.g, this._origClear.b, this._origClear.a)
    this._reality = null
    this._active = false
  }
}
