// SttEngine — a thin, swappable speech-to-text abstraction so the rest of the
// app never depends on a specific engine. Push-to-talk: start() opens the mic,
// stop() closes it and finalises. Results arrive via onResult(text, isFinal).
//
// Implementations:
//   • NativeStt    — (P2) the custom `Stt` Capacitor plugin: Android
//     SpeechRecognizer offline + Bluetooth-headset (SCO) routing. Preferred on
//     the phone. `available` flips to true once the plugin ships.
//   • WebSpeechStt — browser SpeechRecognition (dev/testing in a desktop
//     browser; NOT offline, not used on the phone).
//   • NullStt      — no engine: logs and no-ops, so the pipeline still runs.

// SpeechRecognizer error codes → readable German (for the Debug-Log).
const STT_ERROR = {
  1: 'Netzwerk-Timeout', 2: 'Netzwerkfehler', 3: 'Audiofehler', 4: 'Serverfehler',
  5: 'Client-Fehler', 6: 'keine Sprache gehört (Timeout)', 7: 'nicht verstanden',
  8: 'Erkenner beschäftigt', 9: 'keine Mikrofon-Berechtigung', 10: 'zu viele Anfragen',
  11: 'Server getrennt', 12: 'Sprache nicht unterstützt',
  13: 'Offline-Sprachpaket fehlt', 14: 'Support nicht prüfbar'
}

class BaseStt {
  constructor() { this._resultCbs = new Set(); this._errCbs = new Set(); this._statusCbs = new Set() }
  onResult(cb) { this._resultCbs.add(cb); return () => this._resultCbs.delete(cb) }
  onError(cb) { this._errCbs.add(cb); return () => this._errCbs.delete(cb) }
  onStatus(cb) { this._statusCbs.add(cb); return () => this._statusCbs.delete(cb) }
  _emit(text, isFinal, conf) { this._resultCbs.forEach(cb => { try { cb(text, isFinal, conf) } catch {} }) }
  _err(e) { this._errCbs.forEach(cb => { try { cb(e) } catch {} }) }
  _status(msg) { if (msg) this._statusCbs.forEach(cb => { try { cb(msg) } catch {} }) }
  get available() { return false }
  async start() {}
  async stop() {}
}

export class NullStt extends BaseStt {
  async start() {
    console.warn('[stt] no engine available')
    this._status('keine STT-Engine aktiv (natives Plugin nicht im Build? / kein Browser-STT)')
  }
}

export class WebSpeechStt extends BaseStt {
  constructor({ lang = 'de-DE' } = {}) {
    super()
    this.lang = lang
    this._Ctor = (typeof window !== 'undefined') &&
      (window.SpeechRecognition || window.webkitSpeechRecognition) || null
    this._rec = null
  }
  get available() { return !!this._Ctor }
  async start() {
    if (!this._Ctor || this._rec) return
    const rec = new this._Ctor()
    rec.lang = this.lang
    rec.interimResults = true
    rec.continuous = false
    rec.maxAlternatives = 1
    rec.onresult = (ev) => {
      const r = ev.results[ev.results.length - 1]
      this._emit(r[0]?.transcript || '', r.isFinal, r[0]?.confidence)
    }
    rec.onerror = (ev) => this._err(ev?.error || ev)
    rec.onend = () => { this._rec = null }
    this._rec = rec
    try { rec.start() } catch (e) { this._rec = null; this._err(e) }
  }
  async stop() {
    if (!this._rec) return
    try { this._rec.stop() } catch {}
    this._rec = null
  }
}

// Native engine via the `Stt` Capacitor plugin (android/.../voice/SttPlugin.java):
// Android SpeechRecognizer, offline + Bluetooth-headset routing. start()/stop()
// forward to the plugin; its `sttResult`/`sttError` listeners re-emit here.
const NATIVE_READY = true
export class NativeStt extends BaseStt {
  constructor({ lang = 'de-DE' } = {}) { super(); this.lang = lang; this._Stt = null; this._subs = [] }
  get available() {
    try { return NATIVE_READY && !!(window.Capacitor?.isNativePlatform?.()) } catch { return false }
  }
  // Returns true once the plugin proxy + listeners are ready. IMPORTANT: never
  // RETURN the Capacitor plugin proxy from an async fn — the proxy intercepts
  // `.then`, so the async machinery treats it as a thenable and tries to unwrap
  // it (calls a non-existent native "then"), hanging forever. Keep it in this._Stt
  // and return a boolean instead.
  async _plugin() {
    if (this._Stt) return true
    try {
      const { Capacitor, registerPlugin } = await import('@capacitor/core')
      if (!Capacitor?.isNativePlatform?.()) return false
      const Stt = registerPlugin('Stt')
      this._subs.push(await Stt.addListener('sttResult',
        (e) => this._emit(e?.text || '', !!e?.isFinal, e?.confidence)))
      this._subs.push(await Stt.addListener('sttError', (e) => {
        const code = e?.error
        this._status(`STT-Fehler ${code} – ${STT_ERROR[code] || 'unbekannt'}`)
        this._err(code)
      }))
      this._Stt = Stt
      return true
    } catch (e) { this._status('STT-Init-Fehler: ' + (e?.message || e)); return false }
  }
  async start() {
    if (!(await this._plugin())) { this._status('STT-Plugin nicht erreichbar'); return }
    try {
      await this._Stt.start({ lang: this.lang, offline: true, partial: true })
    } catch (e) {
      this._status('STT-Start-Fehler: ' + (e?.message || e))
      this._err(e)
    }
  }
  async stop() {
    if (!this._Stt) return
    try { await this._Stt.stop() } catch {}
  }
}

// Pick the best available engine: native on the phone (P2) → Web Speech in a
// browser → Null otherwise.
export function createSttEngine(opts = {}) {
  const native = new NativeStt(opts)
  if (native.available) return native
  const web = new WebSpeechStt(opts)
  if (web.available) return web
  return new NullStt()
}
