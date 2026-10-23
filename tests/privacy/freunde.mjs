// Freundesliste (`friendships`, Paket 0c).
//
// Privatsphäre-relevant an zwei Stellen: Ein Konto darf fremde Nutzer nicht
// lesen — also müssen Handle-Auflösung und Anzeigenamen über den Server
// gehen, und zwar so, dass niemand damit Konten durchblättern kann. Und eine
// Freundschaft ist etwas zwischen ZWEI Konten: Ein Drittes sieht weder die
// Einladung noch die Beziehung.

export const name = 'Freundesliste'

export async function run(t) {
  const { req } = await import('../_harness.mjs')

  const anna = await t.user('fr-anna')
  const ben = await t.user('fr-ben')
  const dritte = await t.user('fr-dritte')
  const handle = `anna_${Date.now().toString(36)}`
  const setze = await req(`/api/collections/users/records/${anna.id}`, { method: 'PATCH', token: anna.token, body: { username: handle } })
  t.check('Anna wählt einen Handle', setze.status === 200, `status ${setze.status} ${JSON.stringify(setze.data)}`)

  const rows = (token) => req('/api/collections/friendships/records?sort=-updated', { token }).then(r => r.data?.items || [])

  // ── Auflösen: genau, nicht blättern ─────────────────────────────────────
  const r1 = await req(`/api/users/resolve?q=${handle}`, { token: ben.token })
  t.check('Ben findet Anna über den Handle', r1.status === 200 && r1.data?.id === anna.id, `status ${r1.status} ${JSON.stringify(r1.data)}`)
  t.check('… und bekommt nur Kennung und Anzeigename', Object.keys(r1.data || {}).sort().join(',') === 'id,name' && r1.data?.name === handle, JSON.stringify(r1.data))
  const r2 = await req(`/api/users/resolve?q=${handle.slice(0, 4)}`, { token: ben.token })
  t.check('ein Teilstück des Handles trifft NICHT', r2.status === 404, `status ${r2.status}`)
  const r3 = await req(`/api/users/resolve?q=${encodeURIComponent(anna.email)}`, { token: ben.token })
  t.check('die genaue E-Mail trifft', r3.status === 200 && r3.data?.id === anna.id, `status ${r3.status}`)
  const r4 = await req(`/api/users/resolve?q=${handle}`, { token: anna.token })
  t.check('sich selbst aufzulösen ist kein Treffer', r4.status === 400 && r4.data?.code === 'self', `status ${r4.status}`)
  const r5 = await req(`/api/users/resolve?q=${handle}`)
  t.check('ohne Anmeldung nichts', r5.status === 401, `status ${r5.status}`)

  // ── Einladen ────────────────────────────────────────────────────────────
  const selbst = await req('/api/collections/friendships/records', { method: 'POST', token: ben.token, body: { from: ben.id, to: ben.id, status: 'invited' } })
  t.check('sich selbst einladen → 400', selbst.status === 400, `status ${selbst.status}`)
  const fremd = await req('/api/collections/friendships/records', { method: 'POST', token: dritte.token, body: { from: ben.id, to: anna.id, status: 'invited' } })
  t.check('im Namen eines anderen einladen → abgelehnt', fremd.status === 400 || fremd.status === 403, `status ${fremd.status}`)
  const sofort = await req('/api/collections/friendships/records', { method: 'POST', token: ben.token, body: { from: ben.id, to: anna.id, status: 'accepted' } })
  t.check('eine Einladung kann nicht als „angenommen" angelegt werden', sofort.status === 400 || sofort.status === 403, `status ${sofort.status}`)

  const ein = await req('/api/collections/friendships/records', { method: 'POST', token: ben.token, body: { from: ben.id, to: anna.id, status: 'invited' } })
  t.check('Ben lädt Anna ein', ein.status === 200 && ein.data?.status === 'invited', `status ${ein.status} ${JSON.stringify(ein.data)}`)
  t.check('der Server stempelt die Anzeigenamen', ein.data?.to_name === handle && typeof ein.data?.from_name === 'string', `${ein.data?.from_name} → ${ein.data?.to_name}`)
  const doppelt = await req('/api/collections/friendships/records', { method: 'POST', token: ben.token, body: { from: ben.id, to: anna.id, status: 'invited' } })
  t.check('dieselbe Einladung zweimal → abgelehnt (eindeutiges Paar)', doppelt.status === 400, `status ${doppelt.status}`)

  // ── Wer sieht was ───────────────────────────────────────────────────────
  const beiAnna = await rows(anna.token)
  t.check('Anna sieht die Einladung', beiAnna.some(f => f.id === ein.data?.id && f.status === 'invited'), `${beiAnna.length} Zeile(n)`)
  const beiDritter = await rows(dritte.token)
  t.check('ein Drittes sieht NICHTS', !beiDritter.some(f => f.id === ein.data?.id), `${beiDritter.length} Zeile(n)`)
  const direkt = await req(`/api/collections/friendships/records/${ein.data?.id}`, { token: dritte.token })
  t.check('auch nicht über die Kennung', direkt.status === 404 || direkt.status === 403, `status ${direkt.status}`)

  // ── Gegenrichtung ist Annahme ───────────────────────────────────────────
  const gegen = await req('/api/collections/friendships/records', { method: 'POST', token: anna.token, body: { from: anna.id, to: ben.id, status: 'invited' } })
  t.check('Anna lädt Ben ein, während Bens Einladung offen ist → 409 reverse_accepted',
    gegen.status === 409 && gegen.data?.code === 'reverse_accepted', `status ${gegen.status} ${JSON.stringify(gegen.data)}`)
  const nachher = await rows(ben.token)
  t.check('… und Bens Einladung ist jetzt angenommen', nachher.some(f => f.id === ein.data?.id && f.status === 'accepted'), JSON.stringify(nachher.map(f => f.status)))
  t.check('… ohne zweite Zeile', nachher.filter(f => [f.from, f.to].includes(anna.id)).length === 1)
  const nochmal = await req('/api/collections/friendships/records', { method: 'POST', token: anna.token, body: { from: anna.id, to: ben.id, status: 'invited' } })
  t.check('Freunde noch einmal einladen → 409 already_friends', nochmal.status === 409 && nochmal.data?.code === 'already_friends', `status ${nochmal.status}`)

  // ── Ändern: nur der Status, nur von der eingeladenen Seite ──────────────
  const id = ein.data?.id
  const dritteAendert = await req(`/api/collections/friendships/records/${id}`, { method: 'PATCH', token: dritte.token, body: { status: 'declined' } })
  t.check('ein Drittes kann nicht ändern', dritteAendert.status === 404 || dritteAendert.status === 403, `status ${dritteAendert.status}`)
  const einladerAendert = await req(`/api/collections/friendships/records/${id}`, { method: 'PATCH', token: ben.token, body: { status: 'declined' } })
  t.check('der Einladende kann den Status nicht setzen', einladerAendert.status === 404 || einladerAendert.status === 403, `status ${einladerAendert.status}`)
  const nameAendern = await req(`/api/collections/friendships/records/${id}`, { method: 'PATCH', token: anna.token, body: { from_name: 'Hacker' } })
  t.check('die eingeladene Seite ändert nur den Status, keine Namen', nameAendern.status === 403 && nameAendern.data?.code === 'status_only', `status ${nameAendern.status} ${JSON.stringify(nameAendern.data)}`)
  const zurueck = await req(`/api/collections/friendships/records/${id}`, { method: 'PATCH', token: anna.token, body: { status: 'invited' } })
  t.check('eine beantwortete Einladung lässt sich nicht zurückdrehen', zurueck.status === 403, `status ${zurueck.status}`)

  // ── Ablehnen und Entfernen ──────────────────────────────────────────────
  const ein2 = await req('/api/collections/friendships/records', { method: 'POST', token: dritte.token, body: { from: dritte.id, to: anna.id, status: 'invited' } })
  const ablehnen = await req(`/api/collections/friendships/records/${ein2.data?.id}`, { method: 'PATCH', token: anna.token, body: { status: 'declined' } })
  t.check('Anna lehnt die Einladung des Dritten ab', ablehnen.status === 200 && ablehnen.data?.status === 'declined', `status ${ablehnen.status}`)
  const nochEinmal = await req('/api/collections/friendships/records', { method: 'POST', token: anna.token, body: { from: anna.id, to: dritte.id, status: 'invited' } })
  t.check('nach einer Ablehnung darf die andere Richtung neu einladen', nochEinmal.status === 200, `status ${nochEinmal.status} ${JSON.stringify(nochEinmal.data)}`)
  await req(`/api/collections/friendships/records/${nochEinmal.data?.id}`, { method: 'DELETE', token: anna.token })

  const entfernt = await req(`/api/collections/friendships/records/${id}`, { method: 'DELETE', token: anna.token })
  t.check('Anna entfernt Ben als Freund (beide Seiten dürfen)', entfernt.status === 204, `status ${entfernt.status}`)
  const beiBen = await rows(ben.token)
  t.check('… und bei Ben ist die Zeile weg', !beiBen.some(f => f.id === id))
}
