// Nähe-Meldung (Privatsphäre-Stufe „Nähe") — POST /api/proximity.
//
// Der Client meldet Objekt-IDs, nie Koordinaten. Geprüft wird die SERVER-Seite:
// Auth-Zwang, Sehen-Recht als Grenze, saubere Antwort. Die Umkreis-Rechnung
// selbst sitzt im Client (ProximityReporter) und ist hier nicht Gegenstand.
//
// Was der Test NICHT zeigen kann: dass der Broadcast beim Agent ankommt — dafür
// bräuchte es ein Realtime-Abo, siehe die Anmerkung unten.

export const name = 'Privatsphäre: Nähe-Meldung'

export async function run(t) {
  const { req } = await import('../_harness.mjs')

  const owner = await t.user('owner')     // besitzt das Objekt (Agent-Rolle)
  const player = await t.user('player')   // steht davor

  const obj = await t.object(owner.token, {
    name: 'Naehe-Testobjekt', type: 'npc', lat: 50.4466, lon: 7.5971, altitude: 0, state: {},
  })

  const report = (token, body) => req('/api/proximity', { method: 'POST', token, body })

  // ── Auth ───────────────────────────────────────────────────────────────
  const anon = await report(undefined, { enter: [obj.id] })
  t.check('ohne Token abgewiesen', anon.status === 401, `status ${anon.status}`)

  // ── Sehen-Recht ist die Grenze ─────────────────────────────────────────
  // Der Spieler darf das Objekt (noch) nicht sehen → es darf ihn nicht spüren.
  const blind = await report(player.token, { enter: [obj.id] })
  t.check('unsichtbares Objekt spuert nichts', blind.status === 200 && blind.data?.delivered === 0,
    `delivered ${blind.data?.delivered}, skipped ${blind.data?.skipped}`)
  t.check('unsichtbares Objekt wird als uebersprungen gemeldet', blind.data?.skipped === 1)

  // Jetzt sichtbar machen.
  await t.share(owner.token, obj.id)
  const seen = await report(player.token, { enter: [obj.id] })
  t.check('sichtbares Objekt wird akzeptiert', seen.status === 200 && seen.data?.skipped === 0,
    `skipped ${seen.data?.skipped}`)
  // delivered === 0 ist hier KEIN Fehler: es hat schlicht niemand das Topic
  // abonniert. Der Test prueft die Grenze (skipped), nicht die Zustellung.

  // ── Der Besitzer selbst ────────────────────────────────────────────────
  const own = await report(owner.token, { enter: [obj.id] })
  t.check('Besitzer darf ebenfalls melden', own.status === 200 && own.data?.skipped === 0)

  // ── Robustheit ─────────────────────────────────────────────────────────
  const ghost = await report(player.token, { enter: ['gibtsnichtxxxxxxx'] })
  t.check('unbekannte ID kippt den Aufruf nicht', ghost.status === 200 && ghost.data?.skipped === 1,
    `status ${ghost.status}`)

  const empty = await report(player.token, {})
  t.check('leerer Aufruf ist ok', empty.status === 200 && empty.data?.delivered === 0)

  const junk = await report(player.token, { enter: [1, null, {}, 'x'.repeat(10)] })
  t.check('Muell im Array kippt nichts', junk.status === 200, `status ${junk.status}`)

  // Deckel gegen Missbrauch: max. 64 IDs pro Richtung.
  const flood = await report(player.token, { enter: Array.from({ length: 200 }, (_, i) => `id${i}`) })
  t.check('Massen-Meldung wird gedeckelt, nicht abgelehnt',
    flood.status === 200 && flood.data?.skipped === 64, `skipped ${flood.data?.skipped}`)

  // ── Verlassen ──────────────────────────────────────────────────────────
  const gone = await report(player.token, { leave: [obj.id] })
  t.check('Verlassen wird akzeptiert', gone.status === 200 && gone.data?.skipped === 0)

  // ── Koordinaten kommen hier nicht vor ──────────────────────────────────
  // Die Route hat kein Feld dafür; ein Client, der es doch mitschickt, darf
  // damit nichts bewirken. Das ist der Kern der Stufe.
  const withCoords = await report(player.token, { enter: [obj.id], lat: 50.4466, lon: 7.5971 })
  t.check('mitgeschickte Koordinaten werden ignoriert (kein Fehler, keine Wirkung)',
    withCoords.status === 200 && withCoords.data?.skipped === 0)
}
