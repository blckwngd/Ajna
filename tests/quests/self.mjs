// Der Aussteller darf seinen EIGENEN Auftrag durchspielen.
//
// Bewusst erlaubt (Nutzeranforderung: Aussteller und Spieler sind beim Testen
// dieselbe Person). Harmlos, weil Belohnung und geforderte Items dann von ihm zu
// ihm wandern (No-Op) — gewinnen lässt sich nichts, was ihm nicht ohnehin gehört.

export const name = 'Eigener Auftrag: durchspielbar, aber nicht geschenkt'

export async function run(t) {
  const A = await t.user('solo')

  const reward = await t.item(A.token, 'Solo Belohnung')
  await t.carry(A.token, reward.id)
  const pelt = await t.item(A.token, 'Wolfsfell')
  await t.carry(A.token, pelt.id)

  const call = await t.call(A.token, 'Testauftrag', 'Bring mir ein Wolfsfell')
  let r = await t.quest.publish(A.token, call.id, {
    rewardItems: [reward.id], requires: [{ match: { name: 'Wolfsfell' }, count: 1 }], verify: 'items',
  })
  t.check('Eigenen Auftrag veröffentlichen', r.status === 200, 'HTTP ' + r.status)

  r = await t.quest.accept(A.token, call.id)
  t.check('Eigenen Auftrag ANNEHMEN', r.status === 200, 'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  r = await t.quest.complete(A.token, call.id)
  t.check('Eigenen Auftrag ABSCHLIESSEN', r.status === 200 && r.data?.status === 'done',
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  const rew = await t.read(A.token, reward.id)
  t.check('Belohnung noch bei mir, Treuhand gelöst', rew?.carried_by === A.id && !rew?.state?.escrow,
    'escrow=' + JSON.stringify(rew?.state?.escrow || null))

  // Trotz Selbst-Abschluss gilt die Bedingung: ohne das geforderte Item nichts.
  const reward2 = await t.item(A.token, 'Solo Belohnung 2')
  await t.carry(A.token, reward2.id)
  const call2 = await t.call(A.token, 'Testauftrag 2', 'Bring mir ein Einhorn')
  await t.quest.publish(A.token, call2.id, {
    rewardItems: [reward2.id], requires: [{ match: { name: 'Einhorn' }, count: 1 }], verify: 'items',
  })
  await t.quest.accept(A.token, call2.id)
  r = await t.quest.complete(A.token, call2.id)
  t.check('Ohne erfüllte Bedingung → 409 (kein vorgetäuschter Erfolg)', r.status === 409,
    r.data?.error || ('HTTP ' + r.status))
}
