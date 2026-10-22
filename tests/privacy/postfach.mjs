// Postfach für Direktnachrichten (`chat_inbox`).
//
// Eine Nachricht an jemanden, der gerade nicht verbunden ist, ging bisher
// verloren — für Gespräche vor Ort richtig, für Direktnachrichten zu wenig.
// Jetzt wartet sie im Postfach, bis der Empfänger sie abholt.
//
// Was hier auf dem Spiel steht, ist weniger das Zustellen als das NICHT-
// Mitlesen und das NICHT-Aufheben: Nur der Empfänger sieht sein Postfach,
// nicht einmal der Absender; eine zugestellte Nachricht wird nicht abgelegt;
// eine flüchtige nie — auch nicht für einen abwesenden Empfänger.

export const name = 'Postfach'

const PB = process.env.AJNA_TEST_PB || 'http://127.0.0.1:8090'

export async function run(t) {
  const { req } = await import('../_harness.mjs')
  const Quelle = typeof EventSource === 'function'
    ? EventSource
    : (await import('eventsource')).EventSource

  const sender = await t.user('pf-sender')
  const empfaenger = await t.user('pf-empfaenger')
  const lauscher = await t.user('pf-lauscher')

  const senden = (body) => req('/api/chat/send', { method: 'POST', token: sender.token, body })
  const postfach = (token) => req('/api/collections/chat_inbox/records?sort=created', { token })

  // ── Niemand hört zu → Postfach ──────────────────────────────────────────
  const r1 = await senden({ to: empfaenger.id, text: 'Ich war da, du nicht.', object: 'figur-x', meta: { probe: 1 } })
  t.check('an einen Abwesenden: angenommen, nicht zugestellt, abgelegt',
    r1.status === 200 && r1.data?.delivered === 0 && r1.data?.stored === true, JSON.stringify(r1.data))

  const r2 = await senden({ to: empfaenger.id, text: 'Flüchtig — bitte nicht aufheben.', ephemeral: true })
  t.check('eine flüchtige Nachricht wird NICHT abgelegt',
    r2.status === 200 && r2.data?.delivered === 0 && r2.data?.stored === false, JSON.stringify(r2.data))

  const r3 = await senden({ to: 'kein-konto-xyz', text: 'An eine Kennung ohne Konto.' })
  t.check('ohne Konto dahinter: kein Postfach, ehrlich gemeldet',
    r3.status === 200 && r3.data?.stored === false, JSON.stringify(r3.data))

  // ── Wer sieht das Postfach? ─────────────────────────────────────────────
  const beimEmpfaenger = await postfach(empfaenger.token)
  const zeilen = beimEmpfaenger.data?.items || []
  t.check('der Empfänger findet genau die eine Nachricht', zeilen.length === 1, `${zeilen.length} Zeile(n)`)
  t.check('… mit Absender, Objekt, Text, Meta und Zeitstempel des Absendens',
    zeilen[0]?.from === sender.id && zeilen[0]?.object === 'figur-x'
      && zeilen[0]?.text === 'Ich war da, du nicht.' && zeilen[0]?.meta?.probe === 1
      && /^\d{4}-\d{2}-\d{2}T/.test(zeilen[0]?.ts || ''),
    JSON.stringify(zeilen[0] ?? null))

  const beimAbsender = await postfach(sender.token)
  t.check('der ABSENDER sieht sie nicht mehr — sie gehört dem Empfänger',
    (beimAbsender.data?.items || []).length === 0, `${(beimAbsender.data?.items || []).length} Zeile(n)`)
  const beimLauscher = await postfach(lauscher.token)
  t.check('ein Dritter sieht nichts', (beimLauscher.data?.items || []).length === 0,
    `${(beimLauscher.data?.items || []).length} Zeile(n)`)
  const direkt = await req(`/api/collections/chat_inbox/records/${zeilen[0]?.id}`, { token: lauscher.token })
  t.check('auch nicht über die Kennung der Zeile', direkt.status === 404 || direkt.status === 403, `status ${direkt.status}`)

  // ── Niemand schreibt am Server vorbei ───────────────────────────────────
  const fremd = await req('/api/collections/chat_inbox/records', {
    method: 'POST', token: lauscher.token,
    body: { from: lauscher.id, to: empfaenger.id, text: 'untergeschoben', ts: new Date().toISOString() },
  })
  t.check('über die Collection-API legt niemand etwas ab', fremd.status === 400 || fremd.status === 403, `status ${fremd.status}`)

  // ── Löschen: nur der Empfänger ──────────────────────────────────────────
  const fremdLoeschen = await req(`/api/collections/chat_inbox/records/${zeilen[0]?.id}`,
    { method: 'DELETE', token: lauscher.token })
  t.check('ein Dritter kann nicht löschen', fremdLoeschen.status === 404 || fremdLoeschen.status === 403,
    `status ${fremdLoeschen.status}`)
  const absenderLoeschen = await req(`/api/collections/chat_inbox/records/${zeilen[0]?.id}`,
    { method: 'DELETE', token: sender.token })
  t.check('der Absender auch nicht', absenderLoeschen.status === 404 || absenderLoeschen.status === 403,
    `status ${absenderLoeschen.status}`)
  const abgeholt = await req(`/api/collections/chat_inbox/records/${zeilen[0]?.id}`,
    { method: 'DELETE', token: empfaenger.token })
  t.check('der Empfänger holt ab (löscht)', abgeholt.status === 204, `status ${abgeholt.status}`)
  const danach = await postfach(empfaenger.token)
  t.check('danach ist das Postfach leer', (danach.data?.items || []).length === 0)

  // ── Zugestellt heißt: nicht abgelegt ────────────────────────────────────
  // Der Empfänger ist diesmal verbunden. Die Nachricht kommt an UND bleibt
  // flüchtig — das Postfach ist kein Mitschnitt.
  const es = new Quelle(PB + '/api/realtime')
  try {
    const clientId = await new Promise((fertig, scheitern) => {
      const uhr = setTimeout(() => scheitern(new Error('keine PB_CONNECT-Nachricht')), 5000)
      es.addEventListener('PB_CONNECT', (ev) => { clearTimeout(uhr); fertig(JSON.parse(ev.data).clientId) })
      es.onerror = () => { clearTimeout(uhr); scheitern(new Error('Realtime-Verbindung fehlgeschlagen')) }
    })
    const live = []
    es.addEventListener(`chat:${empfaenger.id}`, (ev) => live.push(JSON.parse(ev.data)))
    await fetch(PB + '/api/realtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: empfaenger.token },
      body: JSON.stringify({ clientId, subscriptions: [`chat:${empfaenger.id}`] }),
    })
    const r4 = await senden({ to: empfaenger.id, text: 'Jetzt bist du da.' })
    await new Promise(r => setTimeout(r, 800))
    t.check('verbunden: zugestellt und NICHT abgelegt',
      r4.data?.delivered === 1 && r4.data?.stored === false && live.length === 1, JSON.stringify(r4.data))
    const nachher = await postfach(empfaenger.token)
    t.check('das Postfach bleibt leer', (nachher.data?.items || []).length === 0)
  } catch (err) {
    t.check('Zustellung bei Verbindung geprüft', false, err.message)
  } finally {
    es.close()
  }
}
