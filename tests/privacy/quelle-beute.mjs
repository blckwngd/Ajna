// Aufgehobene Beute bleibt änderbar — der Quellenanspruch darf sie nicht
// einfrieren.
//
// DER ZUSAMMENSTOSS: Zwei bestehende Mechanismen widersprechen sich.
//
//   • `/pickup` überträgt den BESITZ an den Sammler („Loot: Eigentum übergeht
//     auf den Sammler").
//   • `pruefeQuellenanspruch` vergleicht die Quelle gegen den BESITZER des
//     Datensatzes — nicht gegen den Aufrufer.
//
// Zusammen heisst das: Sobald jemand ein Agent-Objekt mit `state.source`
// aufhebt, gehört es ihm, passt aber nicht mehr zu seiner Quelle — und JEDE
// weitere Änderung scheitert mit 403. Gemeldet wurde es als „ich kann die
// Adress-Lupe nicht verschieben".
//
// Dass es nicht früher auffiel, liegt daran, dass `/pickup` und `/place` über
// `$app.save()` laufen und den Request-Hook gar nicht auslösen. Aufheben und
// Ablegen ging also, nur Ziehen nicht.
//
// Die Regel lautet jetzt: Eine UNVERÄNDERTE Quelle ist kein Anspruch.

export const name = 'Quelle & Beute'

export async function run(t) {
  const { req } = await import('../_harness.mjs')

  const agent = await t.user('qb-agent')
  const spieler = await t.user('qb-spieler')
  const QUELLE = `prueflabor-${Date.now().toString(36).slice(-6)}`

  // Der „Agent" registriert seinen Namen und legt tragbare Beute an.
  const manifest = await req('/api/collections/agent_manifests/records', {
    method: 'POST', token: agent.token,
    body: {
      source: QUELLE, agent_name: 'Prüflabor', description: 'Testquelle',
      layers: [{ key: 'all', label: 'Alles', predicate: null }],
      // Pflicht: Die Regel lässt nur zu, sich SELBST einzutragen.
      owner: agent.id,
    },
  })
  t.check('Manifest registriert', manifest.status === 200, `status ${manifest.status}`)

  const rec = await t.object(agent.token, {
    name: 'Prüf-Beute', type: 'item', lat: 50.4466, lon: 7.5971, altitude: 0,
    state: { portable: true, source: QUELLE },
  })
  const obj = rec.id

  // Sichtbar für alle Angemeldeten, sonst kann niemand sie aufheben.
  await req('/api/collections/object_permissions/records', {
    method: 'POST', token: agent.token,
    body: { object: obj, subject_type: 'authenticated', subject: '', rights: ['view'], interact_actions: ['examine'] },
  })

  // Eine FREMDE Quelle zu beanspruchen bleibt verboten — das ist der Zweck des
  // Hooks, und er muss erhalten bleiben.
  const geklaut = await req('/api/collections/objects/records', {
    method: 'POST', token: spieler.token,
    body: { name: 'Angeblich', type: 'item', lat: 50.4, lon: 7.5, state: { source: QUELLE } },
  })
  t.check('fremde Quelle beanspruchen bleibt verboten', geklaut.status === 403, `status ${geklaut.status}`)

  // ── Aufheben: der Besitz geht über ──────────────────────────────────────
  const auf = await req(`/api/objects/${obj}/pickup`, { method: 'POST', token: spieler.token })
  t.check('Beute lässt sich aufheben', auf.status === 200, `status ${auf.status}`)
  t.check('und der Besitz geht an den Sammler', auf.data?.owner === spieler.id,
    `owner ${auf.data?.owner}`)

  const ab = await req(`/api/objects/${obj}/place`, {
    method: 'POST', token: spieler.token, body: { lat: 50.4470, lon: 7.5975 },
  })
  t.check('und ablegen geht auch', ab.status === 200, `status ${ab.status}`)

  // ── Und jetzt das, was vorher scheiterte ────────────────────────────────
  const ziehen = await req(`/api/collections/objects/records/${obj}`, {
    method: 'PATCH', token: spieler.token, body: { lat: 50.4475, lon: 7.5980 },
  })
  t.check('der neue Besitzer darf sie VERSCHIEBEN', ziehen.status === 200,
    `status ${ziehen.status}  ${JSON.stringify(ziehen.data).slice(0, 120)}`)
  t.check('die Quelle bleibt dabei erhalten', ziehen.data?.state?.source === QUELLE,
    `source ${ziehen.data?.state?.source}`)

  // Die geerbte Quelle ausdrücklich nochmal mitzuschicken ist unverändert —
  // also erlaubt. (Der Client schickt den ganzen Datensatz, nicht nur das
  // Geänderte; ohne diese Zusage wäre jedes Speichern aus der Oberfläche eine
  // Behauptung.)
  const gleich = await req(`/api/collections/objects/records/${obj}`, {
    method: 'PATCH', token: spieler.token,
    body: { state: { portable: true, source: QUELLE } },
  })
  t.check('die geerbte Quelle unverändert mitzuschicken ist erlaubt', gleich.status === 200,
    `status ${gleich.status}`)

  // Ein unbeanspruchter Name bleibt erlaubt — so der Entwurf des Hooks.
  const umbiegen = await req(`/api/collections/objects/records/${obj}`, {
    method: 'PATCH', token: spieler.token,
    body: { state: { portable: true, source: `${QUELLE}-frei` } },
  })
  t.check('ein unbeanspruchter Name bleibt erlaubt', umbiegen.status === 200,
    `status ${umbiegen.status}`)

  // ABER: Ist die Quelle einmal weg, lässt sie sich nicht zurückholen — das
  // wäre ein echter Anspruch auf einen fremden Namen. Genau die Grenze, die der
  // Hook ziehen soll; die Ausnahme oben darf sie nicht aufweichen.
  const zurueck = await req(`/api/collections/objects/records/${obj}`, {
    method: 'PATCH', token: spieler.token,
    body: { state: { portable: true, source: QUELLE } },
  })
  t.check('eine aufgegebene fremde Quelle lässt sich NICHT zurückholen',
    zurueck.status === 403, `status ${zurueck.status}`)
}
