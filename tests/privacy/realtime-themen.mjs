// Wer darf auf welchem Realtime-Thema mithören?
//
// Der Fehler, gegen den das hier steht, war still und sechs Monate alt: Ein
// Realtime-Thema ist eine frei gewählte Zeichenkette, und beim Abonnieren hat
// niemand geprüft, ob der Name den Abonnenten etwas angeht. Ein beliebiges
// angemeldetes Konto konnte `chat:<fremde-id>` abonnieren und jede Nachricht
// an diesen Menschen mitlesen.
//
// Aufgefallen ist es erst beim Entwurf der LLM-Figuren — solange eine Figur
// aus einer festen Satzliste antwortet, steht auf dem Kanal nichts Eigenes.
//
// Diese Suite prüft die Grenze aus beiden Richtungen: Der Berechtigte muss
// weiterhin empfangen, der Unberechtigte darf nicht. Das Zweite allein wäre
// wertlos — eine Regel, die alles verbietet, besteht es auch.

export const name = 'Realtime-Themen'

const PB = process.env.AJNA_TEST_PB || 'http://127.0.0.1:8090'

/**
 * Eine Realtime-Verbindung mit Posteingang je Thema.
 *
 * Bewusst roh über EventSource statt über das SDK: Geprüft wird, was der
 * SERVER durchlässt, und das SDK würde eine abgelehnte Anmeldung womöglich
 * selbst wiederholen oder verschlucken.
 */
async function verbindung(Quelle, token, themen) {
  const es = new Quelle(PB + '/api/realtime')
  const eingang = new Map(themen.map(t => [t, []]))
  const clientId = await new Promise((fertig, scheitern) => {
    const uhr = setTimeout(() => scheitern(new Error('keine PB_CONNECT-Nachricht')), 5000)
    es.addEventListener('PB_CONNECT', (ev) => {
      clearTimeout(uhr)
      fertig(JSON.parse(ev.data).clientId)
    })
    es.onerror = () => { clearTimeout(uhr); scheitern(new Error('Realtime-Verbindung fehlgeschlagen')) }
  })
  for (const t of themen) {
    es.addEventListener(t, (ev) => {
      try { eingang.get(t).push(JSON.parse(ev.data)) } catch { eingang.get(t).push(ev.data) }
    })
  }
  const ab = await fetch(PB + '/api/realtime', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ clientId, subscriptions: themen }),
  })
  return { es, eingang, status: ab.status, zu: () => { try { es.close() } catch {} } }
}

export async function run(t) {
  const { req } = await import('../_harness.mjs')
  const Quelle = typeof EventSource === 'function'
    ? EventSource
    : (await import('eventsource')).EventSource

  const opfer = await t.user('rt-opfer')
  const lauscher = await t.user('rt-lauscher')
  const sender = await t.user('rt-sender')

  // ── Gerichteter Chat ────────────────────────────────────────────────────
  // Der Lauscher fragt BEIDES in EINER Anfrage: sein eigenes Thema und ein
  // fremdes. Genau so schickt ein Client seine Liste — und genau deshalb
  // filtert der Wächter, statt die Anfrage abzulehnen.
  const vOpfer = await verbindung(Quelle, opfer.token, [`chat:${opfer.id}`])
  const vLausch = await verbindung(Quelle, lauscher.token,
    [`chat:${lauscher.id}`, `chat:${opfer.id}`])

  t.check('die gefilterte Anmeldung wird trotzdem angenommen',
    vLausch.status === 204 || vLausch.status === 200, `status ${vLausch.status}`)

  const senden = (an, text) => req('/api/chat/send', {
    method: 'POST', token: sender.token, body: { to: an, text },
  })
  const r1 = await senden(opfer.id, 'vertraulich an das Opfer')
  const r2 = await senden(lauscher.id, 'offen an den Lauscher')
  t.check('beide Nachrichten angenommen', r1.status === 200 && r2.status === 200,
    `${r1.status}/${r2.status}`)

  await new Promise(r => setTimeout(r, 1000))

  const beimOpfer = vOpfer.eingang.get(`chat:${opfer.id}`)
  const fremdesBeimLauscher = vLausch.eingang.get(`chat:${opfer.id}`)
  const eigenesBeimLauscher = vLausch.eingang.get(`chat:${lauscher.id}`)

  t.check('der Empfänger bekommt seine Nachricht', beimOpfer.length === 1,
    `${beimOpfer.length} Nachricht(en)`)
  t.check('ein fremdes Postfach bleibt STUMM', fremdesBeimLauscher.length === 0,
    `${fremdesBeimLauscher.length} mitgelesen`)
  // Die Gegenprobe, ohne die alles andere wertlos wäre: Das erlaubte Thema
  // derselben Anfrage muss überlebt haben.
  t.check('das eigene Postfach derselben Anfrage funktioniert weiter',
    eigenesBeimLauscher.length === 1, `${eigenesBeimLauscher.length} Nachricht(en)`)

  vOpfer.zu(); vLausch.zu()

  // ── Näherung ────────────────────────────────────────────────────────────
  // `proximity:<objektId>` trägt die Konto-ID dessen, der hinzutritt. Das
  // gehört dem, der das Objekt betreibt — nicht jedem, der es ansehen darf.
  const figur = await t.object(opfer.token, {
    name: 'Prüf-Figur', type: 'prueflabor-rt', lat: 50.4466, lon: 7.5971, altitude: 0, state: {},
  })
  // Für alle sichtbar machen: sonst scheiterte das Melden schon an der Sicht,
  // und die Prüfung sagte nichts über den Wächter aus.
  await req('/api/collections/object_permissions/records', {
    method: 'POST', token: opfer.token,
    body: {
      object: figur.id, subject_type: 'authenticated', subject: '',
      rights: ['view'], interact_actions: ['examine'],
    },
  })

  const vBesitzer = await verbindung(Quelle, opfer.token, [`proximity:${figur.id}`])
  const vFremder = await verbindung(Quelle, lauscher.token, [`proximity:${figur.id}`])

  const nah = await req('/api/proximity', {
    method: 'POST', token: sender.token, body: { enter: [figur.id], leave: [] },
  })
  t.check('Näherung gemeldet', nah.status === 200, `status ${nah.status}`)
  await new Promise(r => setTimeout(r, 1000))

  const beimBesitzer = vBesitzer.eingang.get(`proximity:${figur.id}`)
  const beimFremden = vFremder.eingang.get(`proximity:${figur.id}`)
  t.check('der Betreiber des Objekts erfährt die Näherung', beimBesitzer.length === 1,
    `${beimBesitzer.length} Ereignis(se)`)
  t.check('ein Dritter erfährt sie NICHT', beimFremden.length === 0,
    `${beimFremden.length} mitgelesen`)

  vBesitzer.zu(); vFremder.zu()

  // ── Gewöhnliche Collection-Themen bleiben unberührt ─────────────────────
  // Der Wächter darf nur die beiden Namensräume anfassen. Ginge hier etwas
  // verloren, bliebe die halbe Anwendung stehen, ohne dass es auffiele.
  const vListe = await verbindung(Quelle, lauscher.token, ['objects'])
  t.check('das Collection-Thema „objects" wird weiter angenommen',
    vListe.status === 204 || vListe.status === 200, `status ${vListe.status}`)
  const sichtbar = vListe.eingang.get('objects')
  await t.object(opfer.token, {
    name: 'Prüf-Objekt sichtbar', type: 'prueflabor-rt',
    lat: 50.4466, lon: 7.5971, altitude: 0, state: {},
  })
  await req('/api/collections/object_permissions/records', {
    method: 'POST', token: opfer.token,
    body: {
      object: figur.id, subject_type: 'everyone', subject: '',
      rights: ['view'], interact_actions: [],
    },
  })
  await new Promise(r => setTimeout(r, 800))
  t.check('und liefert weiterhin Ereignisse', sichtbar.length > 0,
    `${sichtbar.length} Ereignis(se)`)
  vListe.zu()
}
