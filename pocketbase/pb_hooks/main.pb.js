/// <reference path="../pb_data/types.d.ts" />

// =====================================================================
// Ajna — PocketBase JS-Hooks
//
// Enthält:
//   - Owner-Auto-Set beim Anlegen eines Objekts
//   - Default-ACEs aus users.default_permissions beim Anlegen anwenden
//   - Cache-Invalidation für effective_permissions auf:
//       * object_permissions create/update/delete
//       * groups update/delete
//       * objects create (für Owner-Defaults)
//   - POST /api/objects/{id}/interact: ephemerer Aktions-Broadcast über
//     den Subscriptions-Broker (kein DB-Write für den Trigger selbst)
//
// Permission-Logik lebt in permissions.js — wird im Handler via require()
// geladen, weil der Goja-VM-Pool keine Modul-Scope-Variablen zwischen
// Boot und Hook-Aufruf teilt.
// =====================================================================


// ---------------------------------------------------------------------
// Owner setzen, wenn ein neues Objekt angelegt wird (BEFORE)
// ---------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const user = e.auth
  if (user) {
    e.record.set("owner", user.id)
  }
  e.next()
}, "objects")


// ---------------------------------------------------------------------
// Nach erfolgreichem Object-Create: Default-Permissions des Owners
// materialisieren + Cache neu berechnen.
// ---------------------------------------------------------------------
onRecordAfterCreateSuccess((e) => {
  try {
    const owner = e.record.get("owner")
    if (owner) {
      const { applyOwnerDefaults, recomputeForObject } = require(`${__hooks}/permissions.js`)
      applyOwnerDefaults(owner, e.record.id)
      recomputeForObject(e.record.id)
    }
  } catch (err) {
    console.log("[objects.afterCreate] error: " + (err && err.message ? err.message : err))
  }
  e.next()
}, "objects")


// ---------------------------------------------------------------------
// object_permissions: jede CRUD-Aktion löst Cache-Refresh für das
// betroffene Objekt aus. Die Helper-Funktion wird in jedem Hook neu
// per require() geholt, weil der Goja-VM-Pool keine Modul-Scope-
// Funktionen zwischen Boot und Hook-Aufruf teilt.
// ---------------------------------------------------------------------
onRecordAfterCreateSuccess((e) => {
  try {
    const { recomputeForObject } = require(`${__hooks}/permissions.js`)
    const objId = e.record.get("object")
    if (objId) recomputeForObject(objId)
  } catch (err) {
    console.log("[object_permissions.afterCreate] error: " + (err && err.message ? err.message : err))
  }
  e.next()
}, "object_permissions")

onRecordAfterUpdateSuccess((e) => {
  try {
    const { recomputeForObject } = require(`${__hooks}/permissions.js`)
    const objId = e.record.get("object")
    if (objId) recomputeForObject(objId)
  } catch (err) {
    console.log("[object_permissions.afterUpdate] error: " + (err && err.message ? err.message : err))
  }
  e.next()
}, "object_permissions")

onRecordAfterDeleteSuccess((e) => {
  try {
    const { recomputeForObject } = require(`${__hooks}/permissions.js`)
    const objId = e.record.get("object")
    if (objId) recomputeForObject(objId)
  } catch (err) {
    console.log("[object_permissions.afterDelete] error: " + (err && err.message ? err.message : err))
  }
  e.next()
}, "object_permissions")


// ---------------------------------------------------------------------
// groups update/delete: alle Objekte, deren ACEs (direkt oder via
// Vorfahren-Gruppe) diese Gruppe referenzieren, brauchen Cache-Refresh.
// ---------------------------------------------------------------------
onRecordAfterUpdateSuccess((e) => {
  try {
    const { recomputeForGroup } = require(`${__hooks}/permissions.js`)
    recomputeForGroup(e.record.id)
  } catch (err) {
    console.log("[groups.afterUpdate] error: " + (err && err.message ? err.message : err))
  }
  e.next()
}, "groups")

onRecordAfterDeleteSuccess((e) => {
  try {
    const { recomputeForGroup } = require(`${__hooks}/permissions.js`)
    recomputeForGroup(e.record.id)
  } catch (err) {
    console.log("[groups.afterDelete] error: " + (err && err.message ? err.message : err))
  }
  e.next()
}, "groups")


// =====================================================================
// POST /api/objects/{id}/interact
//
// Body: { "action": "attack", "payload": <optional, beliebige Daten> }
//
// Workflow:
//   1) Objekt laden (404 wenn unbekannt)
//   2) Permission-Check via resolveEffective + canInteract (403 wenn nicht erlaubt)
//   3) Broker-Broadcast an alle Subscriber von "interact:<objectId>"
//      → KEIN DB-Write für den Trigger selbst
// =====================================================================
routerAdd("POST", "/api/objects/{id}/interact", (e) => {
  try {
    const { resolveEffective, canInteract } = require(`${__hooks}/permissions.js`)

    const objectId = e.request.pathValue("id")
    const info = e.requestInfo()

    // -- Body validieren --
    const body = info.body || {}
    const action = body.action
    if (!action || typeof action !== "string") {
      return e.json(400, { error: "field 'action' (string) is required" })
    }

    // -- Objekt laden --
    let objectRecord
    try {
      objectRecord = $app.findRecordById("objects", objectId)
    } catch (err) {
      return e.json(404, { error: "object not found" })
    }

    // -- Permission-Check --
    const user = info.auth  // null bei anonymem Request
    const effective = resolveEffective(user, objectRecord)

    if (!canInteract(effective, action)) {
      return e.json(403, {
        error: "not allowed to perform '" + action + "' on this object"
      })
    }

    // -- Broker-Broadcast --
    const topic = "interact:" + objectId
    const payload = JSON.stringify({
      action: action,
      source: user ? user.id : null,
      ts: new Date().toISOString(),
      payload: body.payload || null
    })

    const message = new SubscriptionMessage({
      name: topic,
      data: payload
    })

    let delivered = 0
    const clients = $app.subscriptionsBroker().clients()
    for (const id in clients) {
      const client = clients[id]
      if (client.hasSubscription(topic)) {
        client.send(message)
        delivered++
      }
    }

    return e.json(200, { ok: true, delivered: delivered })
  } catch (err) {
    console.log("[interact] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


// =====================================================================
// POST /api/objects/{id}/pickup  — Objekt ins Inventar aufnehmen
//
// Setzt carried_by = anfragender User (Objekt verschwindet aus der Welt).
// Erlaubt, wenn der User OWNER ist ODER das Objekt state.portable === true UND
// er es sehen darf (view). Loot (Nicht-Owner + portable) → Eigentum übergeht auf
// den Sammler, Permission-Cache wird neu berechnet.
// =====================================================================
routerAdd("POST", "/api/objects/{id}/pickup", (e) => {
  try {
    const { resolveEffective, recomputeForObject } = require(`${__hooks}/permissions.js`)
    const objectId = e.request.pathValue("id")
    const info = e.requestInfo()
    const user = info.auth
    if (!user) return e.json(401, { error: "authentication required" })

    let obj
    try { obj = $app.findRecordById("objects", objectId) }
    catch (err) { return e.json(404, { error: "object not found" }) }

    const carried = obj.get("carried_by")
    if (carried && carried !== user.id) {
      return e.json(409, { error: "object already carried by someone else" })
    }

    // Treuhand: gebundene Quest-Belohnung ist unantastbar, bis der Auftrag
    // abgeschlossen oder abgebrochen wird. activeEscrowOf ignoriert Bindungen an
    // gelöschte/beendete Aufträge — sonst blieben Items ewig gesperrt.
    {
      const { parseState, activeEscrowOf } = require(`${__hooks}/quests.js`)
      const bound = activeEscrowOf($app, obj, parseState(obj))
      if (bound) {
        return e.json(409, { error: "object is escrowed as a quest reward (call " + bound + ")" })
      }
    }

    const isOwner = obj.get("owner") === user.id
    let ownerChanged = false
    if (!isOwner) {
      // PB-JSVM liefert JSON-Felder je nach Version als String ODER als
      // Byte-/Zeichen-Array (JsonRaw) — beides robust nach Objekt parsen, sonst
      // ist state.portable undefined und Loot wird fälschlich abgelehnt.
      let state = obj.get("state")
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
      const portable = state && typeof state === "object" && !Array.isArray(state) && state.portable === true
      const eff = resolveEffective(user, obj)
      const canSee = (eff.rights || []).indexOf("view") !== -1
      if (!portable || !canSee) {
        return e.json(403, { error: "not allowed to pick up this object" })
      }
      obj.set("owner", user.id)   // Loot: Eigentum übergeht auf den Sammler
      ownerChanged = true
    }

    obj.set("carried_by", user.id)
    $app.save(obj)
    if (ownerChanged) { try { recomputeForObject(obj.id) } catch (_) {} }
    return e.json(200, { ok: true, id: obj.id, owner: obj.get("owner") })
  } catch (err) {
    console.log("[pickup] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


// =====================================================================
// POST /api/objects/{id}/place  — getragenes Objekt wieder in die Welt setzen
//
// Nur der Träger (carried_by) darf platzieren. Setzt lat/lon(/altitude) und
// leert carried_by → Objekt erscheint an der neuen Position wieder in der Welt.
// =====================================================================
routerAdd("POST", "/api/objects/{id}/place", (e) => {
  try {
    const objectId = e.request.pathValue("id")
    const info = e.requestInfo()
    const user = info.auth
    if (!user) return e.json(401, { error: "authentication required" })

    let obj
    try { obj = $app.findRecordById("objects", objectId) }
    catch (err) { return e.json(404, { error: "object not found" }) }

    if (obj.get("carried_by") !== user.id) {
      return e.json(403, { error: "you can only place an object you carry" })
    }

    // Treuhand: an einen Auftrag gebundene Belohnung darf NICHT aus dem
    // Inventar verschwinden — sonst wäre das Belohnungsversprechen ungedeckt.
    {
      const { parseState, activeEscrowOf } = require(`${__hooks}/quests.js`)
      const bound = activeEscrowOf($app, obj, parseState(obj))
      if (bound) {
        return e.json(409, { error: "object is escrowed as a quest reward (call " + bound + ") — cancel the call first" })
      }
    }

    const body = info.body || {}
    const lat = Number(body.lat), lon = Number(body.lon)
    if (!isFinite(lat) || !isFinite(lon)) {
      return e.json(400, { error: "fields 'lat' and 'lon' (numbers) are required" })
    }
    obj.set("lat", lat)
    obj.set("lon", lon)
    if (body.altitude !== undefined && isFinite(Number(body.altitude))) {
      obj.set("altitude", Number(body.altitude))
    }
    obj.set("carried_by", "")   // zurück in die Welt
    $app.save(obj)
    return e.json(200, { ok: true, id: obj.id })
  } catch (err) {
    console.log("[place] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


// =====================================================================
// QUESTS / HANDEL — gedeckte Belohnungen
//
// Ein Auftrag (`type: "call"`) zahlt NUR Objekte aus, die der Aussteller
// besitzt und die beim Posten treuhänderisch gebunden wurden. Nichts wird
// erzeugt. Der Abschluss ist ein atomarer Tausch:
//   requiresItems (Spieler → Aussteller)  ↔  rewardItems (Aussteller → Spieler)
// Clientseitig ginge das nicht: nur der Server darf fremden Besitz bewegen.
// =====================================================================

// POST /api/objects/{id}/quest/publish
// Body: { rewardItems: [objectId, …],
//         requiresItems?: [objectId, …],                     // konkrete Instanzen
//         requires?: [{ match: {type?,name?,tag?}, count? }], // Gattung + Anzahl
//         verify?: "items" | "agent",
//         repeatable?: bool, rewardPerRun?: number }          // mehrfach spielbar
// Bindet die Belohnung treuhänderisch. Nur der Aussteller (owner).
//
// verify: "items" (Default) — Server entscheidet deterministisch.
// verify: "agent"           — der Aussteller-Agent entscheidet mit eigener
//                             Logik (siehe quest/approve).
routerAdd("POST", "/api/objects/{id}/quest/publish", (e) => {
  try {
    const { parseState, activeEscrowOf, callDataOf, idList, validateSpecs } = require(`${__hooks}/quests.js`)
    const callId = e.request.pathValue("id")
    const info = e.requestInfo()
    const user = info.auth
    if (!user) return e.json(401, { error: "authentication required" })

    let call
    try { call = $app.findRecordById("objects", callId) }
    catch (err) { return e.json(404, { error: "call not found" }) }
    if (call.get("type") !== "call") return e.json(400, { error: "object is not a call" })
    if (call.get("owner") !== user.id) return e.json(403, { error: "only the issuer may publish this call" })

    const body = info.body || {}
    const rewardIds = idList(body.rewardItems)
    const requireIds = idList(body.requiresItems)
    const specs = Array.isArray(body.requires) ? body.requires : []
    if (!rewardIds.length) {
      return e.json(400, { error: "rewardItems must list at least one item you own — rewards are never minted" })
    }
    const specCheck = validateSpecs(specs)
    if (!specCheck.ok) return e.json(400, { error: specCheck.error })

    // Wiederholbar: pro Durchlauf wird nur ein Teil des Vorrats ausgezahlt.
    // Der Vorrat begrenzt damit die Wiederholungen — es kann nie mehr
    // herausgegeben werden, als hinterlegt wurde.
    const repeatable = body.repeatable === true
    const perRun = repeatable ? Math.max(1, Number(body.rewardPerRun) || 1) : 0
    if (repeatable && perRun > rewardIds.length) {
      return e.json(400, { error: "rewardPerRun (" + perRun + ") exceeds the escrowed reward pool (" + rewardIds.length + ")" })
    }

    // Jede Belohnung muss im Inventar des Ausstellers liegen und frei sein.
    const rewards = []
    for (let i = 0; i < rewardIds.length; i++) {
      const id = rewardIds[i]
      let item
      try { item = $app.findRecordById("objects", id) }
      catch (err) { return e.json(404, { error: "reward item not found: " + id }) }
      if (item.get("carried_by") !== user.id) {
        return e.json(409, { error: "reward item is not in your inventory: " + id })
      }
      const st = parseState(item)
      const bound = activeEscrowOf($app, item, st)
      if (bound && bound !== callId) {
        return e.json(409, { error: "reward item already escrowed to another call: " + id })
      }
      rewards.push({ rec: item, state: st })
    }

    $app.runInTransaction((txApp) => {
      for (let i = 0; i < rewards.length; i++) {
        rewards[i].state.escrow = { call: callId }
        rewards[i].rec.set("state", rewards[i].state)
        txApp.save(rewards[i].rec)
      }
      const cs = parseState(call)
      const c = callDataOf(cs)
      c.rewardItems = rewardIds
      if (requireIds.length) c.requiresItems = requireIds; else delete c.requiresItems
      // Gattungs-Forderungen („3× Wolfsfell") — normalisiert ablegen.
      if (specs.length) {
        const norm = []
        for (let i = 0; i < specs.length; i++) {
          const m = specs[i].match || {}
          const entry = { match: {}, count: Number(specs[i].count == null ? 1 : specs[i].count) || 1 }
          if (m.type) entry.match.type = String(m.type)
          if (m.name) entry.match.name = String(m.name)
          if (m.tag) entry.match.tag = String(m.tag)
          norm.push(entry)
        }
        c.requires = norm
      } else delete c.requires
      // Wer entscheidet über den Abschluss? Nur "agent" weicht vom Default ab.
      c.verify = (String(body.verify || "") === "agent") ? "agent" : "items"
      if (repeatable) { c.repeatable = true; c.rewardPerRun = perRun }
      else { delete c.repeatable; delete c.rewardPerRun }
      // Veröffentlichen heißt: der Aussteller bietet den Auftrag (neu) an →
      // Lebenszyklus zurücksetzen. Sonst bliebe ein bereits erledigter Auftrag
      // für immer "done" und ließe sich mit frischer Belohnung nicht wiederbeleben.
      c.status = "open"
      delete c.claimedBy
      delete c.completedBy
      delete c.pendingBy
      cs.call = c
      call.set("state", cs)
      txApp.save(call)
    })

    // Den GESPEICHERTEN Stand zurückgeben: der Client soll seine Ansicht daraus
    // auffrischen und nicht aus dem Cache, der per Realtime noch nachhinkt.
    const saved = callDataOf(parseState($app.findRecordById("objects", callId)))
    return e.json(200, { ok: true, id: callId, call: saved, rewardItems: rewardIds, requiresItems: requireIds })
  } catch (err) {
    console.log("[quest.publish] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


// POST /api/objects/{id}/quest/accept — Auftrag annehmen (jeder mit view-Recht).
routerAdd("POST", "/api/objects/{id}/quest/accept", (e) => {
  try {
    const { resolveEffective } = require(`${__hooks}/permissions.js`)
    const { parseState, callDataOf } = require(`${__hooks}/quests.js`)
    const callId = e.request.pathValue("id")
    const info = e.requestInfo()
    const user = info.auth
    if (!user) return e.json(401, { error: "authentication required" })

    let call
    try { call = $app.findRecordById("objects", callId) }
    catch (err) { return e.json(404, { error: "call not found" }) }
    if (call.get("type") !== "call") return e.json(400, { error: "object is not a call" })

    const eff = resolveEffective(user, call)
    if ((eff.rights || []).indexOf("view") === -1) {
      return e.json(403, { error: "not allowed to see this call" })
    }

    const st = parseState(call)
    const c = callDataOf(st)
    if (c.status === "done") return e.json(409, { error: "call already completed" })
    if (c.claimedBy && c.claimedBy !== user.id) {
      return e.json(409, { error: "call already claimed by someone else" })
    }

    c.status = "claimed"
    c.claimedBy = user.id
    st.call = c
    call.set("state", st)
    $app.save(call)
    return e.json(200, { ok: true, id: callId, status: c.status })
  } catch (err) {
    console.log("[quest.accept] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


// POST /api/objects/{id}/quest/complete — Abschluss anfordern.
//
// verify: "items" (Default) → Server prüft deterministisch (geforderte Items +
//   gedeckte Treuhand) und tauscht sofort atomar.
// verify: "agent" → Server zahlt NICHT aus. Er prüft nur die harten
//   Voraussetzungen, setzt den Auftrag auf "pending" und überlässt die
//   inhaltliche Entscheidung dem Aussteller-Agent (Monster erlegt? Ort
//   erreicht? …). Der ruft danach quest/approve bzw. quest/reject.
routerAdd("POST", "/api/objects/{id}/quest/complete", (e) => {
  try {
    const { resolveEffective, recomputeForObject } = require(`${__hooks}/permissions.js`)
    const { parseState, callDataOf, resolveSwap, executeSwap } = require(`${__hooks}/quests.js`)
    const callId = e.request.pathValue("id")
    const info = e.requestInfo()
    const user = info.auth
    if (!user) return e.json(401, { error: "authentication required" })

    let call
    try { call = $app.findRecordById("objects", callId) }
    catch (err) { return e.json(404, { error: "call not found" }) }
    if (call.get("type") !== "call") return e.json(400, { error: "object is not a call" })

    const eff = resolveEffective(user, call)
    if ((eff.rights || []).indexOf("view") === -1) {
      return e.json(403, { error: "not allowed to see this call" })
    }

    const st = parseState(call)
    const c = callDataOf(st)
    if (c.status === "done") return e.json(409, { error: "call already completed" })
    if (c.status === "cancelled") return e.json(409, { error: "call was cancelled" })
    if (c.claimedBy && c.claimedBy !== user.id) {
      return e.json(403, { error: "call is claimed by someone else" })
    }

    // Harte Voraussetzungen gelten in BEIDEN Modi — ein Agent soll nicht über
    // eine ungedeckte Belohnung entscheiden müssen.
    const swap = resolveSwap($app, call, c, user.id)
    if (!swap.ok) return e.json(swap.code, { error: swap.error })

    if (c.verify === "agent") {
      c.status = "pending"
      c.pendingBy = user.id
      st.call = c
      call.set("state", st)
      $app.save(call)   // Realtime-Update → der Aussteller-Agent sieht "pending"
      return e.json(202, { ok: true, id: callId, status: "pending", message: "awaiting issuer verification" })
    }

    const moved = executeSwap($app, call, st, c, swap, user.id)
    for (let i = 0; i < moved.length; i++) {
      try { recomputeForObject(moved[i]) } catch (_) {}   // Eigentum gewechselt
    }
    // Status NICHT hart "done": ein wiederholbarer Auftrag steht danach wieder
    // auf "open", solange der Vorrat reicht — executeSwap hat c.status gesetzt.
    return e.json(200, {
      ok: true, id: callId, status: c.status,
      rewardsLeft: (c.rewardItems || []).length, completions: c.completions || 1,
      repeatable: c.repeatable === true
    })
  } catch (err) {
    console.log("[quest.complete] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


// POST /api/objects/{id}/quest/approve — NUR der Aussteller (Agent).
// Body: { user?: "<completerId>",           (sonst pendingBy, sonst claimedBy)
//         requiresItems?: [objectId, …] }   zusätzlich einzuziehende Instanzen
//
// Der Agent hat seine EIGENE Bedingung geprüft (Monster erlegt, Ort erreicht,
// beliebige Logik) und gibt hier frei. Über `requiresItems` kann er dabei selbst
// bestimmen, WELCHE Gegenstände eingezogen werden — so lassen sich Mengen-/
// Gattungs-/Sonderregeln komplett agent-seitig abbilden. Der Server prüft
// weiterhin, dass diese Items dem Spieler gehören und dass die Belohnung gedeckt
// ist, und führt den Tausch atomar aus: ein Agent kann also nur die von IHM
// hinterlegte Treuhand freigeben, niemals etwas erzeugen.
routerAdd("POST", "/api/objects/{id}/quest/approve", (e) => {
  try {
    const { recomputeForObject } = require(`${__hooks}/permissions.js`)
    const { parseState, callDataOf, idList, resolveSwap, executeSwap } = require(`${__hooks}/quests.js`)
    const callId = e.request.pathValue("id")
    const info = e.requestInfo()
    const user = info.auth
    if (!user) return e.json(401, { error: "authentication required" })

    let call
    try { call = $app.findRecordById("objects", callId) }
    catch (err) { return e.json(404, { error: "call not found" }) }
    if (call.get("type") !== "call") return e.json(400, { error: "object is not a call" })
    if (call.get("owner") !== user.id) {
      return e.json(403, { error: "only the issuer may approve this call" })
    }

    const st = parseState(call)
    const c = callDataOf(st)
    if (c.status === "done") return e.json(409, { error: "call already completed" })
    if (c.status === "cancelled") return e.json(409, { error: "call was cancelled" })

    const body = info.body || {}
    const completerId = String(body.user || c.pendingBy || c.claimedBy || "").trim()
    if (!completerId) {
      return e.json(409, { error: "no completer to approve — pass 'user' or wait for a claim/completion request" })
    }

    // Der Agent darf zusätzlich konkrete Instanzen benennen (eigene Logik).
    const swap = resolveSwap($app, call, c, completerId, idList(body.requiresItems))
    if (!swap.ok) return e.json(swap.code, { error: swap.error })

    const moved = executeSwap($app, call, st, c, swap, completerId)
    for (let i = 0; i < moved.length; i++) {
      try { recomputeForObject(moved[i]) } catch (_) {}
    }
    return e.json(200, {
      ok: true, id: callId, status: c.status, completedBy: completerId,
      collected: swap.required.length, rewardsLeft: (c.rewardItems || []).length,
      repeatable: c.repeatable === true
    })
  } catch (err) {
    console.log("[quest.approve] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


// POST /api/objects/{id}/quest/reject — NUR der Aussteller (Agent).
// Body: { reason?: "…" }  → Auftrag geht zurück in den Umlauf, Treuhand bleibt.
routerAdd("POST", "/api/objects/{id}/quest/reject", (e) => {
  try {
    const { parseState, callDataOf } = require(`${__hooks}/quests.js`)
    const callId = e.request.pathValue("id")
    const info = e.requestInfo()
    const user = info.auth
    if (!user) return e.json(401, { error: "authentication required" })

    let call
    try { call = $app.findRecordById("objects", callId) }
    catch (err) { return e.json(404, { error: "call not found" }) }
    if (call.get("type") !== "call") return e.json(400, { error: "object is not a call" })
    if (call.get("owner") !== user.id) {
      return e.json(403, { error: "only the issuer may reject this call" })
    }

    const st = parseState(call)
    const c = callDataOf(st)
    if (c.status === "done") return e.json(409, { error: "call already completed" })

    const body = info.body || {}
    const reason = body.reason ? String(body.reason).slice(0, 500) : null
    // Zurück in den Umlauf: bleibt beim Beanspruchenden, wenn es einen gibt.
    c.status = c.claimedBy ? "claimed" : "open"
    delete c.pendingBy
    if (reason) c.rejectReason = reason; else delete c.rejectReason
    st.call = c
    call.set("state", st)
    $app.save(call)
    return e.json(200, { ok: true, id: callId, status: c.status, reason: reason })
  } catch (err) {
    console.log("[quest.reject] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


// POST /api/objects/{id}/quest/cancel — Aussteller bricht ab, Treuhand wird frei.
routerAdd("POST", "/api/objects/{id}/quest/cancel", (e) => {
  try {
    const { parseState, escrowCallOf, callDataOf, idList } = require(`${__hooks}/quests.js`)
    const callId = e.request.pathValue("id")
    const info = e.requestInfo()
    const user = info.auth
    if (!user) return e.json(401, { error: "authentication required" })

    let call
    try { call = $app.findRecordById("objects", callId) }
    catch (err) { return e.json(404, { error: "call not found" }) }
    if (call.get("type") !== "call") return e.json(400, { error: "object is not a call" })
    if (call.get("owner") !== user.id) return e.json(403, { error: "only the issuer may cancel this call" })

    const st = parseState(call)
    const c = callDataOf(st)
    if (c.status === "done") return e.json(409, { error: "call already completed" })

    const rewardIds = idList(c.rewardItems)
    const rewards = []
    for (let i = 0; i < rewardIds.length; i++) {
      let item
      try { item = $app.findRecordById("objects", rewardIds[i]) } catch (err) { continue }
      const ist = parseState(item)
      if (escrowCallOf(ist) === callId) rewards.push({ rec: item, state: ist })
    }

    $app.runInTransaction((txApp) => {
      for (let i = 0; i < rewards.length; i++) {
        delete rewards[i].state.escrow
        rewards[i].rec.set("state", rewards[i].state)
        txApp.save(rewards[i].rec)
      }
      c.status = "cancelled"
      st.call = c
      call.set("state", st)
      txApp.save(call)
    })

    const saved = callDataOf(parseState($app.findRecordById("objects", callId)))
    return e.json(200, { ok: true, id: callId, status: "cancelled", released: rewards.length, call: saved })
  } catch (err) {
    console.log("[quest.cancel] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


// =====================================================================
// Debug-Endpoint: View-Rule Klausel-für-Klausel auswerten
//
// Spiegelt die in objects.viewRule kodierte Logik in JS nach und sagt
// pro Klausel, ob sie für den ANFRAGENDEN User matchen würde. Plus
// listet alle ACEs des Objekts auf, damit man sieht, wie die Daten
// wirklich gespeichert sind (Case/Whitespace-Issues bei subject_type
// fallen so direkt auf).
//
//   GET /api/objects/{id}/debug-view
// =====================================================================
routerAdd("GET", "/api/objects/{id}/debug-view", (e) => {
  try {
    const objectId = e.request.pathValue("id")
    const info = e.requestInfo()
    const user = info.auth

    let object
    try { object = $app.findRecordById("objects", objectId) }
    catch { return e.json(404, { error: "object not found" }) }

    const result = {
      objectId,
      objectOwner: object.get("owner"),
      requestAuth: user ? { id: user.id, email: user.get("email") } : null,
    }

    // --- 1) Owner-Check
    result.ownerMatch = !!user && object.get("owner") === user.id

    // --- 2) effective_permissions-Cache
    let cacheRows = []
    if (user) {
      try {
        cacheRows = $app.findRecordsByFilter(
          "effective_permissions",
          "object = {:oid} && user = {:uid}",
          "", 100, 0,
          { oid: objectId, uid: user.id }
        )
      } catch {}
    }
    result.cache = {
      rows: cacheRows.map(r => ({
        id: r.id, user: r.get("user"), rights: r.get("rights")
      })),
      hasViewRight: cacheRows.some(r => {
        const rights = r.get("rights") || []
        return Array.isArray(rights) ? rights.indexOf("view") >= 0 : false
      })
    }

    // --- 3-5) Implicit-Audience-Checks auf object_permissions
    let aceRows = []
    try {
      aceRows = $app.findRecordsByFilter(
        "object_permissions",
        "object = {:oid}",
        "", 200, 0,
        { oid: objectId }
      )
    } catch (err) {
      result.aceQueryError = err && err.message
    }

    // ACEs raw aufzeigen — Whitespace/Case-Probleme werden hier sichtbar,
    // weil JSON.stringify die Werte verbatim druckt.
    result.objectAces = aceRows.map(r => {
      const rights = r.get("rights")
      return {
        id: r.id,
        subject_type: r.get("subject_type"),
        subject_type_len: (r.get("subject_type") || "").length,
        subject: r.get("subject"),
        rights: rights,
        rights_isArray: Array.isArray(rights),
        rights_contains_view: Array.isArray(rights)
          ? rights.indexOf("view") >= 0
          : (typeof rights === "string" ? rights.indexOf("view") >= 0 : false)
      }
    })

    const hasView = a => {
      const r = a.get("rights") || []
      if (Array.isArray(r)) return r.indexOf("view") >= 0
      if (typeof r === "string") return r.indexOf("view") >= 0
      return false
    }

    const everyoneAce       = aceRows.find(a => a.get("subject_type") === "everyone"        && hasView(a))
    const authenticatedAce  = aceRows.find(a => a.get("subject_type") === "authenticated"   && hasView(a))
    const anonymousAce      = aceRows.find(a => a.get("subject_type") === "anonymous"       && hasView(a))

    result.implicit = {
      everyoneMatch:      !!everyoneAce,
      authenticatedMatch: !!authenticatedAce && !!user,
      anonymousMatch:     !!anonymousAce     && !user
    }

    result.shouldSee = result.ownerMatch
      || result.cache.hasViewRight
      || result.implicit.everyoneMatch
      || result.implicit.authenticatedMatch
      || result.implicit.anonymousMatch

    return e.json(200, result)
  } catch (err) {
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


// =====================================================================
// Invitations — Friend-/Group-Einladungen
//
// Privacy-Modell: die users-Collection ist strikt (jeder sieht nur sich
// selbst). Damit Einladungen UI-tauglich angezeigt werden können (z. B.
// "Anna hat dich eingeladen"), schreibt der Server beim Anlegen ein
// Email-Snapshot ins Invitation-Record. Empfänger sehen damit den
// Inviter, ohne dass dessen User-Record direkt lesbar wäre.
// =====================================================================

// POST /api/groups/{id}/invite — Body: { email } ODER { name }
//
// Privacy: in vielen Szenarien wollen Spieler ihre Mailadresse NICHT
// preisgeben (Spielrunden-Bekanntschaften etc.). Daher zweite Lookup-
// Methode per `users.name`. Bei Mehrdeutigkeit (mehrere User mit
// gleichem Anzeigenamen) gibt der Hook 409 zurück und verlangt eine
// eindeutigere Angabe oder die E-Mail.
routerAdd("POST", "/api/groups/{id}/invite", (e) => {
  try {
    const groupId = e.request.pathValue("id")
    const info = e.requestInfo()
    const body = info.body || {}
    const email = (body.email || "").trim().toLowerCase()
    const name  = (body.name  || "").trim()

    if (!email && !name) {
      return e.json(400, { error: "either 'email' or 'name' is required" })
    }

    const user = info.auth
    if (!user) return e.json(401, { error: "auth required" })

    let group
    try { group = $app.findRecordById("groups", groupId) }
    catch { return e.json(404, { error: "group not found" }) }

    if (group.get("owner") !== user.id) {
      return e.json(403, { error: "only the group owner may invite" })
    }

    // Invitee per E-Mail oder Name finden ($app läuft mit App-Privilege
    // und umgeht die strenge users.viewRule).
    let invitee
    if (email) {
      try {
        invitee = $app.findFirstRecordByFilter(
          "users",
          "email = {:email}",
          { email }
        )
      } catch {
        return e.json(404, { error: "no user with this email" })
      }
    } else {
      // Name ist nicht unique — Mehrdeutigkeit explizit melden, statt
      // willkürlich einen User zu nehmen.
      const matches = $app.findRecordsByFilter(
        "users",
        "name = {:name}",
        "", 5, 0,
        { name }
      )
      if (matches.length === 0) {
        return e.json(404, { error: "no user with this name" })
      }
      if (matches.length > 1) {
        return e.json(409, {
          error: "multiple users share this name — please invite by email instead"
        })
      }
      invitee = matches[0]
    }

    if (invitee.id === user.id) {
      return e.json(400, { error: "cannot invite yourself" })
    }

    if ((group.get("members") || []).indexOf(invitee.id) !== -1) {
      return e.json(409, { error: "user is already a member" })
    }

    // Duplikate verhindern
    let existing = null
    try {
      existing = $app.findFirstRecordByFilter(
        "invitations",
        "group = {:g} && invitee = {:u} && status = 'pending'",
        { g: groupId, u: invitee.id }
      )
    } catch { /* none */ }
    if (existing) {
      return e.json(409, { error: "invitation already pending" })
    }

    const col = $app.findCollectionByNameOrId("invitations")
    const rec = new Record(col, {
      group: groupId,
      group_name: group.get("name"),
      inviter: user.id,
      inviter_email: user.get("email") || "",
      invitee: invitee.id,
      invitee_email: invitee.get("email") || email,
      status: "pending"
    })
    $app.save(rec)

    return e.json(200, { ok: true, invitationId: rec.id })
  } catch (err) {
    console.log("[invite] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


// POST /api/invitations/{id}/accept
routerAdd("POST", "/api/invitations/{id}/accept", (e) => {
  try {
    const invId = e.request.pathValue("id")
    const info = e.requestInfo()
    const user = info.auth
    if (!user) return e.json(401, { error: "auth required" })

    let inv
    try { inv = $app.findRecordById("invitations", invId) }
    catch { return e.json(404, { error: "invitation not found" }) }

    if (inv.get("invitee") !== user.id) {
      return e.json(403, { error: "only the invitee may accept" })
    }
    if (inv.get("status") !== "pending") {
      return e.json(400, { error: "invitation is no longer pending" })
    }

    let group
    try { group = $app.findRecordById("groups", inv.get("group")) }
    catch {
      // Gruppe wurde zwischenzeitlich gelöscht — Invitation auf declined setzen.
      inv.set("status", "declined")
      $app.save(inv)
      return e.json(410, { error: "group no longer exists" })
    }

    const members = (group.get("members") || []).slice()
    if (members.indexOf(user.id) === -1) {
      members.push(user.id)
      group.set("members", members)
      $app.save(group)
    }

    inv.set("status", "accepted")
    $app.save(inv)

    return e.json(200, { ok: true })
  } catch (err) {
    console.log("[invitations.accept] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


// POST /api/invitations/{id}/decline
routerAdd("POST", "/api/invitations/{id}/decline", (e) => {
  try {
    const invId = e.request.pathValue("id")
    const info = e.requestInfo()
    const user = info.auth
    if (!user) return e.json(401, { error: "auth required" })

    let inv
    try { inv = $app.findRecordById("invitations", invId) }
    catch { return e.json(404, { error: "invitation not found" }) }

    if (inv.get("invitee") !== user.id) {
      return e.json(403, { error: "only the invitee may decline" })
    }
    if (inv.get("status") !== "pending") {
      return e.json(400, { error: "invitation is no longer pending" })
    }

    inv.set("status", "declined")
    $app.save(inv)

    return e.json(200, { ok: true })
  } catch (err) {
    console.log("[invitations.decline] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


// =====================================================================
// POST /api/objects/{id}/recompute-permissions
//
// Debug-Endpoint: trigger einen Cache-Refresh für ein Objekt von Hand.
// Hilft, wenn die Hooks nach Schema-Änderungen mal nicht greifen sollten.
// Nur der Object-Owner darf das (oder Superuser).
// =====================================================================
routerAdd("POST", "/api/objects/{id}/recompute-permissions", (e) => {
  try {
    const { recomputeForObject } = require(`${__hooks}/permissions.js`)
    const objectId = e.request.pathValue("id")

    let obj
    try { obj = $app.findRecordById("objects", objectId) }
    catch { return e.json(404, { error: "object not found" }) }

    const info = e.requestInfo()
    const user = info.auth
    if (!user || obj.get("owner") !== user.id) {
      return e.json(403, { error: "only the object owner may recompute" })
    }

    const result = recomputeForObject(objectId)
    return e.json(200, { ok: true, result })
  } catch (err) {
    console.log("[recompute-permissions] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


// =====================================================================
// GET /api/objects/{id}/effective-rights
//
// Liefert die effektiven Rechte des aktuell eingeloggten Users (oder
// anonymer Aufrufer) auf das Objekt — inkl. impliziter Audiences.
// Client-UI nutzt das, um Buttons zu enablen/disablen.
// =====================================================================
routerAdd("GET", "/api/objects/{id}/effective-rights", (e) => {
  try {
    const { resolveEffective } = require(`${__hooks}/permissions.js`)

    const objectId = e.request.pathValue("id")
    let objectRecord
    try {
      objectRecord = $app.findRecordById("objects", objectId)
    } catch (err) {
      return e.json(404, { error: "object not found" })
    }

    const info = e.requestInfo()
    const eff = resolveEffective(info.auth || null, objectRecord)
    return e.json(200, eff)
  } catch (err) {
    console.log("[effective-rights] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})
