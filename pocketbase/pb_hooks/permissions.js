/// <reference path="../pb_data/types.d.ts" />

// =====================================================================
// Ajna — Permission-Resolver
//
// Wird per require() aus den .pb.js-Hooks geladen, weil der Goja-VM-Pool
// in PocketBase Modul-Scope-Variablen NICHT zwischen Boot und Hook-Aufruf
// teilt. require() evaluiert dieses File pro VM-Instanz neu.
//
// WICHTIG: der Resolver ist noch ein Stub. Endgültige Logik liest aus
//   - objects.owner
//   - effective_permissions (Cache pro user+object)
//   - object_permissions mit subject_type ∈ {authenticated, anonymous, everyone}
// siehe ajna-permissions-concept.
// =====================================================================

const ALL_RIGHTS = ["view", "edit", "move", "owner"]
const ALL_ACTIONS = ["*"]

/**
 * Liefert die effektiven Rechte eines Users (oder Anonym) auf ein Objekt.
 * @param {Record|null} user           Auth-Record oder null
 * @param {Record}      objectRecord   das Zielobjekt (PB-Record)
 * @returns {{rights: string[], interact_actions: string[]}}
 */
function resolveEffective(user, objectRecord) {
  // 1) Owner-Shortcut — Eigentümer hat immer alles.
  if (user && objectRecord.get("owner") === user.id) {
    return { rights: ALL_RIGHTS.slice(), interact_actions: ALL_ACTIONS.slice() }
  }

  // 2) TODO: ACE-Auflösung
  //
  // const aces = $app.findRecordsByFilter(
  //   "object_permissions",
  //   "object = {:obj}",
  //   "", 200, 0,
  //   { "obj": objectRecord.id }
  // )
  // ... transitive groups, union rights, union interact_actions ...

  // 3) Default-Policy bis das ACE-System steht
  if (user) {
    return { rights: ["view"], interact_actions: ALL_ACTIONS.slice() }
  }
  return { rights: [], interact_actions: [] }
}

/** prüft, ob ein konkreter Action-Key durch das effective-set abgedeckt ist. */
function canInteract(effective, action) {
  const allowed = effective.interact_actions || []
  return allowed.indexOf("*") !== -1 || allowed.indexOf(action) !== -1
}

module.exports = {
  ALL_RIGHTS,
  ALL_ACTIONS,
  resolveEffective,
  canInteract
}
