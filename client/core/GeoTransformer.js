/**
 * GeoTransformer — WGS84 ↔ lokale Babylon-Meter via equirectangulärer
 * Projektion um die Welt-Origin.
 *
 * **Achsen-Konvention** (Default): Z = Nord, X = Ost, Y = Höhe.
 *
 * Beide horizontalen Achsen sind über Konstruktor-Optionen invertierbar
 * — z. B. wenn die Default-Kamera-Blickrichtung des AR-Clients vom
 * Anwender als "Nord = nach hinten" empfunden wird (Mirror-Effekt beim
 * Abgleich mit der Karte):
 *
 *   new GeoTransformer({ invertNorthSouth: true })
 *
 * Wirkung der Flags:
 *   • `invertNorthSouth: true`  →  +lat-Differenz wird zu -Z (statt +Z)
 *   • `invertEastWest: true`    →  +lon-Differenz wird zu -X (statt +X)
 *
 * Beide Flags sind reine Reflexionen — sie ändern die Händigkeit des
 * lokalen Raums. Konsumenten, die auf "Welt-Bearing → lokaler Yaw"-
 * Formeln gestützt sind (z. B. der Walk-Agent), brauchen ggf. eine
 * zusätzliche π-Korrektur auf der Y-Rotation, sobald geflippt wird.
 */
export class GeoTransformer {
  constructor({ invertNorthSouth = false, invertEastWest = false } = {}) {
    this.origin = null
    this.earthRadius = 6378137
    this.invertNorthSouth = invertNorthSouth
    this.invertEastWest   = invertEastWest
  }

  setOrigin(lat, lon, altitude) {
    this.origin = { lat, lon, altitude }
  }

  _signX() { return this.invertEastWest   ? -1 : 1 }
  _signZ() { return this.invertNorthSouth ? -1 : 1 }

  toLocal(lat, lon, altitude = 0) {
    if (!this.origin) return BABYLON.Vector3.Zero()

    const dLat = (lat - this.origin.lat) * Math.PI / 180
    const dLon = (lon - this.origin.lon) * Math.PI / 180

    const meanLat =
      (lat + this.origin.lat) / 2 * Math.PI / 180

    const x = this._signX() * dLon * this.earthRadius * Math.cos(meanLat)
    const z = this._signZ() * dLat * this.earthRadius
    const y = altitude - this.origin.altitude

    return new BABYLON.Vector3(x, y, z)
  }

  toWorld(x, y, z) {
    if (!this.origin) return { lat: 0, lon: 0, altitude: 0 }

    const dLat = this._signZ() * z / this.earthRadius
    const lat = this.origin.lat + dLat * 180 / Math.PI

    const meanLat = (lat + this.origin.lat) / 2 * Math.PI / 180
    const lon = this.origin.lon +
      (this._signX() * x) / (this.earthRadius * Math.cos(meanLat)) * 180 / Math.PI

    const altitude = this.origin.altitude + y

    return { lat, lon, altitude }
  }
}