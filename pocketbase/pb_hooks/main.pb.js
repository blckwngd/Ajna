/// <reference path="../pb_data/types.d.ts" />

// =====================================================================
// Ajna — PocketBase JS-Hooks
//
// Enthält:
//   - Owner-Auto-Set beim Anlegen eines Objekts
//   - POST /api/objects/{id}/interact: ephemerer Aktions-Broadcast über
//     den Subscriptions-Broker (kein DB-Write für den Trigger selbst)
//
// Permission-Logik lebt in permissions.js — wird im Handler via require()
// geladen, weil der Goja-VM-Pool keine Modul-Scope-Variablen zwischen
// Boot und Hook-Aufruf teilt.
// =====================================================================


// ---------------------------------------------------------------------
// Owner setzen, wenn ein neues Objekt angelegt wird
// ---------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const user = e.auth
  if (user) {
    e.record.set("owner", user.id)
  }
  e.next()
}, "objects")


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
//
// Empfänger sind typischerweise:
//   - alle Game-Clients, die dieses Objekt geladen haben (für visuelle
//     Reaktion: Sound, Partikel, ggf. eigene Animation)
//   - der dem Objekt zugeordnete Agent (NPC-Logik), der ggf. mit einem
//     persistierten Animation-State-Update via pb.collection('objects')
//     .update(id, { animation_state: 'die' }) reagiert.
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
    $app.subscriptionsBroker().clients().forEach((client) => {
      if (client.hasSubscription(topic)) {
        client.send(message)
        delivered++
      }
    })

    return e.json(200, { ok: true, delivered: delivered })
  } catch (err) {
    // Diagnose-Pfad solange die Route stabilisiert wird. Sobald sie
    // sich verlässlich verhält, kann der äußere try/catch raus —
    // PocketBase fängt nicht-gefangene Exceptions selbst ab.
    console.log("[interact] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})
