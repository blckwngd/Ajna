// Gastkonten (users.guest) — was der Server beim Anlegen ohne Anmeldung zusichert.
//
// Sicherheitsrelevant an zwei Stellen: `users.email` ist seit Migration
// 1788100000 collection-weit optional — die Adresspflicht für Nicht-Gäste
// hält allein der Hook. Und `guest` ist eine Aussage des SERVERS über ein
// Konto: Könnte ein Konto es selbst auf false setzen, wäre ein Gast auf einen
// Schlag ein „echtes" Konto ohne bewiesene Adresse.
//
// Die Einstellungs-Fälle (signup.require_email, signup.guests) brauchen
// Superuser-Zugang (AJNA_TEST_SU / AJNA_TEST_SU_PW); ohne ihn überspringen sie
// sich ausdrücklich — lieber eine benannte Lücke als ein Test, der so tut.

export const name = 'Gastkonten'

export async function run(t) {
  const { req } = await import('../_harness.mjs')
  const PW = 'gtest-pw-12345'
  const tag = Date.now().toString(36)
  const eigene = []   // selbst angelegte Konten — hinterher weg
  const anlegen = (body, token) => req('/api/collections/users/records', { method: 'POST', token, body })
  const login = async (identity) => {
    const r = await req('/api/collections/users/auth-with-password', { method: 'POST', body: { identity, password: PW } })
    if (r.data?.token) eigene.push({ id: r.data.record.id, token: r.data.token })
    return r
  }

  // ── anonym mit Adresse: Gast, unverifiziert ────────────────────────────
  const a = await anlegen({ email: `gtest-${tag}-a@example.invalid`, password: PW, passwordConfirm: PW, name: `gtest-${tag}-a` })
  t.check('anonym angelegt → 200', a.status === 200, `status ${a.status} ${JSON.stringify(a.data?.data || '')}`)
  t.check('… ist Gast (guest = true)', a.data?.guest === true, `guest=${a.data?.guest}`)
  t.check('… nicht verifiziert', a.data?.verified === false, `verified=${a.data?.verified}`)
  const la = await login(`gtest-${tag}-a@example.invalid`)
  t.check('… Login mit Adresse', la.status === 200 && !!la.data?.token, `status ${la.status}`)

  // ── der Client kann sich nicht selbst „echt" nennen ────────────────────
  if (la.data?.token) {
    const p = await req(`/api/collections/users/records/${la.data.record.id}`,
      { method: 'PATCH', token: la.data.token, body: { guest: false } })
    t.check('guest:false vom Client → bleibt Gast', p.status === 200 && p.data?.guest === true,
      `status ${p.status} guest=${p.data?.guest}`)
  }

  // ── ohne Namen: erzeugter Handle, auch als username ────────────────────
  const b = await anlegen({ email: `gtest-${tag}-b@example.invalid`, password: PW, passwordConfirm: PW })
  t.check('ohne Namen → Handle gast-…', b.status === 200 && /^gast-[a-z0-9]{6}$/.test(b.data?.name || ''),
    `status ${b.status} name=${b.data?.name}`)
  t.check('… username = Handle', b.status === 200 && b.data?.username === b.data?.name, `username=${b.data?.username}`)
  await login(`gtest-${tag}-b@example.invalid`)

  // ── ohne Adresse bei Vorgabe (require_email = true) → 403 mit Code ─────
  const c = await anlegen({ password: PW, passwordConfirm: PW, name: `gtest-${tag}-c` })
  t.check('ohne Adresse (Vorgabe) → 403 guest_email_required',
    c.status === 403 && c.data?.data?.signup?.code === 'guest_email_required',
    `status ${c.status} ${JSON.stringify(c.data?.data || c.data?.message)}`)

  // ── angemeldet angelegt: kein Gast → Adresse Pflicht ───────────────────
  const echt = await t.user('echt')
  const f = await anlegen({ password: PW, passwordConfirm: PW, name: `gtest-${tag}-f` }, echt.token)
  t.check('angemeldet ohne Adresse → 400 (kein Gast)', f.status === 400 && f.data?.data?.email?.code === 'validation_required',
    `status ${f.status} ${JSON.stringify(f.data?.data || '')}`)

  // ── Einstellungen (nur mit Superuser-Zugang) ───────────────────────────
  if (await t.setzeEinstellung('signup.require_email', false)) {
    const d = await anlegen({ password: PW, passwordConfirm: PW, name: `gtest-${tag}-d` })
    t.check('require_email=false: ohne Adresse erlaubt', d.status === 200 && d.data?.guest === true, `status ${d.status}`)
    const ld = await login(`gtest-${tag}-d`)
    t.check('… Login per username', ld.status === 200 && !!ld.data?.token, `status ${ld.status}`)
    const reset = await req('/api/collections/users/request-password-reset', { method: 'POST', body: { email: '' } })
    t.check('… Passwort-Reset ohne Adresse → 400', reset.status === 400, `status ${reset.status}`)
    await t.setzeEinstellung('signup.require_email', true)

    if (await t.setzeEinstellung('signup.guests', false)) {
      const e = await anlegen({ email: `gtest-${tag}-e@example.invalid`, password: PW, passwordConfirm: PW, name: `gtest-${tag}-e` })
      t.check('signup.guests=false → 403 guest_signup_disabled',
        e.status === 403 && e.data?.data?.signup?.code === 'guest_signup_disabled', `status ${e.status}`)
      await t.setzeEinstellung('signup.guests', true)
    }
  } else {
    console.log('   ⏭  Einstellungs-Fälle übersprungen (AJNA_TEST_SU / AJNA_TEST_SU_PW nicht gesetzt)')
  }

  for (const k of eigene) await req(`/api/collections/users/records/${k.id}`, { method: 'DELETE', token: k.token })
}
