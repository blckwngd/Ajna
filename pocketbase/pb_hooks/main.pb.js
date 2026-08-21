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
// state.source DURCHSETZEN (BEFORE, objects create+update).
//
// Bis hierher war `state.source` eine Selbstauskunft, die der Client nur noch
// sichtbar machte. Jetzt weist der Server sie ab: Ein Source-Name gehört dem
// Konto, das ihn per Manifest registriert hat — wer ein Objekt unter fremdem
// Namen anlegen will, bekommt 403.
//
// BEWUSST ERLAUBT bleibt ein Name, den NIEMAND registriert hat. Sonst müssten
// Agents ihr Manifest vor dem ersten Objekt veröffentlichen, und Agents ohne
// Manifest könnten gar nichts mehr schreiben — eine Verhaltensänderung, die
// bestehende Installationen bricht, ohne einen Angriff zu verhindern: einen
// unbeanspruchten Namen zu nutzen ist keine Täuschung. Solche Objekte zeigt
// der Client als „Quelle nicht registriert“.
//
// Verglichen wird gegen den OWNER des Datensatzes, nicht gegen den Aufrufer:
// Wer fremde Objekte bearbeiten darf (`edit`), ändert damit nichts an deren
// Herkunft — sie bleibt die des Eigentümers.
// ---------------------------------------------------------------------
function pruefeQuellenanspruch(e) {
  try {
    // JSON-Felder kommen im JSVM je nach Pfad als Objekt, als STRING oder als
    // Byte-Array an — `parseState` deckt alle drei ab. Meine erste Fassung
    // prüfte nur auf Objekt und ließ dadurch JEDE Behauptung durch: der Hook
    // lief, fand `source` aber nie.
    const { parseState } = require(`${__hooks}/quests.js`)
    const src = parseState(e.record).source
    if (src && typeof src === "string") {
      // Auf CREATE setzt der Owner-Hook oben bereits `owner`; als Netz der
      // Aufrufer, falls die Reihenfolge einmal wechselt.
      const owner = e.record.get("owner") || (e.auth ? e.auth.id : "")
      let inhaber = null
      try {
        const m = $app.findFirstRecordByFilter("agent_manifests", "source = {:s}", { s: src })
        inhaber = m ? m.get("owner") : null
      } catch (err) { inhaber = null }   // 404 = niemand hat den Namen

      if (inhaber && inhaber !== owner) {
        throw new ForbiddenError(
          `Die Quelle "${src}" gehört einem anderen Konto. `
          + `Registriere einen eigenen Namen über das Agent-Manifest.`)
      }
    }
  } catch (err) {
    if (err instanceof ForbiddenError) throw err
    console.log("[objects.source] " + (err && err.message ? err.message : err))
  }
  e.next()
}
onRecordCreateRequest(pruefeQuellenanspruch, "objects")
onRecordUpdateRequest(pruefeQuellenanspruch, "objects")


// ---------------------------------------------------------------------
// agent_manifests: Identität des Eigentümers EINSTEMPELN (BEFORE).
//
// `owner_handle` und `owner_sealed` sind abgeleitet — sie kommen aus dem
// Konto, nie aus der Anfrage. Ein Agent kann sich also weder einen fremden
// Handle geben noch sich selbst das Betreiber-Siegel ausstellen. Deshalb
// werden die Werte hier bedingungslos überschrieben, auch wenn der Client
// etwas mitgeschickt hat.
//
// Der Handle darf sich ändern (Umbenennung). Laufende Agents veröffentlichen
// ihr Manifest periodisch neu (Heartbeat), die Kopie heilt sich damit von
// selbst; für dauerhaft gestoppte Agents bleibt der letzte Stand stehen.
// ---------------------------------------------------------------------
function stampeManifestIdentitaet(e) {
  try {
    const ownerId = e.record.get("owner")
    if (ownerId) {
      const u = $app.findRecordById("users", ownerId)
      e.record.set("owner_handle", u ? (u.get("username") || "") : "")
      e.record.set("owner_sealed", u ? !!u.get("agent_seal") : false)
    } else {
      e.record.set("owner_handle", "")
      e.record.set("owner_sealed", false)
    }
  } catch (err) {
    // Kein Grund, das Manifest scheitern zu lassen — ohne Handle zeigt der
    // Client eben „nicht bestätigt", was die sichere Vorgabe ist.
    console.log("[manifest.stamp] " + (err && err.message ? err.message : err))
    e.record.set("owner_handle", "")
    e.record.set("owner_sealed", false)
  }
  e.next()
}
// ---------------------------------------------------------------------
// users.agent_seal ist eine Aussage des BETREIBERS über ein Konto — niemals
// eine Aussage des Kontos über sich selbst.
//
// Die Rechteregel der users-Collection erlaubt jedem, seinen EIGENEN Datensatz
// zu ändern, und PocketBase kennt keine Schreibrechte je Feld. Ohne diesen
// Hook konnte sich also jedes Konto per `updateCurrentUser({agent_seal:true})`
// selbst zum bestätigten Agenten erklären — gemessen, nicht vermutet.
//
// Nur Superuser (Administration) dürfen das Feld setzen. Alle anderen bekommen
// den gespeicherten Wert zurückgeschrieben; das schlägt nicht fehl, sondern
// ignoriert die Aussage stillschweigend.
// ---------------------------------------------------------------------
onRecordCreateRequest((e) => {
  if (!e.hasSuperuserAuth()) e.record.set("agent_seal", false)
  e.next()
}, "users")

onRecordUpdateRequest((e) => {
  if (!e.hasSuperuserAuth()) {
    let alt = false
    try { alt = !!$app.findRecordById("users", e.record.id).get("agent_seal") } catch (err) {}
    e.record.set("agent_seal", alt)
  }
  e.next()
}, "users")

// ---------------------------------------------------------------------
// users.karma_points — dieselbe Falle wie agent_seal, dieselbe Antwort.
//
// Karma ist eine Aussage des SERVERS über ein Konto: Punkte entstehen
// ausschließlich beim Auszahlen eines Auftrags (pb_hooks/karma.js). Weil die
// users-Regel jedem erlaubt, seinen eigenen Datensatz zu ändern, und
// PocketBase keine Schreibrechte je Feld kennt, könnte sich sonst jedes Konto
// per updateCurrentUser({karma_points: 999}) auf Stufe 5 setzen.
//
// Neue Konten starten bei 0; bei Änderungen wird der gespeicherte Wert
// zurückgeschrieben. Kein Fehler, sondern stilles Ignorieren — der Client
// schickt das Feld ohnehin nur versehentlich mit.
// ---------------------------------------------------------------------
onRecordCreateRequest((e) => {
  if (!e.hasSuperuserAuth()) e.record.set("karma_points", 0)
  e.next()
}, "users")

onRecordUpdateRequest((e) => {
  if (!e.hasSuperuserAuth()) {
    let alt = 0
    try {
      const p = Number($app.findRecordById("users", e.record.id).get("karma_points"))
      alt = isFinite(p) && p > 0 ? p : 0
    } catch (err) {}
    e.record.set("karma_points", alt)
  }
  e.next()
}, "users")


onRecordCreateRequest(stampeManifestIdentitaet, "agent_manifests")
onRecordUpdateRequest(stampeManifestIdentitaet, "agent_manifests")


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
// WAL-Checkpoint-Cron: hält das SQLite-Write-Ahead-Log klein. Ohne das
// wächst es unter Dauer-Schreiblast (Agents!) unbegrenzt, und nach einem
// UNSAUBEREN Shutdown (OOM-Kill) muss PB beim Boot das komplette WAL
// wiederherstellen — minutenlang stumm vor "Server started" (VPS-Vorfall
// 2026-08-10: pm2 "online", Port nie gebunden). TRUNCATE checkpointet und
// stutzt die Datei auf 0.
// ---------------------------------------------------------------------
// Checkpointet BEIDE Datenbanken: data.db UND die Auxiliary-/Logs-DB —
// letztere bekommt jeden API-Request der Dauerpoller und wächst am schnellsten.
// Ergebnis wird geloggt, wenn der Checkpoint nicht durchkam (busy=1 heißt:
// ein langlebiger Reader blockiert — dann wächst das WAL trotz Cron weiter).
cronAdd("wal_checkpoint", "*/15 * * * *", () => {
  for (const [label, db] of [["data", () => $app.db()], ["aux", () => $app.auxDB && $app.auxDB()]]) {
    try {
      const conn = db()
      if (!conn) continue
      const res = new DynamicModel({ busy: 0, log: 0, checkpointed: 0 })
      conn.newQuery("PRAGMA wal_checkpoint(TRUNCATE)").one(res)
      if (res.busy || res.log > res.checkpointed) {
        console.log(`[wal_checkpoint] ${label}: busy=${res.busy} log=${res.log} checkpointed=${res.checkpointed} — WAL nicht (voll) eingedampft`)
      }
    } catch (err) {
      console.log(`[wal_checkpoint] ${label} error: ` + (err && err.message ? err.message : err))
    }
  }
})

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
      // Die Byte-Fassung ist UTF-8; siehe utf8.js, warum das wichtig ist.
      const state = require(`${__hooks}/utf8.js`).jsonObject(obj.get("state"), {})
      const portable = !Array.isArray(state) && state.portable === true
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
//         verify?: "items" | "agent" | "crowd",
//         repeatable?: bool, rewardPerRun?: number }          // mehrfach spielbar
// Bindet die Belohnung treuhänderisch. Nur der Aussteller (owner).
//
// verify: "items" (Default) — Server entscheidet deterministisch.
// verify: "crowd"           — andere Spieler nehmen ab (quest/confirm).
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
      // Zulässige Abnahmewege — siehe „Wer nimmt ab?" in quests.js.
      // Alles Unbekannte fällt auf "items" zurück: ein Auftrag mit
      // unverstandenem Verfahren wäre sonst nie abschließbar.
      const v = String(body.verify || "")
      c.verify = (v === "agent" || v === "issuer" || v === "crowd" || v === "group") ? v : "items"
      // Prüfgruppe nur bei verify:"group" — sonst stünde eine Gruppe im
      // Datensatz, die niemand auswertet.
      if (c.verify === "group" && body.pruefgruppe) c.pruefgruppe = String(body.pruefgruppe)
      else if (c.verify !== "group") delete c.pruefgruppe
      if (repeatable) { c.repeatable = true; c.rewardPerRun = perRun }
      else { delete c.repeatable; delete c.rewardPerRun }
      // Veröffentlichen heißt: der Aussteller bietet den Auftrag (neu) an →
      // Lebenszyklus zurücksetzen. Sonst bliebe ein bereits erledigter Auftrag
      // für immer "done" und ließe sich mit frischer Belohnung nicht wiederbeleben.
      c.status = "open"
      // Zeitpunkt der Ausschreibung. Daran hängt die Wartezeit, nach der ein
      // zunächst nur bei der Figur angebotener Auftrag zusätzlich gelistet wird
      // (siehe GET /api/quests/near). Ohne eigenen Stempel zählte das
      // Anlegedatum des Objekts — bei einem wiederbelebten Auftrag also ein
      // Datum von vor Wochen.
      c.publishedAt = new Date().toISOString()
      delete c.angeboten
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
    const { parseState, callDataOf, istAbgelaufen, markiereAbgelaufen } = require(`${__hooks}/quests.js`)
    const { karmaReicht } = require(`${__hooks}/karma.js`)
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

    // Frist zuerst: ein abgelaufener Auftrag lässt sich nicht mehr annehmen,
    // und der Stand wird gleich mitgeschrieben (lazy expiry).
    if (istAbgelaufen(c)) {
      if (markiereAbgelaufen(c)) {
        st.call = c
        call.set("state", st)
        try { $app.save(call) } catch (err) {}
      }
      return e.json(409, { error: "call expired", status: "expired", deadline: c.deadline })
    }

    if (c.claimedBy && c.claimedBy !== user.id) {
      return e.json(409, { error: "call already claimed by someone else" })
    }

    // Karma-Bedingung: `state.call.karma` ist die geforderte STUFE (0–5).
    // Geprüft wird gegen den serverseitig geführten Punktestand — der Client
    // kann ihn nicht setzen (siehe Hook „karma_points" oben).
    const noetig = Number(c.karma) || 0
    if (noetig > 0) {
      const k = karmaReicht($app, user.id, noetig)
      if (!k.ok) {
        return e.json(403, {
          error: "karma level " + k.noetig + " required, you have " + k.stufe,
          karma: k.stufe, karmaRequired: k.noetig
        })
      }
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
    const { parseState, callDataOf, resolveSwap, executeSwap,
            istAbgelaufen, markiereAbgelaufen,
            noetigeStimmen, neueEinreichung, pruefeNachweis,
            brauchtAbnahme } = require(`${__hooks}/quests.js`)
    const { karmaFuerAbschluss } = require(`${__hooks}/karma.js`)
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

    // Frist gilt auch beim Abschluss: Wer die Zeit überzieht, bekommt nicht
    // ausgezahlt. Sonst wäre die Frist eine Bitte, keine Bedingung.
    if (istAbgelaufen(c)) {
      if (markiereAbgelaufen(c)) {
        st.call = c
        call.set("state", st)
        try { $app.save(call) } catch (err) {}
      }
      return e.json(409, { error: "call expired", status: "expired", deadline: c.deadline })
    }

    if (c.claimedBy && c.claimedBy !== user.id) {
      return e.json(403, { error: "call is claimed by someone else" })
    }

    // Nachweis zuerst: Fehlt er, ist der Auftrag nicht gemeldet, sondern
    // unvollständig. Das soll der Bearbeiter erfahren, bevor irgendetwas
    // anderes passiert — und der Prüfer soll ihn später vorliegen haben.
    const nw = pruefeNachweis(call, c, (info.body || {}).proof)
    if (!nw.ok) {
      return e.json(400, { error: "proof incomplete", missing: nw.fehlend })
    }

    // Harte Voraussetzungen gelten in BEIDEN Modi — ein Agent soll nicht über
    // eine ungedeckte Belohnung entscheiden müssen.
    const swap = resolveSwap($app, call, c, user.id)
    if (!swap.ok) return e.json(swap.code, { error: swap.error })

    if (brauchtAbnahme(c.verify)) {
      c.status = "pending"
      c.pendingBy = user.id
      // Jede Einreichung bekommt eine eigene Kennung. Beim zweiten Anlauf
      // zählen die Stimmen des ersten damit NICHT mehr mit.
      c.submission = neueEinreichung()
      if (c.verify === "crowd") c.votesNeeded = noetigeStimmen(c)
      // Der Nachweis wandert mit in den Datensatz — ohne ihn säße der Prüfer
      // vor einer Behauptung ohne Anhaltspunkt.
      c.submissionProof = nw.gespeichert
      c.submittedAt = new Date().toISOString()
      st.call = c
      call.set("state", st)
      $app.save(call)   // Realtime-Update → Aussteller-Agent bzw. Schwarm sehen "pending"
      return e.json(202, {
        ok: true, id: callId, status: "pending", submission: c.submission,
        votesNeeded: c.verify === "crowd" ? c.votesNeeded : undefined,
        message: c.verify === "crowd" ? "awaiting crowd confirmation"
          : (c.verify === "group" ? "awaiting review group" : "awaiting issuer verification")
      })
    }

    const moved = executeSwap($app, call, st, c, swap, user.id)
    for (let i = 0; i < moved.length; i++) {
      try { recomputeForObject(moved[i]) } catch (_) {}   // Eigentum gewechselt
    }
    // Karma NACH dem Tausch: Es ist die Nebenwirkung eines tatsächlich
    // ausgezahlten Auftrags, nicht einer erfolgreichen Prüfung.
    const karmaNeu = karmaFuerAbschluss($app, user.id, callId)
    // Status NICHT hart "done": ein wiederholbarer Auftrag steht danach wieder
    // auf "open", solange der Vorrat reicht — executeSwap hat c.status gesetzt.
    return e.json(200, {
      ok: true, id: callId, status: c.status,
      rewardsLeft: (c.rewardItems || []).length, completions: c.completions || 1,
      repeatable: c.repeatable === true,
      karma: karmaNeu
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

    const st = parseState(call)
    const c = callDataOf(st)
    // Wer entscheiden darf, hängt am Abnahmeweg: der Aussteller immer, bei
    // verify:"group" zusätzlich die benannte Prüfgruppe (transitiv, wie überall).
    const { darfAbnehmen } = require(`${__hooks}/quests.js`)
    const { transitiveGroupsOf } = require(`${__hooks}/permissions.js`)
    const erlaubt = darfAbnehmen($app, call, c, user.id, transitiveGroupsOf)
    if (!erlaubt.ok) return e.json(403, { error: erlaubt.grund })
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
    // Gleiche Gutschrift wie im Server-geprüften Pfad: Karma hängt am
    // AUSGEZAHLTEN Auftrag, nicht daran, wer geprüft hat.
    const { karmaFuerAbschluss } = require(`${__hooks}/karma.js`)
    const karmaNeu = karmaFuerAbschluss($app, completerId, callId)
    return e.json(200, {
      ok: true, id: callId, status: c.status, completedBy: completerId,
      collected: swap.required.length, rewardsLeft: (c.rewardItems || []).length,
      repeatable: c.repeatable === true, karma: karmaNeu
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

    const st = parseState(call)
    const c = callDataOf(st)
    // Wer entscheiden darf, hängt am Abnahmeweg: der Aussteller immer, bei
    // verify:"group" zusätzlich die benannte Prüfgruppe (transitiv, wie überall).
    const { darfAbnehmen } = require(`${__hooks}/quests.js`)
    const { transitiveGroupsOf } = require(`${__hooks}/permissions.js`)
    const erlaubt = darfAbnehmen($app, call, c, user.id, transitiveGroupsOf)
    if (!erlaubt.ok) return e.json(403, { error: erlaubt.grund })
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


// ---------------------------------------------------------------------
// GET /api/quests/near?lat=&lon=&radius=&mine=1 — Aufträge einer Gegend.
//
// Warum eine eigene Route und nicht ein Filter auf `objects`: Drei Dinge lassen
// sich nicht als Filterausdruck schreiben.
//
//   1. „Angeboten" ist eine ZEITFRAGE. Ein Auftrag, den eine Figur vergibt, ist
//      zunächst nur im Gespräch mit ihr zu haben (`listed: false`). Nimmt ihn
//      dort niemand an, gehört er nach `anbietenNachH` Stunden zusätzlich in
//      die Liste. Das wird hier LAZY ausgewertet und zurückgeschrieben — aus
//      demselben Grund wie bei der Frist: Was nur tickt, solange ein Agent
//      läuft, ist keine Regel.
//   2. „Kann ich das annehmen?" hängt am Karma des Fragenden.
//   3. Abgelaufenes soll gar nicht erst als verfügbar erscheinen.
//
// Der Client bekommt damit genau die Liste, die er anzeigen kann — statt selbst
// Regeln nachzubauen, die serverseitig ohnehin noch einmal geprüft werden.
// ---------------------------------------------------------------------
routerAdd("GET", "/api/quests/near", (e) => {
  try {
    const { resolveEffective, transitiveGroupsOf } = require(`${__hooks}/permissions.js`)
    const { parseState, callDataOf, istAbgelaufen, markiereAbgelaufen,
            abstandM, noetigeStimmen, zaehleStimmen, darfAbnehmen,
            brauchtAbnahme } = require(`${__hooks}/quests.js`)
    const { karmaStufe, karmaPunkte } = require(`${__hooks}/karma.js`)
    const info = e.requestInfo()
    const user = info.auth
    if (!user) return e.json(401, { error: "authentication required" })

    const q = info.query || {}
    const lat = Number(q.lat), lon = Number(q.lon)
    const radius = Math.min(50000, Math.max(50, Number(q.radius) || 2000))
    const nurMeine = String(q.mine || "") === "1"
    const hatOrt = isFinite(lat) && isFinite(lon)

    let alle = []
    try {
      alle = $app.findRecordsByFilter("objects", 'type = "call"', "-updated", 500, 0) || []
    } catch (err) { alle = [] }

    const meineStufe = karmaStufe(karmaPunkte($app, user.id))
    const jetzt = Date.now()
    const raus = []

    // Gruppen EINMAL auflösen, nicht je Auftrag: die Auflösung läuft transitiv
    // über Untergruppen und ist der teuerste Teil der Rechteprüfung.
    let meineGruppen = null
    const gruppenVon = (uid) => {
      if (String(uid) !== user.id) return transitiveGroupsOf($app, uid) || []
      if (meineGruppen === null) meineGruppen = transitiveGroupsOf($app, uid) || []
      return meineGruppen
    }

    // Namen der Belohnungs-Gegenstände. Ohne sie stünde in der Liste nur
    // „3× Belohnung". Ein Auftrag zahlt selten mehr als eine Handvoll Dinge und
    // Aufträge derselben Ausschreibung greifen auf dieselben Gattungen zurück —
    // deshalb ein Cache und eine Obergrenze, statt die Liste zu einer
    // unbegrenzten Zahl von Einzelabfragen ausarten zu lassen.
    const namenCache = {}
    let lookups = 0

    // Anzeigename des Ausstellers. In der Liste steht „von …" — eine Konto-ID
    // wäre dort so unbrauchbar wie im Gespräch. Bevorzugt der selbstgewählte
    // `username`; ein Konto ohne beides bleibt namenlos statt als ID zu enden.
    const nameCache = {}
    const kontoName = (uid) => {
      const id = String(uid || "")
      if (!id) return ""
      if (!(id in nameCache)) {
        try {
          const u = $app.findRecordById("users", id)
          nameCache[id] = String(u.get("username") || u.get("name") || "")
        } catch (err) { nameCache[id] = "" }
      }
      return nameCache[id]
    }
    const belohnungText = (ids) => {
      const zaehler = {}
      for (let i = 0; i < ids.length; i++) {
        const id = String(ids[i])
        if (!(id in namenCache)) {
          if (lookups >= 200) { namenCache[id] = "" }
          else {
            lookups++
            try { namenCache[id] = String($app.findRecordById("objects", id).get("name") || "") }
            catch (err) { namenCache[id] = "" }
          }
        }
        const n = namenCache[id] || "Belohnung"
        zaehler[n] = (zaehler[n] || 0) + 1
      }
      const teile = []
      for (const n in zaehler) teile.push({ was: n, anzahl: zaehler[n] })
      return teile
    }

    for (let i = 0; i < alle.length; i++) {
      const call = alle[i]
      const meins = String(call.get("owner") || "") === user.id
      if (nurMeine && !meins) continue

      // Sichtbarkeit wie überall über die Rechte — kein Sonderweg.
      if (!meins) {
        const eff = resolveEffective(user, call)
        if ((eff.rights || []).indexOf("view") === -1) continue
      }

      const cLat = Number(call.get("lat")), cLon = Number(call.get("lon"))
      let entfernung = null
      if (hatOrt) {
        if (!isFinite(cLat) || !isFinite(cLon)) continue
        entfernung = abstandM(lat, lon, cLat, cLon)
        if (entfernung > radius) continue
      }

      const st = parseState(call)
      const c = callDataOf(st)
      let geaendert = false

      // Abgelaufenes stilllegen, sobald es jemand sieht.
      if (istAbgelaufen(c) && markiereAbgelaufen(c)) geaendert = true

      // Wartezeit vorbei → zusätzlich listen, Zustand „angeboten".
      const wartetStd = Number(c.anbietenNachH) || 0
      let angeboten = false
      if (c.listed === false && wartetStd > 0 && c.status === "open") {
        const seit = Date.parse(c.publishedAt || call.get("created"))
        if (isFinite(seit) && (jetzt - seit) >= wartetStd * 3600000) {
          c.listed = true
          c.angeboten = true
          geaendert = true
        }
      }
      angeboten = c.angeboten === true

      if (geaendert) {
        st.call = c
        call.set("state", st)
        try { $app.save(call) } catch (err) {}
      }

      // Nicht gelistete Aufträge gehören nicht in die Regionsliste — beim
      // eigenen Bestand („Meine") schon, sonst sähe man seine eigenen
      // Entwürfe nicht.
      if (!meins && c.listed === false) continue

      const noetigesKarma = Number(c.karma) || 0
      const frei = c.status === "open" || (!c.claimedBy && c.status !== "done" && c.status !== "cancelled" && c.status !== "expired")
      const verify = c.verify || "items"
      const bearbeiter = c.claimedBy || null
      const wartet = c.status === "pending"

      // Darf ich über DIESE Einreichung entscheiden?
      //
      // Der Bearbeiter nie — sonst nähme er sich selbst ab. Beim Schwarm
      // entscheidet nicht der Aussteller (er hat approve/reject), sondern jeder
      // andere, der noch nicht gestimmt hat; bei Aussteller- und Gruppenabnahme
      // dieselbe Prüfung wie in quest/approve, damit die Liste nicht mehr
      // anbietet, als die Route hergibt.
      let darfPruefen = false
      let stimmen = null
      if (wartet && bearbeiter !== user.id) {
        if (verify === "crowd") {
          const s = zaehleStimmen($app, call.id, c.submission || "")
          const schonGestimmt = (s.waehler || []).indexOf(user.id) !== -1
          stimmen = { ja: s.ja, nein: s.nein, noetig: noetigeStimmen(c), meine: schonGestimmt }
          darfPruefen = !meins && !schonGestimmt
        } else if (brauchtAbnahme(verify)) {
          darfPruefen = darfAbnehmen($app, call, c, user.id, gruppenVon).ok
        }
      }

      // Der Nachweis ist für die Abnahme da — und für den, der ihn eingereicht
      // hat. Sonst hätte jeder Vorbeikommende Fotos und Notizen fremder Leute.
      const darfNachweisSehen = darfPruefen || meins || bearbeiter === user.id

      raus.push({
        id: call.id,
        name: call.get("name"),
        kurz: c.kurz || "",
        task: c.task || "",
        ort: c.ort || "",
        lat: cLat, lon: cLon,
        distanceM: entfernung === null ? null : Math.round(entfernung),
        owner: call.get("owner"),
        ownerName: kontoName(call.get("owner")),
        mine: meins,
        status: c.status || "open",
        // Ein Auftrag, der nie veröffentlicht wurde, ist ein Entwurf. Ohne
        // diesen Stempel sähe er wie ein offener Auftrag aus, für den nur
        // niemand die Treuhand gebunden hat.
        published: !!c.publishedAt,
        angeboten: angeboten,
        listed: c.listed !== false,
        anbietenNachH: Number(c.anbietenNachH) || 0,
        deadline: c.deadline || null,
        karmaRequired: noetigesKarma,
        karmaOk: meineStufe >= noetigesKarma,
        verify: verify,
        pruefgruppe: c.pruefgruppe || null,
        votesNeeded: verify === "crowd" ? noetigeStimmen(c) : null,
        votes: stimmen,
        nachweis: Array.isArray(c.nachweis) ? c.nachweis : [],
        rewards: (c.rewardItems || []).length,
        rewardParts: belohnungText(c.rewardItems || []),
        rewardPerRun: Number(c.rewardPerRun) || 0,
        steigt: Number(c.steigt) || 0,
        requires: Array.isArray(c.requires) ? c.requires.length : 0,
        claimedBy: bearbeiter,
        pendingBy: c.pendingBy || null,
        pendingByName: c.pendingBy ? kontoName(c.pendingBy) : null,
        submittedAt: c.submittedAt || null,
        submissionProof: darfNachweisSehen ? (c.submissionProof || null) : null,
        canAccept: !meins && frei && meineStufe >= noetigesKarma && !istAbgelaufen(c),
        canVerify: darfPruefen,
      })
    }

    if (hatOrt) raus.sort(function (a, b) { return (a.distanceM || 0) - (b.distanceM || 0) })
    return e.json(200, { quests: raus, karma: meineStufe })
  } catch (err) {
    console.log("[quests.near] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


// ---------------------------------------------------------------------
// POST /api/objects/{id}/quest/confirm — Schwarm-Abnahme.
// Body: { verdict: "ok" | "nein", note?: "…" }
//
// Für Aufträge mit verify:"crowd". Andere Spieler bestätigen (oder widersprechen)
// einer Einreichung; ab `votesNeeded` Ja-Stimmen zahlt der SERVER aus — nicht
// der Schwarm. Der Schwarm entscheidet nur, ob die Bedingung erfüllt ist; ob die
// Belohnung gedeckt ist, prüft weiterhin resolveSwap.
//
// Bewusste Einschränkungen:
//   • Der Einreicher stimmt nicht über sich selbst ab.
//   • Der Aussteller auch nicht — er hat eigene Wege (approve/reject) und wäre
//     als Partei zugleich Schiedsrichter.
//   • Eine Stimme je Person und Einreichungs-Durchgang (Unique-Index).
//   • Genug Nein-Stimmen schicken die Einreichung zurück in „claimed": der
//     Bearbeiter behält den Auftrag und kann nachbessern. Ihn zu verlieren,
//     weil drei Leute den falschen Ort angeschaut haben, wäre unverhältnismäßig.
// ---------------------------------------------------------------------
routerAdd("POST", "/api/objects/{id}/quest/confirm", (e) => {
  try {
    const { resolveEffective, recomputeForObject } = require(`${__hooks}/permissions.js`)
    const { parseState, callDataOf, resolveSwap, executeSwap,
            istAbgelaufen, markiereAbgelaufen,
            noetigeStimmen, zaehleStimmen } = require(`${__hooks}/quests.js`)
    const { karmaFuerAbschluss, karmaAendern } = require(`${__hooks}/karma.js`)
    const callId = e.request.pathValue("id")
    const info = e.requestInfo()
    const user = info.auth
    if (!user) return e.json(401, { error: "authentication required" })

    const body = info.body || {}
    const verdict = String(body.verdict || "").toLowerCase() === "nein" ? "nein" : "ok"
    const note = body.note ? String(body.note).slice(0, 500) : ""

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
    if (c.verify !== "crowd") return e.json(400, { error: "call is not verified by the crowd" })
    if (c.status !== "pending") return e.json(409, { error: "no submission awaiting confirmation" })
    if (!c.submission) return e.json(409, { error: "submission has no id — resubmit required" })

    if (istAbgelaufen(c)) {
      if (markiereAbgelaufen(c)) {
        st.call = c
        call.set("state", st)
        try { $app.save(call) } catch (err) {}
      }
      return e.json(409, { error: "call expired", status: "expired" })
    }

    const einreicher = String(c.pendingBy || c.claimedBy || "")
    if (user.id === einreicher) return e.json(403, { error: "you cannot confirm your own submission" })
    if (user.id === String(call.get("owner") || "")) {
      return e.json(403, { error: "the issuer decides via approve/reject, not as part of the crowd" })
    }

    // Stimme ablegen. Der Unique-Index (call, submission, voter) ist die harte
    // Grenze; der Vorab-Blick liefert nur die verständlichere Meldung.
    const vorher = zaehleStimmen($app, callId, c.submission)
    if (vorher.waehler.indexOf(user.id) !== -1) {
      return e.json(409, { error: "you already voted on this submission" })
    }
    try {
      const coll = $app.findCollectionByNameOrId("quest_confirmations")
      const stimme = new Record(coll)
      stimme.set("call", callId)
      stimme.set("submission", c.submission)
      stimme.set("voter", user.id)
      stimme.set("verdict", verdict)
      if (note) stimme.set("note", note)
      $app.save(stimme)
    } catch (err) {
      return e.json(409, { error: "vote not recorded: " + (err && err.message ? err.message : err) })
    }

    const stimmen = zaehleStimmen($app, callId, c.submission)
    const noetig = Number(c.votesNeeded) || noetigeStimmen(c)

    // Noch nicht entschieden — Zwischenstand melden.
    if (stimmen.ja < noetig && stimmen.nein < noetig) {
      return e.json(200, {
        ok: true, id: callId, status: c.status, decided: false,
        yes: stimmen.ja, no: stimmen.nein, votesNeeded: noetig
      })
    }

    // Abgelehnt: zurück zum Bearbeiter, er darf nachbessern.
    if (stimmen.nein >= noetig) {
      c.status = c.claimedBy ? "claimed" : "open"
      delete c.pendingBy
      delete c.submission
      c.rejectReason = "vom Schwarm abgelehnt (" + stimmen.nein + " von " + noetig + ")"
      st.call = c
      call.set("state", st)
      $app.save(call)
      return e.json(200, {
        ok: true, id: callId, status: c.status, decided: true, approved: false,
        yes: stimmen.ja, no: stimmen.nein, votesNeeded: noetig
      })
    }

    // Angenommen: der Server zahlt aus — mit derselben Deckungsprüfung wie
    // überall. Reicht die Treuhand nicht, bleibt der Auftrag „pending"; die
    // Stimmen bleiben gültig, der Aussteller kann nachlegen.
    const swap = resolveSwap($app, call, c, einreicher)
    if (!swap.ok) {
      return e.json(swap.code, {
        error: swap.error, decided: true, approved: true, payout: false,
        yes: stimmen.ja, no: stimmen.nein
      })
    }
    delete c.submission
    const moved = executeSwap($app, call, st, c, swap, einreicher)
    for (let i = 0; i < moved.length; i++) {
      try { recomputeForObject(moved[i]) } catch (_) {}
    }
    const karmaNeu = karmaFuerAbschluss($app, einreicher, callId)
    // Wer abgenommen hat, bekommt ebenfalls etwas gutgeschrieben — sonst
    // erledigt die undankbare Arbeit niemand. Bewusst klein.
    for (let i = 0; i < stimmen.waehler.length; i++) {
      karmaAendern($app, stimmen.waehler[i], 1, "Abnahme für Auftrag " + callId)
    }
    return e.json(200, {
      ok: true, id: callId, status: c.status, decided: true, approved: true, payout: true,
      yes: stimmen.ja, no: stimmen.nein, votesNeeded: noetig,
      completedBy: einreicher, karma: karmaNeu,
      rewardsLeft: (c.rewardItems || []).length
    })
  } catch (err) {
    console.log("[quest.confirm] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


// POST /api/objects/{id}/quest/cancel — Aussteller bricht ab, Treuhand wird frei.
// POST /api/objects/{id}/quest/abandon — Bearbeiter gibt den Auftrag zurück.
//
// Nicht dasselbe wie `cancel`: Dort zieht der AUSSTELLER die Ausschreibung
// zurück und bekommt seine Treuhand frei. Hier legt der BEARBEITER nur seinen
// Anspruch nieder — der Auftrag bleibt ausgeschrieben und ist sofort wieder zu
// haben. Ohne diesen Weg bliebe ein angenommener Auftrag für immer belegt,
// sobald jemand es sich anders überlegt; die Frist griffe erst Tage später,
// und ein Auftrag ohne Frist gar nicht.
//
// Eine eingereichte Arbeit lässt sich nicht zurückziehen: Über eine laufende
// Abnahme entscheidet der Prüfer, nicht der Eingereichte. Wer nachbessern will,
// wartet die Ablehnung ab — die schickt den Auftrag ohnehin zurück auf
// "claimed".
//
// Karma bleibt unberührt. Einen Auftrag zurückzugeben ist keine Verfehlung,
// sondern besser als ihn liegen zu lassen — Abzug gibt es nur für nachgewiesene
// Verstösse.
routerAdd("POST", "/api/objects/{id}/quest/abandon", (e) => {
  try {
    const { parseState, callDataOf, istAbgelaufen, markiereAbgelaufen } = require(`${__hooks}/quests.js`)
    const callId = e.request.pathValue("id")
    const info = e.requestInfo()
    const user = info.auth
    if (!user) return e.json(401, { error: "authentication required" })

    let call
    try { call = $app.findRecordById("objects", callId) }
    catch (err) { return e.json(404, { error: "call not found" }) }
    if (call.get("type") !== "call") return e.json(400, { error: "object is not a call" })

    const st = parseState(call)
    const c = callDataOf(st)

    if (String(c.claimedBy || "") !== user.id) {
      return e.json(403, { error: "only the player who claimed this call may abandon it" })
    }
    if (c.status === "pending") {
      return e.json(409, { error: "submission is under review — wait for the verdict" })
    }
    if (c.status === "done") return e.json(409, { error: "call already completed" })

    // Abgelaufenes wird nicht wieder freigegeben, sondern stillgelegt — sonst
    // stünde ein Auftrag nach dem Zurückgeben wieder als annehmbar in der
    // Liste, obwohl seine Frist längst um ist.
    if (istAbgelaufen(c)) {
      markiereAbgelaufen(c)
      st.call = c
      call.set("state", st)
      try { $app.save(call) } catch (err) {}
      return e.json(409, { error: "call expired", status: "expired" })
    }

    delete c.claimedBy
    delete c.pendingBy
    c.status = "open"
    st.call = c
    call.set("state", st)
    $app.save(call)
    return e.json(200, { ok: true, id: callId, status: "open" })
  } catch (err) {
    console.log("[quest.abandon] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


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


// =====================================================================
// POST /api/proximity  — "ich bin in der Naehe dieser Objekte"
//
// Privatsphaere-Stufe "Naehe": der Client meldet OBJEKT-IDs, nie Koordinaten.
// Er kennt seine exakte Position, rechnet den Umkreis lokal aus und schickt nur
// die Uebergaenge (betreten/verlassen). Damit erfaehrt ein Agent, dass jemand
// bei seinem Objekt steht, ohne dass die Position den Client verlaesst.
//
// Body: { enter: [objectId, ...], leave: [objectId, ...] }
// Broadcast: Topic `proximity:<objectId>`, { state:'enter'|'leave', source, ts }
//
// Bewusst EIGENES Topic (nicht `interact:`): bestehende Agents, die auf
// Interaktionen hoeren, sollen nicht ploetzlich Praesenz-Events verarbeiten,
// die sie nie abonniert haben.
//
// Erlaubt fuer jedes Objekt, das der User SEHEN darf — Naehe ist keine Aktion
// am Objekt, sondern eine Aussage ueber den Spieler. Ein Objekt, das er nicht
// sieht, darf ihn aber auch nicht spueren.
//
// GRENZE, bewusst: der Client ist die einzige Positionsquelle, also kann er
// Naehe auch behaupten. Proximity-Trigger sind damit *advisory* — sie eignen
// sich fuer Belebung (Agent reagiert, wenn jemand kommt), NICHT als Nachweis
// ("Spieler war an Ort X" als Quest-Bedingung). Wer das braucht, braucht einen
// zweiten Faktor (UWB-Anker, signierter Sensor-Report).
// =====================================================================
routerAdd("POST", "/api/proximity", (e) => {
  try {
    const { resolveEffective } = require(`${__hooks}/permissions.js`)

    const info = e.requestInfo()
    const user = info.auth
    if (!user) return e.json(401, { error: "auth required" })

    const body = info.body || {}
    const list = (v) => (Array.isArray(v) ? v.filter(x => typeof x === "string" && x).slice(0, 64) : [])
    const enter = list(body.enter)
    const leave = list(body.leave)
    if (!enter.length && !leave.length) return e.json(200, { ok: true, delivered: 0 })

    const clients = $app.subscriptionsBroker().clients()
    const ts = new Date().toISOString()
    let delivered = 0
    const skipped = []

    const emit = (objectId, state) => {
      let rec
      try { rec = $app.findRecordById("objects", objectId) } catch (err) { skipped.push(objectId); return }

      // Sehen-Recht ist die Grenze: unsichtbare Objekte spueren dich nicht.
      const eff = resolveEffective(user, rec)
      if ((eff.rights || []).indexOf("view") === -1) { skipped.push(objectId); return }

      const topic = "proximity:" + objectId
      const message = new SubscriptionMessage({
        name: topic,
        data: JSON.stringify({ state: state, source: user.id, ts: ts })
      })
      for (const id in clients) {
        const client = clients[id]
        if (client.hasSubscription(topic)) { client.send(message); delivered++ }
      }
    }

    for (const id of enter) emit(id, "enter")
    for (const id of leave) emit(id, "leave")

    return e.json(200, { ok: true, delivered: delivered, skipped: skipped.length })
  } catch (err) {
    console.log("[proximity] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})


// =====================================================================
// POST /api/agents/{source}/command  — Kommando an einen Agent
//
// Objektloser Befehlskanal. Es gibt Aktionen, die sich an KEIN Objekt haengen
// lassen — "erzeuge hier ein Monster" hat noch kein Objekt, an dem man
// interagieren koennte. Ein unsichtbares Traeger-Objekt waere die Alternative,
// muesste aber aus Rendering, Editor-Listen und Agent-Filtern herausgefiltert
// und vom Client erst gefunden werden.
//
// Body: { command: "<string>", payload: <beliebig> }
// Broadcast: Topic `agent:<source>`, { command, payload, source: <userId>, ts }
//
// BEWUSST NUR TRANSPORT: die Route prueft Authentifizierung und leitet weiter,
// sie vergibt KEINE Rechte. Was ein Kommando bewirkt, entscheidet allein der
// Agent — er MUSS validieren und begrenzen (Cooldown, Obergrenze), denn jeder
// angemeldete Nutzer kann hier senden. `source` im Broadcast ist die vom Server
// gesetzte User-ID (nicht faelschbar), damit Agents pro Nutzer drosseln koennen.
// =====================================================================
// ---------------------------------------------------------------------
// POST /api/chat/send — Nachricht an EINEN Empfänger.
//
// Bewusst NUTZER-zu-NUTZER statt objektgebunden. Der naheliegende Weg wäre
// gewesen, Antworten über `interact:<objekt>` zurückzuschicken — aber das
// verteilt an ALLE Abonnenten dieses Objekts, und derselbe Transport soll
// später Direktnachrichten zwischen Spielern und einen Weltchat tragen. Beides
// hätte sich an einer Objekt-ID nicht festmachen lassen.
//
// `object` ist optionaler Kontext: Spricht ein Spieler eine Figur an, geht die
// Nachricht an deren KONTO (`objects.owner`) — der Agent erfährt über `object`,
// welche seiner Figuren gemeint war. Für eine Direktnachricht bleibt das Feld leer.
//
// Ephemer wie `interact`: kein Datenbankschreibvorgang. Wer offline ist, bekommt
// nichts — für Gespräche vor Ort richtig, für Direktnachrichten später zu wenig.
// Dann kommt eine Ablage dazu, ohne dass sich der Client-Aufruf ändert.
//
// OFFEN und bewusst nicht jetzt gelöst: Missbrauchsschutz (jeder Angemeldete
// darf jedem schreiben) und die Frage, ob Umstehende mithören können sollen.
// ---------------------------------------------------------------------
routerAdd("POST", "/api/chat/send", (e) => {
  try {
    const info = e.requestInfo()
    const user = info.auth
    if (!user) return e.json(401, { error: "auth required" })

    const body = info.body || {}
    const to = body.to
    if (!to || typeof to !== "string") {
      return e.json(400, { error: "field 'to' (user id) is required" })
    }
    const text = body.text
    if (typeof text !== "string" || !text.trim()) {
      return e.json(400, { error: "field 'text' (string) is required" })
    }
    if (text.length > 2000) {
      return e.json(400, { error: "text too long (max 2000)" })
    }

    const topic = "chat:" + to
    const message = new SubscriptionMessage({
      name: topic,
      data: JSON.stringify({
        from: user.id,               // serverseitig — nicht fälschbar
        to: to,
        object: typeof body.object === "string" ? body.object : null,
        text: text,
        meta: body.meta || null,     // z. B. Auswahlantworten
        ts: new Date().toISOString()
      })
    })

    let delivered = 0
    const clients = $app.subscriptionsBroker().clients()
    for (const id in clients) {
      const c = clients[id]
      if (c.hasSubscription(topic)) { c.send(message); delivered++ }
    }
    // delivered === 0 heisst: Empfänger gerade nicht verbunden.
    return e.json(200, { ok: true, delivered: delivered })
  } catch (err) {
    console.log("[chat.send] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "internal error" })
  }
})


routerAdd("POST", "/api/agents/{source}/command", (e) => {
  try {
    const info = e.requestInfo()
    const user = info.auth
    if (!user) return e.json(401, { error: "auth required" })

    const source = e.request.pathValue("source")
    if (!source || !/^[A-Za-z0-9_-]{1,64}$/.test(source)) {
      return e.json(400, { error: "invalid agent source" })
    }

    const body = info.body || {}
    const command = body.command
    if (!command || typeof command !== "string" || command.length > 64) {
      return e.json(400, { error: "field 'command' (string) is required" })
    }

    const topic = "agent:" + source
    const message = new SubscriptionMessage({
      name: topic,
      data: JSON.stringify({
        command: command,
        payload: body.payload || null,
        source: user.id,
        ts: new Date().toISOString()
      })
    })

    let delivered = 0
    const clients = $app.subscriptionsBroker().clients()
    for (const id in clients) {
      const client = clients[id]
      if (client.hasSubscription(topic)) { client.send(message); delivered++ }
    }

    // delivered === 0 heisst: der Agent laeuft gerade nicht. Kein Fehler, aber
    // der Client kann es dem Nutzer sagen ("niemand hoert zu").
    return e.json(200, { ok: true, delivered: delivered })
  } catch (err) {
    console.log("[agent-command] error: " + (err && err.message ? err.message : err))
    return e.json(500, { error: "" + (err && err.message ? err.message : err) })
  }
})
