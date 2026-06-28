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
  }

  init(gameObject) {
    super.init(gameObject)

    this.unsubscribe = this.gps.onPosition(pos => this.smoother.feed(pos))

    // Falls schon ein Fix vorliegt (z. B. persistierter Dummy beim Boot),
    // ohne auf das nächste Event zu warten initial einfüttern.
    const initial = this.gps.getWorldPosition?.()
    if (initial) this.smoother.feed(initial)
  }

  update(/* deltaTime */) {
    // Solange kein Welt-Origin gesetzt ist, bringt toLocal nichts —
    // sobald der Origin steht, setzt der nächste Frame den Player korrekt.
    if (!this.geo.origin) return

    const snap = this.smoother.sample()
    if (!snap) return

    // Die GPS-Höhe (AMSL) ist die Bodenhöhe am Spieler — als Referenz für
    // "über Normalnull"-Objekte mitführen (siehe GeoTransformer.toLocalRef).
    if (Number.isFinite(snap.altitude)) this.geo.groundAltitude = snap.altitude

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
  }
}
