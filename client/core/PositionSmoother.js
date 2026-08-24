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

// Dead-Reckoning (Extrapolation) für Objekte mit Bewegungsvektor — QUELLEN-
// UNABHÄNGIG über `state.motion` (Flugzeuge nutzen historisch `state.adsb`,
// wird weiter unterstützt). Solche Agenten liefern nur alle 30–60 s (API-Limits),
// die Objekte würden also springen. Statt zwischen zwei Messungen zu
// INTERPOLIEREN (und damit ein Update hinterherzuhinken) rechnen wir aus der
// letzten Messung + Geschwindigkeit/Kurs die AKTUELLE Position frameweise VORAUS.
// Bleibt der Agent aus, friert die Extrapolation nach MAX_DR_MS ein, bis das
// Stale-Cleanup greift.
//
// Feldformat (alles optional außer v/trk/lat0/lon0):
//   v     Geschwindigkeit über Grund in m/s
//   trk   Kurs in Grad (CW von Nord)
//   vrate Steigrate in m/s (Flugzeuge; bei Bodenobjekten 0)
//   t     Messzeitpunkt (epoch ms) — kompensiert Poll-/Netz-Latenz
//   lat0/lon0/alt0  Position ZUR Messung
const MAX_DR_MS = 150000

// Wie schnell ein Versatz höchstens abgebaut wird (m/s).
//
// NICHT über eine feste Zeit: Ein Versatz von vier Metern in 700 ms bedeutet
// 5,7 m/s zusätzlich — bei einem gehenden Pferd sieht das aus wie ein Ruck.
// Über eine Höchstgeschwindigkeit bleibt die Korrektur immer langsamer als ein
// Schritt und fällt damit nie auf; sie dauert dafür bei großem Versatz länger.
// Genau der Tausch, um den es geht: eine Abweichung, die niemand bemerkt,
// gegen einen Sprung, den jeder sieht.
const KORREKTUR_TEMPO = 1.2

// Grenzen der Korrekturdauer (ms) — winzige Versätze sofort, große nicht endlos.
const KORREKTUR_MIN_MS = 200
const KORREKTUR_MAX_MS = 3000

// Ab dieser Entfernung ist es kein Versatz mehr, sondern ein Ortswechsel —
// dann wird gesprungen (Meter).
const MAX_KORREKTUR_M = 40

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

    // WEICHE KORREKTUR statt Sprung.
    //
    // Solange ein Objekt vorausgerechnet wird, läuft die Anzeige zwangsläufig
    // ein Stück von der Wahrheit weg (Rundung, Netzlaufzeit, ein Tick zu spät).
    // Trifft dann ein neuer Plan ein, sprang die Figur bisher auf die neue
    // Rechnung — bei 500-ms-Takten unsichtbar, seit die Agents nur noch an
    // Wegknicken melden aber ein deutliches Zucken.
    //
    // Deshalb wird der Versatz im Moment des Eintreffens gemessen und über
    // KORREKTUR_MS auf null gefahren. Die Figur läuft dabei minimal falsch —
    // das ist der bewusste Tausch: eine Abweichung, die niemand bemerkt, gegen
    // einen Sprung, den jeder sieht.
    if (this.curr?.dr && snap.dr) {
      const gezeigt = _extrapolate(this.curr, now)
      const neuStand = _extrapolate(snap, now)
      const dLat = gezeigt.lat - neuStand.lat
      const dLon = gezeigt.lon - neuStand.lon
      const dAlt = gezeigt.altitude - neuStand.altitude
      // Grosse Sprünge sind KEIN Drift, sondern ein Ortswechsel (Editor,
      // Neuplanung, Teleport). Die weichzuzeichnen hiesse, die Figur sekundenlang
      // quer durch die Welt gleiten zu lassen — dort ist Springen richtig.
      const weitM = Math.hypot(dLat * 111320, dLon * 111320 * Math.cos(gezeigt.lat * Math.PI / 180))
      if (weitM <= MAX_KORREKTUR_M) {
        const dauer = Math.min(KORREKTUR_MAX_MS,
          Math.max(KORREKTUR_MIN_MS, (weitM / KORREKTUR_TEMPO) * 1000))
        snap.fix = { lat: dLat, lon: dLon, altitude: dAlt, t: now, dauer }
      }
    }

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
    // Extrapolierende Objekte gelten nur als „in Bewegung", solange sie
    // tatsächlich Fahrt haben. Ohne diese Prüfung bliebe jedes festgemachte
    // Schiff dauerhaft im Pro-Frame-Loop der Karte (v=0 → immer dieselbe
    // Position) — bei einer Rheinstrecke sind das schnell 30 Marker umsonst.
    if (this.curr?.dr) return !(this.curr.dr.v > 0)
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
  // Extrapolations-Parameter: letzte Messung + Bewegungsvektor. `state.motion`
  // ist der quellenunabhängige Weg (Schiffe u. a.), `state.adsb` der historische
  // der Flugzeug-Bridge. age0Ms = wie alt die Messung beim Füttern schon war
  // (Netz-/Poll-Latenz) — damit die Vorausrechnung die JETZT-Position trifft.
  const a = rec.state?.motion || rec.state?.adsb
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
  const p = {
    lat: dr.lat0 + dNorth / 111320,
    lon: dr.lon0 + dEast / (111320 * cosLat),
    altitude: dr.alt0 + dr.vrate * s,
    rotation: { x: curr.rotation.x, y: curr.rotation.y, z: curr.rotation.z }
  }
  // Restlichen Versatz auflösen (siehe feed): Anteil läuft von 1 auf 0.
  const fix = curr.fix
  if (fix) {
    const anteil = 1 - Math.min(1, Math.max(0, (now - fix.t) / (fix.dauer || KORREKTUR_MAX_MS)))
    if (anteil <= 0) { curr.fix = null }
    else {
      p.lat += fix.lat * anteil
      p.lon += fix.lon * anteil
      p.altitude += fix.altitude * anteil
    }
  }
  return p
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
