// ─────────────────────────────────────────────────────────────────────────
//  Melde-Nähe: `vorOrtRadiusM` und der Nachlass für eine Rundung
// ─────────────────────────────────────────────────────────────────────────
//
// Zwei verschiedene Fragen, die man leicht verwechselt:
//
//   annahmeRadiusM  — wer darf den Auftrag ÜBERNEHMEN
//   vorOrtRadiusM   — was darf als ERLEDIGT gemeldet werden
//
// Ein Auftrag kann weiträumig annehmbar und trotzdem nur am Ort meldbar sein.
//
// Der Nachlass ist keine Milde, sondern eine Korrektur an uns selbst: Bei der
// Freigabe-Stufe „Gegend" runden WIR die Meldung auf 100 m. Ohne Ausgleich läge
// jeder, der ehrlich so meldet, systematisch daneben. Wer „genau" behauptet,
// bekommt ihn nicht — und unterhalb der Feinheits-Schwelle gibt es ihn gar
// nicht, weil eine 50-m-Frage mit 100-m-Rundung nur geraten wäre.

export const name = 'Melde-Nähe'

export async function run(t) {
  const A = await t.user('issuer')
  const B = await t.user('player')

  const auftrag = async (titel, radiusM) => {
    // `objects.name` endet bei 32 Zeichen.
    const lohn = await t.item(A.token, `QTest Lohn ${titel}`)
    await t.carry(A.token, lohn.id)
    const c = await t.call(A.token, titel, 'Melden nur am Ort')
    await t.share(A.token, c.id)
    await t.quest.publish(A.token, c.id, { rewardItems: [lohn.id], verify: 'items' })
    const st = (await t.read(A.token, c.id)).state
    st.call.nachweis = ['vorOrt']
    st.call.vorOrtRadiusM = radiusM
    await t.patch(A.token, c.id, { state: st })
    await t.quest.accept(B.token, c.id)
    return c
  }
  const bei = (m) => ({ lat: 50.4466 + m / 111320, lon: 7.5971 })

  // ── Der eingestellte Radius gilt, nicht die Vorgabe ────────────────────
  const eng = await auftrag('QTest M50', 50)
  let r = await t.quest.complete(B.token, eng.id, { proof: { at: { ...bei(120), precise: true } } })
  t.check('120 m sind bei eingestellten 50 m zu weit', r.status === 400, 'HTTP ' + r.status)
  t.check('und die Grenze steht in der Meldung', /erlaubt sind 50 m/.test((r.data?.missing || [])[0] || ''),
    JSON.stringify(r.data?.missing))

  r = await t.quest.complete(B.token, eng.id, { proof: { at: { ...bei(30), precise: true } } })
  t.check('30 m gehen', r.status === 200, 'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  // ── Nachlass nur für die grobe Angabe, nur oberhalb der Schwelle ───────
  const weit = await auftrag('QTest M500g', 500)
  r = await t.quest.complete(B.token, weit.id, { proof: { at: { ...bei(600), precise: false } } })
  t.check('600 m bei 500 m gehen mit gerundeter Angabe durch', r.status === 200,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))

  const weitGenau = await auftrag('QTest M500e', 500)
  r = await t.quest.complete(B.token, weitGenau.id, { proof: { at: { ...bei(600), precise: true } } })
  t.check('wer „genau" behauptet, bekommt keinen Nachlass', r.status === 400, 'HTTP ' + r.status)

  const engGrob = await auftrag('QTest M50g', 50)
  r = await t.quest.complete(B.token, engGrob.id, { proof: { at: { ...bei(120), precise: false } } })
  t.check('unter 500 m gibt es auch für grobe Angaben keinen Nachlass', r.status === 400,
    'HTTP ' + r.status)

  // ── Ohne eigene Angabe gilt die Server-Vorgabe (150 m) ─────────────────
  const vorgabe = await auftrag('QTest MVorgabe', 0)
  r = await t.quest.complete(B.token, vorgabe.id, { proof: { at: { ...bei(120), precise: true } } })
  t.check('ohne eingestellten Radius gelten 150 m', r.status === 200,
    'HTTP ' + r.status + ' ' + (r.data?.error || ''))
}
