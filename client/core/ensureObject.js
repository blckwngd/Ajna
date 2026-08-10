// client/core/ensureObject.js — idempotentes „Objekt sicherstellen"-Muster.
//
// Das wiederkehrende Agent-/Tool-Muster: Objekt über einen State-Marker
// wiedererkennen (match), sonst anlegen; optional Felder aktualisieren und
// eine Standard-ACE garantieren. ACE-Anlage kollidiert häufig mit den aus
// users.default_permissions materialisierten ACEs (Unique-Index auf
// object+subject_type+subject) — deshalb hier Union-Merge statt blindem Create.
//
// Browserfähig (nur AjnaManager-APIs) — Agents nutzen dieselbe Datei per Node.

/**
 * Garantiert eine ACE auf dem Objekt. Existiert bereits eine mit gleichem
 * (subject_type, subject), werden rights/interact_actions per UNION ergänzt
 * (erweitert nie verengend — wer exaktes Ersetzen braucht, macht das selbst).
 * @param {import('./AjnaManager.js').AjnaManager} ajna
 * @param {string} objectId  Composite-ID
 * @param {{subject_type:string, subject?:string, rights?:string[], interact_actions?:string[]}} ace
 * @returns {Promise<'created'|'updated'|'ok'|'failed'>}
 */
export async function ensureAce(ajna, objectId, ace, { warn = console.warn } = {}) {
  const want = {
    subject_type: ace.subject_type,
    subject: ace.subject || '',
    rights: ace.rights || [],
    interact_actions: ace.interact_actions || [],
  }
  try {
    const existing = await ajna.listPermissions(objectId)
    const hit = existing.find(a => a.subject_type === want.subject_type && (a.subject || '') === want.subject)
    if (!hit) {
      await ajna.addPermission(objectId, want)
      return 'created'
    }
    const union = (a = [], b = []) => Array.from(new Set([...a, ...b]))
    const rights = union(hit.rights, want.rights)
    const interact = union(hit.interact_actions, want.interact_actions)
    if (rights.length === (hit.rights || []).length && interact.length === (hit.interact_actions || []).length) {
      return 'ok'   // deckt alles bereits ab
    }
    await ajna.updatePermission(hit.id, { rights, interact_actions: interact })
    return 'updated'
  } catch (err) {
    warn(`ensureAce ${objectId}: ${err?.message || err}`)
    return 'failed'
  }
}

/**
 * Objekt idempotent sicherstellen.
 * @param {import('./AjnaManager.js').AjnaManager} ajna  verbunden (getObjects gefüllt)
 * @param {object} opts
 * @param {(obj:object)=>boolean} opts.match  Wiedererkennung (z. B. o => o?.state?.uwb?.nodeId === 7)
 * @param {object}  opts.fields          Felder für create (und update, falls update:true)
 * @param {boolean} [opts.update=false]  vorhandenes Objekt mit fields aktualisieren
 * @param {object}  [opts.ace]           ACE, die auf dem Objekt garantiert wird (via ensureAce)
 * @param {Function} [opts.warn]
 * @returns {Promise<{obj:object, created:boolean}>}
 */
export async function ensureObject(ajna, { match, fields, update = false, ace = null, warn = console.warn }) {
  let obj = ajna.getObjects().find(match) || null
  let created = false
  if (!obj) {
    obj = await ajna.createObject(fields)
    created = true
  } else if (update) {
    obj = await ajna.updateObject(obj.id, fields)
  }
  if (ace) await ensureAce(ajna, obj.id, ace, { warn })
  return { obj, created }
}
