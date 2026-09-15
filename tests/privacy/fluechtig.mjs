// Flüchtige Daten (`ephemeral`) auf der Chat-Bahn.
//
// GRUNDBAUSTEIN, nicht Sonderfall: Ein Agent, der im Auftrag eines Spielers
// öffentliche Auskünfte abruft (Adressen, Registerauszüge), soll sie ANZEIGEN
// können, ohne dass sie irgendwo liegen bleiben. Dafür trägt die Nachricht ein
// Kennzeichen, das der Empfänger auswertet.
//
// WAS HIER GEPRÜFT WIRD, ist der Server-Teil des Vertrags: dass das Kennzeichen
// unverfälscht beim — und NUR beim — Empfänger ankommt, und dass es immer ein
// echtes true/false ist. Ein fehlendes Feld zwänge jeden Empfänger zu raten, ob
// „nicht flüchtig" gemeint ist oder ob er mit einem älteren Server spricht; im
// Zweifel würde er speichern, und genau das darf nicht passieren.
//
// Was hier NICHT geprüft werden kann: ob ein Client sich daran hält. Das ist
// eine Kennzeichnung, keine Durchsetzung (wie `Cache-Control: no-store`). Für
// Ajnas eigenen Client prüft das `tests/run-ui.mjs` unter „Flüchtige Daten".

export const name = 'Flüchtige Daten'

export async function run(t) {
  const PB = process.env.AJNA_TEST_PB || 'http://127.0.0.1:8090'
  const Quelle = typeof EventSource === 'function'
    ? EventSource
    : (await import('eventsource')).EventSource

  const sender = await t.user('fl-sender')
  const empf = await t.user('fl-empf')

  const posteingang = []
  const es = new Quelle(PB + '/api/realtime')

  try {
    const clientId = await new Promise((fertig, scheitern) => {
      const uhr = setTimeout(() => scheitern(new Error('keine PB_CONNECT-Nachricht')), 5000)
      es.addEventListener('PB_CONNECT', (ev) => {
        clearTimeout(uhr)
        fertig(JSON.parse(ev.data).clientId)
      })
      es.onerror = () => { clearTimeout(uhr); scheitern(new Error('Realtime-Verbindung fehlgeschlagen')) }
    })

    const topic = `chat:${empf.id}`
    es.addEventListener(topic, (ev) => posteingang.push(JSON.parse(ev.data)))

    const ab = await fetch(PB + '/api/realtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: empf.token },
      body: JSON.stringify({ clientId, subscriptions: [topic] }),
    })
    if (ab.status !== 204 && ab.status !== 200) {
      t.check('Chat-Abonnement', false, `status ${ab.status}`)
      return
    }

    const senden = (body) => fetch(PB + '/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: sender.token },
      body: JSON.stringify({ to: empf.id, ...body }),
    })

    const r1 = await senden({ text: 'nur für jetzt', ephemeral: true })
    const r2 = await senden({ text: 'darf bleiben' })
    // Ein Client, der das Feld gar nicht kennt, darf nichts auslösen.
    const r3 = await senden({ text: 'altmodisch', ephemeral: 'ja' })
    t.check('alle drei angenommen', r1.status === 200 && r2.status === 200 && r3.status === 200,
      `${r1.status}/${r2.status}/${r3.status}`)

    await new Promise((r) => setTimeout(r, 800))

    const fl = posteingang.find((m) => m.text === 'nur für jetzt')
    const bl = posteingang.find((m) => m.text === 'darf bleiben')
    const alt = posteingang.find((m) => m.text === 'altmodisch')

    t.check('die flüchtige Nachricht kommt an', !!fl)
    t.check('und trägt ephemeral = true', fl?.ephemeral === true, JSON.stringify(fl?.ephemeral))

    t.check('die gewöhnliche kommt ebenfalls an', !!bl)
    t.check('und trägt ephemeral = FALSE, nicht undefined',
      bl?.ephemeral === false, JSON.stringify(bl?.ephemeral))

    // Nur `=== true` gilt. Sonst machte ein beliebiger wahrheitsähnlicher Wert
    // aus einer gewöhnlichen Nachricht eine flüchtige — oder schlimmer:
    // umgekehrt, wenn jemand später auf Wahrheitswert statt Gleichheit prüft.
    t.check('ein unsauberer Wert gilt als NICHT flüchtig',
      alt?.ephemeral === false, JSON.stringify(alt?.ephemeral))

    t.check('der Absender steht serverseitig fest', fl?.from === sender.id)
  } catch (err) {
    t.check('Flüchtig-Vertrag geprüft', false, err.message)
  } finally {
    es.close()
  }
}
