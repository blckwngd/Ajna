// WandEventBus — a small, extensible event pipeline for wand input events.
//
// Concept (mirrors the firmware CompEventBus): an input event is dispatched to
// ordered subscribers BEFORE it travels further up the chain wand → app → Ajna.
// Default is to FORWARD (bubble up); a handler can keep it LOCAL by calling
// `event.consume()` (e.g. an offline settings change), and/or `event.stop()` to
// prevent further handlers on this tier. The transport to the next tier (here:
// `ajna.interact()`) is done by the consumer only if `event.forward` is still
// true after dispatch.
//
// Extending = just `bus.on(type, handler)`. No core changes needed.

export class WandEventBus {
  constructor() {
    this._byType = new Map()  // type → [{ fn, priority }]
    this._any = []            // '*' subscribers (all types)
  }

  /**
   * Subscribe to an event type ('button' | 'tilt' | 'gesture' | 'effect' | '*').
   * Higher priority runs first. Returns an unsubscribe function.
   */
  on(type, fn, { priority = 0 } = {}) {
    const entry = { fn, priority }
    const list = type === '*'
      ? this._any
      : (this._byType.get(type) || this._byType.set(type, []).get(type))
    list.push(entry)
    list.sort((a, b) => b.priority - a.priority)
    return () => { const i = list.indexOf(entry); if (i >= 0) list.splice(i, 1) }
  }

  /**
   * Dispatch an event through the subscribers. Returns the event; the caller
   * checks `event.forward` to decide whether to send it on to the next tier.
   * @param {string} type
   * @param {object} [data]
   * @param {{forward?: boolean}} [opts]  default forward = true
   */
  dispatch(type, data = {}, { forward = true } = {}) {
    const event = {
      type, data, forward, source: 'wand', _stopped: false,
      consume() { this.forward = false },               // keep local (don't bubble up)
      stop() { this._stopped = true }                   // no further handlers this tier
    }
    const list = [...(this._byType.get(type) || []), ...this._any]
      .sort((a, b) => b.priority - a.priority)
    for (const { fn } of list) {
      if (event._stopped) break
      try { fn(event) } catch (e) { console.warn('[wandbus] handler error', e) }
    }
    return event
  }
}
