// Zugang zum Web-Client (GET /api/client-access) — was die Route Caddy
// gegenüber zusichert.
//
// Sicherheitsrelevant, weil Caddy dieser einen Antwort blind folgt: 204 heißt
// ausliefern. Zugesichert sein muss: Ohne Regel ändert sich nichts (everyone →
// 204 für alle); mit Regel bekommt niemand ohne passendes Cookie ein 204, ein
// gewöhnliches Konto nicht bei "superusers", ein Nicht-Mitglied nicht bei
// "group:<Name>" — und ein Superuser immer. Seitenaufrufe landen auf der
// Anmeldeseite (302), alles andere bekommt den Code (401).
//
// Die Regel-Fälle brauchen Superuser-Zugang (AJNA_TEST_SU / AJNA_TEST_SU_PW);
// ohne ihn überspringen sie sich ausdrücklich.

export const name = 'Zugang zum Web-Client'

const PB = process.env.AJNA_TEST_PB || 'http://127.0.0.1:8090'

/** Aufruf wie von Caddys forward_auth: Cookie + Weiterleitungs-Header, optional als Seitenaufruf. */
async function frage({ token = '', seite = false, uri = '/index-map.html', info = false } = {}) {
  const headers = { 'X-Forwarded-Method': 'GET', 'X-Forwarded-Uri': uri }
  if (token) headers.Cookie = `ajna_zugang=${encodeURIComponent(token)}`
  headers.Accept = seite ? 'text/html,application/xhtml+xml' : 'application/json'
  const r = await fetch(`${PB}/api/client-access${info ? '?info=1' : ''}`, { headers, redirect: 'manual' })
  let data = null
  try { data = await r.json() } catch { /* 204/302 ohne Body */ }
  return { status: r.status, location: r.headers.get('location') || '', konto: r.headers.get('x-ajna-konto') || '', data }
}

export async function run(t) {
  const { req } = await import('../_harness.mjs')

  // ── ohne Regel: wie bisher ─────────────────────────────────────────────
  const mail = process.env.AJNA_TEST_SU, pw = process.env.AJNA_TEST_SU_PW
  if (!mail || !pw) {
    const offen = await frage()
    t.check('ohne Superuser-Zugang nur Grundfall: Antwort ist 204 oder 401/302', [204, 302, 401].includes(offen.status), `status ${offen.status}`)
    console.log('   ⏭  Regel-Fälle übersprungen (AJNA_TEST_SU / AJNA_TEST_SU_PW nicht gesetzt)')
    return
  }
  const su = (await req('/api/collections/_superusers/auth-with-password', { method: 'POST', body: { identity: mail, password: pw } })).data?.token
  if (!t.check('Superuser-Login', !!su)) return

  await t.setzeEinstellung('client.access', 'everyone')
  const jeder = await frage()
  t.check('everyone: ohne Cookie → 204', jeder.status === 204, `status ${jeder.status}`)
  const infoJeder = await frage({ info: true })
  t.check('?info=1 nennt die Regel', infoJeder.status === 200 && infoJeder.data?.policy === 'everyone' && infoJeder.data?.ok === true, JSON.stringify(infoJeder.data))

  const user = await t.user('zugang')
  const anderer = await t.user('zugang2')
  try {
    // ── superusers ───────────────────────────────────────────────────────
    await t.setzeEinstellung('client.access', 'superusers')
    const ohne = await frage()
    t.check('superusers: ohne Cookie → 401 client_access_denied', ohne.status === 401 && ohne.data?.code === 'client_access_denied', `status ${ohne.status} ${JSON.stringify(ohne.data)}`)
    const seite = await frage({ seite: true, uri: '/index-map.html?x=1' })
    t.check('superusers: Seitenaufruf → 302 zur Anmeldeseite mit ?weiter=', seite.status === 302 && seite.location.startsWith('/zugang.html?weiter=%2Findex-map.html'), `status ${seite.status} → ${seite.location}`)
    const konto = await frage({ token: user.token })
    t.check('superusers: gewöhnliches Konto → 401', konto.status === 401, `status ${konto.status}`)
    const chef = await frage({ token: su })
    t.check('superusers: Superuser-Cookie → 204 + X-Ajna-Konto', chef.status === 204 && !!chef.konto, `status ${chef.status} konto=${chef.konto}`)
    const muell = await frage({ token: 'kein.gueltiges.token' })
    t.check('superusers: kaputtes Token → 401', muell.status === 401, `status ${muell.status}`)
    const anmelde = await frage({ seite: true, uri: '/zugang.html?weiter=%2F' })
    t.check('Anmeldeseite selbst wird nie umgeleitet (401 statt Schleife)', anmelde.status === 401, `status ${anmelde.status}`)

    // ── authenticated ────────────────────────────────────────────────────
    await t.setzeEinstellung('client.access', 'authenticated')
    const angemeldet = await frage({ token: user.token })
    t.check('authenticated: Konto-Cookie → 204', angemeldet.status === 204 && angemeldet.konto === user.id, `status ${angemeldet.status}`)
    const anonym = await frage()
    t.check('authenticated: ohne Cookie → 401', anonym.status === 401, `status ${anonym.status}`)

    // ── group:<Name> ─────────────────────────────────────────────────────
    const gName = `ptest-zugang-${Date.now().toString(36)}`
    const g = await req('/api/collections/groups/records', { method: 'POST', token: user.token, body: { name: gName, members: [user.id] } })
    if (t.check('Gruppe angelegt', g.status === 200, `status ${g.status}`)) {
      try {
        await t.setzeEinstellung('client.access', `group:${gName}`)
        const drin = await frage({ token: user.token })
        t.check('group: Mitglied → 204', drin.status === 204, `status ${drin.status}`)
        const draussen = await frage({ token: anderer.token })
        t.check('group: Nicht-Mitglied → 401', draussen.status === 401, `status ${draussen.status}`)
        const chef2 = await frage({ token: su })
        t.check('group: Superuser trotzdem → 204', chef2.status === 204, `status ${chef2.status}`)
      } finally {
        await req(`/api/collections/groups/records/${g.data.id}`, { method: 'DELETE', token: user.token })
      }
    }

    // ── Tippfehler in der Regel sperrt niemanden aus ──────────────────────
    await t.setzeEinstellung('client.access', 'nur-ich')
    const tipp = await frage()
    t.check('unbekannte Regel → wie everyone (204)', tipp.status === 204, `status ${tipp.status}`)
  } finally {
    await t.setzeEinstellung('client.access', 'everyone')
  }
}
