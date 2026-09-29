/// <reference path="../pb_data/types.d.ts" />

// The counting behind `auth-throttle.pb.js`. Kept in its own file for two
// reasons: a `*.pb.js` entry point has no `module.exports` (PocketBase runs it,
// it does not require it), and this way the rules can be tested from plain Node
// with a stand-in store — no server, no waiting.

// Throttle password guessing — without throttling the agents.
//
// THE PROBLEM THIS SOLVES. PocketBase ships a rate limit for authentication
// (2 attempts per 3 seconds), and this instance had to switch it off: every
// `npm run stack` signs several agents in at the same moment from the same
// address, and one test run authenticates dozens of times in a row. No number
// fit both that and an attacker. So password guessing was unlimited — the only
// real hole on the backlog, and everything else on it was a missing feature.
//
// THE INSIGHT THAT UNBLOCKS IT: count FAILURES, not attempts.
//
// An agent burst and a test run are dozens of SUCCESSFUL logins. An attack is a
// long series of failures against one identity. Those two look nothing alike as
// soon as you stop counting the thing they have in common. A successful login
// clears the counter, so honest traffic never meets this code at all.
//
// TWO COUNTERS, VERY DIFFERENT SIZES:
//
//   * per identity — tight. Five wrong passwords for one account in ten
//     minutes is already a lot for a human who forgot theirs.
//   * per address — generous, and short. A shared WLAN, a mobile cell, CGNAT:
//     one address stands for many people. This instance learned that lesson
//     once already, when `users:create` was set to 10/hour on the assumption
//     that guests at an event arrive from different networks. They do not.
//
// THE PRICE OF THE ADDRESS COUNTER, stated plainly: someone spraying from
// behind the same shared address as real players locks those players out too.
// That is why its lock is two minutes and not fifteen. Its job is to make
// spraying pointless — fifty failures buy a two-minute pause, so a sustained
// attack runs at a crawl — not to punish. A venue full of people recovers
// before anyone has finished reading the message.
//
// WHERE THE COUNTERS LIVE: `$app.store()`, the process-wide store. Hook
// callbacks share no module scope here (the goja VM pool hands out fresh
// scopes), so a module-level Map would silently count in one worker and read in
// another. The store is shared and fast.
//
// It is also LOST ON RESTART, and that is a fair trade twice over: an attacker
// cannot restart the server, and an operator who has locked themselves out can.
// The audit trail does not depend on it either — PocketBase logs every failed
// request anyway.
//
// WHAT THIS DOES NOT DO: it does not hide whether an account exists. The reply
// is the same either way, but the timing is not, and closing that gap properly
// is a different piece of work.

const KEY_PREFIX = "authfail:"

/** Settings, adjustable without a code change (collection `settings`). */
function limits(app) {
  const { einstellung } = require(`${__hooks}/gastkonten.js`)
  return {
    perIdentity: Number(einstellung(app, "auth.max_failures_identity", 5)),
    perAddress: Number(einstellung(app, "auth.max_failures_address", 50)),
    windowMs: Number(einstellung(app, "auth.failure_window_s", 600)) * 1000,
    lockMs: Number(einstellung(app, "auth.lock_s", 900)) * 1000,
    // The address lock is SHORT on purpose — see the comment on the two
    // counters above. Fifteen minutes for an account someone is hammering is
    // fair; fifteen minutes for everyone behind a shared WLAN is not.
    lockAddressMs: Number(einstellung(app, "auth.lock_address_s", 120)) * 1000,
  }
}

/**
 * How many entries we are willing to hold.
 *
 * Without a cap an attacker could grow the store by inventing identities — one
 * entry per guess. Past the cap the oldest entries are dropped: the effect is
 * that a spraying attack loses its own history first, and it still cannot get
 * past the per-address counter.
 */
const MAX_ENTRIES = 5000

function readEntry(app, key) {
  const raw = app.store().get(KEY_PREFIX + key)
  return (raw && typeof raw === "object") ? raw : null
}

/** Drop everything that has expired; return how many are left. */
function prune(app, now) {
  const all = app.store().getAll()
  let left = 0
  for (const k in all) {
    if (k.indexOf(KEY_PREFIX) !== 0) continue
    const e = all[k]
    const dead = !e || typeof e !== "object"
      || ((e.until || 0) <= now && (e.first || 0) + 3600000 <= now)
    if (dead) app.store().remove(k)
    else left++
  }
  return left
}

/** Is this key locked right now? Returns the remaining seconds, or 0. */
function lockedFor(app, key, now) {
  const e = readEntry(app, key)
  if (!e || !e.until || e.until <= now) return 0
  return Math.ceil((e.until - now) / 1000)
}

function countFailure(app, key, max, now, cfg, lockMs) {
  const e = readEntry(app, key)
  // A window that has run out starts over: someone who mistyped their password
  // twice last week is not halfway to a lockout today.
  const fresh = !e || (e.first || 0) + cfg.windowMs <= now
  const entry = fresh ? { count: 1, first: now, until: 0 } : { ...e, count: (e.count || 0) + 1 }
  if (entry.count >= max) entry.until = now + (lockMs || cfg.lockMs)
  if (app.store().length() > MAX_ENTRIES) prune(app, now)
  app.store().set(KEY_PREFIX + key, entry)
  return entry
}

function clearFailures(app, key) {
  app.store().remove(KEY_PREFIX + key)
}

module.exports = { limits, readEntry, prune, lockedFor, countFailure, clearFailures, KEY_PREFIX, MAX_ENTRIES }
