/// <reference path="../pb_data/types.d.ts" />
// =====================================================================
// Who may listen on which realtime topic.
//
// THE HOLE THIS CLOSES (measured 2026-10-20, work package 0): realtime
// topics are free-form strings, and PocketBase does not ask whether the
// name concerns the subscriber. Three accounts on a throwaway instance:
// the eavesdropper subscribed to `chat:<victim>` and received every
// message sent to the victim, verbatim.
//
// It stayed invisible because the only thing that ever travelled this way
// was an NPC answering from a fixed list of sentences. That changes as
// soon as characters speak freely and carry over what a player told them.
//
// DIRECTED VS PUBLIC is the line. World messages are meant to reach
// everyone — that is their purpose. Directed messages (player to player,
// player to character) are not. Today *everything* on `chat:*` is
// directed, so `chat:*` is closed here completely. A world chat gets its
// own topic and is public there, rather than softening this rule.
//
// FILTER, DO NOT REJECT. Both work (measured: assigning to
// `e.subscriptions` takes effect, and a 403 leaves already established
// subscriptions alone). Filtering is still the better choice, because a
// client sends its WHOLE topic list on every change: rejecting the batch
// over one bad entry would discard the legitimate topics of that same
// request. Filtering drops only the offending one, and a well-behaved
// client never notices.
//
// STILL OPEN, deliberately not done here: `agent:<source>`. That channel
// carries commands including coordinates (`payload.at`), so a lurker
// learns where someone asked for something. The rule would be "the
// account that owns the manifest for this source, plus its delegates" —
// which needs a manifest lookup and, more importantly, a check of all
// nine agents for whether any subscribes BEFORE publishing its manifest.
// The world-director does it in the right order; the others are
// unchecked. Locking an agent out of its own command channel would be a
// worse failure than the leak, so that one gets its own pass.
// =====================================================================

onRealtimeSubscribeRequest((e) => {
  try {
    // INSIDE the callback, not above it. Hook callbacks in the PocketBase
    // JSVM share no module scope: a `const` at file level is simply not
    // defined in here. It cost a test run — the guard threw on every
    // subscribe and fell back to "collection topics only", which looked
    // like an over-strict rule rather than a missing variable.
    //
    // Only the proximity branch costs a database read. Cap how many of
    // those a single request may trigger, so a client cannot turn one
    // subscribe into a thousand lookups. Generous: the world-director
    // watches about a dozen figures.
    const MAX_PROXIMITY_LOOKUPS = 64

    const requested = e.subscriptions || []
    if (!requested.length) return e.next()

    let auth = null
    try { auth = e.requestInfo()?.auth || null } catch (err) { auth = null }
    const uid = auth ? String(auth.id) : ""

    let lookups = 0

    // `topic` may carry PocketBase's own options suffix (`name?options=…`),
    // so compare on the part before the question mark.
    const nameOf = (topic) => String(topic).split("?")[0]

    const allowed = (topic) => {
      const name = nameOf(topic)

      // Directed chat: your own inbox, nobody else's. An anonymous client
      // has no inbox at all, so the degenerate topic `chat:` is out too.
      if (name.indexOf("chat:") === 0) return !!uid && name === "chat:" + uid

      // Presence at an object carries the account id of whoever walks up.
      // That belongs to the one who runs the object, not to everyone who
      // may look at it — otherwise subscribing to a public landmark would
      // report who is standing there.
      if (name.indexOf("proximity:") === 0) {
        if (!uid) return false
        if (++lookups > MAX_PROXIMITY_LOOKUPS) return false
        const objectId = name.slice("proximity:".length)
        if (!objectId) return false
        let obj = null
        try { obj = $app.findRecordById("objects", objectId) } catch (err) { return false }
        if (String(obj.get("owner")) === uid) return true
        // An ACE granting `owner` is de facto ownership — same reading as
        // the delete rule.
        try {
          const { resolveEffective } = require(`${__hooks}/permissions.js`)
          const eff = resolveEffective(auth, obj)
          return (eff.rights || []).indexOf("owner") !== -1
        } catch (err) { return false }
      }

      return true
    }

    const kept = requested.filter(allowed)
    if (kept.length !== requested.length) {
      const dropped = requested.filter(t => kept.indexOf(t) === -1).map(nameOf)
      console.log(`[realtime] ${dropped.length} topic(s) refused for ${uid || "anonymous"}: ${dropped.join(", ")}`)
      e.subscriptions = kept
    }
    return e.next()
  } catch (err) {
    // A broken guard must not take the realtime connection with it — but
    // it must not wave everything through either. Keep only what is
    // unconditionally harmless.
    console.log("[realtime] guard error, falling back to collection topics only: "
      + (err && err.message ? err.message : err))
    try {
      e.subscriptions = (e.subscriptions || [])
        .filter(t => !/^(chat|proximity):/.test(String(t).split("?")[0]))
    } catch (inner) { /* nothing left to do */ }
    return e.next()
  }
})
