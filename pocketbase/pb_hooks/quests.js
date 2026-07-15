/// <reference path="../pb_data/types.d.ts" />

// =====================================================================
// Ajna — Quest-/Handels-Helfer
//
// Grundsatz: Belohnungen werden NIE erzeugt. Ein Auftrag (`type: "call"`)
// kann nur Objekte auszahlen, die der Aussteller wirklich besitzt
// (`carried_by` = Aussteller) und die beim Posten TREUHÄNDERISCH gebunden
// wurden (`state.escrow.call = <callId>`). Damit ist ein Auftrag im Kern
// ein Tausch: `requiresItems` (was der Spieler liefert) ↔ `rewardItems`
// (was der Aussteller hinterlegt hat). Dasselbe Primitiv trägt später ein
// allgemeines Handelssystem.
//
// Wird per require() IM Handler geladen — der Goja-VM-Pool teilt keinen
// Modul-Scope zwischen Boot und Hook-Aufruf.
// =====================================================================

// PB-JSVM liefert JSON-Felder je nach Version als String ODER als Byte-/
// Zeichen-Array (JsonRaw) — beides robust nach Objekt parsen (dieselbe
// Defensive wie in der pickup-Route).
function parseState(rec) {
  let state = rec.get("state")
  if (typeof state === "string") {
    try { state = JSON.parse(state) } catch (_) { state = {} }
  } else if (Array.isArray(state)) {
    try {
      const s = (state.length && typeof state[0] === "number")
        ? String.fromCharCode.apply(null, state)
        : state.join("")
      state = JSON.parse(s)
    } catch (_) { state = {} }
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) state = {}
  return state
}

/** Call-ID, an die ein Item treuhänderisch gebunden ist — sonst null. */
function escrowCallOf(state) {
  const esc = state && state.escrow
  return (esc && typeof esc === "object" && esc.call) ? String(esc.call) : null
}

/** `state.call` als Objekt (nie null). */
function callDataOf(state) {
  const c = state && state.call
  return (c && typeof c === "object" && !Array.isArray(c)) ? c : {}
}

/** Robuste String-ID-Liste aus beliebigem Body-Wert. */
function idList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (let i = 0; i < value.length; i++) {
    const s = String(value[i] == null ? "" : value[i]).trim()
    if (s) out.push(s)
  }
  return out
}

module.exports = { parseState, escrowCallOf, callDataOf, idList }
