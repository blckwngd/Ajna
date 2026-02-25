export class GPSProvider {

  constructor(options = {}) {

    this.debug = options.debug ?? false
    this.watchId = null
    this.onPositionCallback = null
    this.firstFixResolved = false

    if (!("geolocation" in navigator)) {
      console.error("GPSProvider: Geolocation API not supported in this browser.")
      return
    }

    if (this.debug) {
      console.log("GPSProvider: initialized")
    }
  }

  start() {

    if (this.watchId !== null) {
      if (this.debug) {
        console.warn("GPSProvider: already running")
      }
      return
    }

    if (this.debug) {
      console.log("GPSProvider: requesting position updates...")
    }

    this.watchId = navigator.geolocation.watchPosition(
      position => this.handlePosition(position),
      error => this.handleError(error),
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15000
      }
    )
  }

  stop() {

    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId)

      if (this.debug) {
        console.log("GPSProvider: stopped")
      }

      this.watchId = null
    }
  }

  handlePosition(position) {

    if (this.dummyMode) return

    const coords = position.coords

    const data = {
      lat: coords.latitude,
      lon: coords.longitude,
      altitude: coords.altitude ?? 0,
      accuracy: coords.accuracy,
      altitudeAccuracy: coords.altitudeAccuracy
    }

    if (this.debug) {
      console.log("GPSProvider: position update", data)
    }

    if (this.onPositionCallback) {
      this.onPositionCallback(data)
    }

    if (!this.firstFixResolved && this._firstFixResolver) {
      this.firstFixResolved = true
      this._firstFixResolver(data)

      if (this.debug) {
        console.log("GPSProvider: first fix resolved")
      }
    }
  }

  handleError(error) {

    console.error("GPSProvider: error", error)

    switch (error.code) {
      case error.PERMISSION_DENIED:
        console.error("GPSProvider: user denied geolocation permission")
        break
      case error.POSITION_UNAVAILABLE:
        console.error("GPSProvider: position unavailable")
        break
      case error.TIMEOUT:
        console.error("GPSProvider: request timed out")
        break
    }
  }

  onPosition(callback) {
    this.onPositionCallback = callback
  }

  async waitForFirstFix() {

    if (this.firstFixResolved) {
      if (this.debug) {
        console.log("GPSProvider: first fix already available")
      }
      return
    }

    if (this.debug) {
      console.log("GPSProvider: waiting for first GPS fix...")
    }

    return new Promise(resolve => {
      this._firstFixResolver = resolve
    })
  }

  setDummyPosition(lat, lon, altitude = 0) {

    const data = {
      lat,
      lon,
      altitude,
      accuracy: 0,
      altitudeAccuracy: 0
    }

    console.log("GPSProvider: dummy position set", data)

    if (this.onPositionCallback) {
      this.onPositionCallback(data)
    }
  }

  enableDummyMode(enabled) {
    this.dummyMode = enabled
  }

}