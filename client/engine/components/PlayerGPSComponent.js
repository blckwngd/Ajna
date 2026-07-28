import { BaseComponent } from "../BaseComponent.js"
import { PositionSmoother } from "../../core/PositionSmoother.js"

// Drives the player's local position from a position source (GPSProvider or the
// FusedPositionSource that prefers UWB). Incoming fixes are fed into a
// PositionSmoother and sampled per frame, so low-rate or jumpy fixes (GPS ~1 Hz,
// UWB bursts, source switches) render smoothly at 60 fps instead of snapping.
export class PlayerGPSComponent extends BaseComponent {

  constructor(gps, geo) {
    super()
    this.gps = gps
    this.geo = geo
    this.unsubscribe = null
    this.smoother = new PositionSmoother()
    // Bodenhöhen-Kalibrierung: Median der ersten GPS-Fixes, dann FESTGESCHRIEBEN.
    this._altSamples = []
    this._groundLocked = false
  }

  // „Höhe über Boden" meint immer ERDBODEN, nicht Spielerniveau. Die Bodenhöhe
  // (AMSL) wird deshalb EINMAL beim Start bestimmt — Median der ersten Fixes,
  // minus Augenhöhe (GPS misst das Gerät, nicht den Boden) — und dann fixiert:
  // so springt nichts mit dem GPS-Höhenrauschen, und 'msl'-Objekte bleiben ruhig.
  // Neu kalibrieren (Standortwechsel): Event 'ajna:recalibrate-ground'.
  _feedAltitude(alt) {
    if (this._groundLocked || !Number.isFinite(alt)) return
    const eye = (() => { try { const v = parseFloat(localStorage.getItem('ajna.ar.eye_height')); return Number.isFinite(v) && v > 0.5 && v < 2.5 ? v : 1.7 } catch { return 1.7 } })()
    this._altSamples.push(alt)
    if (this._altSamples.length >= 8) {
      const s = this._altSamples.slice().sort((a, b) => a - b)
      this.geo.groundAltitude = s[Math.floor(s.length / 2)] - eye
      this._groundLocked = true
    } else {
      this.geo.groundAltitude = alt - eye   // vorläufig, bis genug Fixes da sind
    }
  }

  init(gameObject) {
    super.init(gameObject)

    this.unsubscribe = this.gps.onPosition(pos => { this.smoother.feed(pos); this._feedAltitude(pos?.altitude) })
    this._onRecal = () => { this._groundLocked = false; this._altSamples = [] }
    try { window.addEventListener('ajna:recalibrate-ground', this._onRecal) } catch {}

    // Falls schon ein Fix vorliegt (z. B. persistierter Dummy beim Boot),
    // ohne auf das nächste Event zu warten initial einfüttern.
    const initial = this.gps.getWorldPosition?.()
    if (initial) { this.smoother.feed(initial); this._feedAltitude(initial.altitude) }
  }

  update(/* deltaTime */) {
    // Eingefroren (z. B. SLAM-Nahmodus treibt die Position selbst): GPS-Anker
    // festhalten, damit GPS-Jitter das lokale SLAM-Umrunden nicht stört.
    if (this.paused) return
    // Solange kein Welt-Origin gesetzt ist, bringt toLocal nichts —
    // sobald der Origin steht, setzt der nächste Frame den Player korrekt.
    if (!this.geo.origin) return

    const snap = this.smoother.sample()
    if (!snap) return
    // Bodenhöhe wird NICHT mehr pro Frame nachgeführt — sie ist beim Start aus
    // den ersten Fixes festgeschrieben (siehe _feedAltitude): "über dem Boden"
    // heißt Erdboden, und der wackelt nicht mit dem GPS-Höhenrauschen.

    // Der Spieler steht IMMER auf der Bodenebene (Y=0); die Kamera sitzt über
    // CameraComponent auf Augenhöhe darüber. Die GPS-Höhe fließt bewusst NICHT
    // in die Spieler-Y ein (sonst schwebte er bei Origin-/Höhen-Versatz oder
    // GPS-Höhenrauschen) — nur X/Z folgen der Position.
    const local = this.geo.toLocal(snap.lat, snap.lon, 0)
    local.y = 0
    this.gameObject.root.position.copyFrom(local)
  }

  dispose() {
    if (this.unsubscribe) this.unsubscribe()
    try { window.removeEventListener('ajna:recalibrate-ground', this._onRecal) } catch {}
  }
}
