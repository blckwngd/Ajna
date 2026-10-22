/// <reference path="../pb_data/types.d.ts" />
// =====================================================================
// Who holds an agent source name?
//
// ONE answer for every place that asks. The object hook (may this account
// write `state.source = X`?) and the realtime guard (may this account listen
// on `agent:X`?) are the same question, and two copies of the rule would
// drift apart — exactly what the comment in main.pb.js warns about: "two
// places that answer the same question differently are worse than one
// wrong answer".
//
// THE RULE: `agent_manifests` is unique over (source, owner), not over
// source alone. A second account may create a manifest for the same name,
// and its upsert reports success. So the name belongs to the OLDEST
// manifest (sorted by `created`), and to the accounts that manifest lists
// in `delegates`. The client sorts the same way (AgentFilters.js).
//
// Not an entry point (no `.pb.js`): loaded via require() INSIDE a hook
// callback, because callbacks share no module scope.
// =====================================================================

/**
 * @param {string} source
 * @returns {{owner: string, delegates: string[]} | null}  null = unclaimed
 */
function holderOfSource(source) {
  if (!source) return null
  let hits
  try {
    hits = $app.findRecordsByFilter(
      "agent_manifests", "source = {:s}", "created", 50, 0, { s: source })
  } catch (err) { return null }   // 404 = nobody holds the name
  const m = hits && hits.length ? hits[0] : null
  if (!m) return null
  let delegates = []
  try {
    // JSON fields arrive in the JSVM as object, as STRING or as BYTE ARRAY.
    // `jsonArray` covers all three — a hand-rolled parse once missed the
    // third and delegation silently did nothing.
    const { jsonArray } = require(`${__hooks}/utf8.js`)
    delegates = jsonArray(m.get("delegates")).map(String)
  } catch (err) { delegates = [] }
  return { owner: String(m.get("owner") || ""), delegates }
}

/**
 * May `accountId` act for `source`? True when the name is held by that
 * account or delegated to it. An UNCLAIMED name is open to everyone — the
 * caller decides whether that is acceptable for its case.
 * @param {string} source
 * @param {string} accountId
 * @param {{owner: string, delegates: string[]} | null} [holder]  pre-fetched
 */
function mayActForSource(source, accountId, holder) {
  const h = holder === undefined ? holderOfSource(source) : holder
  if (!h) return true
  if (!accountId) return false
  return h.owner === accountId || h.delegates.indexOf(accountId) !== -1
}

module.exports = { holderOfSource, mayActForSource }
