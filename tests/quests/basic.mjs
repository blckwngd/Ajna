// Grundfall des Tauschs + Agent-Verifikation.
//
// Deckt den Kern des gedeckten Belohnungsmodells ab: nichts wird erzeugt, die
// Treuhand ist unantastbar, der Abschluss tauscht atomar in BEIDE Richtungen.

export const name = 'Tausch: Grundfall + Agent-Verifikation'

export async function run(t) {
  const A = await t.user('issuer')   // Aussteller
  const B = await t.user('player')   // Spieler

  // --- Belohnung beim Aussteller, gefordertes Item beim Spieler -------------
  const reward = await t.item(A.token, 'QTest Belohnung')
  t.check('Aussteller nimmt Belohnung ins Inventar', (await t.carry(A.token, reward.id)).status === 200)

  const tribute = await t.item(B.token, 'QTest Fell')
  t.check('Spieler hat gefordertes Item im Inventar', (await t.carry(B.token, tribute.id)).status === 200)

  const call = await t.call(A.token, 'QTest Auftrag', 'Bring mir das Fell')
  await t.share(A.token, call.id)

  let r = await t.quest.publish(A.token, call.id, {
    rewardItems: [reward.id], requiresItems: [tribute.id], verify: 'items',
  })
  t.check('Veröffentlichen bindet die Belohnung', r.status === 200, 'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  // --- Treuhand ist unantastbar --------------------------------------------
  r = await t.place(A.token, reward.id)
  t.check('Gebundene Belohnung kann NICHT abgelegt werden', r.status === 409, 'HTTP ' + r.status)

  const foreignCall = await t.call(B.token, 'QTest Fremd')
  r = await t.quest.publish(B.token, foreignCall.id, { rewardItems: [reward.id], verify: 'items' })
  t.check('Fremdes Item kann nicht hinterlegt werden', r.status === 409, 'HTTP ' + r.status)

  // Frueher stand hier „der Aussteller scheitert an der fehlenden
  // Gegenleistung" (das Fell liegt beim Spieler). Seit 2026-09-02 scheitert er
  // eine Stufe frueher: Den eigenen Auftrag erledigt man gar nicht erst,
  // ausser als Probelauf oder mit Superuser-Recht (s. Suite „probelauf").
  //
  // Die fehlende Gegenleistung wird weiter geprueft — in „requires", wo sie
  // hingehoert. Hier den Bearbeiter zu nehmen ginge nicht: Der TRAEGT das Fell.
  r = await t.quest.complete(A.token, call.id)
  t.check('der Aussteller schliesst seinen eigenen Auftrag nicht ab', r.status === 403,
    'HTTP ' + r.status + ' ' + (r.data?.code || ''))

  // --- Der eigentliche Tausch ----------------------------------------------
  r = await t.quest.accept(B.token, call.id)
  t.check('Spieler nimmt Auftrag an', r.status === 200, 'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  r = await t.quest.complete(B.token, call.id)
  t.check('Abschluss (verify: items) liefert done', r.status === 200 && r.data?.status === 'done',
    'HTTP ' + r.status + ' ' + (r.data?.error || r.data?.status || ''))

  // Mit dem Token des SPIELERS lesen: nach dem Tausch gehört es ihm, der
  // Aussteller darf es nicht mehr sehen (Permission-Recompute).
  const rew = await t.read(B.token, reward.id)
  t.check('Belohnung gehört jetzt dem Spieler', rew?.carried_by === B.id && rew?.owner === B.id,
    `carried_by=${rew?.carried_by === B.id ? 'Spieler' : rew?.carried_by}`)
  t.check('Treuhand ist gelöst', !rew?.state?.escrow, JSON.stringify(rew?.state?.escrow || null))

  const trib = await t.read(A.token, tribute.id)
  t.check('Gefordertes Item ging an den Aussteller', trib?.carried_by === A.id && trib?.owner === A.id,
    `carried_by=${trib?.carried_by === A.id ? 'Aussteller' : trib?.carried_by}`)

  r = await t.quest.complete(B.token, call.id)
  t.check('Zweiter Abschluss wird abgelehnt (kein Doppel-Kassieren)', r.status === 409, 'HTTP ' + r.status)

  // --- verify: 'agent' ------------------------------------------------------
  const reward2 = await t.item(A.token, 'QTest Belohnung 2')
  await t.carry(A.token, reward2.id)
  const call3 = await t.call(A.token, 'QTest Agent-Auftrag', 'Erlege das Monster')
  await t.share(A.token, call3.id)

  r = await t.quest.publish(A.token, call3.id, { rewardItems: [reward2.id], verify: 'agent' })
  t.check('Agent-Auftrag veröffentlicht', r.status === 200, 'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  r = await t.quest.complete(B.token, call3.id)
  t.check('verify:agent zahlt NICHT sofort aus (202 pending)', r.status === 202 && r.data?.status === 'pending',
    'HTTP ' + r.status + ' ' + (r.data?.status || r.data?.error || ''))

  const mid = await t.read(A.token, reward2.id)
  t.check('Belohnung bleibt bis zur Freigabe beim Aussteller', mid?.carried_by === A.id)

  r = await t.quest.approve(B.token, call3.id)
  t.check('Nur der Aussteller darf freigeben (Spieler → 403)', r.status === 403, 'HTTP ' + r.status)

  r = await t.quest.approve(A.token, call3.id)
  t.check('Agent gibt frei → Tausch', r.status === 200 && r.data?.status === 'done',
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  const rew2 = await t.read(B.token, reward2.id)
  t.check('Belohnung 2 gehört jetzt dem Spieler', rew2?.carried_by === B.id && rew2?.owner === B.id)
}
