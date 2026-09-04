// Verwaiste Treuhand — die Bindung muss sich selbst heilen.
//
// Die Markierung `state.escrow.call` am Item verwaist auf drei Wegen. Ohne
// Selbstheilung bleiben betroffene Items FÜR IMMER gesperrt: weder ablegbar noch
// je wieder als Belohnung verwendbar (genau das ist in der Praxis passiert).

export const name = 'Treuhand: verwaiste Bindungen heilen selbst'

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

  // Das publish-Echo muss den gespeicherten Stand liefern — der Editor befüllt
  // sich daraus (der Cache hinkt per Realtime nach).
  const c1 = await t.item(A.token, 'Münze A')
  const c2 = await t.item(A.token, 'Münze B')
  await t.carry(A.token, c1.id); await t.carry(A.token, c2.id)
  const call = await t.call(A.token, 'Rep')
  let r = await t.quest.publish(A.token, call.id, {
    rewardItems: [c1.id, c2.id], repeatable: true, rewardPerRun: 1,
  })
  await probelauf(t, A, call.id)
  t.check('publish-Echo liefert repeatable/rewardPerRun zurück',
    r.data?.call?.repeatable === true && r.data?.call?.rewardPerRun === 1,
    'repeatable=' + JSON.stringify(r.data?.call?.repeatable))

  // --- Weg 1: Auftrag gelöscht → Bindung läuft ins Leere -------------------
  r = await t.del(A.token, call.id)
  t.check('Auftrag gelöscht', r.status < 400, 'HTTP ' + r.status)
  t.check('Markierung bleibt am Item (Rohdaten)', !!(await t.read(A.token, c1.id))?.state?.escrow)
  r = await t.place(A.token, c1.id)
  t.check('Gelöschter Auftrag → Item wieder ablegbar (selbstheilend)', r.status === 200,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))
  await t.carry(A.token, c1.id)

  // --- Weg 2: erschöpfter wiederholbarer Auftrag gibt den Rest frei --------
  const d = []
  for (let i = 0; i < 3; i++) { const x = await t.item(A.token, 'D' + i); await t.carry(A.token, x.id); d.push(x) }
  const call2 = await t.call(A.token, 'Rep2')
  // Vorrat 3, 2 pro Durchlauf → nach Durchlauf 1 bleibt 1 Item übrig, Auftrag done.
  await t.quest.publish(A.token, call2.id, { rewardItems: d.map(x => x.id), repeatable: true, rewardPerRun: 2 })
  await probelauf(t, A, call2.id)
  await t.quest.accept(A.token, call2.id)
  r = await t.quest.complete(A.token, call2.id)
  t.check('Vorrat 3 / 2 pro Durchlauf → nach 1 Durchlauf done', r.status === 200 && r.data?.status === 'done',
    'status=' + r.data?.status)
  t.check('Rest-Item wurde NICHT ewig gebunden gelassen', !(await t.read(A.token, d[2].id))?.state?.escrow)
  t.check('Rest-Item ist ablegbar', (await t.place(A.token, d[2].id)).status === 200)
  await t.carry(A.token, d[2].id)

  // --- Weg 3: neu veröffentlicht ohne das alte Item → altes wird frei ------
  const e1 = await t.item(A.token, 'E1'); await t.carry(A.token, e1.id)
  const e2 = await t.item(A.token, 'E2'); await t.carry(A.token, e2.id)
  const call3 = await t.call(A.token, 'Rep3')
  await t.quest.publish(A.token, call3.id, { rewardItems: [e1.id] })
  await probelauf(t, A, call3.id)
  await t.quest.publish(A.token, call3.id, { rewardItems: [e2.id] })
  await probelauf(t, A, call3.id)
  r = await t.place(A.token, e1.id)
  t.check('Neu veröffentlicht ohne altes Item → altes ist frei', r.status === 200,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))
  await t.carry(A.token, e1.id)

  // Gegenprobe: die Selbstheilung darf kein Loch in die Deckung reißen.
  r = await t.place(A.token, e2.id)
  t.check('Aktuell gebundenes Item bleibt gesperrt', r.status === 409, 'HTTP ' + r.status)
}
