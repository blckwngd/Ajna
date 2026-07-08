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

    const isOwner = obj.get("owner") === user.id
    let ownerChanged = false
    if (!isOwner) {
      let state = obj.get("state")
      if (typeof state === "string") { try { state = JSON.parse(state) } catch (_) { state = {} } }
      const portable = state && typeof state === "object" && state.portable === true
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
