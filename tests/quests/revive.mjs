// Ein erledigter Auftrag lässt sich durch erneutes Veröffentlichen wiederbeleben.
//
// Vorher eine Sackgasse: publish ließ einen vorhandenen Status unangetastet, ein
// „done"-Auftrag blieb für immer erledigt — frische Belohnung binden ging, spielen
// nicht. Veröffentlichen heißt „ich biete den Auftrag (neu) an" → Lebenszyklus
// zurücksetzen. „Speichern" tut das bewusst NICHT.

export const name = 'Wiederbeleben: Veröffentlichen setzt den Lebenszyklus zurück'

// SELBST DURCHGESPIELT, DESHALB ALS PROBELAUF: Seit 2026-09-02 ist der eigene
// Auftrag gesperrt (siehe quests/probelauf.mjs) — ausser als Probelauf oder mit
// Superuser-Recht. Der Gegenstand dieser Suite bleibt davon unberuehrt: Ein
// Probelauf aendert nur Karma und Sichtbarkeit, der Tausch laeuft normal.
const probelauf = async (t, A, id) => {
  const st = (await t.read(A.token, id)).state
  st.call = { ...(st.call || {}), probelauf: true }
  await t.patch(A.token, id, { state: st })
}

export async function run(t) {
  const A = await t.user('solo')

  const r1 = await t.item(A.token, 'Belohnung 1')
  await t.carry(A.token, r1.id)
  const call = await t.call(A.token, 'Testauftrag')

  await t.quest.publish(A.token, call.id, { rewardItems: [r1.id] })
  await probelauf(t, A, call.id)
  await t.quest.accept(A.token, call.id)
  let r = await t.quest.complete(A.token, call.id)
  t.check('Auftrag ist erledigt (Ausgangslage)', r.data?.status === 'done', 'status=' + r.data?.status)

  r = await t.quest.accept(A.token, call.id)
  t.check('Erledigter Auftrag: Annehmen abgelehnt', r.status === 409, 'HTTP ' + r.status)

  // Wiederbeleben: frische Belohnung binden + wiederholbar machen.
  const r2 = await t.item(A.token, 'Belohnung 2')
  const r3 = await t.item(A.token, 'Belohnung 3')
  await t.carry(A.token, r2.id); await t.carry(A.token, r3.id)

  r = await t.quest.publish(A.token, call.id, {
    rewardItems: [r2.id, r3.id], repeatable: true, rewardPerRun: 1,
  })
  await probelauf(t, A, call.id)
  t.check('Erneutes Veröffentlichen setzt auf „offen" zurück',
    r.status === 200 && r.data?.call?.status === 'open',
    'status=' + r.data?.call?.status + ' ' + (r.data?.error || ''))
  t.check('… und trägt repeatable', r.data?.call?.repeatable === true)
  t.check('… und alte Marker sind weg',
    r.data?.call?.completedBy === undefined && r.data?.call?.claimedBy === undefined)

  r = await t.quest.accept(A.token, call.id)
  t.check('Wiederbelebter Auftrag: Annehmen geht', r.status === 200, 'HTTP ' + r.status)
  r = await t.quest.complete(A.token, call.id)
  t.check('Durchlauf 1 → bleibt offen (wiederholbar)', r.data?.status === 'open', 'status=' + r.data?.status)
  r = await t.quest.accept(A.token, call.id)
  t.check('Erneut annehmen geht', r.status === 200, 'HTTP ' + r.status)
  r = await t.quest.complete(A.token, call.id)
  t.check('Durchlauf 2 → Vorrat leer → done', r.data?.status === 'done', 'status=' + r.data?.status)
}
