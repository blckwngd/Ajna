// inputMapping — raw device events → semantic actions.
//
// Devices report what happened physically (`{ code: 'MediaPlayPause' }`,
// `{ code: 'stem1', long: true }`, `{ code: 'swipe_left' }`); the mapping
// says what that MEANS. One table per device kind, overridable per device by
// the user. Everything downstream (AimController) only sees actions.

/** The actions the pointing core understands. `interact_N` is 1-based. */
export const ACTIONS = [
  'aim_toggle', 'announce_target', 'select_target', 'cancel',
  'next_target', 'prev_target', 'calibrate',
  'interact_1', 'interact_2', 'interact_3', 'interact_4',
]

/** German labels for the settings UI (the UI wraps them in t()). */
export const ACTION_LABELS = {
  aim_toggle: 'Peilmodus an/aus',
  announce_target: 'Ziel ansagen',
  select_target: 'Ziel wählen',
  cancel: 'Abbrechen',
  next_target: 'Nächstes Ziel',
  prev_target: 'Voriges Ziel',
  calibrate: 'Kalibrieren',
  interact_1: 'Aktion 1',
  interact_2: 'Aktion 2',
  interact_3: 'Aktion 3',
  interact_4: 'Aktion 4',
}

// Defaults per device kind. Keys are the device's raw codes; `:long` marks a
// long press where the device reports one.
//
// controller — a generic Bluetooth remote / "Daydream" clone. Codes are the
//   KeyboardEvent.key / Android KeyEvent names the app forwards. Media keys
//   are the ones that still arrive with the screen off (MediaSession).
// keyboard  — a desk keyboard, for testing at the computer.
// watch     — stem buttons and the watch's own touch actions (it sends
//   semantic actions for its touch areas directly; see the watch protocol).
const DEFAULTS = {
  controller: {
    MediaPlayPause: 'aim_toggle',
    'MediaPlayPause:long': 'cancel',
    MediaTrackNext: 'next_target',
    MediaTrackPrevious: 'prev_target',
    AudioVolumeUp: 'interact_1',
    AudioVolumeDown: 'interact_2',
    Enter: 'select_target',
    ' ': 'announce_target',
    ArrowRight: 'next_target',
    ArrowLeft: 'prev_target',
    ArrowUp: 'interact_1',
    ArrowDown: 'interact_2',
    Escape: 'cancel',
    swipe_right: 'next_target',
    swipe_left: 'prev_target',
    swipe_up: 'interact_1',
    swipe_down: 'interact_2',
    tap: 'announce_target',
    click: 'select_target',
  },
  keyboard: {
    a: 'aim_toggle', s: 'select_target', d: 'announce_target', Escape: 'cancel',
    ArrowRight: 'next_target', ArrowLeft: 'prev_target',
    '1': 'interact_1', '2': 'interact_2', '3': 'interact_3', '4': 'interact_4', k: 'calibrate',
  },
  watch: {
    stem1: 'aim_toggle',
    'stem1:long': 'cancel',
    stem2: 'announce_target',
    'stem2:long': 'calibrate',
  },
}

/** Default mapping for a device kind (a copy — callers may edit it). */
export function defaultMapping(kind) {
  return { ...(DEFAULTS[kind] || {}) }
}

/**
 * Raw event → action, or null.
 * A device may send a semantic action directly (`{ action: 'interact_2' }`);
 * that passes through when it is a known action.
 *
 * @param {{code?:string, long?:boolean, action?:string}} raw
 * @param {Record<string,string>} mapping
 */
export function mapRawEvent(raw, mapping) {
  if (!raw) return null
  if (raw.action) return ACTIONS.includes(raw.action) ? raw.action : null
  const code = String(raw.code ?? '')
  if (!code) return null
  if (raw.long && mapping[`${code}:long`]) return mapping[`${code}:long`]
  return mapping[code] || null
}

/**
 * Debouncer across ALL input devices: the same action within `windowMs` is
 * one action — two devices bound to the same key, a key that repeats, a
 * button that bounces.
 */
export class ActionDebouncer {
  constructor({ windowMs = 180, now = () => Date.now() } = {}) {
    this.windowMs = windowMs
    this.now = now
    this.last = new Map()   // action → ms
  }
  /** True when the action should fire now. */
  accept(action) {
    const t = this.now()
    const prev = this.last.get(action)
    if (Number.isFinite(prev) && t - prev < this.windowMs) return false
    this.last.set(action, t)
    return true
  }
}
