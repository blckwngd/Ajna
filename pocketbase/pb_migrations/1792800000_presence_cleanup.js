/// <reference path="../pb_data/types.d.ts" />
//
// Knob for the cron `presence_cleanup` (main.pb.js): after how many days a
// presence object (`type = player`) nobody has touched is removed.
//
// A presence is written by a running client every few seconds and stamped
// with `state.seenAt` by the server hook on every write. One that has not
// been touched for days belongs to a client that is gone — and such ghosts
// accumulate: a persona found one from 31.08. standing next to the live one
// of the same account, without actions, and reported the inconsistency.
//
// Default ON with 7 days: a presence is transient by nature, keeping a
// stale one is the error. 0 = never.

migrate((app) => {
  try {
    app.findFirstRecordByFilter('settings', 'key = {:k}', { k: 'presence.stale_days' })
    return   // already there — the operator's value stays
  } catch (err) { /* create below */ }
  const col = app.findCollectionByNameOrId('settings')
  const rec = new Record(col)
  rec.set('key', 'presence.stale_days')
  rec.set('value', 7)
  rec.set('note', 'Nach wie vielen Tagen ohne Lebenszeichen (state.seenAt) der Cron presence_cleanup '
    + 'eine Anwesenheit (objects.type = player) löscht. 0 = nie. Ein laufender Client '
    + 'schreibt seine Anwesenheit alle paar Sekunden; eine tagelang unberührte gehört '
    + 'niemandem mehr.')
  rec.set('public', false)
  app.save(rec)
}, (app) => {
  try {
    app.delete(app.findFirstRecordByFilter('settings', 'key = {:k}', { k: 'presence.stale_days' }))
  } catch (err) { /* never created */ }
})
