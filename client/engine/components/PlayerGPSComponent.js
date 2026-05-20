import { BaseComponent } from "../BaseComponent.js"

export class PlayerGPSComponent extends BaseComponent {

  constructor(gps, geo) {
    super()
    this.gps = gps
    this.geo = geo
    this.unsubscribe = null
  }

  init(gameObject) {
    super.init(gameObject)

    this.unsubscribe = this.gps.onPosition(pos => this._applyPosition(pos))

    // Falls schon ein Fix vorliegt (z. B. persistierter Dummy beim Boot),
    // ohne auf das nächste Event zu warten initial setzen.
    const initial = this.gps.getWorldPosition()
    if (initial) this._applyPosition(initial)
  }

  _applyPosition(pos) {
    // Solange kein Welt-Origin gesetzt ist, bringt toLocal nichts —
    // der nächste Event nach Origin-Setup setzt den Player korrekt.
    if (!this.geo.origin) return

    const local = this.geo.toLocal(
      pos.lat,
      pos.lon,
      pos.altitude ?? 0
    )

    this.gameObject.root.position.copyFrom(local)
  }

  dispose() {
    if (this.unsubscribe) this.unsubscribe()
  }
}
