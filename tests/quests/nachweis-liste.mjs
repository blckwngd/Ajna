// Nachweis statt Ware, und die Regionsliste.
//
// Für Echtwelt-Aufgaben gibt es nichts abzugeben. Geprüft wird deshalb, dass
// der Server einen NACHWEIS verlangt, ihn plausibilisiert, so weit er das kann,
// und ihn dem Prüfer hinterlegt. Danach die Liste: Wer sieht welchen Auftrag,
// und wann wandert ein nur bei der Figur angebotener Auftrag hinein.

export const name = 'Nachweis und Regionsliste'

const ORT = { lat: 50.4466, lon: 7.5971 }   // dieselbe Stelle wie t.call()

export async function run(t) {
  const A = await t.user('issuer')
  const B = await t.user('player')

  // ── Auftrag ganz ohne Ware ─────────────────────────────────────────────
  const lohn = await t.item(A.token, 'QTest Nachweislohn')
  await t.carry(A.token, lohn.id)
  const call = await t.call(A.token, 'QTest Muell sammeln', 'Uferweg saeubern')
  await t.share(A.token, call.id)
  await t.quest.publish(A.token, call.id, { rewardItems: [lohn.id], verify: 'items' })

  let st = (await t.read(A.token, call.id)).state
  st.call.nachweis = ['foto', 'vorOrt']
  await t.patch(A.token, call.id, { state: st })
  await t.quest.accept(B.token, call.id)

  let r = await t.quest.complete(B.token, call.id)
  t.check('ohne Nachweis kein Abschluss', r.status === 400, 'HTTP ' + r.status)
  t.check('und es steht da, was fehlt',
    (r.data?.missing || []).length === 2, JSON.stringify(r.data?.missing))

  r = await t.quest.complete(B.token, call.id, { proof: { photos: ['foto-1'] } })
  t.check('halber Nachweis reicht nicht', r.status === 400)
  t.check('nur der fehlende Teil wird bemaengelt',
    (r.data?.missing || []).length === 1 && /vorOrt/.test(r.data.missing[0]),
    JSON.stringify(r.data?.missing))

  r = await t.quest.complete(B.token, call.id, {
    proof: { photos: ['foto-1'], at: { lat: ORT.lat + 0.02, lon: ORT.lon } },   // ~2,2 km weg
  })
  t.check('Position weit weg wird abgelehnt', r.status === 400)
  t.check('mit Entfernungsangabe', /m entfernt/.test((r.data?.missing || [])[0] || ''),
    JSON.stringify(r.data?.missing))

  r = await t.quest.complete(B.token, call.id, {
    proof: {
      photos: ['foto-1', 'foto-2'], note: 'Ein Sack voll.',
      at: { lat: ORT.lat + 0.0002, lon: ORT.lon, precise: true },   // ~22 m
    },
  })
  t.check('vollstaendiger Nachweis schliesst ab', r.status === 200,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))
  const l = await t.read(B.token, lohn.id)
  t.check('und die Belohnung wandert', l?.carried_by === B.id)

  // ── Nachweis liegt dem Prüfer vor ──────────────────────────────────────
  const lohn2 = await t.item(A.token, 'QTest Nachweislohn 2')
  await t.carry(A.token, lohn2.id)
  const call2 = await t.call(A.token, 'QTest Mit Pruefung', 'Baeume giessen')
  await t.share(A.token, call2.id)
  await t.quest.publish(A.token, call2.id, { rewardItems: [lohn2.id], verify: 'agent' })
  st = (await t.read(A.token, call2.id)).state
  st.call.nachweis = ['foto']
  await t.patch(A.token, call2.id, { state: st })
  await t.quest.accept(B.token, call2.id)
  r = await t.quest.complete(B.token, call2.id, { proof: { photos: ['bild-a'], note: 'Alle sechs.' } })
  t.check('Meldung geht in die Pruefung', r.status === 202, 'HTTP ' + r.status)

  st = (await t.read(A.token, call2.id)).state
  t.check('der Nachweis ist hinterlegt', (st.call.submissionProof?.photos || []).length === 1,
    JSON.stringify(st.call.submissionProof))
  t.check('samt Notiz', st.call.submissionProof?.note === 'Alle sechs.')
  t.check('und Einreichungszeit', !!st.call.submittedAt)

  // ── Regionsliste ───────────────────────────────────────────────────────
  let liste = await t.quest.near(B.token, { lat: ORT.lat, lon: ORT.lon, radius: 500 })
  t.check('Liste antwortet', liste.status === 200, 'HTTP ' + liste.status)
  const ids = (liste.data?.quests || []).map(q => q.id)
  t.check('geteilter Auftrag ist dabei', ids.includes(call2.id))
  const eintrag = liste.data.quests.find(q => q.id === call2.id)
  t.check('mit Entfernung', Number.isFinite(eintrag?.distanceM), 'd=' + eintrag?.distanceM)
  t.check('und Karma-Auskunft', eintrag?.karmaOk === true && eintrag?.karmaRequired === 0)

  const fern = await t.quest.near(B.token, { lat: 48.1, lon: 11.6, radius: 500 })
  t.check('weit entfernte Gegend liefert nichts davon',
    !(fern.data?.quests || []).some(q => q.id === call2.id))

  // Nicht geteilt → nicht sichtbar.
  const geheim = await t.call(A.token, 'QTest Geheim', 'Nur fuer mich')
  liste = await t.quest.near(B.token, { lat: ORT.lat, lon: ORT.lon, radius: 500 })
  t.check('ungeteilter Auftrag bleibt unsichtbar',
    !(liste.data?.quests || []).some(q => q.id === geheim.id))
  liste = await t.quest.near(A.token, { lat: ORT.lat, lon: ORT.lon, radius: 500, mine: 1 })
  t.check('dem Aussteller zeigt "Meine" ihn aber',
    (liste.data?.quests || []).some(q => q.id === geheim.id))

  // ── listed:false und der Übergang zu "angeboten" ───────────────────────
  const lohn3 = await t.item(A.token, 'QTest Figurlohn')
  await t.carry(A.token, lohn3.id)
  const beiFigur = await t.call(A.token, 'QTest Bei der Figur', 'Nur im Gespraech')
  await t.share(A.token, beiFigur.id)
  await t.quest.publish(A.token, beiFigur.id, { rewardItems: [lohn3.id], verify: 'items' })
  st = (await t.read(A.token, beiFigur.id)).state
  st.call.listed = false
  st.call.anbietenNachH = 6
  await t.patch(A.token, beiFigur.id, { state: st })

  liste = await t.quest.near(B.token, { lat: ORT.lat, lon: ORT.lon, radius: 500 })
  t.check('nicht gelisteter Auftrag fehlt in der Region',
    !(liste.data?.quests || []).some(q => q.id === beiFigur.id))

  // Ausschreibung künstlich altern lassen — die Wartezeit ist damit um.
  st = (await t.read(A.token, beiFigur.id)).state
  st.call.publishedAt = new Date(Date.now() - 7 * 3600_000).toISOString()
  await t.patch(A.token, beiFigur.id, { state: st })

  liste = await t.quest.near(B.token, { lat: ORT.lat, lon: ORT.lon, radius: 500 })
  const jetztDa = (liste.data?.quests || []).find(q => q.id === beiFigur.id)
  t.check('nach der Wartezeit steht er in der Liste', !!jetztDa)
  t.check('und ist als "angeboten" markiert', jetztDa?.angeboten === true)

  st = (await t.read(A.token, beiFigur.id)).state
  t.check('der Uebergang wird zurueckgeschrieben',
    st.call.listed === true && st.call.angeboten === true,
    JSON.stringify({ listed: st.call.listed, angeboten: st.call.angeboten }))

  // ── Karma-Bedingung in der Liste ───────────────────────────────────────
  st.call.karma = 4
  await t.patch(A.token, beiFigur.id, { state: st })
  liste = await t.quest.near(B.token, { lat: ORT.lat, lon: ORT.lon, radius: 500 })
  const streng = (liste.data?.quests || []).find(q => q.id === beiFigur.id)
  t.check('zu hohes Karma: sichtbar, aber nicht annehmbar',
    streng && streng.karmaOk === false && streng.canAccept === false,
    JSON.stringify({ ok: streng?.karmaOk, annehmbar: streng?.canAccept }))
}
