// „Auftrag nur vor Ort annehmen" — die Schranke muss SERVERSEITIG greifen.
//
// Sonst ist sie Dekoration: Der Client entscheidet dann selbst, ob er den Knopf
// zeigt, und wer die Route direkt aufruft, nimmt den Auftrag vom Sofa aus an.
//
// WAS DAS IST UND WAS NICHT: eine Plausibilitätsschranke, kein Nachweis. Die
// Position kommt vom Gerät des Bearbeiters — er kann sie erfinden, genau wie
// bei POST /api/proximity. Der Zweck trägt trotzdem: Sie verhindert, dass
// jemand alle Aufträge der Stadt reserviert und liegen lässt. Wer dafür seine
// Koordinaten fälscht, hat die Schranke mit Absicht umgangen; das ist eine
// andere Frage als die, gegen die sie gebaut ist.
//
// Der Auftrag liegt bei 50.4466 / 7.5971 (siehe t.call).

export const name = 'Nur vor Ort annehmen'

/** Punkt in `m` Metern nördlich vom Auftrag. */
const noerdlich = (m) => ({ lat: 50.4466 + m / 111320, lon: 7.5971 })

/** Auftrag mit Annahme-Radius anlegen und ausschreiben. */
async function auftragMit(t, A, titel, radiusM) {
  const lohn = await t.item(A.token, `QTest Lohn ${titel}`)
  await t.carry(A.token, lohn.id)
  const c = await t.call(A.token, titel, 'Vor Ort annehmen')
  await t.share(A.token, c.id)
  await t.quest.publish(A.token, c.id, { rewardItems: [lohn.id], verify: 'items' })
  const st = (await t.read(A.token, c.id)).state
  st.call.annahmeRadiusM = radiusM
  await t.patch(A.token, c.id, { state: st })
  return c
}

export async function run(t) {
  const A = await t.user('issuer')
  const B = await t.user('player')

  // ── Ohne Auflage bleibt alles wie bisher ───────────────────────────────
  //
  // Das ist die wichtigste Prüfung des ganzen Falls: Es gibt Aufträge in der
  // Datenbank, die dieses Feld nie gesehen haben. Würden die plötzlich eine
  // Position verlangen, wäre die Auftragsliste über Nacht unbenutzbar.
  const frei = await auftragMit(t, A, 'QTest Ohne Auflage', 0)
  let r = await t.quest.accept(B.token, frei.id)
  t.check('ein Auftrag ohne Annahme-Radius geht wie immer', r.status === 200, 'HTTP ' + r.status)

  // ── Mit Auflage: ohne Position kein Anspruch ───────────────────────────
  const eng = await auftragMit(t, A, 'QTest Vor Ort', 250)
  r = await t.quest.accept(B.token, eng.id)
  t.check('ohne mitgeschickten Standort wird abgelehnt', r.status === 403, 'HTTP ' + r.status)
  t.check('und zwar mit eigenem Code, nicht mit einem übersetzten Satz',
    r.data?.code === 'accept_needs_position', r.data?.code)
  t.check('die geforderte Nähe steht in der Antwort', r.data?.maxDistanceM === 250,
    'maxDistanceM=' + r.data?.maxDistanceM)

  let st = (await t.read(A.token, eng.id)).state
  t.check('der Auftrag bleibt dabei unangetastet',
    st.call.status === 'open' && !st.call.claimedBy, 'status=' + st.call.status)

  // ── Zu weit weg ────────────────────────────────────────────────────────
  r = await t.quest.accept(B.token, eng.id, { at: noerdlich(2000) })
  t.check('aus 2 km Entfernung geht es nicht', r.status === 403, 'HTTP ' + r.status)
  t.check('mit dem Code für „zu weit"', r.data?.code === 'accept_too_far', r.data?.code)
  t.check('und der gemessenen Entfernung', Number(r.data?.distanceM) > 1500,
    'distanceM=' + r.data?.distanceM)

  // ── Nah genug ──────────────────────────────────────────────────────────
  r = await t.quest.accept(B.token, eng.id, { at: noerdlich(100) })
  t.check('aus 100 m Entfernung geht es', r.status === 200, 'HTTP ' + r.status + ' ' + (r.data?.error || ''))
  st = (await t.read(A.token, eng.id)).state
  t.check('und der Auftrag ist danach vergeben', st.call.claimedBy === B.id)

  // ── Stufe „Nähe": die Antwort ohne den Ort ─────────────────────────────
  //
  // Bei dieser Freigabe hat der Client gar keine Koordinaten zu senden. Er
  // rechnet den Umkreis selbst und meldet nur das Ergebnis — genauso belastbar
  // wie eine gesendete Koordinate (beide kommen von ihm), aber ohne einen Ort
  // preiszugeben.
  const nah1 = await auftragMit(t, A, 'QTest Nähe Ja', 250)
  r = await t.quest.accept(B.token, nah1.id, { nah: true })
  t.check('„ich bin im Umkreis" genügt — ganz ohne Koordinate', r.status === 200,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  const nah2 = await auftragMit(t, A, 'QTest Nähe Nein', 250)
  r = await t.quest.accept(B.token, nah2.id, { nah: false })
  t.check('ein ehrliches „ich bin nicht da" wird abgelehnt', r.status === 403, 'HTTP ' + r.status)
  t.check('als „zu weit", nicht als fehlende Position', r.data?.code === 'accept_too_far', r.data?.code)

  // ── Rundungs-Kulanz nur bei weiten Radien ──────────────────────────────
  //
  // Ab 500 m darf die Stufe „Gegend" mitmachen, und die rundet auf 100 m. Ohne
  // Kulanz läge jeder, der so meldet, systematisch daneben — und zwar gerade an
  // der Grenze, wo es darauf ankommt.
  const weit = await auftragMit(t, A, 'QTest Gegend', 600)
  r = await t.quest.accept(B.token, weit.id, { at: noerdlich(700) })
  t.check('600-m-Auftrag verzeiht 700 m (Rundung der Stufe „Gegend")', r.status === 200,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  const weit2 = await auftragMit(t, A, 'QTest Gegend Fern', 600)
  r = await t.quest.accept(B.token, weit2.id, { at: noerdlich(900) })
  t.check('aber 900 m sind auch mit Kulanz zu viel', r.status === 403, 'HTTP ' + r.status)

  // ── Reihenfolge der Ablehnungen ────────────────────────────────────────
  //
  // Karma zuerst, Ort zuletzt: Wer das Karma nicht hat, soll nicht erst
  // hinlaufen und dort erfahren, dass es ohnehin nichts wird.
  const karma = await auftragMit(t, A, 'QTest Karma Und Ort', 250)
  st = (await t.read(A.token, karma.id)).state
  st.call.karma = 5
  await t.patch(A.token, karma.id, { state: st })
  r = await t.quest.accept(B.token, karma.id, { at: noerdlich(5000) })
  t.check('fehlendes Karma wird vor der Entfernung gemeldet',
    r.status === 403 && /karma/i.test(r.data?.error || ''), r.data?.error)
}
