// Schwarm-Abnahme: andere Spieler bestätigen eine Einreichung.
//
// Der Kern, der geprüft werden muss: Der Schwarm entscheidet nur, OB die
// Bedingung erfüllt ist. Ausgezahlt wird vom Server, mit derselben
// Deckungsprüfung wie überall — sonst könnten drei Freunde eine Belohnung
// beschließen, die es gar nicht gibt.
//
// Ebenso wichtig: Wer nicht abstimmen darf. Einreicher und Aussteller sind
// Partei, nicht Schiedsrichter.

export const name = 'Schwarm-Abnahme'

export async function run(t) {
  const A = await t.user('issuer')     // Aussteller
  const B = await t.user('player')     // Bearbeiter
  const C = await t.user('voter1')
  const D = await t.user('voter2')

  const lohn = await t.item(A.token, 'QTest Schwarmlohn')
  await t.carry(A.token, lohn.id)
  const call = await t.call(A.token, 'QTest Schwarm', 'Müll sammeln')
  await t.share(A.token, call.id)
  await t.quest.publish(A.token, call.id, { rewardItems: [lohn.id], verify: 'crowd' })

  // Zwei Ja-Stimmen sollen reichen.
  let st = (await t.read(A.token, call.id)).state
  st.call.schwarmZahl = 2
  await t.patch(A.token, call.id, { state: st })

  await t.quest.accept(B.token, call.id)
  let r = await t.quest.complete(B.token, call.id)
  t.check('Melden führt in die Abnahme statt zur Auszahlung', r.status === 202,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))
  t.check('Einreichung bekommt eine Kennung', !!r.data?.submission)
  t.check('nötige Stimmen werden mitgeteilt', r.data?.votesNeeded === 2, 'n=' + r.data?.votesNeeded)
  const sub1 = r.data.submission

  // Belohnung ist noch nicht gewandert.
  let l = await t.read(A.token, lohn.id)
  t.check('vor der Abnahme bleibt die Belohnung beim Aussteller', l?.carried_by === A.id)

  // ── Wer nicht abstimmen darf ────────────────────────────────────────────
  r = await t.quest.confirm(B.token, call.id)
  t.check('der Einreicher bestätigt sich nicht selbst', r.status === 403, 'HTTP ' + r.status)
  r = await t.quest.confirm(A.token, call.id)
  t.check('der Aussteller ist nicht Teil des Schwarms', r.status === 403, 'HTTP ' + r.status)

  // ── Erste Stimme: Zwischenstand ─────────────────────────────────────────
  r = await t.quest.confirm(C.token, call.id, { verdict: 'ok' })
  t.check('erste Stimme wird gezählt', r.status === 200 && r.data?.yes === 1,
    'HTTP ' + r.status + ' ja=' + r.data?.yes)
  t.check('noch nicht entschieden', r.data?.decided === false)

  r = await t.quest.confirm(C.token, call.id, { verdict: 'ok' })
  t.check('zweimal abstimmen geht nicht', r.status === 409, 'HTTP ' + r.status)

  l = await t.read(A.token, lohn.id)
  t.check('eine Stimme zahlt noch nicht aus', l?.carried_by === A.id)

  // ── Zweite Stimme: entschieden und ausgezahlt ───────────────────────────
  r = await t.quest.confirm(D.token, call.id, { verdict: 'ok' })
  t.check('zweite Stimme entscheidet', r.data?.decided === true && r.data?.approved === true,
    JSON.stringify({ decided: r.data?.decided, approved: r.data?.approved }))
  t.check('und der Server zahlt aus', r.data?.payout === true)
  l = await t.read(B.token, lohn.id)
  t.check('Belohnung liegt beim Bearbeiter', l?.carried_by === B.id, 'carried_by=' + l?.carried_by)
  t.check('Bearbeiter bekommt Karma', Number(r.data?.karma) > 0, 'karma=' + r.data?.karma)

  const cNach = await t.readUser(C.token, C.id)
  t.check('wer abnimmt, bekommt ebenfalls etwas', Number(cNach?.karma_points || 0) > 0,
    'karma=' + cNach?.karma_points)

  // ── Ablehnung schickt zurück zum Bearbeiter ─────────────────────────────
  const lohn2 = await t.item(A.token, 'QTest Schwarmlohn 2')
  await t.carry(A.token, lohn2.id)
  const call2 = await t.call(A.token, 'QTest Schwarm Nein', 'Nicht sauber genug')
  await t.share(A.token, call2.id)
  await t.quest.publish(A.token, call2.id, { rewardItems: [lohn2.id], verify: 'crowd' })
  st = (await t.read(A.token, call2.id)).state
  st.call.schwarmZahl = 2
  await t.patch(A.token, call2.id, { state: st })
  await t.quest.accept(B.token, call2.id)
  const e2 = await t.quest.complete(B.token, call2.id)

  await t.quest.confirm(C.token, call2.id, { verdict: 'nein', note: 'Da liegt noch was' })
  r = await t.quest.confirm(D.token, call2.id, { verdict: 'nein' })
  t.check('genug Nein-Stimmen entscheiden ebenfalls', r.data?.decided === true && r.data?.approved === false)
  st = (await t.read(A.token, call2.id)).state
  t.check('Auftrag bleibt beim Bearbeiter statt frei zu werden', st.call.status === 'claimed',
    'status=' + st.call.status)
  t.check('mit Begründung', /abgelehnt/.test(st.call.rejectReason || ''))
  const l2 = await t.read(A.token, lohn2.id)
  t.check('nichts ausgezahlt', l2?.carried_by === A.id)

  // ── Neue Einreichung: alte Stimmen zählen nicht mehr ────────────────────
  r = await t.quest.complete(B.token, call2.id)
  t.check('erneutes Melden bekommt eine NEUE Kennung',
    !!r.data?.submission && r.data.submission !== e2.data?.submission)
  r = await t.quest.confirm(C.token, call2.id, { verdict: 'ok' })
  t.check('derselbe Prüfer darf im neuen Durchgang wieder abstimmen', r.status === 200,
    'HTTP ' + r.status)
  t.check('und der Zähler beginnt von vorn', r.data?.yes === 1 && r.data?.no === 0,
    JSON.stringify({ ja: r.data?.yes, nein: r.data?.no }))
}
