export class GeoTransformer {
  constructor() {
    this.origin = null
    this.earthRadius = 6378137
  }

  setOrigin(lat, lon, altitude) {
    this.origin = { lat, lon, altitude }
  }

  toLocal(lat, lon, altitude = 0) {
    if (!this.origin) return BABYLON.Vector3.Zero()

    const dLat = (lat - this.origin.lat) * Math.PI / 180
    const dLon = (lon - this.origin.lon) * Math.PI / 180

    const meanLat =
      (lat + this.origin.lat) / 2 * Math.PI / 180

    const x = dLon * this.earthRadius * Math.cos(meanLat)
    const z = dLat * this.earthRadius
    const y = altitude - this.origin.altitude

    return new BABYLON.Vector3(x, y, z)
  }

  toWorld(x, y, z) {
    if (!this.origin) return { lat: 0, lon: 0, altitude: 0 }

    const dLat = z / this.earthRadius
    const lat = this.origin.lat + dLat * 180 / Math.PI

    const meanLat = (lat + this.origin.lat) / 2 * Math.PI / 180
    const lon = this.origin.lon +
      x / (this.earthRadius * Math.cos(meanLat)) * 180 / Math.PI

    const altitude = this.origin.altitude + y

    return { lat, lon, altitude }
  }
}