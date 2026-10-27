// haptics — vibration patterns for pointing, in ONE table.
//
// A pattern is an array of milliseconds, alternating off/on and starting with
// an off phase — exactly what `navigator.vibrate`, Android's
// `VibrationEffect.createWaveform(long[], -1)` and the watch expect. The
// phone sends the timings to the devices instead of an id, so the watch app
// needs no copy of this table and a new pattern needs no watch update.
//
// Events say WHAT happened; the object type colours the target-change
// pattern, so a player feels whether the arm crossed a figure or a thing.

export const HAPTIC_EVENTS = ['target', 'target_lost', 'select', 'deselect', 'success', 'error', 'aim_on', 'aim_off', 'fallback', 'calibrated']

// Per object type, felt when the aim moves onto it. Short and distinct:
// one tick for things, two for figures, a long one for big creatures.
const TARGET_BY_TYPE = {
  npc:     [0, 25, 60, 25],
  player:  [0, 25, 60, 25],
  animal:  [0, 15, 40, 15, 40, 15],
  enemy:   [0, 60, 40, 60],
  dragon:  [0, 120],
  item:    [0, 20],
  diamond: [0, 20],
  call:    [0, 20, 80, 40],
  hint:    [0, 10, 30, 10],
  poi:     [0, 30],
}
const TARGET_DEFAULT = [0, 30]

const BY_EVENT = {
  target_lost: [0, 8],
  select:      [0, 80],
  deselect:    [0, 20, 50, 20],
  success:     [0, 40, 60, 80],
  error:       [0, 150, 80, 150],
  aim_on:      [0, 15, 30, 15],
  aim_off:     [0, 15],
  fallback:    [0, 200, 100, 200, 100, 200],
  calibrated:  [0, 30, 40, 30, 40, 30],
}

/**
 * Timings for an event (and, for 'target', the object type).
 * @param {string} event
 * @param {string} [objectType]
 * @returns {number[]}
 */
export function hapticPattern(event, objectType = '') {
  if (event === 'target') return TARGET_BY_TYPE[String(objectType || '').toLowerCase()] || TARGET_DEFAULT
  return BY_EVENT[event] || TARGET_DEFAULT
}
