/// <reference path="../pb_data/types.d.ts" />

// Throttle password guessing — without throttling the agents.
//
// The reasoning lives in `auth-throttle.js` next to the counting. This file is
// the entry point: PocketBase executes every `*.pb.js` in pb_hooks at start,
// and only those. A helper file is loaded when something requires it — which is
// why the first version of this hook never ran at all.

onRecordAuthWithPasswordRequest((e) => {
  // Required INSIDE the callback: the goja VM pool hands out fresh scopes, so
  // a module loaded at boot is not the one this callback sees.
  const { limits, lockedFor, countFailure, clearFailures } = require(`${__hooks}/auth-throttle.js`)
  const now = Date.now()
  const cfg = limits(e.app)
  const identity = String(e.identity || "").trim().toLowerCase()
  // `realIP()` honours the proxy headers PocketBase is configured to trust —
  // behind Caddy that is the client, not the proxy.
  let address = ""
  try { address = String(e.realIP() || "") } catch (err) { address = "" }

  const idKey = "id:" + identity
  const ipKey = "ip:" + address

  // Locked? Answer the same way for a known and an unknown account, and say
  // how long — a user who mistyped deserves to know when to try again, and it
  // tells an attacker nothing they could not measure themselves.
  const wait = Math.max(
    identity ? lockedFor(e.app, idKey, now) : 0,
    address ? lockedFor(e.app, ipKey, now) : 0,
  )
  if (wait > 0) {
    // 429, not 400: the client can tell "wrong password" from "wait a moment".
    //
    // The shape is PocketBase's, not ours — anything in `data` that is not a
    // ValidationError comes back to the client wrapped as `validation_invalid_value`,
    // which is how the first version of this hook shipped a code nobody could read.
    // `auth_locked` is the stable part; the client turns it into a sentence in
    // the reader's language (docs/mehrsprachigkeit.md), the English text is the
    // fallback for the log.
    throw new ApiError(429, "too many failed attempts",
      { auth: new ValidationError("auth_locked",
          wait >= 60
        ? "Too many failed attempts. Try again in " + Math.ceil(wait / 60) + " min."
        : "Too many failed attempts. Try again in " + wait + " s.") })
  }

  try {
    e.next()
  } catch (err) {
    // Only WRONG CREDENTIALS count. A malformed request or a server error is
    // not a guess, and counting it would lock people out over our own bugs.
    const status = Number(err && err.status) || 400
    if (status === 400 || status === 401 || status === 403) {
      if (identity) {
        const entry = countFailure(e.app, idKey, cfg.perIdentity, now, cfg, cfg.lockMs)
        if (entry.until) {
          console.log("[auth] gesperrt: " + identity + " nach " + entry.count
            + " Fehlversuchen (" + Math.round(cfg.lockMs / 60000) + " min)")
        }
      }
      if (address) countFailure(e.app, ipKey, cfg.perAddress, now, cfg, cfg.lockAddressMs)
    }
    throw err
  }

  // Got in: the slate is clean. This is why agents and the test suite never
  // notice this hook — they succeed.
  if (identity) clearFailures(e.app, idKey)
})
