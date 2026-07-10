// ArFovCalibration — gleicht das FOV der virtuellen AR-Kamera an das ANGEZEIGTE
// Sichtfeld des echten Kamerabilds an, damit das Bodengitter beim Neigen (Pitch)
// zum realen Boden passt statt stärker zu kippen.
//
// Warum nötig: die Kamera ist eine UniversalCamera mit Babylon-Default-FOV (~46°
// vertikal), das reale Kamerabild läuft als <video object-fit:cover> mit einem
// gerätespezifisch beschnittenen Sichtfeld. Der Browser liefert das echte
// Kamera-FOV nicht → wir SCHÄTZEN es aus den Video-Maßen (Cover-Crop) und lassen
// den Nutzer per Slider FEINJUSTIEREN (pro Gerät in localStorage).
//
// Modell: FOVMODE_VERTICAL_FIXED (Default) → camera.fov IST das vertikale FOV,
// horizontal folgt aus dem Canvas-Aspekt. Da Video (cover) und Canvas beide den
// Screen-Aspekt füllen, genügt es, das vertikale FOV anzugleichen.

const FACTOR_KEY  = 'ajna.ar.fov_factor'
const SENSOR_HFOV = 67 * Math.PI / 180   // Annahme typische Handy-Rückkamera (horizontal); Faktor korrigiert Abweichung

export class ArFovCalibration {
  /**
   * @param {{camera:object, getVideo:()=>HTMLVideoElement|null, getCanvas:()=>HTMLElement|null, parent?:HTMLElement}} opts
   */
  constructor({ camera, getVideo, getCanvas, parent = document.body }) {
    this.camera = camera
    this.getVideo = getVideo
    this.getCanvas = getCanvas
    this.parent = parent
    this._defaultFov = camera?.fov ?? 0.8
    this.factor = this._load()
    this._el = null
    this._videoBound = null
  }

  _load() {
    const v = parseFloat(localStorage.getItem(FACTOR_KEY))
    return Number.isFinite(v) && v >= 0.3 && v <= 2.5 ? v : 1
  }
  _save() { try { localStorage.setItem(FACTOR_KEY, String(this.factor)) } catch {} }

  // Geschätztes ANGEZEIGTES vertikales FOV des Kamerabilds (rad); null wenn das
  // Video noch keine Maße hat.
  _baseFov() {
    const v = this.getVideo?.()
    const c = this.getCanvas?.()
    const cw = c?.clientWidth || c?.width
    const ch = c?.clientHeight || c?.height
    if (!v?.videoWidth || !v?.videoHeight || !cw || !ch) return null
    const videoAspect = v.videoWidth / v.videoHeight
    const screenAspect = cw / ch
    const sensorVFov = 2 * Math.atan(Math.tan(SENSOR_HFOV / 2) / videoAspect)
    // object-fit: cover — vertikal wird nur beschnitten, wenn das Video SCHMALER
    // (höher) als der Screen ist; sonst füllt es die Höhe voll aus.
    if (videoAspect >= screenAspect) return sensorVFov
    return 2 * Math.atan(Math.tan(sensorVFov / 2) * (videoAspect / screenAspect))
  }

  apply() {
    if (!this.camera) return
    const base = this._baseFov() ?? this._defaultFov
    this.camera.fov = Math.max(0.2, Math.min(2.2, base * this.factor))
    this._updateLabel()
  }

  /** XR-/Free-Modus: virtuelle Kamera auf ihr Default-FOV zurücksetzen. */
  reset() { if (this.camera) this.camera.fov = this._defaultFov }

  setFactor(f) {
    this.factor = Math.max(0.3, Math.min(2.5, f))
    this._save()
    this.apply()
  }

  // Slider einblenden (nur bei aktivem Kamera-Passthrough). Bindet einmalig den
  // loadedmetadata-Handler des Videos, damit das FOV neu berechnet wird, sobald
  // die echten Maße da sind.
  show() {
    if (!this._el) this._build()
    this._el.style.display = 'flex'
    this._bindVideo()
    this.apply()
  }
  hide() { if (this._el) this._el.style.display = 'none' }

  _bindVideo() {
    const v = this.getVideo?.()
    if (!v || this._videoBound === v) return
    this._videoBound = v
    v.addEventListener('loadedmetadata', () => this.apply())
    v.addEventListener('resize', () => this.apply())   // Auflösung/Orientierung geändert
  }

  _build() {
    const wrap = document.createElement('div')
    wrap.className = 'ar-fov-cal'
    wrap.style.cssText =
      'position:absolute;left:50%;transform:translateX(-50%);' +
      'bottom:calc(env(safe-area-inset-bottom, 0px) + 74px);z-index:1000;' +
      'display:flex;align-items:center;gap:8px;background:rgba(0,0,0,.6);color:#fff;' +
      'font:12px system-ui,sans-serif;padding:6px 10px;border-radius:8px;' +
      'backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);user-select:none'
    wrap.innerHTML =
      '<span title="Bodengitter an reales Kamerabild angleichen">FOV</span>' +
      '<input type="range" min="0.5" max="2.0" step="0.02" style="width:150px">' +
      '<span class="ar-fov-val" style="min-width:34px;text-align:right"></span>'
    const range = wrap.querySelector('input')
    range.value = String(this.factor)
    // Slider fängt Pointer/Touch selbst (sonst würde der AR-Kompass mitscrollen).
    ;['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'click'].forEach(ev =>
      wrap.addEventListener(ev, e => e.stopPropagation()))
    range.addEventListener('input', () => this.setFactor(parseFloat(range.value)))
    this._range = range
    this._val = wrap.querySelector('.ar-fov-val')
    this.parent.appendChild(wrap)
    this._el = wrap
  }

  _updateLabel() {
    if (this._val) this._val.textContent = `${Math.round((this.camera?.fov || 0) * 180 / Math.PI)}°`
    if (this._range && parseFloat(this._range.value) !== this.factor) this._range.value = String(this.factor)
  }
}
