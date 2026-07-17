// Wiederholbare Aufträge — der Treuhand-Vorrat begrenzt die Durchläufe.
//
// Kernpunkt des gedeckten Modells: eine Wiederholung braucht Nachschub. Es kann
// nie öfter ausgezahlt werden, als der Aussteller hinterlegt hat.

export const name = 'Wiederholbar: Vorrat begrenzt die Durchläufe'

export async function run(t) {
  const A = await t.user('issuer')
  const B = await t.user('player')

  // 3 Münzen Vorrat, 1 pro Durchlauf → genau 3 Durchläufe.
  const coins = []
  for (let i = 0; i < 3; i++) {
    const c = await t.item(A.token, 'Münze')
    await t.carry(A.token, c.id)
    coins.push(c)
  }
  const call = await t.call(A.token, 'Wiederholbar', 'Immer wieder')
  await t.share(A.token, call.id)

  let r = await t.quest.publish(A.token, call.id, {
    rewardItems: coins.map(c => c.id), repeatable: true, rewardPerRun: 5,
  })
  t.check('rewardPerRun > Vorrat wird abgelehnt', r.status === 400, 'HTTP ' + r.status)

  r = await t.quest.publish(A.token, call.id, {
    rewardItems: coins.map(c => c.id), repeatable: true, rewardPerRun: 1,
  })
  t.check('Wiederholbaren Auftrag veröffentlichen (Vorrat 3, 1/Durchlauf)', r.status === 200,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  for (let i = 1; i <= 2; i++) {
    await t.quest.accept(B.token, call.id)
    r = await t.quest.complete(B.token, call.id)
    t.check(`Durchlauf ${i}: abgeschlossen, Auftrag bleibt offen`, r.status === 200 && r.data?.status === 'open',
      'status=' + r.data?.status)
  }

  await t.quest.accept(B.token, call.id)
  r = await t.quest.complete(B.token, call.id)
  t.check('Durchlauf 3: Vorrat erschöpft → done', r.status === 200 && r.data?.status === 'done',
    'status=' + r.data?.status)

  r = await t.quest.complete(B.token, call.id)
  t.check('Vierter Durchlauf abgelehnt (nichts mehr da)', r.status === 409, 'HTTP ' + r.status)

  let mine = 0
  for (const c of coins) if ((await t.read(B.token, c.id))?.carried_by === B.id) mine++
  t.check('Alle 3 Münzen wanderten zum Spieler', mine === 3, mine + '/3')

  const cr = await t.read(A.token, call.id)
  t.check('completions = 3 gezählt', cr?.state?.call?.completions === 3, 'completions=' + cr?.state?.call?.completions)

  // Gegenprobe: ohne repeatable bleibt es einmalig (Default unverändert).
  const rw = await t.item(A.token, 'Einmal')
  await t.carry(A.token, rw.id)
  const once = await t.call(A.token, 'Einmalig', 'nur einmal')
  await t.share(A.token, once.id)
  await t.quest.publish(A.token, once.id, { rewardItems: [rw.id] })
  await t.quest.accept(B.token, once.id)
  r = await t.quest.complete(B.token, once.id)
  t.check('Ohne repeatable: nach Abschluss done', r.status === 200 && r.data?.status === 'done',
    'status=' + r.data?.status)
}
