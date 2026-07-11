// CompassCalibration — Indikator für die Güte des Geräte-Kompasses in der AR.
//
// Zweck: sichtbar machen, OB die Kompass-Orientierung vertrauenswürdig ist. Das
// trennt zwei Fehlerbilder, die sich sonst gleich anfühlen:
//   • „Berechnung falsch" — Kompass ist stabil/kalibriert, die Welt zeigt aber
//     verdreht → Frame-/Offset-Problem (siehe AR-Nord-Offset), NICHT die Hardware.
//   • „Kompass driftet"   — der rohe Kompass-Wert zappelt/wandert, obwohl das
//     Gerät ruhig liegt → Magnetometer braucht Kalibrierung (liegende 8).
//
// Signale:
//   • iOS: DeviceOrientationEvent.webkitCompassHeading (0=N, CW) +
//     webkitCompassAccuracy (Grad; klein=gut; -1=unkalibriert).
//   • Android: 'deviceorientationabsolute' mit absolute alpha → grobes Heading.
//   • Beide: 'devicemotion' rotationRate → erkennt „ruhig"; solange ruhig, wird
//     die Streuung des Heading gemessen (Zappeln/Drift in Grad).
//
// Die eigentliche AR-Kamera-Orientierung macht weiterhin Babylons
// DeviceOrientation-Input — dies hier liest NUR mit und bewertet.

import { messageLog } from './MessageLog.js'

const STILL_RATE = 12      // deg/s: darunter gilt das Gerät als ruhig (Gyro-Betrag)
const WIN_MS = 2500        // Fenster für die Ruhe-Streuung
const UPDATE_MS = 250      // Badge-Aktualisierung drosseln

// Qualitätsstufen aus Zappel-Streuung (Grad, Spitze-Spitze im Ruhefenster).
const JIT_GOOD = 4, JIT_OK = 10
// Qualitätsstufen aus iOS-Genauigkeit (Grad).
const ACC_GOOD = 20, ACC_OK = 40

const FLAG_KEY = 'ajna.ar.compass_indicator'   // '0' blendet aus; Default an
const shortAngle = (a) => ((a + 540) % 360) - 180   // → (-180,180]

export class CompassCalibration {
  constructor({ parent = document.body } = {}) {
    this.parent = parent
    this._active = false        // AR-Modus an?
    this._el = null
    this._heading = null
    this._absolute = false
    this._accuracy = null       // iOS: Grad, sonst null
    this._jitter = null         // gemessene Ruhe-Streuung (Grad) oder null
    this._still = false
    this._quality = null        // 'good' | 'ok' | 'bad' | null
    this._buf = []              // { t, cum } akkumuliertes Heading im Ruhefenster
    this._cum = 0               // fortlaufend entwrappt
    this._lastHeading = null
    this._lastUpdate = 0
    this._onOrient = this._onOrient.bind(this)
    this._onMotion = this._onMotion.bind(this)
  }

  static enabled() { try { return localStorage.getItem(FLAG_KEY) !== '0' } catch { return true } }
  static setEnabled(on) { try { localStorage.setItem(FLAG_KEY, on ? '1' : '0') } catch {} }

  // AR-Modus an: Sensoren + Badge nur wenn eingeschaltet (Default an).
  activate() {
    this._active = true
    if (CompassCalibration.enabled()) this._startSensors(); else this._stopSensors()
  }
  deactivate() { this._active = false; this._stopSensors() }

  // Vom Einstellungs-Toggle (wirkt sofort, wenn AR aktiv).
  setVisible(on) {
    CompassCalibration.setEnabled(on)
    if (this._active) { on ? this._startSensors() : this._stopSensors() }
  }

  _startSensors() {
    if (this._listening) return
    this._listening = true
    // Android liefert das ABSOLUTE Heading nur über 'deviceorientationabsolute';
    // iOS über 'deviceorientation' (+ webkitCompass*). Beide binden, den jeweils
    // aussagekräftigeren Wert nehmen.
    window.addEventListener('deviceorientationabsolute', this._onOrient, true)
    window.addEventListener('deviceorientation', this._onOrient, true)
    window.addEventListener('devicemotion', this._onMotion, true)
    this._show()
  }
  _stopSensors() {
    if (!this._listening) return
    this._listening = false
    window.removeEventListener('deviceorientationabsolute', this._onOrient, true)
    window.removeEventListener('deviceorientation', this._onOrient, true)
    window.removeEventListener('devicemotion', this._onMotion, true)
    this._hide()
    this._buf = []; this._lastHeading = null
  }

  _onMotion(e) {
    const r = e.rotationRate
    if (!r) return
    const mag = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0)
    this._still = mag < STILL_RATE
  }

  _onOrient(e) {
    // Heading + (falls vorhanden) Genauigkeit bestimmen.
    let heading = null, absolute = false, accuracy = null
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      heading = e.webkitCompassHeading            // iOS: schon Kompass-Heading (CW von N)
      absolute = true
      if (typeof e.webkitCompassAccuracy === 'number') accuracy = e.webkitCompassAccuracy
    } else if (e.absolute === true && typeof e.alpha === 'number') {
      heading = (360 - e.alpha) % 360             // Android absolut (flach genähert)
      absolute = true
    } else if (typeof e.alpha === 'number' && this._heading == null) {
      heading = (360 - e.alpha) % 360             // relativer Fallback, nur zur Anzeige
    }
    if (heading == null) return
    this._heading = heading
    this._absolute = absolute
    this._accuracy = accuracy

    // Zappel-/Drift-Messung: nur während das Gerät ruhig liegt (sonst ist die
    // Heading-Änderung eine echte Drehung, kein Fehler).
    const now = Date.now()
    if (this._lastHeading != null) {
      if (this._still) {
        this._cum += shortAngle(heading - this._lastHeading)
        this._buf.push({ t: now, cum: this._cum })
        while (this._buf.length && now - this._buf[0].t > WIN_MS) this._buf.shift()
        if (this._buf.length >= 4) {
          let lo = Infinity, hi = -Infinity
          for (const s of this._buf) { if (s.cum < lo) lo = s.cum; if (s.cum > hi) hi = s.cum }
          this._jitter = hi - lo                  // Spitze-Spitze im Ruhefenster (Grad)
        }
      } else {
        // Bewegung → Ruhefenster verwerfen (frisch messen, wenn wieder ruhig).
        this._buf = []
      }
    }
    this._lastHeading = heading

    this._evalQuality()
    if (now - this._lastUpdate > UPDATE_MS) { this._lastUpdate = now; this._render() }
  }

  _evalQuality() {
    let q = null
    if (this._accuracy != null && this._accuracy >= 0) {
      q = this._accuracy <= ACC_GOOD ? 'good' : this._accuracy <= ACC_OK ? 'ok' : 'bad'
    } else if (this._accuracy === -1) {
      q = 'bad'                                   // iOS meldet ausdrücklich unkalibriert
    } else if (this._jitter != null) {
      q = this._jitter <= JIT_GOOD ? 'good' : this._jitter <= JIT_OK ? 'ok' : 'bad'
    }
    if (q && q !== this._quality) {
      const prev = this._quality
      this._quality = q
      // Wechsel in den Verlauf schreiben (aber nicht den allerersten „Aufwärmwert").
      if (prev) {
        const word = q === 'good' ? 'gut' : q === 'ok' ? 'mittel' : 'schlecht'
        messageLog.push(`Kompass-Kalibrierung: ${word}${q === 'bad' ? ' – Gerät in liegender 8 bewegen' : ''}`, 'system')
      }
    } else {
      this._quality = q ?? this._quality
    }
  }

  // ── Badge ────────────────────────────────────────────────────────────
  _show() { if (!this._el) this._build(); this._el.style.display = 'flex'; this._render() }
  _hide() { if (this._el) this._el.style.display = 'none' }

  _build() {
    const el = document.createElement('div')
    el.className = 'ar-compass-cal'
    el.style.cssText =
      'position:absolute;left:50%;transform:translateX(-50%);' +
      'top:calc(env(safe-area-inset-top, 0px) + 8px);z-index:1000;pointer-events:none;' +
      'display:flex;flex-direction:column;align-items:center;gap:2px;' +
      'background:rgba(0,0,0,.55);color:#fff;font:12px system-ui,sans-serif;' +
      'padding:5px 10px;border-radius:9px;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);text-align:center'
    el.innerHTML =
      '<div class="acc-line" style="display:flex;align-items:center;gap:7px"></div>' +
      '<div class="acc-hint" style="font-size:11px;opacity:.85"></div>'
    this.parent.appendChild(el)
    this._el = el
    this._lineEl = el.querySelector('.acc-line')
    this._hintEl = el.querySelector('.acc-hint')
  }

  _render() {
    if (!this._el || !this._lineEl) return
    const color = this._quality === 'good' ? '#54c26b' : this._quality === 'ok' ? '#e6b23a' : this._quality === 'bad' ? '#e0533b' : '#9aa0aa'
    const word = this._quality === 'good' ? 'gut' : this._quality === 'ok' ? 'mittel' : this._quality === 'bad' ? 'schlecht' : '…'
    const hdg = this._heading == null ? '–' : `${this._absolute ? '' : '~'}${Math.round(this._heading)}°`
    const detail = this._accuracy != null && this._accuracy >= 0
      ? `±${Math.round(this._accuracy)}°`
      : (this._jitter != null && this._still ? `±${this._jitter.toFixed(1)}°` : '')
    this._lineEl.innerHTML =
      `<span title="Kompass-Heading">🧭 ${hdg}</span>` +
      `<span style="width:9px;height:9px;border-radius:50%;background:${color};display:inline-block"></span>` +
      `<span style="color:${color}">${word}</span>` +
      (detail ? `<span style="opacity:.7">${detail}</span>` : '')
    this._hintEl.textContent = this._quality === 'bad'
      ? 'Kompass kalibrieren: Gerät in liegender 8 bewegen'
      : (this._accuracy == null && this._jitter == null ? 'Ruhig halten zum Messen der Drift' : '')
    this._hintEl.style.display = this._hintEl.textContent ? 'block' : 'none'
  }

  dispose() { this._stopSensors(); this._el?.remove(); this._el = null }
}
