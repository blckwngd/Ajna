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

const MAX_INTERP_MS = 500

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
    if (!record || !Number.isFinite(record.lat) || !Number.isFinite(record.lon)) return
    const snap = _snapFromRecord(record, now)
    if (this.curr && _sameTarget(this.curr, snap)) return
    this.prev = this.curr
    this.curr = snap
  }

  /**
   * Aktuell interpolierte Position oder null, wenn noch nichts gefüttert wurde.
   * @param {number} [now=performance.now()]
   * @returns {{lat,lon,altitude,rotation:{x,y,z}}|null}
   */
  sample(now = performance.now()) {
    if (!this.curr) return null
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
  return {
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
