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
  // UTF-8-Dekodierung liegt in utf8.js. Sie hier von Hand zu machen war lange
  // falsch: Bytes wurden als Latin-1 gelesen, „Bäume" wurde zu „BÃ¤ume" — und
  // weil Hooks den Stand zurückschreiben, wurde das gespeichert.
  const { jsonObject } = require(`${__hooks}/utf8.js`)
  const state = jsonObject(rec.get("state"), {})
  return Array.isArray(state) ? {} : state
}

/** Call-ID aus der Markierung am Item — sagt NICHTS über deren Gültigkeit. */
function escrowCallOf(state) {
  const esc = state && state.escrow
  return (esc && typeof esc === "object" && esc.call) ? String(esc.call) : null
}

/**
 * Wie escrowCallOf, aber SELBSTHEILEND: liefert die Call-ID nur, wenn die
 * Bindung noch wirklich gilt. Eine Markierung allein reicht nicht — sie kann
 * auf drei Wegen verwaisen:
 *   • der Auftrag wurde gelöscht,
 *   • er ist erledigt/abgebrochen,
 *   • er führt das Item nicht mehr als Belohnung (neu veröffentlicht).
 * Ohne diese Prüfung blieben solche Items für immer gesperrt — weder ablegbar
 * noch als Belohnung wiederverwendbar.
 *
 * @returns {string|null} Call-ID bei gültiger Bindung, sonst null
 */
function activeEscrowOf(app, rec, state) {
  const id = escrowCallOf(state)
  if (!id) return null
  let call
  try { call = app.findRecordById("objects", id) }
  catch (err) { return null }                       // Auftrag gelöscht → frei
  if (call.get("type") !== "call") return null
  const c = callDataOf(parseState(call))
  if (c.status === "done" || c.status === "cancelled") return null   // beendet → frei
  const ids = idList(c.rewardItems)
  for (let i = 0; i < ids.length; i++) if (ids[i] === rec.id) return id
  return null                                        // nicht mehr gelistet → frei
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
  // Der Aussteller DARF seinen eigenen Auftrag abschließen — praktisch zum
  // Durchspielen/Testen und harmlos: Belohnung und geforderte Items wandern
  // dann von ihm zu ihm (No-Op), die Treuhand wird gelöst. Es lässt sich damit
  // nichts gewinnen, was ihm nicht ohnehin gehört.

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
    const bound = activeEscrowOf(app, item, parseState(item))
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
        if (activeEscrowOf(app, rec, st)) continue   // gebundene Items sind tabu
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

  // Wiederholbare Aufträge zahlen pro Durchlauf nur einen Teil des Vorrats aus.
  // Damit begrenzt der Treuhand-Vorrat die Wiederholungen von selbst — es kann
  // nie mehr herausgegeben werden, als der Aussteller hinterlegt hat.
  const repeatable = callData.repeatable === true
  // „Belohnung steigt je Durchlauf": Der n-te Durchlauf zahlt
  // rewardPerRun + steigt·n. Die Einstellung wurde bisher gespeichert und an
  // die Oberfläche zurückgegeben — und nie angewandt. Ein Regler ohne Wirkung.
  const steigt = repeatable ? Math.max(0, Number(callData.steigt) || 0) : 0
  const gelaufen = Math.max(0, Number(callData.completions) || 0)
  const perRun = repeatable
    ? Math.max(1, (Number(callData.rewardPerRun) || 1) + steigt * gelaufen)
    : rewardIds.length
  if (rewardIds.length < perRun) {
    return { ok: false, code: 409, error: "reward pool exhausted: needs " + perRun + " per run, " + rewardIds.length + " left" }
  }

  const payIds = rewardIds.slice(0, perRun)
  const rewards = []
  for (let i = 0; i < payIds.length; i++) {
    const id = payIds[i]
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

  return {
    ok: true, issuer: issuer, rewards: rewards, required: required,
    remainingRewards: rewardIds.slice(perRun), repeatable: repeatable, perRun: perRun,
    steigt: steigt
  }
}

/**
 * Führt den Tausch ATOMAR aus: Belohnung → Spieler, geforderte Items →
 * Aussteller, Treuhand lösen. Gibt die bewegten Objekt-IDs zurück (Aufrufer
 * baut damit den Permission-Cache neu).
 *
 * Danach entscheidet der Vorrat über den Status: ein wiederholbarer Auftrag geht
 * zurück auf "open", solange noch genug Belohnung gebunden ist — sonst "done"
 * (erschöpft). Einmalige Aufträge sind nach dem Durchlauf immer "done".
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
    callData.rewardItems = swap.remainingRewards
    callData.completions = (Number(callData.completions) || 0) + 1
    callData.completedBy = completerId          // zuletzt abgeschlossen von
    delete callData.pendingBy
    // Gegen den Bedarf des NÄCHSTEN Durchlaufs prüfen, nicht des gerade
    // bezahlten: Mit Steigerung kostet der nächste mehr. Sonst bliebe der
    // Auftrag offen, und der nächste Spieler liefe beim Abschluss in ein 409.
    const naechsterBedarf = swap.perRun + (Number(swap.steigt) || 0)
    if (swap.repeatable && swap.remainingRewards.length >= naechsterBedarf) {
      callData.status = "open"                  // zurück in den Umlauf
      delete callData.claimedBy
    } else {
      callData.status = "done"                  // einmalig bzw. Vorrat zu klein
      // Reste freigeben: bei perRun=2 und Vorrat 3 bliebe sonst 1 Item ewig
      // gebunden, obwohl der Auftrag erledigt ist.
      for (let i = 0; i < swap.remainingRewards.length; i++) {
        try {
          const left = txApp.findRecordById("objects", swap.remainingRewards[i])
          const lst = parseState(left)
          delete lst.escrow
          left.set("state", lst)
          txApp.save(left)
        } catch (err) { /* schon weg → egal */ }
      }
      callData.rewardItems = []
    }
    callState.call = callData
    call.set("state", callState)
    txApp.save(call)
  })
  return moved
}

// =====================================================================
//  Frist
// =====================================================================
// `state.call.deadline` ist ein ISO-Zeitpunkt. Geprüft wird LAZY — beim
// Annehmen und beim Abschließen —, nicht von einem Zeitgeber.
//
// Warum nicht per Timer oder Agent: Eine Frist, die nur tickt, solange ein
// Prozess läuft, ist keine Frist. Läge die Auswertung beim Quest-Agent, blieben
// bei dessen Ausfall Belohnungen unbegrenzt in der Treuhand gebunden — echter
// Besitz, den niemand mehr freigeben kann. Die lazy Prüfung braucht niemanden,
// der läuft: Wer den Auftrag anfasst, stellt fest, dass er abgelaufen ist.

/**
 * Ist der Auftrag über seine Frist hinaus?
 * @param {object} call  callData (state.call)
 * @param {number} [jetzt]  ms
 * @returns {boolean}  ohne Frist immer false
 */
function istAbgelaufen(call, jetzt) {
  const d = call && call.deadline
  if (!d) return false
  const t = Date.parse(d)
  if (!isFinite(t)) return false
  return t <= (jetzt || Date.now())
}

/**
 * Abgelaufenen Auftrag stilllegen: Anspruch lösen, Status setzen.
 *
 * Die TREUHAND wird hier bewusst NICHT aufgelöst — gebundene Gegenstände
 * gehören weiterhin dem Aussteller und werden über quest/cancel freigegeben.
 * Ein automatisches Zurückbuchen wäre ein Besitzwechsel ohne Auftrag.
 *
 * @returns {boolean} true, wenn etwas geändert wurde
 */
function markiereAbgelaufen(call) {
  if (!call || call.status === "expired" || call.status === "done" || call.status === "cancelled") {
    return false
  }
  call.status = "expired"
  delete call.claimedBy
  delete call.pendingBy
  return true
}

// =====================================================================
//  Wer nimmt ab?
// =====================================================================
// `state.call.verify` sagt, WER über einen gemeldeten Abschluss entscheidet:
//
//   "items"           der Server, deterministisch (gelieferte Gegenstände)
//   "issuer"/"agent"  der AUSSTELLER des Auftrags — Mensch oder Agent
//   "group"           eine benannte Prüfgruppe (state.call.pruefgruppe)
//   "crowd"           andere Spieler, x von y (quest/confirm)
//
// ZUM NAMEN "agent": historisch. Als es die Aufträge zuerst gab, stellte sie
// immer ein Agent aus, und die Route heißt bis heute quest/approve mit der
// Prüfung `call.owner === user.id`. Gemeint war nie „ein Bot entscheidet",
// sondern „der Aussteller entscheidet" — bei einer Stichprobe durch einen
// Verein ist das ein Mensch. `"issuer"` ist der ehrliche Name; `"agent"` bleibt
// gültig, damit bestehende Aufträge und Agents weiterlaufen.

/** Entscheidet der Aussteller selbst? */
function istAusstellerAbnahme(verify) {
  return verify === "issuer" || verify === "agent"
}

/** Braucht dieser Weg eine menschliche Entscheidung (also erst „pending")? */
function brauchtAbnahme(verify) {
  return istAusstellerAbnahme(verify) || verify === "group" || verify === "crowd"
}

/**
 * Darf dieses Konto über den Abschluss entscheiden?
 *
 * Der Aussteller darf immer — er trägt die Belohnung. Bei `verify: "group"`
 * zusätzlich jedes Mitglied der benannten Gruppe, aufgelöst über dieselbe
 * transitive Mitgliedschaft wie die Rechte (Untergruppen zählen mit).
 *
 * @returns {{ok: boolean, grund: string}}
 */
function darfAbnehmen(app, callRec, c, userId, gruppenVon) {
  if (String(callRec.get("owner") || "") === userId) return { ok: true, grund: "issuer" }
  if (c.verify !== "group") return { ok: false, grund: "only the issuer may approve this call" }
  const gruppe = String(c.pruefgruppe || "")
  if (!gruppe) return { ok: false, grund: "call names no review group" }
  // Die Auflösung kommt VON AUSSEN. Sie hier per require() nachzuladen ging
  // schief und der Fehler verschwand in einem catch — die Abnahme scheiterte
  // dann mit „nicht in der Prüfgruppe", obwohl die Mitgliedschaft bestand.
  if (typeof gruppenVon !== "function") {
    return { ok: false, grund: "review group cannot be resolved" }
  }
  const meine = gruppenVon(userId) || []
  for (let i = 0; i < meine.length; i++) {
    if (String(meine[i]) === gruppe) return { ok: true, grund: "review group" }
  }
  return { ok: false, grund: "you are not in the review group for this call" }
}

// =====================================================================
//  Schwarm-Abnahme
// =====================================================================

/** Wie viele Ja-Stimmen dieser Auftrag braucht (Vorgabe 3, sinnvoll 1–9). */
function noetigeStimmen(call) {
  const n = Number(call && call.schwarmZahl)
  if (!isFinite(n)) return 3
  return Math.max(1, Math.min(9, Math.round(n)))
}

/**
 * Kennung eines Einreichungs-Durchgangs. Ohne sie zählten beim zweiten
 * Einreichen die Stimmen des ersten mit.
 */
function neueEinreichung() {
  return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * Stimmen eines Durchgangs zählen.
 * @returns {{ja: number, nein: number, waehler: string[]}}
 */
function zaehleStimmen(app, callId, submission) {
  const ergebnis = { ja: 0, nein: 0, waehler: [] }
  let zeilen = []
  try {
    zeilen = app.findRecordsByFilter(
      "quest_confirmations",
      "call = {:call} && submission = {:sub}",
      "-created", 200, 0,
      { call: callId, sub: submission }
    )
  } catch (err) { return ergebnis }
  for (let i = 0; i < zeilen.length; i++) {
    const v = zeilen[i].get("verdict")
    if (v === "ok") ergebnis.ja++
    else if (v === "nein") ergebnis.nein++
    ergebnis.waehler.push(String(zeilen[i].get("voter")))
  }
  return ergebnis
}

// =====================================================================
//  Nachweis
// =====================================================================
// Für Echtwelt-Aufgaben („Müll gesammelt") gibt es nichts abzugeben. Der
// Abschluss hängt dann nicht an Ware, sondern an einem Nachweis:
//
//   foto        mindestens ein Bildverweis
//   vorOrt      eine gemeldete Position nahe am Einsatzort
//   gegenstand  läuft weiter über requires/requiresItems (resolveSwap)
//
// WAS DAS IST UND WAS NICHT: Keiner dieser Nachweise ist ein Beweis. Die
// Position meldet das Gerät des Bearbeiters selbst und kann gefälscht werden;
// ein Bild kann alt oder von woanders sein. Die Prüfung erhöht den AUFWAND und
// gibt dem Prüfer etwas in die Hand — mehr behauptet sie nicht. Belastbar wird
// Anwesenheit erst mit einem zweiten Faktor am Ort (NFC/Beacon), siehe die
// Planung zur Regel-Engine.
//
// Deshalb prüft der Server nur, was er prüfen KANN: dass eine Angabe gemacht
// wurde und dass sie plausibel ist (Entfernung zum Auftrag).

const VOR_ORT_RADIUS_M = 150

/** Grobe Meter-Distanz zwischen zwei WGS84-Punkten. */
function abstandM(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * 111320
  const dLon = (bLon - aLon) * 111320 * Math.cos(aLat * Math.PI / 180)
  return Math.sqrt(dLat * dLat + dLon * dLon)
}

/**
 * Nachweis gegen die Forderungen des Auftrags prüfen.
 *
 * @param {object} callRec   Auftrags-Record (für lat/lon)
 * @param {object} c         callData
 * @param {object} proof     { note?, photos?, at? }
 * @returns {{ok: boolean, fehlend: string[], gespeichert: object}}
 */
function pruefeNachweis(callRec, c, proof) {
  const noetig = Array.isArray(c.nachweis) ? c.nachweis : []
  const p = (proof && typeof proof === "object") ? proof : {}
  const fehlend = []

  const bilder = Array.isArray(p.photos)
    ? p.photos.map(function (x) { return String(x || "").slice(0, 300) }).filter(Boolean)
    : []
  // Der übliche Weg ist heute ein Datensatz in `quest_proofs` mit bis zu drei
  // Bildern; die Route prüft vorher, dass er dem Melder und diesem Auftrag
  // gehört. `photos` bleibt als Verweis-Liste bestehen — ein Agent, der
  // Bilder woanders ablegt, soll deswegen nicht scheitern.
  const beleg = p.proofId ? String(p.proofId).slice(0, 40) : ""
  if (noetig.indexOf("foto") !== -1 && !beleg && bilder.length === 0) {
    fehlend.push("foto: mindestens ein Bild")
  }

  let ort = null
  if (noetig.indexOf("vorOrt") !== -1) {
    const lat = Number(p.at && p.at.lat), lon = Number(p.at && p.at.lon)
    if (!isFinite(lat) || !isFinite(lon)) {
      fehlend.push("vorOrt: keine Position gemeldet")
    } else {
      const grenze = Number(c.vorOrtRadiusM) > 0 ? Number(c.vorOrtRadiusM) : VOR_ORT_RADIUS_M
      const d = abstandM(Number(callRec.get("lat")), Number(callRec.get("lon")), lat, lon)
      if (!isFinite(d) || d > grenze) {
        fehlend.push("vorOrt: " + Math.round(d) + " m entfernt, erlaubt sind " + grenze + " m")
      } else {
        // `precise` sagt, ob die Stufe „Genau" galt — eine vergröberte Angabe
        // ist schwächer und soll dem Prüfer nicht als exakt verkauft werden.
        ort = { lat: lat, lon: lon, precise: p.at.precise === true, distanceM: Math.round(d) }
      }
    }
  }

  return {
    ok: fehlend.length === 0,
    fehlend: fehlend,
    gespeichert: {
      note: p.note ? String(p.note).slice(0, 1000) : "",
      photos: bilder.slice(0, 8),
      proofId: beleg || undefined,
      at: ort,
    },
  }
}

module.exports = {
  VOR_ORT_RADIUS_M, abstandM, pruefeNachweis,
  istAusstellerAbnahme, brauchtAbnahme, darfAbnehmen,
  parseState, escrowCallOf, activeEscrowOf, callDataOf, idList,
  specMatches, describeSpec, validateSpecs,
  resolveSwap, executeSwap,
  istAbgelaufen, markiereAbgelaufen,
  noetigeStimmen, neueEinreichung, zaehleStimmen
}
