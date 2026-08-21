// Deutscher Text überlebt die Hooks.
//
// ANLASS: Aufgefallen beim Anbinden der Auftragsliste. Der Kurztext eines
// Auftrags kam als „Kurz fÃ¼r die Liste" zurück. Die Ursache lag nicht in der
// Liste, sondern in `parseState()`:
//
//     String.fromCharCode.apply(null, bytes)
//
// PocketBase reicht JSON-Felder je nach Weg als Byte-Array durch. Diese Zeile
// las jedes Byte als ein Zeichen — also Latin-1. UTF-8 kodiert „ü" als zwei
// Bytes, und daraus wurde „Ã¼".
//
// SCHLIMMER ALS EIN ANZEIGEFEHLER: Hooks lesen den Stand nicht nur, sie
// schreiben ihn zurück (annehmen, abschliessen, Frist stilllegen). Die
// Verstümmelung wurde also GESPEICHERT und bei jedem weiteren Durchgang erneut
// kodiert. Unbemerkt blieb das, weil sämtliche bestehenden Prüfungen ihre Texte
// in ASCII schrieben — „Uferweg saeubern" statt „Uferweg säubern".
//
// Diese Suite schreibt deshalb absichtlich so, wie ein Mensch tippt.

export const name = 'Umlaute überleben die Hooks'

const TEXT = {
  kurz: 'Bäume gießen — 10 Liter je Baum',
  task: 'Sechs Jungbäume an der Allee wässern. Kanister stehen bereit; groß genug für zwei Runden.',
  ort: 'Allee am Spielplatz, südlicher Zugang',
  notiz: 'Alle sechs gegossen, Größe passt.',
}

export async function run(t) {
  const A = await t.user('issuer')
  const B = await t.user('player')

  const lohn = await t.item(A.token, 'QTest Gießkanne')
  await t.carry(A.token, lohn.id)
  const call = await t.call(A.token, 'QTest Bäume gießen', TEXT.task)
  await t.share(A.token, call.id)

  // Beschreibende Felder wie aus dem Editor.
  let st = (await t.read(A.token, call.id)).state
  st.call.kurz = TEXT.kurz
  st.call.ort = TEXT.ort
  await t.patch(A.token, call.id, { state: st })

  st = (await t.read(A.token, call.id)).state
  t.check('Datenbank speichert richtig', st.call.kurz === TEXT.kurz, 'kurz=' + st.call.kurz)

  // ── Jeder Hook, der den Stand anfasst ──────────────────────────────────
  let r = await t.quest.publish(A.token, call.id, { rewardItems: [lohn.id], verify: 'issuer' })
  t.check('Veröffentlichen geht', r.status === 200, 'HTTP ' + r.status)
  st = (await t.read(A.token, call.id)).state
  t.check('Veröffentlichen lässt den Kurztext heil', st.call.kurz === TEXT.kurz, 'kurz=' + st.call.kurz)
  t.check('und die Aufgabe', st.call.task === TEXT.task, 'task=' + st.call.task)
  t.check('und den Ort', st.call.ort === TEXT.ort)
  t.check('das ß überlebt', /gießen/.test(st.call.kurz), st.call.kurz)

  await t.quest.accept(B.token, call.id)
  st = (await t.read(A.token, call.id)).state
  t.check('Annehmen lässt den Text heil', st.call.kurz === TEXT.kurz, 'kurz=' + st.call.kurz)

  r = await t.quest.complete(B.token, call.id, { proof: { note: TEXT.notiz } })
  t.check('Melden geht in die Abnahme', r.status === 202, 'HTTP ' + r.status)
  st = (await t.read(A.token, call.id)).state
  t.check('Melden lässt den Text heil', st.call.kurz === TEXT.kurz, 'kurz=' + st.call.kurz)
  t.check('und die Notiz kommt unverstümmelt an',
    st.call.submissionProof?.note === TEXT.notiz, 'note=' + st.call.submissionProof?.note)

  // ── Die Liste gibt zurück, was drinsteht ───────────────────────────────
  const liste = await t.quest.near(A.token, { lat: 50.4466, lon: 7.5971, radius: 500 })
  const e = (liste.data?.quests || []).find(q => q.id === call.id)
  t.check('Liste liefert den Kurztext', e?.kurz === TEXT.kurz, 'kurz=' + e?.kurz)
  t.check('Liste liefert die Aufgabe', e?.task === TEXT.task)
  t.check('Liste liefert den Ort', e?.ort === TEXT.ort)
  t.check('Objektname mit Umlaut bleibt heil', e?.name === 'QTest Bäume gießen', 'name=' + e?.name)
  t.check('Belohnungsname mit Umlaut bleibt heil',
    (e?.rewardParts || [])[0]?.was === 'QTest Gießkanne', JSON.stringify(e?.rewardParts))

  r = await t.quest.approve(A.token, call.id)
  t.check('Abnehmen geht', r.status === 200, 'HTTP ' + r.status)
  st = (await t.read(A.token, call.id)).state
  t.check('auch nach dem Abschluss steht der Text noch da',
    st.call.kurz === TEXT.kurz, 'kurz=' + st.call.kurz)

  // ── Mehrfach durchlaufen darf nicht aufschaukeln ───────────────────────
  // Doppelte Kodierung fällt bei einem Durchgang kaum auf, bei dreien schon:
  // aus „ä" wird „Ã¤", dann „ÃƒÂ¤". Deshalb hier ausdrücklich wiederholt.
  const call2 = await t.call(A.token, 'QTest Wiederholt', TEXT.task)
  await t.share(A.token, call2.id)
  const lohn2 = await t.item(A.token, 'QTest Zweitlohn')
  await t.carry(A.token, lohn2.id)
  for (let i = 0; i < 3; i++) {
    await t.quest.publish(A.token, call2.id, { rewardItems: [lohn2.id], verify: 'items' })
    await t.quest.accept(B.token, call2.id)
    await t.raw(`/api/objects/${call2.id}/quest/abandon`, { method: 'POST', token: B.token, body: {} })
  }
  st = (await t.read(A.token, call2.id)).state
  t.check('nach drei Durchläufen unverändert', st.call.task === TEXT.task, 'task=' + st.call.task)

  // ── Gruppennamen mit Umlaut ────────────────────────────────────────────
  // Die Rechteauflösung liest dieselben Byte-Arrays.
  const g = await t.raw('/api/collections/groups/records', {
    method: 'POST', token: A.token,
    body: { name: 'QTest Prüfgruppe Süd', owner: A.id, members: [B.id] },
  })
  t.check('Gruppe mit Umlaut angelegt', g.status === 200, 'HTTP ' + g.status)
  const obj = await t.object(A.token, {
    name: 'QTest Gruppenobjekt Ü', type: 'item',
    lat: 50.4466, lon: 7.5971, altitude: 0, state: {},
  })
  await t.raw('/api/collections/object_permissions/records', {
    method: 'POST', token: A.token,
    body: { object: obj.id, subject_type: 'group', subject: g.data.id, rights: ['view'], interact_actions: [] },
  })
  const gesehen = await t.read(B.token, obj.id)
  t.check('Gruppenrecht greift trotz Umlaut im Namen', gesehen?.id === obj.id)
  t.check('und der Gruppenname bleibt heil',
    (await t.raw(`/api/collections/groups/records/${g.data.id}`, { token: A.token })).data?.name === 'QTest Prüfgruppe Süd')
}
