const STORAGE_KEY_MODE = "ajna.gps.dummyMode"
const STORAGE_KEY_POSITION = "ajna.gps.dummyPosition"
// Zuletzt gesehene ECHTE Position. Beim nächsten Start beginnt die Szene dort,
// statt am Standard-Dummy: der Geo-Ursprung steht damit sofort ungefähr richtig,
// Kulisse und Interessensbereich werden gleich für die richtige Gegend geholt.
// Ohne das startete jeder Hard-Reload am zuletzt von Hand gesetzten Punkt — und
// alles sprang erst beim ersten Fix mehrere Kilometer weit.
const STORAGE_KEY_LAST = "ajna.gps.lastKnown"
// Schreiben kostet Zeit im Hauptthread; ein Fix pro Sekunde muss nicht jedes
// Mal auf die Platte. Gespeichert wird, was sich lohnt: alle 15 s ODER nach
// 25 m Bewegung.
const PERSIST_MS = 15_000
const PERSIST_MOVE_M = 25

// Wird benutzt, wenn dummyMode aktiv ist (Boot oder Toggle), aber noch
// keine eigene Dummy-Position über das Debug-UI gesetzt wurde. Ohne
// diese Invariante würde gps.start() nichts broadcasten — waitForOrigin
// in main.js hängt dann endlos und Szene, Gitter sowie Objekt-Liste
// bleiben leer.
const DEFAULT_DUMMY_POSITION = {
  lat: 50.45131870958352,
  lon: 7.536272555643111,
  altitude: 0
}

export class GPSProvider {

  constructor(options = {}) {

    this.debug = options.debug ?? false
    this.watchId = null
    this.firstFixResolved = false
    this._firstFixResolver = null

    // Mehrere Subscriber unterstützen (PlayerGPSComponent, später Map etc.)
    this.listeners = new Set()

    // Persistierte Dummy-Konfiguration aus dem Browser-Storage laden.
    // Damit kann eine im DebugUI gesetzte Dummy-Position über Reloads
    // hinweg als schneller Startpunkt genutzt werden.
    this.dummyMode = this._readBool(STORAGE_KEY_MODE, false)
    this.dummyPosition = this._readJSON(STORAGE_KEY_POSITION, null)
    this.lastKnown = this._lesePosition(STORAGE_KEY_LAST)
    this._persistAt = 0

    // Invariante: dummyMode aktiv ⇒ dummyPosition existiert. Sonst
    // hätten weder Boot noch späterer Toggle eine Position zum Broadcasten.
    if (this.dummyMode && !this.dummyPosition) {
      this._setDefaultDummyPosition()
    }

    // Startpunkt der Szene, damit getWorldPosition() ohne Wartezeit eine
    // sinnvolle Antwort hat. Source explizit setzen — wird sonst erst beim
    // ersten _applyData markiert.
    const start = this._startPosition()
    this.data = start ? { ...start } : null

    if (!("geolocation" in navigator)) {
      console.error("GPSProvider: Geolocation API not supported in this browser.")
    }

    if (this.debug) {
      console.log("GPSProvider: initialized", {
        dummyMode: this.dummyMode,
        dummyPosition: this.dummyPosition
      })
    }
  }

  start() {

    // Dummy zuerst broadcasten: löst waitForFirstFix() sofort aus und
    // erlaubt main.js, Origin zu setzen und Objekte zu laden, ohne auf
    // den realen GPS-Fix zu warten.
    const start = this._startPosition()
    if (start) {
      this._applyData(start)
    }

    if (!this.dummyMode) {
      this._startRealWatch()
    }
  }

  stop() {
    this._stopRealWatch()
  }

  _startRealWatch() {

    if (this.watchId !== null) return
    if (!("geolocation" in navigator)) return

    if (this.debug) {
      console.log("GPSProvider: starting real watchPosition")
    }

    this.watchId = navigator.geolocation.watchPosition(
      position => this._handleRealPosition(position),
      error => this._handleError(error),
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15000
      }
    )
  }

  _stopRealWatch() {

    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId)
      this.watchId = null

      if (this.debug) {
        console.log("GPSProvider: real watchPosition stopped")
      }
    }
  }

  _handleRealPosition(position) {

    // Im Dummy-Modus überstimmt die Dummy-Position alle echten Updates.
    if (this.dummyMode) return

    const coords = position.coords

    this._applyData({
      lat: coords.latitude,
      lon: coords.longitude,
      altitude: coords.altitude ?? 0,
      accuracy: coords.accuracy,
      altitudeAccuracy: coords.altitudeAccuracy,
      // Kurs über Grund (0 = Nord). Das Betriebssystem liefert ihn nur, wenn
      // man sich BEWEGT — im Stand und am Schreibtisch ist er null. Für Geräte
      // ohne Magnetometer ist er die einzige Blickrichtung, die es gibt; die
      // Minimap richtet sich danach aus, wenn die Kamera keine liefert.
      heading: Number.isFinite(coords.heading) ? coords.heading : undefined,
      source: "real"
    })

    this._merkePosition(coords)
  }

  // ── Startpunkt über Neustarts hinweg ────────────────────────────────────

  /**
   * Womit die Szene startet, bevor der erste echte Fix da ist.
   *
   * Reihenfolge mit Absicht:
   *   1. Dummy-Modus an → die von Hand gesetzte Position. Sie IST die Ansage
   *      des Anwenders und darf von nichts überstimmt werden.
   *   2. Sonst die zuletzt gesehene echte Position — der beste Schätzwert
   *      dafür, wo das Gerät gleich sein wird.
   *   3. Sonst eine gesetzte Dummy-Position (immer noch besser als nichts).
   *
   * @returns {{lat:number, lon:number, altitude:number, source:string}|null}
   */
  _startPosition() {
    if (this.dummyMode && this.dummyPosition) return { source: "dummy", ...this.dummyPosition }
    if (this.lastKnown) return { source: "last", ...this.lastKnown }
    if (this.dummyPosition) return { source: "dummy", ...this.dummyPosition }
    return null
  }

  /** Echte Position sichern — gedrosselt nach Zeit UND Weg. */
  _merkePosition(coords) {
    const jetzt = Date.now()
    const weit = !this.lastKnown || this._abstandM(this.lastKnown, coords) >= PERSIST_MOVE_M
    if (!weit && jetzt - this._persistAt < PERSIST_MS) return
    this._persistAt = jetzt
    const pos = {
      lat: coords.latitude,
      lon: coords.longitude,
      altitude: coords.altitude ?? 0,
      t: jetzt,
    }
    this.lastKnown = pos
    this._writeJSON(STORAGE_KEY_LAST, pos)
  }

  /**
   * Öffentlicher Startpunkt für Ansichten, die vor dem ersten Fix schon etwas
   * zeigen müssen (Karten-Zentrum, Szenen-Ursprung). Dieselbe Rangfolge wie
   * intern — wichtig, damit Karte und 3D-Ansicht am selben Ort beginnen.
   * @returns {{lat:number, lon:number, altitude:number, source:string}|null}
   */
  getStartPosition() { return this._startPosition() }

  /** Gespeicherte Position lesen und auf Plausibilität prüfen. */
  _lesePosition(key) {
    const p = this._readJSON(key, null)
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return null
    if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return null
    return p
  }

  /** Grobe Meter-Distanz — reicht für eine Schreibschwelle völlig. */
  _abstandM(a, b) {
    const bLat = b.lat ?? b.latitude, bLon = b.lon ?? b.longitude
    return Math.hypot((bLat - a.lat) * 111320,
      (bLon - a.lon) * 111320 * Math.cos(a.lat * Math.PI / 180))
  }

  /** Gemerkte Position verwerfen (Debug-UI / Ortswechsel von Hand). */
  clearLastKnown() {
    this.lastKnown = null
    try { localStorage.removeItem(STORAGE_KEY_LAST) } catch { /* privater Modus */ }
  }

  _handleError(error) {

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

  // Zentraler Eintrittspunkt — egal ob die Daten von Dummy oder Real kommen.
  _applyData(data) {

    this.data = { source: "dummy", ...data }

    if (this.debug) {
      console.log("GPSProvider: position update", this.data)
    }

    if (!this.firstFixResolved && this._firstFixResolver) {
      this.firstFixResolved = true
      this._firstFixResolver(this.data)
    } else if (!this.firstFixResolved) {
      // Falls noch niemand auf waitForFirstFix() wartet, trotzdem als
      // resolved markieren — Subscriber bekommen die Daten direkt.
      this.firstFixResolved = true
    }

    this.listeners.forEach(listener => {
      try {
        listener(this.data)
      } catch (e) {
        console.error("GPSProvider: listener error", e)
      }
    })
  }

  onPosition(callback) {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  async waitForFirstFix() {

    if (this.firstFixResolved) {
      return this.data
    }

    return new Promise(resolve => {
      this._firstFixResolver = resolve
    })
  }

  getWorldPosition() {
    return this.data
  }

  // Inject an external real fix (e.g. native Capacitor Geolocation on Android,
  // where the WebView's navigator.geolocation often never fires). Ignored in
  // dummy mode, like real WebView updates.
  ingest(lat, lon, altitude = 0, accuracy = 0) {
    if (this.dummyMode) return
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
    this._applyData({ lat, lon, altitude: altitude ?? 0, accuracy, source: "real" })
  }

  // ---- Dummy-Steuerung ----

  setDummyPosition(lat, lon, altitude = 0) {

    const position = {
      lat,
      lon,
      altitude,
      accuracy: 0,
      altitudeAccuracy: 0,
      source: "dummy"
    }

    this.dummyPosition = position
    this._writeJSON(STORAGE_KEY_POSITION, position)

    // Auch wenn dummyMode aus ist: der Anwender hat die Position explizit
    // gesetzt — sofort anwenden. Bei aktivem dummyMode bleibt sie ohnehin
    // bestehen; bei inaktivem überschreibt der nächste echte Fix sie wieder.
    this._applyData(position)
  }

  clearDummyPosition() {
    this.dummyPosition = null
    localStorage.removeItem(STORAGE_KEY_POSITION)
  }

  enableDummyMode(enabled) {

    if (this.dummyMode === enabled) return

    // Toggle ON ohne hinterlegte Dummy-Position: Default verwenden,
    // damit immer ein Broadcast erfolgt (sonst kein Badge-Update,
    // kein Origin, etc.). siehe DEFAULT_DUMMY_POSITION oben.
    if (enabled && !this.dummyPosition) {
      this._setDefaultDummyPosition()
    }

    this.dummyMode = enabled
    this._writeBool(STORAGE_KEY_MODE, enabled)

    if (enabled) {
      this._stopRealWatch()
      this._applyData(this.dummyPosition)
    } else {
      this._startRealWatch()
    }
  }

  _setDefaultDummyPosition() {
    this.dummyPosition = { ...DEFAULT_DUMMY_POSITION, source: "dummy" }
    this._writeJSON(STORAGE_KEY_POSITION, this.dummyPosition)
  }

  isDummyMode() {
    return this.dummyMode
  }

  getDummyPosition() {
    return this.dummyPosition
  }

  // ---- localStorage Helper ----

  _readBool(key, fallback) {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : raw === "true"
  }

  _writeBool(key, value) {
    localStorage.setItem(key, value ? "true" : "false")
  }

  _readJSON(key, fallback) {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    try {
      return JSON.parse(raw)
    } catch {
      return fallback
    }
  }

  _writeJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value))
  }
}
