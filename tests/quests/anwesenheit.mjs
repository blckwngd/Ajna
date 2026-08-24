// Anwesenheit: Wer da steht, ist auch wirklich da — und heißt auch so.
//
// Ein Spieler wird in der Welt durch ein gewöhnliches Objekt vertreten
// (`type: "player"`). Das ist Absicht: dieselben Rechte, dieselbe Verteilung,
// dieselbe Darstellung wie für alles andere. Genau deshalb muss der Server drei
// Dinge einstempeln, statt sie dem Client zu glauben:
//
//   • den ANZEIGENAMEN — sonst könnte sich jeder als jemand anders ausgeben,
//     und das Schild über dem Kopf wäre wertlos;
//   • das KARMA — es ist serverseitig geführt und genau dadurch etwas wert;
//   • den BESITZER — sonst legte jemand eine Anwesenheit FÜR einen anderen an
//     und stellte ihn irgendwohin.
//
// Fremde Konten sind nicht lesbar (die users-Regeln geben nur den eigenen
// Datensatz heraus) — ohne dieses Einstempeln hätte ein Betrachter also gar
// keine Möglichkeit, den Namen zu prüfen.

export const name = 'Anwesenheit ist nicht fälschbar'

const ORT = { lat: 50.4466, lon: 7.5971 }

export async function run(t) {
  const A = await t.user('spieler')
  const B = await t.user('fremder')
  const echterName = String((await t.readUser(A.token, A.id))?.name || '')

  const anwesenheit = (u, extra = {}) => t.object(u.token, {
    name: 'Anwesenheit', type: 'player',
    lat: ORT.lat, lon: ORT.lon, altitude: 0,
    state: { realtime: true, presence: true },
    ...extra,
  })

  // ── Der Server stempelt ein ────────────────────────────────────────────
  const rec = await anwesenheit(A)
  t.check('Anwesenheit lässt sich anlegen', !!rec?.id)

  let st = (await t.read(A.token, rec.id))?.state
  t.check('sie ist als Anwesenheit markiert', st?.presence === true)
  t.check('der Anzeigename kommt vom Server', st?.name === echterName,
    `name="${st?.name}" erwartet "${echterName}"`)
  t.check('Karma steht dabei', Number(st?.karma) === 0, 'karma=' + st?.karma)
  t.check('und ein Zeitstempel gegen Gespenster', !!st?.seenAt, 'seenAt=' + st?.seenAt)

  // ── Ein selbst gesetzter Name hält nicht ───────────────────────────────
  await t.patch(A.token, rec.id, { state: { presence: true, name: 'Der Kaiser', karma: 5 } })
  st = (await t.read(A.token, rec.id))?.state
  t.check('ein selbst gesetzter Name wird überschrieben', st?.name === echterName,
    'name=' + st?.name)
  t.check('und selbst gesetztes Karma ebenso', Number(st?.karma) === 0, 'karma=' + st?.karma)
  t.check('der Zeitstempel wird neu gesetzt', !!st?.seenAt)

  // ── Niemand stellt jemand anderen irgendwohin ──────────────────────────
  const fremd = await anwesenheit(B, { owner: A.id })
  const fremdRec = await t.read(B.token, fremd.id)
  t.check('der Besitzer wird auf den Anlegenden gesetzt', fremdRec?.owner === B.id,
    'owner=' + fremdRec?.owner)
  t.check('und der Name entsprechend', fremdRec?.state?.name !== echterName,
    'name=' + fremdRec?.state?.name)

  // ── Andere Objekte bleiben unberührt ───────────────────────────────────
  const npc = await t.object(A.token, {
    name: 'QTest Normal', type: 'npc',
    lat: ORT.lat, lon: ORT.lon, altitude: 0,
    state: { name: 'Eigener Name', karma: 99 },
  })
  const nst = (await t.read(A.token, npc.id))?.state
  t.check('ein gewöhnliches Objekt behält seinen state',
    nst?.name === 'Eigener Name' && Number(nst?.karma) === 99, JSON.stringify(nst))
  t.check('und wird nicht als Anwesenheit markiert', nst?.presence === undefined)

  // ── Sichtbarkeit ist nicht automatisch ─────────────────────────────────
  // Ohne Freigabe sieht die Anwesenheit niemand — die sichere Vorgabe.
  t.check('ohne Freigabe sieht ein Fremder sie nicht',
    (await t.read(B.token, rec.id))?.id !== rec.id)

  const ace = await t.raw('/api/collections/object_permissions/records', {
    method: 'POST', token: A.token,
    body: { object: rec.id, subject_type: 'authenticated', subject: '', rights: ['view'], interact_actions: [] },
  })
  t.check('Freigabe lässt sich setzen', ace.status === 200, 'HTTP ' + ace.status)
  const gesehen = await t.read(B.token, rec.id)
  t.check('danach sieht der Fremde sie', gesehen?.id === rec.id)
  t.check('samt Name aus der Server-Quelle', gesehen?.state?.name === echterName,
    'name=' + gesehen?.state?.name)
  t.check('und samt Karma', Number(gesehen?.state?.karma) === 0)
}
