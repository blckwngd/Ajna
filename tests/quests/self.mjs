// Der eigene Auftrag: auch mit Sonderrecht nicht geschenkt.
//
// Diese Suite hiess einmal „Aussteller darf seinen EIGENEN Auftrag
// durchspielen" und pruefte genau das. Seit 2026-09-02 ist es umgekehrt: Der
// eigene Auftrag ist gesperrt (siehe quests/probelauf.mjs), ausser als
// Probelauf oder mit Superuser-Recht.
//
// WAS HIER BLEIBT, IST DIE INTERESSANTERE FRAGE: Wenn jemand die Sperre
// LEGITIM umgeht — als Superuser —, bekommt er dann Karma für seinen eigenen
// Auftrag? Er darf es nicht. Die alte Begruendung „Nullsummenspiel, alles
// wandert von ihm zu ihm" galt naemlich nur fuer GEGENSTAENDE. Karma entsteht
// neu; es ist keine Kosmetik, sondern sperrt ueber `karmaReicht` andere
// Auftraege und steht anderen Spielern als Sterne vor Augen.
//
// Dazu die Gegenprobe: Ein fremder Bearbeiter bekommt sehr wohl etwas — sonst
// haette die Sperre einfach alles abgeschaltet.

export const name = 'Eigener Auftrag: durchspielbar, aber nicht geschenkt'

export async function run(t) {
  const A = await t.user('solo')
  const B = await t.user('fremder')

  // ── Gegenprobe zuerst: der normale Weg zahlt ───────────────────────────
  const lohnB = await t.item(A.token, 'Solo Lohn Fremd')
  await t.carry(A.token, lohnB.id)
  const fuerB = await t.call(A.token, 'Auftrag fuer Fremde', 'Ganz normal')
  await t.share(A.token, fuerB.id)
  await t.quest.publish(A.token, fuerB.id, { rewardItems: [lohnB.id], verify: 'items' })
  await t.quest.accept(B.token, fuerB.id)
  const bVor = Number((await t.readUser(B.token, B.id))?.karma_points) || 0
  let r = await t.quest.complete(B.token, fuerB.id)
  t.check('ein fremder Bearbeiter schliesst ab', r.status === 200,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))
  const lohnNach = await t.read(B.token, lohnB.id)
  t.check('und bekommt die Belohnung', lohnNach?.carried_by === B.id)
  t.check('samt Karma', (Number((await t.readUser(B.token, B.id))?.karma_points) || 0) > bVor)

  // ── Mit Superuser-Recht: erlaubt, aber unbezahlt ───────────────────────
  const stab = await t.item(A.token, 'Solo Schluessel')
  if (!(await t.setzeEinstellung('superuser.items', [stab.id]))) {
    t.check('Superuser-Prüfung übersprungen (keine Verwaltungs-Zugangsdaten)', true,
      'AJNA_TEST_SU/_PW nicht gesetzt')
    return
  }
  await t.carry(A.token, stab.id)

  const lohnA = await t.item(A.token, 'Solo Lohn Eigen')
  await t.carry(A.token, lohnA.id)
  const eigen = await t.call(A.token, 'Eigener Auftrag', 'Mit Sonderrecht')
  await t.quest.publish(A.token, eigen.id, { rewardItems: [lohnA.id], verify: 'items' })

  const aVor = Number((await t.readUser(A.token, A.id))?.karma_points) || 0
  r = await t.quest.accept(A.token, eigen.id)
  t.check('mit Superuser-Recht darf man den eigenen Auftrag annehmen', r.status === 200,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))
  r = await t.quest.complete(A.token, eigen.id)
  t.check('und abschliessen', r.status === 200, 'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  const aNach = Number((await t.readUser(A.token, A.id))?.karma_points) || 0
  t.check('aber Karma gibt es dafür nicht', aNach === aVor, `vorher ${aVor}, nachher ${aNach}`)

  const lohnA2 = await t.read(A.token, lohnA.id)
  t.check('die Belohnung bleibt bei ihm, Treuhand gelöst',
    lohnA2?.carried_by === A.id && !lohnA2?.state?.escrow,
    'escrow=' + JSON.stringify(lohnA2?.state?.escrow || null))

  // ── Auch mit Sonderrecht gilt die Bedingung ────────────────────────────
  const lohnA3 = await t.item(A.token, 'Solo Lohn 3')
  await t.carry(A.token, lohnA3.id)
  const eigen2 = await t.call(A.token, 'Eigener mit Forderung', 'Bring mir ein Einhorn')
  await t.quest.publish(A.token, eigen2.id, {
    rewardItems: [lohnA3.id], requires: [{ match: { name: 'Einhorn' }, count: 1 }], verify: 'items',
  })
  await t.quest.accept(A.token, eigen2.id)
  r = await t.quest.complete(A.token, eigen2.id)
  t.check('ohne erfüllte Bedingung → 409 (kein vorgetäuschter Erfolg)', r.status === 409,
    r.data?.error || ('HTTP ' + r.status))
}
