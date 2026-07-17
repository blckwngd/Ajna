// Geforderte Gegenstände: Gattung + Anzahl (A) und Agent-bestimmter Einzug (B).
//
// Kernpunkt: „bring mir 3× Wolfsfell" darf NICHT das Bärenfell mitnehmen, und
// ein Agent darf beim Freigeben nur Items einziehen, die dem Spieler gehören.

export const name = 'Forderungen: Gattung + Anzahl, Agent-Einzug'

export async function run(t) {
  const A = await t.user('issuer')
  const B = await t.user('player')

  // --- A: Gattungs-Forderung „3× Wolfsfell" --------------------------------
  const reward = await t.item(A.token, 'QT2 Schwert')
  await t.carry(A.token, reward.id)

  const pelts = []
  for (let i = 0; i < 3; i++) {
    const p = await t.item(B.token, 'Wolfsfell')
    await t.carry(B.token, p.id)
    pelts.push(p)
  }
  // Ablenkung: gleicher Typ, anderer Name → darf NICHT zählen.
  const decoy = await t.item(B.token, 'Bärenfell')
  await t.carry(B.token, decoy.id)

  const call = await t.call(A.token, 'QT2 Fell-Auftrag', 'Bring mir 3 Wolfsfelle')
  await t.share(A.token, call.id)

  let r = await t.quest.publish(A.token, call.id, {
    rewardItems: [reward.id], requires: [{ match: { name: 'Wolfsfell' }, count: 3 }], verify: 'items',
  })
  t.check('Gattungs-Forderung veröffentlichen', r.status === 200, 'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  // Eine Forderung ohne Merkmal würde ALLES treffen → muss abgelehnt werden.
  const badCall = await t.call(A.token, 'QT2 Bad')
  const dummy = await t.item(A.token, 'QT2 Dummy')
  await t.carry(A.token, dummy.id)
  r = await t.quest.publish(A.token, badCall.id, { rewardItems: [dummy.id], requires: [{ match: {}, count: 1 }] })
  t.check('Forderung ohne Merkmal wird abgelehnt', r.status === 400, 'HTTP ' + r.status)

  // Zu wenige Felle → Abschluss scheitert mit klarer Meldung.
  await t.quest.accept(B.token, call.id)
  await t.place(B.token, pelts[2].id)      // eins ablegen → nur noch 2 im Inventar
  r = await t.quest.complete(B.token, call.id)
  t.check('Zu wenige geforderte Items → 409', r.status === 409, r.data?.error || ('HTTP ' + r.status))

  await t.carry(B.token, pelts[2].id)      // wieder aufnehmen
  r = await t.quest.complete(B.token, call.id)
  t.check('Mit 3 Fellen: Abschluss', r.status === 200 && r.data?.status === 'done',
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  let moved = 0
  for (const p of pelts) if ((await t.read(A.token, p.id))?.carried_by === A.id) moved++
  t.check('Genau die 3 Wolfsfelle wurden eingezogen', moved === 3, moved + '/3')
  t.check('Bärenfell blieb beim Spieler (Gattung trennt sauber)',
    (await t.read(B.token, decoy.id))?.carried_by === B.id)
  const rew = await t.read(B.token, reward.id)
  t.check('Belohnung ging an den Spieler', rew?.carried_by === B.id && rew?.owner === B.id)

  // --- B: Agent benennt die einzuziehenden Instanzen beim Freigeben --------
  const reward3 = await t.item(A.token, 'QT2 Amulett')
  await t.carry(A.token, reward3.id)
  const loot = await t.item(B.token, 'QT2 Beute')
  await t.carry(B.token, loot.id)

  const call3 = await t.call(A.token, 'QT2 Agent-Auftrag', 'Erlege das Monster')
  await t.share(A.token, call3.id)
  // Bewusst OHNE deklarierte Forderung — der Agent entscheidet beim Freigeben.
  r = await t.quest.publish(A.token, call3.id, { rewardItems: [reward3.id], verify: 'agent' })
  t.check('Agent-Auftrag ohne deklarierte Forderung veröffentlicht', r.status === 200, 'HTTP ' + r.status)

  r = await t.quest.complete(B.token, call3.id)
  t.check('Abschluss → pending (Agent prüft)', r.status === 202, 'HTTP ' + r.status)

  r = await t.quest.approve(A.token, call3.id, { requiresItems: [loot.id] })
  t.check('Agent gibt frei UND benennt einzuziehendes Item', r.status === 200 && r.data?.collected === 1,
    'HTTP ' + r.status + ' collected=' + r.data?.collected + ' ' + (r.data?.error || ''))
  t.check('Vom Agent benanntes Item ging an den Aussteller',
    (await t.read(A.token, loot.id))?.carried_by === A.id)
  t.check('Belohnung ging an den Spieler', (await t.read(B.token, reward3.id))?.carried_by === B.id)

  // Ein Agent darf nichts einziehen, was dem Spieler nicht gehört.
  const foreign = await t.item(A.token, 'QT2 Fremd')
  await t.carry(A.token, foreign.id)
  const reward4 = await t.item(A.token, 'QT2 Ring')
  await t.carry(A.token, reward4.id)
  const call4 = await t.call(A.token, 'QT2 Auftrag 4')
  await t.share(A.token, call4.id)
  await t.quest.publish(A.token, call4.id, { rewardItems: [reward4.id], verify: 'agent' })
  await t.quest.accept(B.token, call4.id)
  r = await t.quest.approve(A.token, call4.id, { requiresItems: [foreign.id] })
  t.check('Agent kann keine fremden Items einziehen', r.status === 409, 'HTTP ' + r.status)
}
