// Frist und Karma — die beiden neuen Bedingungen am Auftrag.
//
// Beides muss SERVERSEITIG greifen, sonst ist es Dekoration:
//   • Eine Frist, die nur der Client kennt, hält niemanden auf.
//   • Ein Karma, das der Client schreiben darf, ist kein Maß, sondern ein Wunsch.
//
// Geprüft wird deshalb gegen die echten Routen — inklusive des Versuchs, sich
// selbst Karma zu geben.

export const name = 'Frist und Karma'

/** ISO-Zeitpunkt relativ zu jetzt. */
const inMs = (ms) => new Date(Date.now() + ms).toISOString()

export async function run(t) {
  const A = await t.user('issuer')
  const B = await t.user('player')

  // ── Frist: abgelaufen heißt zu ─────────────────────────────────────────
  const r1 = await t.item(A.token, 'QTest Lohn 1')
  await t.carry(A.token, r1.id)
  const alt = await t.call(A.token, 'QTest Abgelaufen', 'Zu spät')
  await t.share(A.token, alt.id)
  await t.quest.publish(A.token, alt.id, { rewardItems: [r1.id], verify: 'items' })
  // Frist in die Vergangenheit setzen — so, wie der Editor sie schreiben würde.
  let st = (await t.read(A.token, alt.id)).state
  st.call.deadline = inMs(-60_000)
  await t.patch(A.token, alt.id, { state: st })

  let r = await t.quest.accept(B.token, alt.id)
  t.check('abgelaufener Auftrag lässt sich nicht annehmen', r.status === 409,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))
  t.check('mit klarer Begründung', /expired/.test(r.data?.error || ''))

  st = (await t.read(A.token, alt.id)).state
  t.check('Stand wird beim Anfassen mitgeschrieben (lazy expiry)', st.call.status === 'expired',
    'status=' + st.call.status)
  t.check('Anspruch ist gelöst', !st.call.claimedBy)

  // Die Treuhand bleibt bewusst gebunden — der Aussteller löst sie per cancel.
  const lohn = await t.read(A.token, r1.id)
  t.check('Belohnung bleibt gebunden, wird nicht automatisch zurückgebucht',
    !!lohn?.state?.escrow?.call)

  // ── Frist: noch offen heißt offen ──────────────────────────────────────
  const r2 = await t.item(A.token, 'QTest Lohn 2')
  await t.carry(A.token, r2.id)
  const frisch = await t.call(A.token, 'QTest Mit Frist', 'Noch Zeit')
  await t.share(A.token, frisch.id)
  await t.quest.publish(A.token, frisch.id, { rewardItems: [r2.id], verify: 'items' })
  st = (await t.read(A.token, frisch.id)).state
  st.call.deadline = inMs(3600_000)
  await t.patch(A.token, frisch.id, { state: st })

  r = await t.quest.accept(B.token, frisch.id)
  t.check('laufende Frist stört das Annehmen nicht', r.status === 200, 'HTTP ' + r.status)

  // Läuft die Frist zwischen Annahme und Abschluss ab, gibt es nichts.
  st = (await t.read(A.token, frisch.id)).state
  st.call.deadline = inMs(-1000)
  await t.patch(A.token, frisch.id, { state: st })
  r = await t.quest.complete(B.token, frisch.id)
  t.check('Abschluss nach Fristablauf wird abgelehnt', r.status === 409,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))
  const lohn2 = await t.read(A.token, r2.id)
  t.check('und die Belohnung bleibt beim Aussteller', lohn2?.carried_by === A.id,
    'carried_by=' + lohn2?.carried_by)

  // ── Karma: Punktestand ist nicht selbst setzbar ────────────────────────
  const selbst = await t.patchUser(B.token, B.id, { karma_points: 999 })
  const nachher = await t.readUser(B.token, B.id)
  t.check('Selbst gesetztes Karma wird nicht übernommen',
    Number(nachher?.karma_points || 0) === 0,
    'HTTP ' + selbst.status + ' karma=' + nachher?.karma_points)

  // ── Karma: Bedingung am Auftrag ────────────────────────────────────────
  const r3 = await t.item(A.token, 'QTest Lohn 3')
  await t.carry(A.token, r3.id)
  const streng = await t.call(A.token, 'QTest Nur mit Karma', 'Vertrauenssache')
  await t.share(A.token, streng.id)
  await t.quest.publish(A.token, streng.id, { rewardItems: [r3.id], verify: 'items' })
  st = (await t.read(A.token, streng.id)).state
  st.call.karma = 3
  await t.patch(A.token, streng.id, { state: st })

  r = await t.quest.accept(B.token, streng.id)
  t.check('ohne genug Karma kein Annehmen', r.status === 403, 'HTTP ' + r.status)
  t.check('Antwort nennt Ist und Soll',
    r.data?.karmaRequired === 3 && r.data?.karma === 0,
    JSON.stringify({ ist: r.data?.karma, soll: r.data?.karmaRequired }))

  // ── Karma: Gutschrift beim Abschluss ───────────────────────────────────
  const r4 = await t.item(A.token, 'QTest Lohn 4')
  await t.carry(A.token, r4.id)
  const offen = await t.call(A.token, 'QTest Ohne Bedingung', 'Einfach machen')
  await t.share(A.token, offen.id)
  await t.quest.publish(A.token, offen.id, { rewardItems: [r4.id], verify: 'items' })
  await t.quest.accept(B.token, offen.id)
  r = await t.quest.complete(B.token, offen.id)
  t.check('Abschluss geht durch', r.status === 200, 'HTTP ' + r.status + ' ' + (r.data?.error || ''))
  t.check('und schreibt Karma gut', Number(r.data?.karma) > 0, 'karma=' + r.data?.karma)

  // Zweiter Abschluss erhöht weiter — die Stufe ergibt sich aus den Punkten.
  const r5 = await t.item(A.token, 'QTest Lohn 5')
  await t.carry(A.token, r5.id)
  const zweit = await t.call(A.token, 'QTest Zweiter', 'Nochmal')
  await t.share(A.token, zweit.id)
  await t.quest.publish(A.token, zweit.id, { rewardItems: [r5.id], verify: 'items' })
  await t.quest.accept(B.token, zweit.id)
  const r2te = await t.quest.complete(B.token, zweit.id)
  t.check('zweiter Abschluss erhöht den Stand weiter',
    Number(r2te.data?.karma) > Number(r.data?.karma),
    `${r.data?.karma} → ${r2te.data?.karma}`)
}
