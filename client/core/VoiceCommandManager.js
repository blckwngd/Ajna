// VoiceCommandManager — turns a wand push-to-talk hold into an action via offline
// STT. Domain-agnostic: it owns the PTT/listen lifecycle and fires ONCE per hold;
// what to recognise and what to do with a hit are injected, so the same class
// drives both:
//   • Button 3 → command on the LOCKED object  (match → action key, dispatch → interact)
//   • Button 1 → wand light effect             (match → effect id, dispatch → light cmd)
//
// Flow: wand PTT pressed (button held STILL) → engine.start() → transcripts →
// match(text) → on a non-null result, dispatch(result) once. Released/aborted →
// engine.stop(); one final match attempt on the last transcript.
//
// Privacy: audio + recognition stay on-device; only the resulting action leaves.

export class VoiceCommandManager {
  /**
   * @param {object}   o
   * @param {object}   o.wand     WandManager (provides onPtt)
   * @param {object}   o.engine   SttEngine
   * @param {number}   o.button   which PTT button this manager handles (1 or 3)
   * @param {function} o.match    (transcript) => action | null  (null/undefined = no match)
   * @param {function} o.dispatch (action) => void  (perform it)
   * @param {function} [o.canStart] () => bool — may we listen now? (default: yes)
   * @param {string}   [o.notReadyMsg] spoken if canStart() is false
   * @param {function} [o.announce] (text) => void — spoken feedback
   */
  constructor({ wand, engine, button = 3, match, dispatch, canStart, notReadyMsg, announce } = {}) {
    this.wand = wand
    this.engine = engine
    this.button = button
    this.match = match || (() => null)
    this.dispatch = dispatch || (() => {})
    this.canStart = canStart || (() => true)
    this.notReadyMsg = notReadyMsg || null
    this.announce = announce || (() => {})
    this._listening = false
    this._lastText = ''
    this._fired = false
    this._closeTimer = null
    wand?.onPtt?.((pressed, btn) => { if (btn === this.button) this._onPtt(pressed) })
    engine?.onResult?.((text, isFinal) => this._onResult(text, isFinal))
    engine?.onError?.((e) => console.warn('[voice] stt error', e?.message || e))
  }

  // Diagnostic line → the app Debug-Log (via wand.log) and the console.
  _log(line) { try { this.wand?.log?.(line) } catch {} ; console.debug('[voice]', line) }

  _onPtt(pressed) {
    if (pressed) {
      if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null }
      if (!this.canStart()) {
        this._log(`🎤 ptt start (Knopf ${this.button}) – ${this.notReadyMsg || 'nicht bereit'}`)
        if (this.notReadyMsg) this.announce(this.notReadyMsg)
        return
      }
      this._listening = true; this._lastText = ''; this._fired = false
      this._log(`🎤 ptt start (Knopf ${this.button}) – zuhören…`)
      this.engine?.start?.()
    } else {
      if (!this._listening) return
      this.engine?.stop?.()
      this._log(`🎤 ptt end (Knopf ${this.button})`)
      // The FINAL result arrives async AFTER stop() — keep listening briefly so we
      // don't conclude "nichts erkannt" before it lands.
      if (this._closeTimer) clearTimeout(this._closeTimer)
      this._closeTimer = setTimeout(() => {
        this._closeTimer = null
        if (!this._fired) {
          const matched = this._tryMatch(this._lastText, true)
          if (!matched) this._log(this._lastText
            ? `🎤 erkannt: «${this._lastText}» → kein Befehl zugeordnet`
            : '🎤 nichts erkannt')
        }
        this._listening = false
      }, 1800)
    }
  }

  _onResult(text, isFinal) {
    if (!this._listening) return
    this._lastText = text || this._lastText
    this._tryMatch(text, isFinal)   // fire as soon as a confident match appears
  }

  _tryMatch(text, isFinal) {
    if (this._fired || !text) return false
    const action = this.match(text)
    if (action === null || action === undefined) {   // (0 is a valid action, e.g. light "off")
      if (isFinal) this.announce('Nicht verstanden')
      return false
    }
    this._fired = true
    this._log(`🎤 erkannt: «${text}» → ${action}`)
    this.dispatch(action)
    return true
  }
}
