// advancedMode.js — which parts of the settings a normal player ever sees.
//
// WHY. The app carries features most people never touch: pairing a wand,
// connecting UWB tags, the debug readouts — later a robot driver. Every one of
// them is a section in the settings and a question in somebody's head. Somebody
// who installed a geo game should not have to decide what "UWB-Ortung" means
// before they can look at the map.
//
// So they are off by default and appear together behind one switch. That is
// deliberately NOT a permission boundary and not a plugin system: it only
// decides what is shown. Code splitting and the Android permissions are
// separate questions, both bigger (see docs/arbeitspakete.md, Paket 7).
//
// The value lives in localStorage, per device. A switch like this belongs to
// the phone in your hand, not to the account: the same person uses the plain
// app on their everyday phone and the full one on the device screwed to a rover.

const KEY = 'ajna_advanced'

/** Are the advanced sections shown on this device? Default: no. */
export function isAdvanced() {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

/**
 * Turn the advanced sections on or off.
 *
 * Wrapped in try/catch like every other storage access here — a private window
 * or blocked site data must not take the settings screen down with it.
 */
export function setAdvanced(on) {
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {}
  return !!on
}
