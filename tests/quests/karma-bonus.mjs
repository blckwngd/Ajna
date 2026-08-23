// Karma: Abschluss und Abnahme werden getrennt gutgeschrieben.
//
// ANLASS: Vorher gab es pauschal 5 Punkte, egal ob der Server rechnete oder ein
// Mensch nachsah. Die Stichprobe konnte damit nur wehtun — und was nur wehtun
// kann, wird gemieden. Jetzt: 2 Punkte fürs Erledigen, 3 weitere, wenn jemand
// abgenommen hat. In Summe bleibt der geprüfte Weg bei 5, niemand steht
// schlechter da als vorher.
//
// Ausdrücklich NICHT geprüft, weil es das nicht gibt: ein Abzug für eine
// abgelehnte Abnahme. Eine Ablehnung ist kein Verstoß, und eine Prüfgruppe soll
// kein Druckmittel in der Hand halten.

export const name = 'Karma: Abschluss und Abnahme getrennt'

const ABSCHLUSS = 2
const BONUS = 3
const PRUEFER = 1

export async function run(t) {
  const A = await t.user('issuer')
  const B = await t.user('player')
  const P = await t.user('pruefer')

  const karma = async (u) => Number((await t.readUser(u.token, u.id))?.karma_points) || 0

  const auftrag = async (name, verify, extra = {}) => {
    const lohn = await t.item(A.token, 'QTest Karmalohn ' + name)
    await t.carry(A.token, lohn.id)
    const call = await t.call(A.token, 'QTest ' + name, 'Etwas tun')
    await t.share(A.token, call.id)
    await t.quest.publish(A.token, call.id, { rewardItems: [lohn.id], verify, ...extra })
    return call
  }

  // ── Der Server rechnet: kein Bonus ─────────────────────────────────────
  let vorher = await karma(B)
  let call = await auftrag('Uebergabe', 'items')
  await t.quest.accept(B.token, call.id)
  let r = await t.quest.complete(B.token, call.id)
  t.check('Übergabe schliesst sofort ab', r.status === 200, 'HTTP ' + r.status)
  let nachher = await karma(B)
  t.check(`Server-Prüfung bringt ${ABSCHLUSS} Punkte`, nachher - vorher === ABSCHLUSS,
    'Differenz=' + (nachher - vorher))

  // ── Der Aussteller nimmt ab: Abschluss + Bonus ─────────────────────────
  vorher = await karma(B)
  const vorherA = await karma(A)
  call = await auftrag('Stichprobe', 'issuer')
  await t.quest.accept(B.token, call.id)
  r = await t.quest.complete(B.token, call.id)
  t.check('Stichprobe geht in die Abnahme', r.status === 202, 'HTTP ' + r.status)
  t.check('vor der Abnahme gibt es noch nichts', (await karma(B)) === vorher,
    'Karma=' + (await karma(B)))
  r = await t.quest.approve(A.token, call.id)
  t.check('Abnahme geht', r.status === 200, 'HTTP ' + r.status)
  nachher = await karma(B)
  t.check(`abgenommen bringt ${ABSCHLUSS + BONUS} Punkte`, nachher - vorher === ABSCHLUSS + BONUS,
    'Differenz=' + (nachher - vorher))
  t.check('und damit so viel wie früher pauschal', ABSCHLUSS + BONUS === 5)
  t.check('der Aussteller bekommt für die eigene Abnahme nichts',
    (await karma(A)) === vorherA, 'Differenz=' + ((await karma(A)) - vorherA))

  // ── Ablehnen kostet nichts ─────────────────────────────────────────────
  vorher = await karma(B)
  call = await auftrag('Abgelehnt', 'issuer')
  await t.quest.accept(B.token, call.id)
  await t.quest.complete(B.token, call.id)
  r = await t.quest.reject(A.token, call.id, { reason: 'So nicht' })
  t.check('Ablehnen geht', r.status === 200, 'HTTP ' + r.status)
  t.check('eine abgelehnte Abnahme kostet kein Karma', (await karma(B)) === vorher,
    'Differenz=' + ((await karma(B)) - vorher))

  // Nachbessern bringt danach die volle Gutschrift — die Ablehnung war kein
  // Makel, nur eine Zwischenstation.
  r = await t.quest.complete(B.token, call.id)
  t.check('nachbessern ist möglich', r.status === 202, 'HTTP ' + r.status)
  await t.quest.approve(A.token, call.id)
  t.check('und bringt dann die volle Gutschrift',
    (await karma(B)) - vorher === ABSCHLUSS + BONUS, 'Differenz=' + ((await karma(B)) - vorher))

  // ── Prüfgruppe: der Prüfer bekommt auch etwas ──────────────────────────
  const g = await t.raw('/api/collections/groups/records', {
    method: 'POST', token: A.token,
    body: { name: 'QTest Karmagruppe', owner: A.id, members: [P.id] },
  })
  vorher = await karma(B)
  const vorherP = await karma(P)
  call = await auftrag('Gruppe', 'group', { pruefgruppe: g.data.id })
  await t.quest.accept(B.token, call.id)
  await t.quest.complete(B.token, call.id)
  r = await t.quest.approve(P.token, call.id)
  t.check('die Gruppe darf abnehmen', r.status === 200, 'HTTP ' + r.status)
  t.check('der Bearbeiter bekommt Abschluss und Bonus',
    (await karma(B)) - vorher === ABSCHLUSS + BONUS, 'Differenz=' + ((await karma(B)) - vorher))
  t.check(`der Prüfer bekommt ${PRUEFER} Punkt`, (await karma(P)) - vorherP === PRUEFER,
    'Differenz=' + ((await karma(P)) - vorherP))

  // ── Schwarm ────────────────────────────────────────────────────────────
  vorher = await karma(B)
  const vorherP2 = await karma(P)
  call = await auftrag('Schwarm', 'crowd')
  let st = (await t.read(A.token, call.id)).state
  st.call.schwarmZahl = 1
  await t.patch(A.token, call.id, { state: st })
  await t.quest.accept(B.token, call.id)
  await t.quest.complete(B.token, call.id)
  r = await t.quest.confirm(P.token, call.id, { verdict: 'ok' })
  t.check('eine Stimme entscheidet', r.status === 200, 'HTTP ' + r.status)
  t.check('auch der Schwarm ist eine menschliche Abnahme',
    (await karma(B)) - vorher === ABSCHLUSS + BONUS, 'Differenz=' + ((await karma(B)) - vorher))
  t.check('wer abstimmt, bekommt ebenfalls einen Punkt',
    (await karma(P)) - vorherP2 === PRUEFER, 'Differenz=' + ((await karma(P)) - vorherP2))
}
