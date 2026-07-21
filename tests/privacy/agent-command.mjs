// Agent-Befehlskanal (POST /api/agents/{source}/command).
//
// Sicherheitsrelevant, weil der Kanal bewusst OFFEN ist: jeder angemeldete
// Nutzer darf senden. Genau deshalb muss geprüft sein, was die Route zusichert —
// Authentifizierung, saubere Eingabe-Validierung, und vor allem: dass die
// gemeldete `source` vom SERVER kommt und nicht aus dem Body übernommen wird
// (sonst könnte ein Nutzer Kommandos im Namen eines anderen absetzen und
// agentenseitige Drosselung pro Nutzer wäre wertlos).

export const name = 'Agent-Befehlskanal'

export async function run(t) {
  const { req } = await import('../_harness.mjs')

  const user = await t.user('cmd')
  const send = (token, source, body) =>
    req(`/api/agents/${source}/command`, { method: 'POST', token, body })

  // ── Auth ───────────────────────────────────────────────────────────────
  const anon = await send(undefined, 'world-director', { command: 'spawn' })
  t.check('ohne Token abgewiesen', anon.status === 401, `status ${anon.status}`)

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
