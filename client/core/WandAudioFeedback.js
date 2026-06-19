// WandAudioFeedback — optional spoken/audible cues for wand pointing.
//
//   • new object focused  -> speak its name (TTS)
//   • action triggered     -> speak the action's name (TTS)
//   • focus lost           -> a discreet tone (Web Audio); falls back to TTS "aus"
//
// Toggled from the in-app menu; the on/off state is persisted in localStorage so
// it is honoured across the (separate) map and AR pages. Page-agnostic: no
// BABYLON/Leaflet dependency.

const STORAGE_KEY = 'ajna_wand_audio'
const STORAGE_KEY_DEBUG = 'ajna_wand_audio_debug'

// Human-readable names for the generic wand actions (override via constructor).
const ACTION_LABELS = {
  wand_press:   'Auslösen',
  wand_long:    'Halten',
  wand_gesture: 'Geste',
  wand_effect:  'Effekt'
}

// German spoken labels for the debug announcer (state + raw events).
const STATE_LABELS = {
  initialize: 'Initialisierung', idle: 'Bereit', flashlight: 'Taschenlampe',
  ledshow: 'Lichtshow', lightcontrol: 'Lichtsteuerung', soundcontrol: 'Klangsteuerung',
  debug: 'Debug-Modus', wifijam: 'WLAN-Störer', robotcontrol: 'Robotersteuerung'
}
const GESTURE_LABELS = {
  tap: 'Tippen', double_tap: 'Doppeltippen', flick: 'Schnipsen', shake: 'Schütteln',
  twist_cw: 'Drehung rechts', twist_ccw: 'Drehung links',
  pose_up: 'Pose nach oben', pose_down: 'Pose nach unten', pose_forward: 'Pose nach vorn',
  pose_back: 'Pose nach hinten', pose_left: 'Pose nach links', pose_right: 'Pose nach rechts'
}
const DIR_LABELS = { forward: 'vorne', back: 'hinten', left: 'links', right: 'rechts' }
const POINTING_LABELS = { pointer: 'Zeigestock', walkingstick: 'Wanderstab', auto: 'Automatisch', disabled: 'Aus' }
// Short system-status announcements (debug). Keep terse to avoid chatter.
const SYSTEM_LABELS = {
  gps_fix:       'GPS-Fix',
  server_up:     'Server verbunden',
  server_down:   'Server getrennt',
  login:         'Angemeldet',
  logout:        'Abgemeldet',
  wand_up:       'Stab verbunden',
  wand_down:     'Stab getrennt',
  uwb_node_up:   'UWB-Knoten verbunden',
  uwb_node_down: 'UWB-Knoten getrennt',
  uwb_net:       'UWB-Netz aktiv'
}

export class WandAudioFeedback {
  constructor({ lang = 'de-DE', actionLabels } = {}) {
    this.lang = lang
    this.actionLabels = { ...ACTION_LABELS, ...(actionLabels || {}) }
    this._audioCtx = null
    this._q = []            // pending queued utterances (announce)
    this._busy = false
    this._backendP = null   // cached TTS backend probe
  }

  /** True if a usable TTS backend exists: native Capacitor TTS (Android/iOS) or
   *  Web Speech (desktop browser). The Android System WebView lacks Web Speech,
   *  which is why the native plugin is used there. */
  static ttsAvailable() {
    if (typeof window === 'undefined') return false
    if (window.Capacitor?.isNativePlatform?.()) return true   // native TTS plugin
    return !!window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function'
  }

  static isEnabled() { try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false } }
  static setEnabled(on) { try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0') } catch {} }
  get enabled() { return WandAudioFeedback.isEnabled() }

  // Debug announcer: speak state changes + raw events (to learn the wand by ear).
  // Only active when audio feedback AND debug are both enabled.
  static isDebugEnabled() { try { return localStorage.getItem(STORAGE_KEY_DEBUG) === '1' } catch { return false } }
  static setDebugEnabled(on) { try { localStorage.setItem(STORAGE_KEY_DEBUG, on ? '1' : '0') } catch {} }
  get debug() { return this.enabled && WandAudioFeedback.isDebugEnabled() }

  // ── TTS backend: native Capacitor plugin → Web Speech → none ────────
  _backend() {
    if (this._backendP) return this._backendP
    this._backendP = (async () => {
      try {
        const { Capacitor } = await import('@capacitor/core')
        if (Capacitor?.isNativePlatform?.()) {
          const { TextToSpeech } = await import('@capacitor-community/text-to-speech')
          return { kind: 'native', tts: TextToSpeech }
        }
      } catch (e) { console.warn('[tts] native init failed', e?.message || e) }
      if (typeof window !== 'undefined' && window.speechSynthesis) return { kind: 'web' }
      return { kind: 'none' }
    })()
    return this._backendP
  }

  // Speak one utterance; resolves when it finishes (so the queue can sequence).
  async _say(text) {
    const b = await this._backend()
    if (b.kind === 'native') {
      try { await b.tts.speak({ text: String(text), lang: this.lang }) }
      catch (e) { console.warn('[tts] native speak failed', e?.message || e) }
    } else if (b.kind === 'web') {
      await new Promise(res => {
        try {
          const u = new SpeechSynthesisUtterance(String(text))
          u.lang = this.lang
          u.onend = u.onerror = () => res()
          window.speechSynthesis.speak(u)
        } catch { res() }
      })
    }
  }

  _drain() {
    if (this._busy) return
    const text = this._q.shift()
    if (text == null) return
    this._busy = true
    this._say(text).finally(() => { this._busy = false; this._drain() })
  }

  // Queued cue — distinct status messages play sequentially without clobbering.
  announce(text) { if (text) { this._q.push(String(text)); this._drain() } }

  // Interrupting cue — "latest wins" (e.g. the focused object name): clear the
  // queue, stop current speech, then say this.
  async speak(text) {
    if (!text) return
    this._q.length = 0
    try {
      const b = await this._backend()
      if (b.kind === 'native') { try { await b.tts.stop() } catch {} }
      else if (b.kind === 'web') { try { window.speechSynthesis.cancel() } catch {} }
    } catch {}
    this._busy = false
    this.announce(text)
  }

  // Short, soft sine blip to signal "no object selected anymore".
  _tone() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) { this.announce('aus'); return }   // fallback per requirement
      if (!this._audioCtx) this._audioCtx = new Ctx()
      const ctx = this._audioCtx
      if (ctx.state === 'suspended') ctx.resume()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = 330
      const t0 = ctx.currentTime
      gain.gain.setValueAtTime(0.0001, t0)
      gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18)
      osc.connect(gain); gain.connect(ctx.destination)
      osc.start(t0); osc.stop(t0 + 0.2)
    } catch { this.announce('aus') }
  }

  /** target: { id, name } when a (new) object is focused, or null on focus loss. */
  onTargetChange(target) {
    if (!this.enabled) return
    if (target?.id) { if (target.name) this.speak(target.name) }
    else this._tone()
  }

  /** info: { action, name, actionLabel? } — speaks the action's name. */
  onInteraction(info) {
    if (!this.enabled) return
    const label = info?.actionLabel || this.actionLabels[info?.action] || info?.action
    if (label) this.speak(label)
  }

  // ── debug announcer (learning aid; audio + debug must both be on) ────

  /** Announce a wand state change, e.g. 'lightcontrol' → "Lichtsteuerung". */
  announceState(name) {
    if (!this.debug || !name) return
    this.announce(STATE_LABELS[name] || name)
  }

  /** Announce a raw input event (bus event {type, data}) in German. */
  announceEvent(event) {
    if (!this.debug || !event) return
    const d = event.data || {}
    let label
    switch (event.type) {
      case 'button':  label = `Knopf ${d.id}${d.long ? ' lang' : ''}`; break
      case 'tilt':    label = `Neigung ${DIR_LABELS[d.dir] || d.dir || ''}`; break
      case 'gesture': label = GESTURE_LABELS[d.name] || d.name || 'Geste'; break
      case 'effect':  label = `Effekt ${d.domain || ''} ${d.id ?? ''}`.trim(); break
      default:        return
    }
    if (label) this.announce(label)
  }

  /** Announce a short system status (key from SYSTEM_LABELS), debug-gated. */
  announceSystem(key) {
    if (!this.debug) return
    const t = SYSTEM_LABELS[key]
    if (t) this.announce(t)
  }

  /** Announce a pointing-mode change, e.g. 'pointer' → "Modus Zeigestock". */
  announceMode(mode) {
    if (!this.debug || !mode) return
    this.announce(`Modus ${POINTING_LABELS[mode] || mode}`)
  }
}
