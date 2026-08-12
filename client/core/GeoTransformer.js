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
    // Bodenhöhe (AMSL) am Spieler — vom PlayerGPSComponent gepflegt. Referenz
    // für die Umrechnung von "über Normalnull"-Objekthöhen (siehe toLocalRef).
    this.groundAltitude = null
    // Höhenquelle fürs Gelände (setTerrain) — solange null, ist die Welt eben.
    this.terrain = null
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

  /**
   * Wie toLocal, aber die Höhe wird gemäß Referenz interpretiert:
   *  • 'ground' (Default): `altitude` = Höhe ÜBER BODEN (AGL). Die Bodenebene
   *    liegt bei Y=0 (der Spieler steht darauf) → Y = altitude. So sitzen
   *    NPCs/Items bei altitude 0 am Boden und fliegende Objekte schweben um
   *    ihre AGL-Höhe darüber.
   *  • 'msl': `altitude` = Höhe über Normalnull (AMSL) → Y relativ zur
   *    Bodenhöhe am Spieler (groundAltitude), sonst zur Origin-Höhe. So
   *    erscheinen Echtwelt-Objekte (z. B. Flugzeuge) in korrekter absoluter Höhe.
   * X/Z sind in beiden Fällen identisch (horizontale Projektion).
   * @returns {BABYLON.Vector3}
   */
  toLocalRef(lat, lon, altitude = 0, ref = 'ground') {
    const v = this.toLocal(lat, lon, 0)   // nur X/Z nutzen; Y unten setzen
    if (ref === 'msl') {
      const ground = Number.isFinite(this.groundAltitude)
        ? this.groundAltitude
        : (this.origin?.altitude || 0)
      v.y = altitude - ground
    } else {
      // AGL: auf das GELÄNDE aufsetzen, nicht auf die Startebene. Ohne
      // geladenes Relief bleibt es beim alten Verhalten (ebener Boden y=0).
      v.y = this.terrainHeightAt(lat, lon) + altitude
    }
    return v
  }

  /**
   * Geländehöhe (relativ zum Origin-Boden) an einer Weltkoordinate.
   * Liefert 0, solange kein Relief geladen ist — dann verhält sich alles wie
   * auf der ebenen Startfläche.
   * @returns {number} Meter
   */
  terrainHeightAt(lat, lon) {
    const h = this.terrain?.elevationAt?.(lat, lon)
    return Number.isFinite(h) ? h : 0
  }

  /**
   * Höhenquelle setzen — ein Objekt mit `elevationAt(lat, lon)` in Metern
   * RELATIV zum Origin-Boden (siehe engine/environment/Terrain.js). Damit
   * folgen alle AGL-Objekte (Figuren, Items, Marker, UWB-Anker) dem Relief,
   * ohne dass ihre Aufrufer etwas davon wissen müssen.
   * @param {{elevationAt(lat:number, lon:number): number|null}|null} provider
   * @param {number} [originAltitudeM]  absolute Geländehöhe am Origin (ü. NN);
   *        setzt groundAltitude, damit auch 'msl'-Objekte (Flugzeuge) stimmen.
   */
  setTerrain(provider, originAltitudeM) {
    this.terrain = provider || null
    if (Number.isFinite(originAltitudeM)) this.groundAltitude = originAltitudeM
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