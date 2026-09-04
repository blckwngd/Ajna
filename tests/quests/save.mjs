// „Speichern" im Editor darf die Konfiguration übernehmen — und die Treuhand
// NICHT anfassen.
//
// Hintergrund: der Editor schreibt beim Speichern `state.call`. Ein Merge, der
// alles aus dem Record zieht, verwarf die Eingaben stillschweigend („Wiederholbar"
// blieb wirkungslos); einer, der alles aus dem Formular zieht, würde die Treuhand
// mit einem veralteten State-JSON überschreiben. Dieser Test hält die Trennung fest.

export const name = 'Speichern: Konfig aus dem Formular, Treuhand aus dem Record'

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

  const c1 = await t.item(A.token, 'M1')
  const c2 = await t.item(A.token, 'M2')
  await t.carry(A.token, c1.id); await t.carry(A.token, c2.id)
  const call = await t.call(A.token, 'SaveTest')

  // 1) Veröffentlichen OHNE repeatable.
  await t.quest.publish(A.token, call.id, { rewardItems: [c1.id, c2.id] })
  await probelauf(t, A, call.id)

  // 2) „Speichern" = Record-Update mit state.call: Treuhand-Felder aus dem
  //    Record, Konfiguration aus dem Formular.
  const cur = await t.read(A.token, call.id)
  let r = await t.patch(A.token, call.id, {
    state: {
      ...cur.state,
      call: {
        rewardItems: cur.state.call.rewardItems,   // Treuhand: aus dem Record
        status: cur.state.call.status,
        task: 't', verify: 'items',                // Konfig: aus dem Formular
        repeatable: true, rewardPerRun: 1,
      },
    },
  })
  // Das „Speichern" schreibt `state.call` neu — dabei faellt das Kennzeichen
  // weg. Erneut setzen, sonst greift die Sperre fuer eigene Auftraege.
  await probelauf(t, A, call.id)
  t.check('„Speichern" schreibt repeatable in den Record',
    r.status === 200 && r.data?.state?.call?.repeatable === true,
    'repeatable=' + JSON.stringify(r.data?.state?.call?.repeatable))

  // 3) Der Abschluss muss das respektieren → bleibt offen.
  await t.quest.accept(A.token, call.id)
  r = await t.quest.complete(A.token, call.id)
  t.check('Abschluss respektiert per „Speichern" gesetztes repeatable → bleibt offen',
    r.status === 200 && r.data?.status === 'open', 'status=' + r.data?.status + ' ' + (r.data?.error || ''))
  t.check('Treuhand überlebte das Speichern (Rest-Vorrat da)', (r.data?.rewardsLeft ?? -1) === 1,
    'rewardsLeft=' + r.data?.rewardsLeft)

  r = await t.quest.accept(A.token, call.id)
  t.check('Auftrag lässt sich ERNEUT annehmen', r.status === 200, 'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  r = await t.quest.complete(A.token, call.id)
  t.check('Zweiter Durchlauf → Vorrat leer → done', r.status === 200 && r.data?.status === 'done',
    'status=' + r.data?.status)
}
