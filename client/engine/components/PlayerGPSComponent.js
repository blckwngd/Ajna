import { BaseComponent } from "../BaseComponent.js"

export class PlayerGPSComponent extends BaseComponent {

  constructor(geo) {
    super()
    this.geo = geo
    this.watchId = null
  }

  init(gameObject) {
    super.init(gameObject)

    if ("geolocation" in navigator) {
      this.watchId = navigator.geolocation.watchPosition(pos => {

        const { latitude, longitude, altitude } = pos.coords

        const local = this.geo.toLocal(
          latitude,
          longitude,
          altitude ?? 0
        )

        this.gameObject.root.position.copyFrom(local)

      }, err => {
        console.warn("GPS error:", err)
      }, {
        enableHighAccuracy: true
      })
    }
  }

  dispose() {
    if (this.watchId) {
      navigator.geolocation.clearWatch(this.watchId)
    }
  }
}