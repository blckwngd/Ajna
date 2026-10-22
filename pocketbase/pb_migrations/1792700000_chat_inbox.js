/// <reference path="../pb_data/types.d.ts" />
//
// Collection `chat_inbox` — the mailbox for direct messages whose recipient
// was not connected.
//
// WHAT IT IS NOT: a chat history. Every message that reaches a connected
// recipient stays ephemeral exactly as before (POST /api/chat/send delivers
// through the realtime broker and writes nothing). Only a message that found
// NOBODY listening (`delivered === 0`) is kept here, and only until the
// recipient picks it up — the client deletes what it has shown. A server
// that stored every line between a player and a character would hold a
// profile of who talks to whom about what; this one holds a few undelivered
// notes for a few days.
//
// Messages marked `ephemeral: true` are never stored, whoever the recipient
// is: the sender asked for nothing to be kept, and an offline recipient does
// not change that.
//
// Rules: only the RECIPIENT reads and deletes. Nobody writes through the API —
// the chat route saves via $app.save(), which bypasses the rules. The sender
// has no access either: once sent, a note belongs to its recipient.
//
// Retention: the cron `chat_inbox_expiry` in main.pb.js deletes what is
// older than `chat.inbox_days` (setting, default 14).

migrate((app) => {
  const collection = new Collection({
    type: 'base',
    name: 'chat_inbox',
    listRule:   'to = @request.auth.id',
    viewRule:   'to = @request.auth.id',
    createRule: null,
    updateRule: null,
    deleteRule: 'to = @request.auth.id',
    fields: [
      { type: 'relation', name: 'from', required: true, collectionId: '_pb_users_auth_', cascadeDelete: true, maxSelect: 1 },
      { type: 'relation', name: 'to',   required: true, collectionId: '_pb_users_auth_', cascadeDelete: true, maxSelect: 1 },
      // Context object (raw id) when a character was addressed — same meaning
      // as in the realtime message.
      { type: 'text', name: 'object', required: false, max: 64 },
      { type: 'text', name: 'text', required: true, max: 2000 },
      { type: 'json', name: 'meta', required: false, maxSize: 8192 },
      // When the sender wrote it — the pickup time is `created` of the
      // realtime message the client rebuilds, the original stamp matters.
      { type: 'text', name: 'ts', required: true, max: 40 },
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
    ],
    indexes: [
      'CREATE INDEX `idx_chat_inbox_to` ON `chat_inbox` (`to`, `created`)',
    ],
  })
  app.save(collection)

  // The retention knob, visible in the admin UI so it can be found and
  // changed; an absent record cannot be told apart from a missing feature.
  try {
    app.findFirstRecordByFilter('settings', 'key = {:k}', { k: 'chat.inbox_days' })
  } catch (err) {
    const col = app.findCollectionByNameOrId('settings')
    const rec = new Record(col)
    rec.set('key', 'chat.inbox_days')
    rec.set('value', 14)
    rec.set('note', 'Wie viele Tage eine nicht zugestellte Direktnachricht im Postfach (chat_inbox) '
      + 'liegen bleibt, bis der Cron chat_inbox_expiry sie löscht. Abgeholte Nachrichten '
      + 'löscht der Client sofort.')
    rec.set('public', false)
    app.save(rec)
  }
}, (app) => {
  const collection = app.findCollectionByNameOrId('chat_inbox')
  app.delete(collection)
  try {
    const rec = app.findFirstRecordByFilter('settings', 'key = {:k}', { k: 'chat.inbox_days' })
    app.delete(rec)
  } catch (err) { /* was never created */ }
})
