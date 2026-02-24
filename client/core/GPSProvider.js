
export class GPSProvider {
  constructor(callback) {
    navigator.geolocation.watchPosition(
      pos => {
        callback({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          altitude: pos.coords.altitude || 0,
          accuracy: pos.coords.accuracy,
          source: "gps"
        })
      },
      console.error,
      { enableHighAccuracy: true }
    )
  }
}