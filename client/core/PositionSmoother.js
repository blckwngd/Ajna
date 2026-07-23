// PositionSmoother — frameweise Interpolation einer geo-getaggten Position
// (lat/lon/altitude + Rotation).
//
// Frei von BABYLON, Leaflet und allen Render-Engines. Wird sowohl vom
// AR-Client (über GameObject) als auch vom Map-Client (Marker-Animation)
// genutzt, damit Realtime-Updates bei niedriger Rate (z. B. 5 Hz Agent-
// Ticks) auf der Anzeige-Seite (60 fps) flüssig wirken.
//
// Pattern:
//   const sm = new PositionSmoother()
//   // bei jedem eintreffenden Realtime-Update:
//   sm.feed(record)
//   // pro Frame:
//   const snap = sm.sample()
//   if (snap) applyToRenderObject(snap)
//
// Semantik:
//   • Pro `feed()` werden prev → curr verschoben, curr = neue Daten.
//   • `sample(now)` liefert die linear interpolierte Position zwischen
//     prev und curr, basierend auf der Zeit seit dem letzten feed().
//   • Sind prev und curr identisch (Re-feed ohne Datenänderung), bleibt
//     der State unverändert — die Interpolations-Dauer wird nicht
//     unnötig geschrumpft.
//   • Wenn die Lücke zwischen feeds > MAX_INTERP_MS ist (z. B. ein
//     manueller Klick nach längerer Pause), wird gesnappt statt
//     interpoliert — kein "Slow-Creep" nach langer Inaktivität.
//
// Rotationen werden auf dem kürzesten Winkelweg lerped (±π-Wraparound).

// Snap-Cap: bei einer Lücke > MAX_INTERP_MS wird gesnappt statt
// interpoliert. Dimensioniert so, dass die regulären Agent-Tick-Raten
// (aktuell 500 ms) plus etwas Jitter-Spielraum unterhalb des Caps bleiben.
const MAX_INTERP_MS = 1500

// Dead-Reckoning (Extrapolation) für Objekte, die state.adsb tragen — Flugzeuge
// aus dem OpenSky-Agenten. Die kommen wegen des API-Limits nur alle ~30 s, würden
// also snappen. Statt zwischen zwei Messungen zu INTERPOLIEREN (und damit ein
// Update hinterherzuhinken) rechnen wir aus der letzten Messung + Geschwindigkeit/
// Kurs die AKTUELLE Position frameweise VORAUS. Läuft der Agent aus (Budget/stale),
// friert die Extrapolation nach MAX_DR_MS ein, bis das Stale-Cleanup greift.
const MAX_DR_MS = 150000

export class PositionSmoother {
  constructor() {
    this.prev = null
    this.curr = null
  }

  /**
   * Neues Ziel einfüttern. Akzeptiert PB-Records (lat/lon/altitude/rotation)
   * oder beliebige Objekte mit derselben Form.
   * @param {object} record
   * @param {number} [now=performance.now()]
   */
  feed(record, now = performance.now()) {
    if (!record || !Number.isFinite(record.lat) || !Number.isFinite(record.lon)) return false
    const snap = _snapFromRecord(record, now)
    if (this.curr && _sameTarget(this.curr, snap)) return false   // No-op: keine Bewegung
    this.prev = this.curr
    this.curr = snap
    return true
  }

  /**
   * True, wenn keine laufende Interpolation mehr ansteht (Ziel erreicht oder
   * gesnappt). Konsumenten (Map-Loop) können damit „ruhende" Objekte aus dem
   * Pro-Frame-Update nehmen, statt jeden Frame dieselbe Position zu schreiben.
   * @param {number} [now=performance.now()]
   */
  isSettled(now = performance.now()) {
    if (this.curr?.dr) return false          // Flugzeug: extrapoliert dauerhaft
    if (!this.curr || !this.prev) return true
    const duration = this.curr.t - this.prev.t
    if (duration <= 0 || duration > MAX_INTERP_MS) return true
    return (now - this.curr.t) >= duration
  }

  /**
   * Aktuell interpolierte Position oder null, wenn noch nichts gefüttert wurde.
   * @param {number} [now=performance.now()]
   * @returns {{lat,lon,altitude,rotation:{x,y,z}}|null}
   */
  sample(now = performance.now()) {
    if (!this.curr) return null
    if (this.curr.dr) return _extrapolate(this.curr, now)   // Flugzeug: vorausrechnen
    if (!this.prev) return _cloneSnap(this.curr)

    const duration = this.curr.t - this.prev.t
    if (duration <= 0 || duration > MAX_INTERP_MS) return _cloneSnap(this.curr)

    const t = _clamp01((now - this.curr.t) / duration)
    return {
      lat:      _lerp(this.prev.lat,      this.curr.lat,      t),
      lon:      _lerp(this.prev.lon,      this.curr.lon,      t),
      altitude: _lerp(this.prev.altitude, this.curr.altitude, t),
      rotation: {
        x: _lerpAngle(this.prev.rotation.x, this.curr.rotation.x, t),
        y: _lerpAngle(this.prev.rotation.y, this.curr.rotation.y, t),
        z: _lerpAngle(this.prev.rotation.z, this.curr.rotation.z, t)
      }
    }
  }

  /** Setzt den Smoother zurück, ohne neue Daten anzunehmen. */
  reset() { this.prev = null; this.curr = null }
}

// ───────────────────────────────────────────────────────────────────────
//  Internals
// ───────────────────────────────────────────────────────────────────────

function _snapFromRecord(rec, t) {
  const r = rec.rotation || {}
  const snap = {
    lat:      rec.lat,
    lon:      rec.lon,
    altitude: rec.altitude ?? 0,
    rotation: {
      x: Number.isFinite(r.x) ? r.x : 0,
      y: Number.isFinite(r.y) ? r.y : 0,
      z: Number.isFinite(r.z) ? r.z : 0
    },
    t
  }
  // Extrapolations-Parameter (nur Flugzeuge): letzte Messung + Bewegungsvektor.
  // age0Ms = wie alt die Messung schon beim Füttern war (Netz-/Poll-Latenz) —
  // damit die Vorausrechnung die JETZT-Position trifft, nicht die von vorhin.
  const a = rec.state?.adsb
  if (a && Number.isFinite(a.v) && Number.isFinite(a.trk) &&
      Number.isFinite(a.lat0) && Number.isFinite(a.lon0)) {
    const age0 = Number.isFinite(a.t) ? (Date.now() - a.t) : 0
    snap.dr = {
      v: a.v, trk: a.trk,
      vrate: Number.isFinite(a.vrate) ? a.vrate : 0,
      lat0: a.lat0, lon0: a.lon0,
      alt0: Number.isFinite(a.alt0) ? a.alt0 : (rec.altitude ?? 0),
      age0Ms: age0 > 0 ? age0 : 0
    }
  }
  return snap
}

// Position aus letzter Messung + Bewegungsvektor vorausrechnen (Großkreis-nah
// per äquirektangularer Näherung — auf Flugzeug-Zeitskalen genau genug).
function _extrapolate(curr, now) {
  const dr = curr.dr
  let elapsedMs = dr.age0Ms + (now - curr.t)
  if (elapsedMs < 0) elapsedMs = 0
  if (elapsedMs > MAX_DR_MS) elapsedMs = MAX_DR_MS
  const s = elapsedMs / 1000
  const distM = dr.v * s
  const trk = dr.trk * Math.PI / 180
  const dNorth = distM * Math.cos(trk)
  const dEast  = distM * Math.sin(trk)
  const cosLat = Math.cos(dr.lat0 * Math.PI / 180) || 1e-6
  return {
    lat: dr.lat0 + dNorth / 111320,
    lon: dr.lon0 + dEast / (111320 * cosLat),
    altitude: dr.alt0 + dr.vrate * s,
    rotation: { x: curr.rotation.x, y: curr.rotation.y, z: curr.rotation.z }
  }
}

function _sameTarget(a, b) {
  return a.lat === b.lat &&
         a.lon === b.lon &&
         a.altitude === b.altitude &&
         a.rotation.x === b.rotation.x &&
         a.rotation.y === b.rotation.y &&
         a.rotation.z === b.rotation.z
}

function _cloneSnap(s) {
  return {
    lat: s.lat, lon: s.lon, altitude: s.altitude,
    rotation: { x: s.rotation.x, y: s.rotation.y, z: s.rotation.z }
  }
}

function _lerp(a, b, t) { return a + (b - a) * t }

function _clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t }

// Kürzester Winkelweg — wickelt am ±π-Sprung sauber um.
function _lerpAngle(a, b, t) {
  let d = b - a
  while (d >  Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return a + d * t
}
