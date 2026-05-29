/// <reference path="../pb_data/types.d.ts" />

// =====================================================================
// Ajna — Permission-Resolver
//
// Wird per require() aus den .pb.js-Hooks geladen, weil der Goja-VM-Pool
// in PocketBase Modul-Scope-Variablen NICHT zwischen Boot und Hook-Aufruf
// teilt. require() evaluiert dieses File pro VM-Instanz neu.
//
// Modell (siehe ajna-permissions-concept):
//   - objects.owner → Eigentümer, hat immer alle Rechte.
//   - object_permissions = ACE-Tabelle (Source of Truth).
//   - effective_permissions = Cache pro (user, object) für die schnelle
//     Filter-Auswertung in den objects-API-Rules.
//   - implicit audiences (authenticated/anonymous/everyone) werden NICHT
//     im Cache materialisiert; resolveEffective löst sie on-the-fly auf,
//     die API-Rules prüfen sie direkt gegen object_permissions.
// =====================================================================

const ALL_RIGHTS  = ["view", "edit", "move", "owner"]
const ALL_ACTIONS = ["*"]
const IMPLICIT_AUDIENCES = new Set(["authenticated", "anonymous", "everyone"])

// ----------------------------------------------------------------------
// Group-Traversierung
// ----------------------------------------------------------------------

/**
 * BFS-Suche nach allen Gruppen, in denen `userId` direkt oder transitiv
 * Mitglied ist (über `members` direkt, plus über `subgroups`-Verschachtelung).
 * @returns {string[]} Group-IDs
 */
function transitiveGroupsOf(userId) {
  if (!userId) return []

  const result = new Set()
  const queue  = []

  // Direkte Memberships
  const direct = $app.findRecordsByFilter(
    "groups",
    "members ?= {:uid}",
    "", 500, 0,
    { uid: userId }
  )
  for (const g of direct) {
    result.add(g.id)
    queue.push(g.id)
  }

  // Aufwärts in der subgroup-Hierarchie
  while (queue.length > 0) {
    const current = queue.shift()
    const parents = $app.findRecordsByFilter(
      "groups",
      "subgroups ?= {:gid}",
      "", 500, 0,
      { gid: current }
    )
    for (const p of parents) {
      if (!result.has(p.id)) {
        result.add(p.id)
        queue.push(p.id)
      }
    }
  }

  return Array.from(result)
}

/**
 * Alle User-IDs, die direkt oder transitiv (über sub-groups) Mitglied
 * von `groupId` sind. Wird vom Cache-Refresh genutzt, um zu wissen,
 * welche User-Caches sich ändern.
 */
function transitiveMembersOf(groupId) {
  const result  = new Set()
  const visited = new Set()
  const stack   = [groupId]

  while (stack.length > 0) {
    const gid = stack.pop()
    if (visited.has(gid)) continue
    visited.add(gid)

    let group
    try { group = $app.findRecordById("groups", gid) }
    catch { continue }

    for (const m of (group.get("members") || [])) result.add(m)
    for (const s of (group.get("subgroups") || [])) stack.push(s)
  }

  return Array.from(result)
}

// ----------------------------------------------------------------------
// ACE-Auflösung
// ----------------------------------------------------------------------

/** Aggregiert alle ACEs eines Objekts, deren subject-Key in subjectKeys liegt. */
function aggregateAces(objectId, subjectKeys) {
  const aces = $app.findRecordsByFilter(
    "object_permissions",
    "object = {:obj}",
    "", 500, 0,
    { obj: objectId }
  )

  const rights   = new Set()
  const interact = new Set()
  for (const ace of aces) {
    const type = ace.get("subject_type")
    const subj = ace.get("subject") || ""
    const key  = IMPLICIT_AUDIENCES.has(type) ? `${type}:` : `${type}:${subj}`
    if (!subjectKeys.has(key)) continue

    for (const r of (ace.get("rights") || []))           rights.add(r)
    for (const a of (ace.get("interact_actions") || [])) interact.add(a)
  }

  return {
    rights: Array.from(rights),
    interact_actions: Array.from(interact)
  }
}

/**
 * Effektive Rechte eines Users (oder Anonym) auf ein Objekt — inkl.
 * impliziter Audiences. Wird vom Interact-Endpoint zur Laufzeit gerufen.
 */
function resolveEffective(user, objectRecord) {
  // Owner-Shortcut
  if (user && objectRecord.get("owner") === user.id) {
    return { rights: ALL_RIGHTS.slice(), interact_actions: ALL_ACTIONS.slice() }
  }

  const subjectKeys = new Set(["everyone:"])
  if (user) {
    subjectKeys.add("authenticated:")
    subjectKeys.add(`user:${user.id}`)
    for (const g of transitiveGroupsOf(user.id)) subjectKeys.add(`group:${g}`)
  } else {
    subjectKeys.add("anonymous:")
  }

  return aggregateAces(objectRecord.id, subjectKeys)
}

/**
 * Wie resolveEffective, aber OHNE implicit audiences. Wird für den Cache
 * benutzt — die Audience-Rechte fließen über die API-Rule direkt in die
 * sichtbaren Records, brauchen keinen materialisierten Cache-Eintrag.
 */
function resolveExplicit(userId, objectRecord) {
  if (!userId) return { rights: [], interact_actions: [] }

  if (objectRecord.get("owner") === userId) {
    return { rights: ALL_RIGHTS.slice(), interact_actions: ALL_ACTIONS.slice() }
  }

  const subjectKeys = new Set([`user:${userId}`])
  for (const g of transitiveGroupsOf(userId)) subjectKeys.add(`group:${g}`)

  return aggregateAces(objectRecord.id, subjectKeys)
}

/** Hilfsfunktion: prüft, ob ein Action-Key durch das effective-set abgedeckt ist. */
function canInteract(effective, action) {
  const allowed = effective.interact_actions || []
  return allowed.indexOf("*") !== -1 || allowed.indexOf(action) !== -1
}

// ----------------------------------------------------------------------
// Cache-Pflege
// ----------------------------------------------------------------------

/**
 * Schreibt/aktualisiert den effective_permissions-Cache-Eintrag für
 * (userId, objectRecord). Leeres Rights+Actions → Eintrag wird gelöscht.
 */
function recomputeFor(userId, objectRecord) {
  // Bestehenden Eintrag finden
  let existing = null
  try {
    existing = $app.findFirstRecordByFilter(
      "effective_permissions",
      "user = {:u} && object = {:o}",
      { u: userId, o: objectRecord.id }
    )
  } catch { /* none */ }

  const eff = resolveExplicit(userId, objectRecord)

  const ownerOnly = objectRecord.get("owner") === userId
  const empty = ownerOnly
             || (eff.rights.length === 0 && eff.interact_actions.length === 0)

  console.log(`[recomputeFor] user=${userId} object=${objectRecord.id} `
    + `ownerOnly=${ownerOnly} rights=${JSON.stringify(eff.rights)} `
    + `interact=${JSON.stringify(eff.interact_actions)} `
    + `existing=${existing ? existing.id : "none"}`)

  if (empty) {
    if (existing) $app.delete(existing)
    return
  }

  try {
    if (existing) {
      existing.set("rights", eff.rights)
      existing.set("interact_actions", eff.interact_actions)
      $app.save(existing)
      console.log(`[recomputeFor] updated existing cache ${existing.id}`)
    } else {
      const col = $app.findCollectionByNameOrId("effective_permissions")
      const rec = new Record(col, {
        user: userId,
        object: objectRecord.id,
        rights: eff.rights,
        interact_actions: eff.interact_actions
      })
      $app.save(rec)
      console.log(`[recomputeFor] created new cache record ${rec.id}`)
    }
  } catch (saveErr) {
    const msg = saveErr && saveErr.message ? saveErr.message : String(saveErr)
    console.log(`[recomputeFor] SAVE FAILED: ${msg}`)
  }
}

/**
 * Neuberechnung des Caches für ein gesamtes Objekt — sammelt alle User,
 * die per ACE direkt oder über transitive Gruppen-Mitgliedschaft Rechte
 * darauf hätten, und schreibt sie in den Cache.
 */
function recomputeForObject(objectId) {
  let obj
  try { obj = $app.findRecordById("objects", objectId) }
  catch { return { error: "object not found", objectId } }

  const affectedUsers = new Set()

  const aces = $app.findRecordsByFilter(
    "object_permissions",
    "object = {:obj}",
    "", 500, 0,
    { obj: objectId }
  )

  console.log(`[recompute] object=${objectId} aces=${aces.length}`)

  for (const ace of aces) {
    const type = ace.get("subject_type")
    const subj = ace.get("subject") || ""
    if (type === "user" && subj) {
      affectedUsers.add(subj)
    } else if (type === "group" && subj) {
      for (const m of transitiveMembersOf(subj)) affectedUsers.add(m)
    }
    // implicit audiences: kein Cache-Eintrag nötig
  }

  console.log(`[recompute] object=${objectId} affectedUsers=${affectedUsers.size}`)

  // Cache-Einträge entfernen, die nicht mehr "betroffen" sind
  const stale = $app.findRecordsByFilter(
    "effective_permissions",
    "object = {:obj}",
    "", 500, 0,
    { obj: objectId }
  )
  for (const c of stale) {
    if (!affectedUsers.has(c.get("user"))) $app.delete(c)
  }

  // Neu berechnen
  for (const userId of affectedUsers) {
    recomputeFor(userId, obj)
  }

  return { objectId, aces: aces.length, affectedUsers: Array.from(affectedUsers) }
}

/**
 * Group-Members/Subgroups haben sich geändert: alle Objekte, deren ACEs
 * direkt oder indirekt diese Gruppe referenzieren, brauchen einen
 * Recompute.
 */
function recomputeForGroup(groupId) {
  // Erst: alle "Vorfahren"-Gruppen (inkl. der Gruppe selbst) sammeln.
  // Eine ACE auf eine Vorfahre-Gruppe macht jeden Member dieser Gruppe
  // betroffen — und die Member ändern sich bei jeder Edit.
  const ancestors = new Set([groupId])
  const queue     = [groupId]
  while (queue.length > 0) {
    const current = queue.shift()
    const parents = $app.findRecordsByFilter(
      "groups",
      "subgroups ?= {:gid}",
      "", 500, 0,
      { gid: current }
    )
    for (const p of parents) {
      if (!ancestors.has(p.id)) {
        ancestors.add(p.id)
        queue.push(p.id)
      }
    }
  }

  // Alle Objekte, die ACEs auf eine dieser Gruppen haben
  const affectedObjects = new Set()
  for (const gid of ancestors) {
    const aces = $app.findRecordsByFilter(
      "object_permissions",
      `subject_type = "group" && subject = {:gid}`,
      "", 500, 0,
      { gid }
    )
    for (const a of aces) affectedObjects.add(a.get("object"))
  }

  for (const objId of affectedObjects) recomputeForObject(objId)
}

// ----------------------------------------------------------------------
// Default-Permissions beim Object-Create
// ----------------------------------------------------------------------

/**
 * Liest users.default_permissions des Owners und materialisiert sie als
 * object_permissions-Einträge für das neue Objekt. Eingaben werden
 * defensiv validiert — fehlerhafte Templates blockieren das Create nicht.
 */
function applyOwnerDefaults(ownerId, objectId) {
  if (!ownerId) {
    console.log(`[applyOwnerDefaults] skip object=${objectId}: no owner`)
    return
  }

  let user
  try { user = $app.findRecordById("users", ownerId) }
  catch (err) {
    console.log(`[applyOwnerDefaults] skip object=${objectId}: owner=${ownerId} not found (${err && err.message})`)
    return
  }

  let defaults = user.get("default_permissions")

  // Goja-Bridge-Fallstrick: PB liefert JSON-Felder unter bestimmten Bedingungen
  // als Array von Bytes (Go-[]byte) oder Einzel-Char-Strings statt als
  // geparsten JS-Wert. Erkennbar daran, dass die Elemente Primitives statt
  // Objekte sind. In dem Fall den String rekonstruieren und neu parsen.
  if (Array.isArray(defaults) && defaults.length > 0 && typeof defaults[0] !== "object") {
    let raw
    try {
      raw = typeof defaults[0] === "number"
        ? String.fromCharCode.apply(null, defaults)
        : defaults.join("")
      defaults = JSON.parse(raw)
      console.log(`[applyOwnerDefaults] re-parsed JSON-field from byte-array (${raw.length} chars)`)
    } catch (err) {
      console.log(`[applyOwnerDefaults] reparse failed object=${objectId}: ${err && err.message}`)
      return
    }
  }

  if (!Array.isArray(defaults) || defaults.length === 0) {
    console.log(`[applyOwnerDefaults] skip object=${objectId}: defaults empty or not array`)
    return
  }
  console.log(`[applyOwnerDefaults] object=${objectId} owner=${ownerId} templates=${defaults.length}`)

  const col = $app.findCollectionByNameOrId("object_permissions")
  for (const tpl of defaults) {
    if (!tpl || typeof tpl !== "object") continue
    const type = tpl.subject_type
    if (typeof type !== "string") continue
    if (!["user","group","authenticated","anonymous","everyone"].includes(type)) continue

    const subj = IMPLICIT_AUDIENCES.has(type) ? "" : (tpl.subject || "")
    if (!IMPLICIT_AUDIENCES.has(type) && !subj) continue   // user/group ohne id macht keinen Sinn

    // owner-Recht nur für user/group erlauben (siehe Konzept-Memo)
    const rights = Array.isArray(tpl.rights) ? tpl.rights.slice() : []
    if (IMPLICIT_AUDIENCES.has(type)) {
      const i = rights.indexOf("owner")
      if (i >= 0) rights.splice(i, 1)
    }

    const interact = Array.isArray(tpl.interact_actions) ? tpl.interact_actions : []

    try {
      const rec = new Record(col, {
        object: objectId,
        subject_type: type,
        subject: subj,
        rights,
        interact_actions: interact
      })
      $app.save(rec)
      console.log(`[applyOwnerDefaults] + ACE object=${objectId} subject_type=${type} rights=${JSON.stringify(rights)}`)
    } catch (err) {
      console.log(`[applyOwnerDefaults] save ACE failed object=${objectId}: ${err && err.message}`)
    }
  }
}

// ----------------------------------------------------------------------
// Exports
// ----------------------------------------------------------------------

module.exports = {
  ALL_RIGHTS,
  ALL_ACTIONS,
  resolveEffective,
  resolveExplicit,
  canInteract,
  recomputeFor,
  recomputeForObject,
  recomputeForGroup,
  applyOwnerDefaults,
  transitiveGroupsOf,
  transitiveMembersOf
}
