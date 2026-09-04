// Probelauf, Superuser-Gruppe und der Gegenstand als Schlüssel.
//
// DREI FRAGEN, DIE ZUSAMMENGEHÖREN:
//
//   1. Wer eine Aufgabe schreibt, will sie zuerst selbst ausprobieren. Dafür
//      gibt es den PROBELAUF: nur für den Autor sichtbar, durchspielbar wie ein
//      echter — aber es fließt nichts, bei niemandem. Damit gibt es auch nichts
//      zu missbrauchen.
//   2. Den eigenen ECHTEN Auftrag zu erledigen ist dagegen gesperrt. Die
//      Ausnahme ist ein Superuser-Recht.
//   3. Dieses Recht hängt entweder an der Gruppe „Superusers" oder an einem
//      GETRAGENEN GEGENSTAND. Der ist übertragbar — wer ihn weitergibt, gibt
//      das Recht mit.
//
// Geprüft wird gegen die echten Routen. Ein Recht, das nur der Client kennt,
// wäre keines.

export const name = 'Probelauf und Superuser'

async function auftrag(t, A, titel, extra = {}) {
  const lohn = await t.item(A.token, `QTest PL ${titel}`)
  await t.carry(A.token, lohn.id)
  const c = await t.call(A.token, titel, 'Zum Ausprobieren')
  await t.share(A.token, c.id)
  await t.quest.publish(A.token, c.id, { rewardItems: [lohn.id], verify: 'items' })
  if (Object.keys(extra).length) {
    const st = (await t.read(A.token, c.id)).state
    Object.assign(st.call, extra)
    await t.patch(A.token, c.id, { state: st })
  }
  return c
}

export async function run(t) {
  const A = await t.user('autor')
  const B = await t.user('andere')

  // ── Der eigene ECHTE Auftrag ist gesperrt ──────────────────────────────
  const echt = await auftrag(t, A, 'QTest PL Echt')
  let r = await t.quest.accept(A.token, echt.id)
  t.check('den eigenen Auftrag annehmen wird abgelehnt', r.status === 403, 'HTTP ' + r.status)
  t.check('mit eigenem Code', r.data?.code === 'own_call_not_allowed', r.data?.code)

  // Die Grenze liegt beim Abschluss — wer die Annahme umgeht, kommt trotzdem
  // nicht durch. Dafür den Anspruch von Hand setzen, wie es ein Angreifer täte.
  let st = (await t.read(A.token, echt.id)).state
  st.call.status = 'claimed'; st.call.claimedBy = A.id
  await t.patch(A.token, echt.id, { state: st })
  r = await t.quest.complete(A.token, echt.id)
  t.check('auch am Annehmen vorbei ist beim Abschluss Schluss', r.status === 403,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  // ── Als Probelauf geht es ──────────────────────────────────────────────
  const probe = await auftrag(t, A, 'QTest PL Probe', { probelauf: true })
  r = await t.quest.accept(A.token, probe.id)
  t.check('ein Probelauf lässt sich selbst annehmen', r.status === 200,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))
  const vorher = Number((await t.readUser(A.token, A.id))?.karma_points) || 0
  r = await t.quest.complete(A.token, probe.id)
  t.check('und abschliessen', r.status === 200, 'HTTP ' + r.status + ' ' + (r.data?.error || ''))
  const nachher = Number((await t.readUser(A.token, A.id))?.karma_points) || 0
  t.check('ohne dass Karma fliesst', nachher === vorher, `vorher ${vorher}, nachher ${nachher}`)

  // ── OHNE Veroeffentlichen durchspielbar ────────────────────────────────
  //
  // GEMELDET: „Ich kann die Quest nach wie vor nicht annehmen." Ursache war
  // eine Kette aus zwei Huerden, die beide fuer einen Probelauf keinen Sinn
  // ergeben: Ein nicht veroeffentlichter Auftrag ist ein ENTWURF (im Fenster
  // ohne Knoepfe), und `resolveSwap` verlangte eine hinterlegte Belohnung.
  // Veroeffentlichen tut aber genau zweierlei — Belohnung binden und den
  // Auftrag sichtbar machen —, und ein Probelauf will beides nicht.
  const roh = await t.call(A.token, 'QTest PL Roh', 'Nie veroeffentlicht')
  let st2 = (await t.read(A.token, roh.id)).state
  st2.call = { ...(st2.call || {}), probelauf: true, verify: 'items' }
  await t.patch(A.token, roh.id, { state: st2 })

  r = await t.quest.accept(A.token, roh.id)
  t.check('ein nicht veröffentlichter Probelauf lässt sich annehmen', r.status === 200,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))
  r = await t.quest.complete(A.token, roh.id)
  t.check('und abschliessen — ganz ohne Treuhand', r.status === 200,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  // Die Bedingungen gelten weiter: Genau dafuer probt man ja.
  const mitForderung = await t.call(A.token, 'QTest PL Forderung', 'Bring ein Einhorn')
  let st3 = (await t.read(A.token, mitForderung.id)).state
  st3.call = { ...(st3.call || {}), probelauf: true, verify: 'items',
               requires: [{ match: { name: 'Einhorn' }, count: 1 }] }
  await t.patch(A.token, mitForderung.id, { state: st3 })
  await t.quest.accept(A.token, mitForderung.id)
  r = await t.quest.complete(A.token, mitForderung.id)
  t.check('geforderte Gegenstände prüft er trotzdem', r.status === 409,
    (r.data?.error || '').slice(0, 40))

  // Ein ECHTER Auftrag ohne Treuhand bleibt dagegen abgelehnt — der Nachlass
  // gilt nur fuer den Probelauf.
  const ohneTreuhand = await t.call(A.token, 'QTest PL Ohne', 'Nichts hinterlegt')
  await t.share(A.token, ohneTreuhand.id)
  let st4 = (await t.read(A.token, ohneTreuhand.id)).state
  st4.call = { ...(st4.call || {}), verify: 'items', status: 'claimed', claimedBy: B.id }
  await t.patch(A.token, ohneTreuhand.id, { state: st4 })
  r = await t.quest.complete(B.token, ohneTreuhand.id)
  t.check('ein echter Auftrag braucht weiterhin eine Treuhand', r.status === 409,
    (r.data?.error || '').slice(0, 40))

  // ── Und niemand sonst sieht ihn ────────────────────────────────────────
  const sichtA = await t.quest.near(A.token, {})
  const sichtB = await t.quest.near(B.token, {})
  const drin = (liste, id) => (liste || []).some(q => q.id === id)
  t.check('der Autor sieht seinen Probelauf', drin(sichtA.data?.quests, probe.id))
  t.check('ein anderer Spieler nicht', !drin(sichtB.data?.quests, probe.id))
  // Gegenprobe: Am echten Auftrag liegt es nicht — der ist für B sichtbar.
  t.check('einen echten Auftrag sieht er sehr wohl', drin(sichtB.data?.quests, echt.id))

  // ── Superuser über einen getragenen Gegenstand ─────────────────────────
  //
  // Der Schlüssel ist eine konkrete Objekt-ID in `settings.superuser.items`.
  // Eine Gattung wäre fälschbar: Namen darf jeder vergeben, IDs nicht.
  const stab = await t.item(A.token, 'QTest Prueferstab')
  const gesetzt = await t.setzeEinstellung('superuser.items', [stab.id])
  if (!gesetzt) {
    // ÜBERSPRUNGEN, NICHT FEHLGESCHLAGEN. `settings` ist nur für die Verwaltung
    // schreibbar; ohne AJNA_TEST_SU/_PW lässt sich der Schlüssel nicht setzen.
    // Das ist eine fehlende Voraussetzung, kein Defekt — ein roter Punkt dafür
    // würde die Suite dauerhaft rot färben und damit wertlos machen.
    t.check('Schlüssel-Gegenstand übersprungen (keine Verwaltungs-Zugangsdaten)', true,
      'mit AJNA_TEST_SU/_PW läuft dieser Teil mit')
    return
  }

  const echt2 = await auftrag(t, A, 'QTest PL Echt2')
  r = await t.quest.accept(A.token, echt2.id)
  t.check('ohne den Stab in der Hand bleibt es gesperrt', r.status === 403, 'HTTP ' + r.status)

  await t.carry(A.token, stab.id)          // aufnehmen → carried_by = A
  r = await t.quest.accept(A.token, echt2.id)
  t.check('mit dem Stab in der Hand geht es', r.status === 200,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  // Übertragbar: abgelegt ist das Recht weg. Genau das unterscheidet einen
  // Gegenstand von einem Gruppen-Eintrag.
  await t.place(A.token, stab.id)          // hinlegen → carried_by = ""
  const echt3 = await auftrag(t, A, 'QTest PL Echt3')
  r = await t.quest.accept(A.token, echt3.id)
  t.check('abgelegt ist das Recht wieder weg', r.status === 403, 'HTTP ' + r.status)

  // Und er wirkt nur für seinen Träger: B hat ihn nie gehabt.
  const echtB = await auftrag(t, B, 'QTest PL EchtB')
  r = await t.quest.accept(B.token, echtB.id)
  t.check('ein fremdes Konto profitiert nicht vom Stab', r.status === 403, 'HTTP ' + r.status)
}
