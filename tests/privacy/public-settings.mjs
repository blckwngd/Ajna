// Öffentliche Einstellungen (View `public_settings`) — was ohne Login lesbar
// ist, und was nicht.
//
// Sicherheitsrelevant, weil die View bewusst OFFEN ist: Sie ist der einzige
// Weg, über den jemand ohne Konto irgendetwas aus `settings` sieht. Zugesichert
// sein muss: Nur Datensätze mit public = true erscheinen, `settings` selbst
// gibt Anonymen weiterhin nichts, und über die View lässt sich nichts
// schreiben. Und: Die beiden Schlüssel, für die es die View gibt (signup.*),
// sind tatsächlich veröffentlicht — sonst liefe jedes Anmeldeformular auf
// seine eigene Vorgabe statt auf die Regel der Instanz.
//
// Die Markier-Fälle brauchen Superuser-Zugang (AJNA_TEST_SU / AJNA_TEST_SU_PW);
// ohne ihn überspringen sie sich ausdrücklich.

export const name = 'Öffentliche Einstellungen'

export async function run(t) {
  const { req } = await import('../_harness.mjs')
  const tag = Date.now().toString(36)

  // ── ohne Login: View offen, settings gibt nichts her ───────────────────
  const offen = await req('/api/collections/public_settings/records?perPage=100')
  t.check('public_settings ohne Login → 200', offen.status === 200, `status ${offen.status}`)
  const keys = (offen.data?.items || []).map(r => r.key)
  t.check('signup.guests veröffentlicht', keys.includes('signup.guests'), keys.join(', '))
  t.check('signup.require_email veröffentlicht', keys.includes('signup.require_email'))
  const felder = Object.keys(offen.data?.items?.[0] || {})
  t.check('View zeigt weder note noch public', felder.length > 0 && !felder.includes('note') && !felder.includes('public'), felder.join(','))

  // Die Regel von `settings` wirkt bei Listen als Filter: Anonym kommt eine
  // leere Liste (200), nicht 401 — beides heißt „nichts zu sehen".
  const zu = await req('/api/collections/settings/records?perPage=5')
  t.check('settings ohne Login → leer oder abgewiesen',
    zu.status >= 400 || (zu.status === 200 && (zu.data?.items || []).length === 0), `status ${zu.status}, ${zu.data?.items?.length ?? '-'} Treffer`)
  const schreib = await req('/api/collections/public_settings/records', { method: 'POST', body: { key: `ptest.x.${tag}`, value: 1 } })
  t.check('Schreiben über die View → abgewiesen', schreib.status >= 400, `status ${schreib.status}`)

  // ── angemeldet (kein Superuser): View ebenso lesbar ────────────────────
  const user = await t.user('pub')
  const alsUser = await req('/api/collections/public_settings/records?perPage=1', { token: user.token })
  t.check('angemeldet: View lesbar', alsUser.status === 200, `status ${alsUser.status}`)

  // ── Superuser: markieren, zurücknehmen ─────────────────────────────────
  const mail = process.env.AJNA_TEST_SU, pw = process.env.AJNA_TEST_SU_PW
  if (!mail || !pw) { console.log('   ⏭  Markier-Fälle übersprungen (AJNA_TEST_SU / AJNA_TEST_SU_PW nicht gesetzt)'); return }
  const a = await req('/api/collections/_superusers/auth-with-password', { method: 'POST', body: { identity: mail, password: pw } })
  const su = a.data?.token
  if (!t.check('Superuser-Login', !!su, `status ${a.status}`)) return

  const eigene = []
  const kPub = `ptest.public.${tag}`, kGeheim = `ptest.secret.${tag}`
  try {
    const pub = await req('/api/collections/settings/records', { method: 'POST', token: su,
      body: { key: kPub, value: { a: 1, b: 'zwei' }, public: true, note: 'Testlauf' } })
    const geheim = await req('/api/collections/settings/records', { method: 'POST', token: su,
      body: { key: kGeheim, value: 'nicht für alle', note: 'Testlauf' } })
    for (const r of [pub, geheim]) if (r.data?.id) eigene.push(r.data.id)
    t.check('Datensätze angelegt (public / nicht public)', pub.status === 200 && geheim.status === 200, `${pub.status}/${geheim.status}`)

    const filter = encodeURIComponent(`key = "${kPub}" || key = "${kGeheim}"`)
    const liste = await req(`/api/collections/public_settings/records?filter=${filter}`)
    const sicht = Object.fromEntries((liste.data?.items || []).map(r => [r.key, r.value]))
    t.check('public = true → anonym sichtbar, Wert bleibt JSON', JSON.stringify(sicht[kPub]) === JSON.stringify({ a: 1, b: 'zwei' }), JSON.stringify(sicht))
    t.check('public = false → anonym unsichtbar', !(kGeheim in sicht))

    const zurueck = await req(`/api/collections/settings/records/${pub.data?.id}`, { method: 'PATCH', token: su, body: { public: false } })
    const danach = await req(`/api/collections/public_settings/records?filter=${encodeURIComponent(`key = "${kPub}"`)}`)
    t.check('zurückgenommen → sofort weg', zurueck.status === 200 && (danach.data?.items || []).length === 0,
      `status ${zurueck.status}, ${danach.data?.items?.length ?? '-'} Treffer`)
  } finally {
    for (const id of eigene) await req(`/api/collections/settings/records/${id}`, { method: 'DELETE', token: su })
  }
}
