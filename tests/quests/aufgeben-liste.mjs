// Zurückgeben eines angenommenen Auftrags, und was die Regionsliste erzählt.
//
// ANLASS: Das Auftragsfenster bot „Aufgeben" an — serverseitig gab es dafür
// keinen Weg. `quest/cancel` ist etwas anderes (der AUSSTELLER zieht die
// Ausschreibung zurück), und `quest/reject` darf nur, wer abnimmt. Ein
// angenommener Auftrag wäre also für immer belegt gewesen, sobald jemand es
// sich anders überlegt.
//
// Zweiter Teil: Die Liste muss dem Fenster alles liefern, was es anzeigt —
// Beschreibung, Belohnungsgattung, Aussteller-Name, Stimmenstand, und vor allem
// die Auskunft „darf ICH das abnehmen". Ohne sie müsste der Client die
// Abnahmeregeln nachbauen, die der Server ohnehin noch einmal prüft.

export const name = 'Aufgeben und Listen-Auskunft'

const ORT = { lat: 50.4466, lon: 7.5971 }

export async function run(t) {
  const A = await t.user('issuer')
  const B = await t.user('player')
  const C = await t.user('zweiter')

  // ── Zurückgeben ────────────────────────────────────────────────────────
  const lohn = await t.item(A.token, 'QTest Aufgabelohn')
  await t.carry(A.token, lohn.id)
  const call = await t.call(A.token, 'QTest Zum Aufgeben', 'Doch keine Lust')
  await t.share(A.token, call.id)
  await t.quest.publish(A.token, call.id, { rewardItems: [lohn.id], verify: 'items' })

  let r = await t.raw(`/api/objects/${call.id}/quest/abandon`, { method: 'POST', token: B.token, body: {} })
  t.check('ohne Annahme kein Zurückgeben', r.status === 403, 'HTTP ' + r.status)

  await t.quest.accept(B.token, call.id)
  r = await t.raw(`/api/objects/${call.id}/quest/abandon`, { method: 'POST', token: C.token, body: {} })
  t.check('nur der Bearbeiter selbst darf', r.status === 403, 'HTTP ' + r.status)

  r = await t.raw(`/api/objects/${call.id}/quest/abandon`, { method: 'POST', token: B.token, body: {} })
  t.check('der Bearbeiter gibt zurück', r.status === 200, 'HTTP ' + r.status + ' ' + (r.data?.error || ''))
  let st = (await t.read(A.token, call.id)).state
  t.check('Auftrag ist wieder offen', st.call.status === 'open', 'status=' + st.call.status)
  t.check('und niemandem mehr zugeordnet', !st.call.claimedBy, 'claimedBy=' + st.call.claimedBy)

  r = await t.quest.accept(C.token, call.id)
  t.check('ein anderer kann ihn sofort übernehmen', r.status === 200, 'HTTP ' + r.status)

  const geld = await t.read(A.token, lohn.id)
  t.check('die Treuhand bleibt gebunden', geld?.carried_by === A.id,
    'carried_by=' + geld?.carried_by)

  // Eine laufende Abnahme lässt sich nicht abbrechen — darüber entscheidet der
  // Prüfer, nicht der Eingereichte.
  const lohn2 = await t.item(A.token, 'QTest Aufgabelohn 2')
  await t.carry(A.token, lohn2.id)
  const call2 = await t.call(A.token, 'QTest In Pruefung', 'Schon gemeldet')
  await t.share(A.token, call2.id)
  await t.quest.publish(A.token, call2.id, { rewardItems: [lohn2.id], verify: 'issuer' })
  await t.quest.accept(B.token, call2.id)
  await t.quest.complete(B.token, call2.id)
  r = await t.raw(`/api/objects/${call2.id}/quest/abandon`, { method: 'POST', token: B.token, body: {} })
  t.check('eingereichte Arbeit lässt sich nicht zurückziehen', r.status === 409, 'HTTP ' + r.status)
  t.check('mit verständlicher Begründung', /review/.test(r.data?.error || ''), r.data?.error)

  // ── Was die Liste liefert ──────────────────────────────────────────────
  st = (await t.read(A.token, call2.id)).state
  st.call.kurz = 'Kurz für die Liste'
  st.call.ort = 'Am Bootshaus'
  st.call.nachweis = ['foto']
  await t.patch(A.token, call2.id, { state: st })

  let liste = await t.quest.near(A.token, { lat: ORT.lat, lon: ORT.lon, radius: 500 })
  let e = (liste.data?.quests || []).find(q => q.id === call2.id)
  t.check('Auftrag steht in der Liste', !!e)
  t.check('mit Kurztext', e?.kurz === 'Kurz für die Liste', 'kurz=' + e?.kurz)
  t.check('mit Aufgabentext', e?.task === 'Schon gemeldet', 'task=' + e?.task)
  t.check('mit Ortsangabe', e?.ort === 'Am Bootshaus')
  t.check('mit Nachweis-Liste', (e?.nachweis || []).join() === 'foto', JSON.stringify(e?.nachweis))
  t.check('mit Belohnungsgattung',
    (e?.rewardParts || [])[0]?.was === 'QTest Aufgabelohn 2', JSON.stringify(e?.rewardParts))
  t.check('mit Anzahl je Gattung', (e?.rewardParts || [])[0]?.anzahl === 1)
  t.check('mit Veröffentlichungs-Stempel', e?.published === true)

  // Der Aussteller nimmt hier ab — die Liste muss ihm das sagen.
  t.check('der Aussteller darf abnehmen', e?.canVerify === true, 'canVerify=' + e?.canVerify)
  t.check('und sieht den eingereichten Nachweis', !!e?.submissionProof)
  t.check('samt Name des Einreichers', !!e?.pendingByName || e?.pendingBy === B.id,
    'pendingByName=' + e?.pendingByName)

  liste = await t.quest.near(C.token, { lat: ORT.lat, lon: ORT.lon, radius: 500 })
  e = (liste.data?.quests || []).find(q => q.id === call2.id)
  t.check('ein Unbeteiligter darf nicht abnehmen', e?.canVerify === false, 'canVerify=' + e?.canVerify)
  t.check('und bekommt den Nachweis nicht zu sehen', !e?.submissionProof,
    JSON.stringify(e?.submissionProof))

  liste = await t.quest.near(B.token, { lat: ORT.lat, lon: ORT.lon, radius: 500 })
  e = (liste.data?.quests || []).find(q => q.id === call2.id)
  t.check('der Bearbeiter nimmt seine eigene Arbeit nicht ab', e?.canVerify === false)
  t.check('sieht aber, was er eingereicht hat', !!e?.submissionProof)

  // ── Schwarm: Stimmenstand steht in der Liste ───────────────────────────
  const lohn3 = await t.item(A.token, 'QTest Schwarmlohn')
  await t.carry(A.token, lohn3.id)
  const call3 = await t.call(A.token, 'QTest Schwarm Liste', 'Bestaetigen bitte')
  await t.share(A.token, call3.id)
  await t.quest.publish(A.token, call3.id, { rewardItems: [lohn3.id], verify: 'crowd' })
  st = (await t.read(A.token, call3.id)).state
  st.call.schwarmZahl = 2
  await t.patch(A.token, call3.id, { state: st })
  await t.quest.accept(B.token, call3.id)
  await t.quest.complete(B.token, call3.id)

  liste = await t.quest.near(C.token, { lat: ORT.lat, lon: ORT.lon, radius: 500 })
  e = (liste.data?.quests || []).find(q => q.id === call3.id)
  t.check('Schwarm: nötige Stimmen stehen dabei', e?.votesNeeded === 2, 'noetig=' + e?.votesNeeded)
  t.check('Stand beginnt bei null', e?.votes?.ja === 0, JSON.stringify(e?.votes))
  t.check('ein Unbeteiligter darf mitstimmen', e?.canVerify === true)
  t.check('noch nicht abgestimmt', e?.votes?.meine === false)

  await t.quest.confirm(C.token, call3.id, { verdict: 'ok' })
  liste = await t.quest.near(C.token, { lat: ORT.lat, lon: ORT.lon, radius: 500 })
  e = (liste.data?.quests || []).find(q => q.id === call3.id)
  t.check('die eigene Stimme wird mitgezählt', e?.votes?.ja === 1, JSON.stringify(e?.votes))
  t.check('und nicht zweimal angeboten', e?.canVerify === false && e?.votes?.meine === true)

  liste = await t.quest.near(A.token, { lat: ORT.lat, lon: ORT.lon, radius: 500 })
  e = (liste.data?.quests || []).find(q => q.id === call3.id)
  t.check('der Aussteller stimmt beim Schwarm nicht mit', e?.canVerify === false)
}
