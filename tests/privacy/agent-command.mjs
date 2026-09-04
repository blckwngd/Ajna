// Agent-Befehlskanal (POST /api/agents/{source}/command).
//
// Sicherheitsrelevant, weil der Kanal bewusst OFFEN ist: jeder angemeldete
// Nutzer darf senden — und seit den anonymen Kommandos (Links aus E-Mails, die
// keinen angemeldeten Absender haben) sogar jeder ohne Konto. Genau deshalb
// muss geprüft sein, was die Route zusichert: saubere Eingabe-Validierung, dass
// die gemeldete `source` vom SERVER kommt und nicht aus dem Body übernommen
// wird (sonst könnte ein Nutzer Kommandos im Namen eines anderen absetzen und
// agentenseitige Drosselung pro Nutzer wäre wertlos) — und vor allem die
// TRENNUNG DER KANÄLE.
//
// Diese Trennung ist die eigentliche Zusicherung: Ein anonymer Aufruf darf
// NIEMALS bei einem Agent landen, der nur `agent:<source>` abonniert hat. Sonst
// wäre aus einer opt-in-Erweiterung eine stille Öffnung ALLER Agents für
// unangemeldete Fremde geworden. Bis hierher stand dieser Test noch auf dem
// alten Vertrag („ohne Token → 401") und hat die neue Zusicherung gar nicht
// geprüft — er hat nur gemeldet, dass sich etwas geändert hat.

export const name = 'Agent-Befehlskanal'

export async function run(t) {
  const { req } = await import('../_harness.mjs')

  const user = await t.user('cmd')
  const send = (token, source, body) =>
    req(`/api/agents/${source}/command`, { method: 'POST', token, body })

  // ── Anonyme Kommandos: angenommen, aber auf eigenem Kanal ──────────────
  const anon = await send(undefined, 'world-director', { command: 'spawn' })
  t.check('ohne Token angenommen (eigener Kanal)', anon.status === 200, `status ${anon.status}`)

  await kanaltrennung(t, user)

  // Auch anonym gilt die Nutzlast-Grenze — sonst wäre der offene Kanal ein
  // Verstärker: eine kleine Anfrage, hunderte Kilobyte an jeden Abonnenten.
  const dick = await send(undefined, 'world-director', { command: 'spawn', payload: { x: 'y'.repeat(9000) } })
  t.check('anonyme Nutzlast über 8 KB → 400', dick.status === 400 && dick.data?.code === 'payload_too_large',
    `status ${dick.status}`)

  // ── Eingabe-Validierung ────────────────────────────────────────────────
  const ok = await send(user.token, 'world-director', { command: 'spawn', payload: { archetype: 'enemy', at: { lat: 50.4, lon: 7.5 } } })
  t.check('gültiges Kommando wird angenommen', ok.status === 200 && ok.data?.ok === true, `status ${ok.status}`)
  t.check('meldet Zustellzahl (0 = kein Agent aktiv)', typeof ok.data?.delivered === 'number',
    `delivered ${ok.data?.delivered}`)

  const noCmd = await send(user.token, 'world-director', { payload: {} })
  t.check('ohne command → 400', noCmd.status === 400, `status ${noCmd.status}`)

  const badCmd = await send(user.token, 'world-director', { command: 123 })
  t.check('command muss ein String sein → 400', badCmd.status === 400, `status ${badCmd.status}`)

  const longCmd = await send(user.token, 'world-director', { command: 'x'.repeat(200) })
  t.check('überlanges command → 400', longCmd.status === 400, `status ${longCmd.status}`)

  // Der Quellname landet in einem Topic-Namen — er darf nichts Wildes enthalten.
  const badSource = await send(user.token, encodeURIComponent('böse topic/#'), { command: 'spawn' })
  t.check('unsaubere Agent-Quelle → 400', badSource.status === 400, `status ${badSource.status}`)

  const okSource = await send(user.token, 'poi-bridge', { command: 'ping' })
  t.check('andere gültige Quelle wird akzeptiert', okSource.status === 200, `status ${okSource.status}`)

  // ── Kein Payload ist auch ok (Kommandos ohne Argumente) ────────────────
  const bare = await send(user.token, 'world-director', { command: 'ping' })
  t.check('Kommando ohne payload ist erlaubt', bare.status === 200)

  // ── Die Route vergibt KEINE Rechte: sie erzeugt selbst nichts ─────────
  // (Der Agent entscheidet. Ohne laufenden Agent darf nichts entstehen.)
  t.check('Route erzeugt selbst keine Objekte (reiner Transport)',
    ok.data?.ok === true && ok.data?.created === undefined)
}


/**
 * Hört auf beiden Topics mit und prüft, wohin die Route tatsächlich zustellt.
 *
 * Ohne diese Prüfung wäre „anonym erlaubt" nur eine Behauptung im Kommentar:
 * Die Statuszeile der Route ist in beiden Fällen 200, der Unterschied steckt
 * allein im Topic-Namen.
 */
async function kanaltrennung(t, user) {
  const PB = process.env.AJNA_TEST_PB || 'http://127.0.0.1:8090'
  // Node bringt EventSource erst als globales Objekt mit, wenn es freigeschaltet
  // ist (hier: nicht). Ein Überspringen wäre bequem, aber gerade hier falsch —
  // die Trennung der Kanäle ist die einzige Zusicherung, die den offenen
  // Endpunkt trägt. Also das Paket nehmen, das ohnehin als Abhängigkeit liegt.
  const Quelle = typeof EventSource === 'function'
    ? EventSource
    : (await import('eventsource')).EventSource

  const privat = []
  const oeffentlich = []
  const es = new Quelle(PB + '/api/realtime')

  try {
    // Erst die Client-ID abwarten, dann die Topics anmelden.
    const clientId = await new Promise((fertig, scheitern) => {
      const uhr = setTimeout(() => scheitern(new Error('keine PB_CONNECT-Nachricht')), 5000)
      es.addEventListener('PB_CONNECT', (ev) => {
        clearTimeout(uhr)
        fertig(JSON.parse(ev.data).clientId)
      })
      es.onerror = () => { clearTimeout(uhr); scheitern(new Error('Realtime-Verbindung fehlgeschlagen')) }
    })

    es.addEventListener('agent:world-director', (ev) => privat.push(JSON.parse(ev.data)))
    es.addEventListener('agent:world-director:public', (ev) => oeffentlich.push(JSON.parse(ev.data)))

    const ab = await fetch(PB + '/api/realtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: user.token },
      body: JSON.stringify({
        clientId,
        subscriptions: ['agent:world-director', 'agent:world-director:public'],
      }),
    })
    if (ab.status !== 204 && ab.status !== 200) {
      t.check('Kanaltrennung geprüft', false, `Abonnement fehlgeschlagen — status ${ab.status}`)
      return
    }

    const senden = (token) => fetch(PB + '/api/agents/world-director/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
      body: JSON.stringify({ command: 'ping', payload: { probe: token ? 'auth' : 'anon' } }),
    })

    await senden(undefined)
    await senden(user.token)
    await new Promise((r) => setTimeout(r, 800))

    const anonAngekommen = oeffentlich.filter((m) => m.payload?.probe === 'anon')
    const authAngekommen = privat.filter((m) => m.payload?.probe === 'auth')

    t.check('anonymes Kommando erreicht NICHT den normalen Kanal',
      privat.every((m) => m.payload?.probe !== 'anon'),
      `${privat.length} Nachricht(en) auf agent:world-director`)
    t.check('anonymes Kommando erreicht den öffentlichen Kanal', anonAngekommen.length === 1)
    t.check('anonym: source ist null, Kennzeichen gesetzt',
      anonAngekommen[0]?.source === null && anonAngekommen[0]?.anonymous === true,
      `source ${JSON.stringify(anonAngekommen[0]?.source)}`)

    t.check('angemeldetes Kommando bleibt auf dem normalen Kanal',
      authAngekommen.length === 1 && oeffentlich.every((m) => m.payload?.probe !== 'auth'))
    t.check('angemeldet: source ist die Server-seitige Nutzer-ID',
      authAngekommen[0]?.source === user.id && authAngekommen[0]?.anonymous === false,
      `source ${JSON.stringify(authAngekommen[0]?.source)}`)
  } catch (err) {
    t.check('Kanaltrennung geprüft', false, err.message)
  } finally {
    es.close()
  }
}
