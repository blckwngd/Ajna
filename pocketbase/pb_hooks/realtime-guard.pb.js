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
// THE RULES, one per namespace:
//
//   chat:<account>              only that account
//   proximity:<object>          the object's operator (owner or ACE `owner`)
//   interact:<object>:owner     the object's operator — the full event with
//                               actor and payload (position on "call");
//                               the public `interact:<object>` stays open
//                               and carries the action only
//   agent:<source>[:public]     the account holding the manifest for that
//                               source, plus its delegates (sources.js).
//                               An UNCLAIMED source stays open: an agent
//                               that publishes no manifest must not fall
//                               out of its own command channel — that
//                               would be a worse failure than the leak.
//                               Every agent of ours publishes its manifest
//                               BEFORE subscribing (checked 2026-10-22:
//                               world-director, robot-agent; the others
//                               take no commands).
//   everything else             untouched (collection topics, interact
//                               public, future world chat)
//
// FILTER, DO NOT REJECT. Both work (measured: assigning to
// `e.subscriptions` takes effect, and a 403 leaves already established
// subscriptions alone). Filtering is still the better choice, because a
// client sends its WHOLE topic list on every change: rejecting the batch
// over one bad entry would discard the legitimate topics of that same
// request. Filtering drops only the offending one, and a well-behaved
// client never notices.
// =====================================================================

onRealtimeSubscribeRequest((e) => {
  try {
    // INSIDE the callback, not above it. Hook callbacks in the PocketBase
    // JSVM share no module scope: a `const` at file level is simply not
    // defined in here. It cost a test run — the guard threw on every
    // subscribe and fell back to "collection topics only", which looked
    // like an over-strict rule rather than a missing variable.
    //
    // Only the object and manifest branches cost a database read. Cap how
    // many of those a single request may trigger, so a client cannot turn
    // one subscribe into a thousand lookups. Generous: the world-director
    // watches about a dozen figures, each with a proximity AND an
    // interact-owner topic, plus its command channel. Viewers subscribe to
    // the public interact topic only (AjnaManager.subscribeInteract), which
    // costs nothing here.
    const MAX_LOOKUPS = 128

    const requested = e.subscriptions || []
    if (!requested.length) return e.next()

    let auth = null
    try { auth = e.requestInfo()?.auth || null } catch (err) { auth = null }
    const uid = auth ? String(auth.id) : ""

    let lookups = 0

    // `topic` may carry PocketBase's own options suffix (`name?options=…`),
    // so compare on the part before the question mark.
    const nameOf = (topic) => String(topic).split("?")[0]

    // Operator of an object: its owner, or an account holding an ACE
    // `owner` right — de facto ownership, same reading as the delete rule.
    const operatesObject = (objectId) => {
      if (!uid || !objectId) return false
      if (++lookups > MAX_LOOKUPS) return false
      let obj = null
      try { obj = $app.findRecordById("objects", objectId) } catch (err) { return false }
      if (String(obj.get("owner")) === uid) return true
      try {
        const { resolveEffective } = require(`${__hooks}/permissions.js`)
        const eff = resolveEffective(auth, obj)
        return (eff.rights || []).indexOf("owner") !== -1
      } catch (err) { return false }
    }

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
        return operatesObject(name.slice("proximity:".length))
      }

      // The full interaction event (who, and what they sent along) goes to
      // the operator alone. The public `interact:<id>` has no suffix and
      // falls through to "allowed".
      if (name.indexOf("interact:") === 0 && /:owner$/.test(name)) {
        return operatesObject(name.slice("interact:".length, -":owner".length))
      }

      // Command channel of an agent: commands carry coordinates
      // (`payload.at`), so a lurker would learn where someone asked for
      // something. The anonymous variant `:public` follows the same rule.
      if (name.indexOf("agent:") === 0) {
        const source = name.slice("agent:".length).replace(/:public$/, "")
        if (!source) return false
        if (++lookups > MAX_LOOKUPS) return false
        try {
          const { mayActForSource } = require(`${__hooks}/sources.js`)
          return mayActForSource(source, uid)
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
        .filter(t => !/^((chat|proximity|agent):|interact:.*:owner$)/.test(String(t).split("?")[0]))
    } catch (inner) { /* nothing left to do */ }
    return e.next()
  }
})
