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
