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
      rights: ['view'], interact_actions: ['examine', 'call'],
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

  // ── Interaktion: ein Ereignis, zwei Themen ──────────────────────────────
  // `interact:<objektId>` erreicht jeden, der das Objekt sieht — Umstehende
  // sollen die Reaktion sehen. Was dort NICHT hingehört: wer es war und was
  // er mitschickte („Rufen" trägt die Position des Rufenden). Das bekommt
  // allein der Betreiber, auf `interact:<objektId>:owner`. Der Auslöser
  // selbst sieht im öffentlichen Echo seine eigene Kennung — so erkennt sein
  // Viewer das Echo und zeigt die Reaktion nicht doppelt.
  const topicPublic = `interact:${figur.id}`
  const topicOwner = `${topicPublic}:owner`
  const cOwner = await verbindung(Quelle, opfer.token, [topicPublic, topicOwner])
  const cEaves = await verbindung(Quelle, lauscher.token, [topicPublic, topicOwner])
  const cActor = await verbindung(Quelle, sender.token, [topicPublic, topicOwner])
  t.check('die Anmeldung mit dem fremden Betreiber-Thema wird angenommen (gefiltert)',
    cEaves.status === 204 || cEaves.status === 200, `status ${cEaves.status}`)

  const call = await req(`/api/objects/${figur.id}/interact`, {
    method: 'POST', token: sender.token,
    body: { action: 'call', payload: { at: { lat: 50.4467, lon: 7.5972, precise: true } } },
  })
  t.check('„Rufen" mit Position angenommen', call.status === 200,
    `status ${call.status} ${JSON.stringify(call.data)}`)
  await new Promise(r => setTimeout(r, 1000))

  const ownerPriv = cOwner.eingang.get(topicOwner), ownerPub = cOwner.eingang.get(topicPublic)
  const eavesPriv = cEaves.eingang.get(topicOwner), eavesPub = cEaves.eingang.get(topicPublic)
  const actorPriv = cActor.eingang.get(topicOwner), actorPub = cActor.eingang.get(topicPublic)

  t.check('der Betreiber bekommt das Ereignis GENAU EINMAL, auf seinem Thema',
    ownerPriv.length === 1 && ownerPub.length === 0,
    `${ownerPriv.length} Betreiber-Thema / ${ownerPub.length} öffentlich`)
  t.check('… mit Absender und Position',
    ownerPriv[0]?.source === sender.id && ownerPriv[0]?.payload?.at?.lat === 50.4467,
    JSON.stringify(ownerPriv[0] ?? null))
  t.check('ein Dritter sieht die Reaktion', eavesPub.length === 1, `${eavesPub.length} öffentlich`)
  t.check('… aber weder Position noch Absender',
    eavesPub.length === 1 && eavesPub[0].payload == null && eavesPub[0].source == null,
    JSON.stringify(eavesPub[0] ?? null))
  t.check('das Betreiber-Thema bleibt für ihn STUMM', eavesPriv.length === 0,
    `${eavesPriv.length} mitgelesen`)
  t.check('der Auslöser erkennt sein eigenes Echo (source = er selbst), ohne Betreiber zu sein',
    actorPub.length === 1 && actorPub[0].source === sender.id && actorPub[0].payload == null
      && actorPriv.length === 0,
    `${JSON.stringify(actorPub[0] ?? null)} / ${actorPriv.length} auf dem Betreiber-Thema`)

  cOwner.zu(); cEaves.zu(); cActor.zu()

  // ── Agent-Kommandos ─────────────────────────────────────────────────────
  // `agent:<quelle>` trägt Kommandos samt Koordinaten. Hören darf, wem der
  // Name gehört: das Konto mit dem ÄLTESTEN Manifest dieser Quelle und seine
  // Delegierten — dieselbe Regel, nach der `state.source` an ein Konto
  // gebunden ist. Ein Name ohne Manifest bleibt offen: Ein Agent, der keines
  // veröffentlicht, soll nicht aus seinem eigenen Kanal fallen.
  const delegate = await t.user('rt-vertreter')
  const source = `rt-agent-${Date.now().toString(36)}`
  const manifest = await req('/api/collections/agent_manifests/records', {
    method: 'POST', token: opfer.token,
    body: { source, agent_name: 'Prüf-Agent', owner: opfer.id, layers: [], delegates: [delegate.id] },
  })
  t.check('Manifest angelegt', manifest.status === 200,
    `status ${manifest.status} ${JSON.stringify(manifest.data)}`)
  try {
    const priv = `agent:${source}`, pub = `agent:${source}:public`
    const unclaimed = `agent:${source}-niemand`
    const aOwner = await verbindung(Quelle, opfer.token, [priv, pub])
    const aDelegate = await verbindung(Quelle, delegate.token, [priv])
    const aEaves = await verbindung(Quelle, lauscher.token, [priv, pub, unclaimed])

    const command = (src, token) => req(`/api/agents/${src}/command`, {
      method: 'POST', token, body: { command: 'spawn', payload: { at: { lat: 50.44, lon: 7.59 } } },
    })
    const r1 = await command(source, sender.token)
    const r2 = await command(source, undefined)
    const r3 = await command(`${source}-niemand`, sender.token)
    t.check('Kommandos angenommen (angemeldet, anonym, unbeanspruchter Name)',
      r1.status === 200 && r2.status === 200 && r3.status === 200, `${r1.status}/${r2.status}/${r3.status}`)
    await new Promise(r => setTimeout(r, 1000))

    t.check('der Inhaber des Namens bekommt das Kommando',
      aOwner.eingang.get(priv).length === 1, `${aOwner.eingang.get(priv).length} Kommando(s)`)
    t.check('… und das anonyme auf dem öffentlichen Thema',
      aOwner.eingang.get(pub).length === 1, `${aOwner.eingang.get(pub).length} Kommando(s)`)
    t.check('ein Delegierter hört ebenfalls',
      aDelegate.eingang.get(priv).length === 1, `${aDelegate.eingang.get(priv).length} Kommando(s)`)
    t.check('ein Dritter hört NICHTS — weder angemeldete noch anonyme Kommandos',
      aEaves.eingang.get(priv).length === 0 && aEaves.eingang.get(pub).length === 0,
      `${aEaves.eingang.get(priv).length}/${aEaves.eingang.get(pub).length} mitgelesen`)
    t.check('ein Name ohne Manifest bleibt offen (gemessen und so gewollt)',
      aEaves.eingang.get(unclaimed).length === 1, `${aEaves.eingang.get(unclaimed).length} Kommando(s)`)

    aOwner.zu(); aDelegate.zu(); aEaves.zu()
  } finally {
    // Das Manifest ist kein Objekt — die Aufräumliste des Harness kennt es
    // nicht. Bliebe es liegen, stünde „Prüf-Agent" im Inhaltsfilter jedes
    // Spielers.
    if (manifest.data?.id) {
      await req(`/api/collections/agent_manifests/records/${manifest.data.id}`,
        { method: 'DELETE', token: opfer.token })
    }
  }

  // ── Gewöhnliche Collection-Themen bleiben unberührt ─────────────────────
  // Der Wächter darf nur die eigenen Namensräume anfassen. Ginge hier etwas
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
