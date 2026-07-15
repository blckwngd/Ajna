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

/**
 * Prüft, ob ein Tausch JETZT zulässig ist, und lädt die beteiligten Records.
 * Deterministisch und server-seitig: geforderte Items im Inventar des Spielers,
 * Belohnung noch gedeckt UND an genau diesen Auftrag gebunden.
 *
 * Bewusst KEINE Aussage über inhaltliche Quest-Bedingungen (Monster erlegt,
 * Ort erreicht …) — die kennt nur der Agent (verify: "agent").
 *
 * @returns {{ok:true, issuer:string, rewards:Array, required:Array}}
 *        | {ok:false, code:number, error:string}
 */
function resolveSwap(app, call, callData, completerId) {
  const issuer = call.get("owner")
  if (!completerId) return { ok: false, code: 409, error: "no completer assigned to this call" }
  if (completerId === issuer) return { ok: false, code: 409, error: "the issuer cannot complete their own call" }

  const requireIds = idList(callData.requiresItems)
  const required = []
  for (let i = 0; i < requireIds.length; i++) {
    const id = requireIds[i]
    let item
    try { item = app.findRecordById("objects", id) }
    catch (err) { return { ok: false, code: 409, error: "required item missing: " + id } }
    if (item.get("carried_by") !== completerId) {
      return { ok: false, code: 409, error: "required item is not in the completer's inventory: " + id }
    }
    required.push(item)
  }

  const rewardIds = idList(callData.rewardItems)
  if (!rewardIds.length) return { ok: false, code: 409, error: "call has no escrowed reward" }
  const rewards = []
  for (let i = 0; i < rewardIds.length; i++) {
    const id = rewardIds[i]
    let item
    try { item = app.findRecordById("objects", id) }
    catch (err) { return { ok: false, code: 409, error: "reward item no longer exists: " + id } }
    const ist = parseState(item)
    if (escrowCallOf(ist) !== call.id) {
      return { ok: false, code: 409, error: "reward item is no longer escrowed to this call: " + id }
    }
    if (item.get("carried_by") !== issuer) {
      return { ok: false, code: 409, error: "reward item is no longer held by the issuer: " + id }
    }
    rewards.push({ rec: item, state: ist })
  }

  return { ok: true, issuer: issuer, rewards: rewards, required: required }
}

/**
 * Führt den Tausch ATOMAR aus: Belohnung → Spieler, geforderte Items →
 * Aussteller, Treuhand lösen, Auftrag auf "done". Gibt die bewegten Objekt-IDs
 * zurück (Aufrufer baut damit den Permission-Cache neu).
 */
function executeSwap(app, call, callState, callData, swap, completerId) {
  const moved = []
  app.runInTransaction((txApp) => {
    for (let i = 0; i < swap.rewards.length; i++) {
      delete swap.rewards[i].state.escrow
      swap.rewards[i].rec.set("state", swap.rewards[i].state)
      swap.rewards[i].rec.set("carried_by", completerId)
      swap.rewards[i].rec.set("owner", completerId)
      txApp.save(swap.rewards[i].rec)
      moved.push(swap.rewards[i].rec.id)
    }
    for (let i = 0; i < swap.required.length; i++) {
      swap.required[i].set("carried_by", swap.issuer)
      swap.required[i].set("owner", swap.issuer)
      txApp.save(swap.required[i])
      moved.push(swap.required[i].id)
    }
    callData.status = "done"
    callData.completedBy = completerId
    delete callData.pendingBy
    callState.call = callData
    call.set("state", callState)
    txApp.save(call)
  })
  return moved
}

module.exports = { parseState, escrowCallOf, callDataOf, idList, resolveSwap, executeSwap }
