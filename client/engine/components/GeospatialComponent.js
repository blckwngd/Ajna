import { BaseComponent } from "../BaseComponent.js"

export class GeospatialComponent extends BaseComponent {

  constructor(geo, lat, lon, altitude = 0) {
    super()
    this.geo = geo
    this.lat = lat
    this.lon = lon
    this.altitude = altitude
  }

  update() {
    const local = this.geo.toLocal(
      this.lat,
      this.lon,
      this.altitude
    )

    this.gameObject.root.position.copyFrom(local)
  }

  setCoordinates(lat, lon, altitude = 0) {
    this.lat = lat
    this.lon = lon
    this.altitude = altitude
  }
}