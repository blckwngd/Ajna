// Abnahme durch eine benannte Prüfgruppe.
//
// Der Anlass: „Stichprobe" und „Prüfgruppe" heissen im Client zwei
// verschiedene Dinge, liefen serverseitig aber beide auf `verify: "agent"` —
// also auf „nur der Aussteller entscheidet". Für die Stichprobe stimmt das
// (der Auftraggeber sieht selbst nach), für eine Prüfgruppe nicht: Dort nehmen
// PERSONEN ab, die nicht der Aussteller sind.
//
// Geprüft wird deshalb: Mitglieder der benannten Gruppe dürfen entscheiden,
// Aussenstehende nicht, und der Aussteller behält sein Recht.

export const name = 'Abnahme durch Prüfgruppe'

export async function run(t) {
  const A = await t.user('issuer')     // Aussteller
  const B = await t.user('player')     // Bearbeiter
  const P = await t.user('pruefer')    // Mitglied der Prüfgruppe
  const X = await t.user('fremd')      // gehört nicht dazu

  // Prüfgruppe anlegen — P ist Mitglied.
  const g = await t.raw('/api/collections/groups/records', {
    method: 'POST', token: A.token,
    body: { name: 'QTest Pruefgruppe', owner: A.id, members: [P.id] },
  })
  t.check('Prüfgruppe angelegt', g.status === 200 && !!g.data?.id,
    'HTTP ' + g.status + ' ' + JSON.stringify(g.data).slice(0, 120))
  const gruppeId = g.data?.id
  if (!gruppeId) return
  const gLese = await t.raw(`/api/collections/groups/records/${gruppeId}`, { token: A.token })
  t.check('P ist Mitglied der Gruppe',
    (gLese.data?.members || []).includes(P.id),
    'members=' + JSON.stringify(gLese.data?.members))

  const lohn = await t.item(A.token, 'QTest Gruppenlohn')
  await t.carry(A.token, lohn.id)
  const call = await t.call(A.token, 'QTest Mit Pruefgruppe', 'Wird von der Gruppe abgenommen')
  await t.share(A.token, call.id)
  let r = await t.quest.publish(A.token, call.id, {
    rewardItems: [lohn.id], verify: 'group', pruefgruppe: gruppeId,
  })
  t.check('Veröffentlichen mit Prüfgruppe geht', r.status === 200,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))
  let st = (await t.read(A.token, call.id)).state
  t.check('Abnahmeweg ist gespeichert', st.call.verify === 'group', 'verify=' + st.call.verify)
  t.check('und die Gruppe steht dabei', st.call.pruefgruppe === gruppeId)

  await t.quest.accept(B.token, call.id)
  r = await t.quest.complete(B.token, call.id)
  t.check('Melden führt in die Abnahme', r.status === 202, 'HTTP ' + r.status)
  t.check('mit passender Auskunft', /review group/.test(r.data?.message || ''), r.data?.message)

  // ── Wer darf entscheiden ───────────────────────────────────────────────
  r = await t.quest.approve(X.token, call.id)
  t.check('Aussenstehende dürfen nicht abnehmen', r.status === 403, 'HTTP ' + r.status)
  t.check('mit verständlicher Begründung', /review group/.test(r.data?.error || ''), r.data?.error)

  r = await t.quest.approve(B.token, call.id)
  t.check('der Bearbeiter erst recht nicht', r.status === 403, 'HTTP ' + r.status)

  r = await t.quest.approve(P.token, call.id)
  t.check('ein Gruppenmitglied darf', r.status === 200,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))
  const l = await t.read(B.token, lohn.id)
  t.check('und die Belohnung wandert zum Bearbeiter', l?.carried_by === B.id,
    'carried_by=' + l?.carried_by)
  t.check('Bearbeiter bekommt Karma', Number(r.data?.karma) > 0, 'karma=' + r.data?.karma)

  // ── Der Aussteller behält sein Recht ───────────────────────────────────
  const lohn2 = await t.item(A.token, 'QTest Gruppenlohn 2')
  await t.carry(A.token, lohn2.id)
  const call2 = await t.call(A.token, 'QTest Gruppe zwei', 'Aussteller greift durch')
  await t.share(A.token, call2.id)
  await t.quest.publish(A.token, call2.id, {
    rewardItems: [lohn2.id], verify: 'group', pruefgruppe: gruppeId,
  })
  await t.quest.accept(B.token, call2.id)
  await t.quest.complete(B.token, call2.id)
  r = await t.quest.reject(A.token, call2.id, { reason: 'Nicht sauber genug' })
  t.check('der Aussteller darf ebenfalls entscheiden', r.status === 200, 'HTTP ' + r.status)
  st = (await t.read(A.token, call2.id)).state
  t.check('Ablehnung schickt zurück zum Bearbeiter', st.call.status === 'claimed',
    'status=' + st.call.status)

  // ── „issuer" ist der ehrliche Name für „agent" ─────────────────────────
  const lohn3 = await t.item(A.token, 'QTest Stichprobenlohn')
  await t.carry(A.token, lohn3.id)
  const call3 = await t.call(A.token, 'QTest Stichprobe', 'Auftraggeber sieht nach')
  await t.share(A.token, call3.id)
  r = await t.quest.publish(A.token, call3.id, { rewardItems: [lohn3.id], verify: 'issuer' })
  t.check('verify "issuer" wird angenommen', r.status === 200, 'HTTP ' + r.status)
  st = (await t.read(A.token, call3.id)).state
  t.check('und bleibt erhalten', st.call.verify === 'issuer', 'verify=' + st.call.verify)
  await t.quest.accept(B.token, call3.id)
  r = await t.quest.complete(B.token, call3.id)
  t.check('führt wie "agent" in die Abnahme', r.status === 202, 'HTTP ' + r.status)
  r = await t.quest.approve(P.token, call3.id)
  t.check('ohne Prüfgruppe entscheidet nur der Aussteller', r.status === 403, 'HTTP ' + r.status)
  r = await t.quest.approve(A.token, call3.id)
  t.check('der Aussteller kann abnehmen', r.status === 200, 'HTTP ' + r.status)
}
