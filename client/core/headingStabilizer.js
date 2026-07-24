// Gyro-gestützte Glättung der AR-Orientierung — verankert Objekte ruhiger in der
// Umgebung.
//
// Problem: das Kamera-Heading kommt aus dem Magnetometer/Kompass (deviceorientation)
// und ist verrauscht — Objekte „schwimmen", vor allem während man STILLHÄLT.
//
// Ansatz (Komplementärfilter-Variante): der Gyroskop-Wert entscheidet, WIE SEHR
// der Kompass-Messung vertraut wird.
//   • Gerät ruhig  → Gyro sagt „keine echte Bewegung" → jede Kompass-Änderung ist
//     Rauschen → stark glätten (kleiner Slerp-Faktor).
//   • Gerät dreht sich → Gyro sagt „echte Bewegung" → Faktor → 1, folgt SOFORT
//     (kein Lag).
//
// BEWUSST nur die Gyro-MAGNITUDE (Betrag, kein Vorzeichen, kein Achsen-Mapping):
// so kann die Fusion nichts „verschlimmern" — ein Sign-/Frame-Fehler eines vollen
// integrierenden Komplementärfilters (Gyro absolut integrieren + Kompass-Drift
// korrigieren) ließe sich ohne Gerät nicht verlässlich absichern. Diese Variante
// bekämpft den sichtbarsten Anteil (Jitter/Schwimmen im Stand) risikofrei; die
// Drift-Korrektur über deviceorientationabsolute wäre ein geräte-getunter Nachbau.

// Slerp-Faktor bei Ruhe (klein = stark glätten). ~0,1/Frame ≈ 150 ms Zeitkonstante.
export const STILL_SMOOTH = 0.1
// Gyro-Magnitude (Grad/s), ab der voll gefolgt wird (Faktor = 1). Bewusste
// Drehungen liegen deutlich darüber, Handzittern/Rauschen darunter.
export const RESPONSIVE_RATE = 20
// Kommen keine Motion-Events mehr, gilt „still" → stark glätten.
const MOTION_STALE_MS = 300

const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * Adaptiver Slerp-Faktor aus der Gyro-Magnitude (linear zwischen STILL_SMOOTH
 * bei 0 und 1 bei RESPONSIVE_RATE, geklemmt).
 */
export function stabilizeFactor(gyroMagDegS, still = STILL_SMOOTH, resp = RESPONSIVE_RATE) {
  const m = Number.isFinite(gyroMagDegS) && gyroMagDegS > 0 ? gyroMagDegS : 0
  const t = still + (m / resp) * (1 - still)
  return t < still ? still : t > 1 ? 1 : t
}

export class HeadingStabilizer {
  constructor() {
    this._mag = 0
    this._lastMs = 0
    this._onMotion = (e) => {
      const r = e.rotationRate
      if (!r) return
      // rotationRate in Grad/s (Spec) über alle drei Geräteachsen — Betrag reicht.
      this._mag = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0)
      this._lastMs = _now()
    }
    try { window.addEventListener('devicemotion', this._onMotion, true) } catch {}
  }

  /** Aktueller Glättungsfaktor (0…1). Stale → 0 (still) → stark glätten. */
  factor() {
    const mag = (_now() - this._lastMs > MOTION_STALE_MS) ? 0 : this._mag
    return stabilizeFactor(mag)
  }

  dispose() { try { window.removeEventListener('devicemotion', this._onMotion, true) } catch {} }
}
