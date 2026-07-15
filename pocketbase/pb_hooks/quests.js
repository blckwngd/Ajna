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
 * Passt ein Item auf eine Gattungs-Angabe? Alle gesetzten Felder müssen passen
 * (UND). Mindestens eines muss gesetzt sein — sonst würde die Angabe ALLES
 * treffen; das lehnt publish ab.
 */
function specMatches(rec, state, m) {
  if (!m || typeof m !== "object") return false
  if (m.type && String(rec.get("type") || "") !== String(m.type)) return false
  if (m.name && String(rec.get("name") || "").toLowerCase() !== String(m.name).toLowerCase()) return false
  if (m.tag) {
    const tags = Array.isArray(state.tags) ? state.tags : []
    let hit = false
    for (let i = 0; i < tags.length; i++) {
      if (String(tags[i]).toLowerCase() === String(m.tag).toLowerCase()) { hit = true; break }
    }
    if (!hit) return false
  }
  return true
}

/** Lesbare Beschreibung einer Gattungs-Angabe (für Fehlermeldungen). */
function describeSpec(spec) {
  const m = (spec && spec.match) || {}
  const bits = []
  if (m.name) bits.push('"' + m.name + '"')
  if (m.type) bits.push("type=" + m.type)
  if (m.tag) bits.push("#" + m.tag)
  return (spec && spec.count > 1 ? spec.count + "× " : "") + (bits.join(" ") || "?")
}

/** Gültigkeit einer Gattungs-Angabe (publish prüft damit vorab). */
function validateSpecs(specs) {
  if (!Array.isArray(specs)) return { ok: false, error: "requires must be an array" }
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]
    const m = (s && s.match) || null
    if (!m || typeof m !== "object" || (!m.type && !m.name && !m.tag)) {
      return { ok: false, error: "each requires[] entry needs match.type, match.name or match.tag — an empty match would accept anything" }
    }
    const c = Number(s.count == null ? 1 : s.count)
    if (!isFinite(c) || c < 1 || c > 99) return { ok: false, error: "requires[].count must be between 1 and 99" }
  }
  return { ok: true }
}

/**
 * Prüft, ob ein Tausch JETZT zulässig ist, und lädt die beteiligten Records.
 * Deterministisch und server-seitig: geforderte Items im Inventar des Spielers,
 * Belohnung noch gedeckt UND an genau diesen Auftrag gebunden.
 *
 * Forderungen können auf zwei Arten kommen:
 *   • `requiresItems` — konkrete Instanzen („bring mir GENAU dieses Objekt")
 *   • `requires`      — Gattung + Anzahl („bring mir 3× Wolfsfell"); der Server
 *                       sucht passende Items im Inventar des Spielers.
 * `extraRequireIds` erlaubt einem Agent, beim Freigeben zusätzlich konkrete
 * Instanzen zu benennen (eigene Logik, s. quest/approve).
 *
 * Bewusst KEINE Aussage über inhaltliche Quest-Bedingungen (Monster erlegt,
 * Ort erreicht …) — die kennt nur der Agent (verify: "agent").
 *
 * @returns {{ok:true, issuer:string, rewards:Array, required:Array}}
 *        | {ok:false, code:number, error:string}
 */
function resolveSwap(app, call, callData, completerId, extraRequireIds) {
  const issuer = call.get("owner")
  if (!completerId) return { ok: false, code: 409, error: "no completer assigned to this call" }
  if (completerId === issuer) return { ok: false, code: 409, error: "the issuer cannot complete their own call" }

  const required = []
  const used = {}   // verhindert, dass dasselbe Item zwei Forderungen erfüllt

  // 1) Konkret benannte Instanzen (aus dem Auftrag + optional vom Agent).
  const requireIds = idList(callData.requiresItems).concat(idList(extraRequireIds))
  for (let i = 0; i < requireIds.length; i++) {
    const id = requireIds[i]
    if (used[id]) continue
    let item
    try { item = app.findRecordById("objects", id) }
    catch (err) { return { ok: false, code: 409, error: "required item missing: " + id } }
    if (item.get("carried_by") !== completerId) {
      return { ok: false, code: 409, error: "required item is not in the completer's inventory: " + id }
    }
    // Ein selbst als Belohnung verpfändetes Item darf nicht eingezogen werden —
    // sonst bräche der Spieler sein eigenes Versprechen an einen anderen Auftrag.
    const bound = escrowCallOf(parseState(item))
    if (bound) return { ok: false, code: 409, error: "required item is escrowed to another call: " + id }
    used[id] = true
    required.push(item)
  }

  // 2) Gattungs-Forderungen im Inventar des Spielers auflösen.
  const specs = Array.isArray(callData.requires) ? callData.requires : []
  if (specs.length) {
    let inv = []
    try {
      inv = app.findRecordsByFilter("objects", "carried_by = {:u}", "", 500, 0, { u: completerId }) || []
    } catch (err) { inv = [] }
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]
      const want = Number(spec && spec.count == null ? 1 : spec.count) || 1
      const found = []
      for (let j = 0; j < inv.length && found.length < want; j++) {
        const rec = inv[j]
        if (!rec || used[rec.id]) continue
        const st = parseState(rec)
        if (escrowCallOf(st)) continue           // gebundene Items sind tabu
        if (!specMatches(rec, st, spec.match)) continue
        found.push(rec)
      }
      if (found.length < want) {
        return {
          ok: false, code: 409,
          error: "missing required items: needs " + describeSpec(spec) + ", found " + found.length + " in inventory"
        }
      }
      for (let j = 0; j < found.length; j++) { used[found[j].id] = true; required.push(found[j]) }
    }
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

module.exports = {
  parseState, escrowCallOf, callDataOf, idList,
  specMatches, describeSpec, validateSpecs,
  resolveSwap, executeSwap
}
