// Schreiben über eine ACE — der Pfad, der zweimal still kaputt war.
//
// WAS HIER SCHIEFGING. `objects.updateRule` stand in der laufenden Instanz mit
// nackten `=`-Operatoren auf der `@collection.effective_permissions`-Referenz.
// In einer API-Regel heisst das nicht „es gibt eine passende Zeile", sondern
// „ALLE Zeilen der Tabelle erfüllen das". Die Regel traf also nur, solange die
// Cache-Tabelle praktisch leer war — in einer benutzten Instanz nie.
//
// Die Folge war ein 404 auf jeden PATCH über eine ACE, obwohl
// `/effective-rights` das Recht korrekt auswies. Es stand ein halbes Jahr als
// Arbeitspaket 2 („nicht nebenbei zu klären"), wurde einmal behoben
// (1786800000) und war danach wieder da — PocketBase schreibt Regeländerungen
// aus der Verwaltungsoberfläche als eigene Migration, deren `down` die Falle
// zurückbringt.
//
// `tools/acl-selftest.mjs` hätte das gefunden. Es lief nur nie, weil es in
// keinem `npm test` stand. Deshalb steht es jetzt hier: Was eine Zusage des
// Rechtemodells ist, gehört in das Netz, das bei jedem Melden läuft.
//
// Die Prüfung auf Objekt B ist genauso wichtig wie die auf A: `?=` darf die
// drei Bedingungen NICHT aus verschiedenen Zeilen zusammensetzen. Täte es das,
// wäre jedes Objekt für jeden mit irgendeiner ACE änderbar.

export const name = 'Schreiben über ACEs'

export async function run(t) {
  const { req } = await import('../_harness.mjs')

  const chef = await t.user('ace-chef')        // Besitzer der Prüfobjekte
  const alice = await t.user('ace-alice')      // bekommt Rechte
  const bob = await t.user('ace-bob')          // bekommt Rechte auf ein ANDERES Objekt

  const mach = async (name) => t.object(chef.token, {
    name, type: 'prueflabor-ace', lat: 50.4466, lon: 7.5971, altitude: 0, state: {},
  })
  const A = (await mach('ACE-Prüfobjekt A')).id
  const B = (await mach('ACE-Prüfobjekt B')).id
  const C = (await mach('ACE-Prüfobjekt C')).id   // für die Gruppe

  const ace = (object, body) => req('/api/collections/object_permissions/records', {
    method: 'POST', token: chef.token, body: Object.assign({ object }, body),
  })
  // `animation_state` ist ein harmloses Feld — hier geht es um das Dürfen,
  // nicht um den Inhalt.
  const patch = (token, id, body = { animation_state: 'prueflauf' }) =>
    req(`/api/collections/objects/records/${id}`, { method: 'PATCH', token, body })

  // ── Grundlinie: der Besitzer ───────────────────────────────────────────
  let r = await patch(chef.token, A)
  t.check('der Besitzer darf schreiben', r.status === 200, `status ${r.status}`)

  // ── Nutzer-ACE mit edit ────────────────────────────────────────────────
  await ace(A, { subject_type: 'user', subject: alice.id, rights: ['view', 'edit'], interact_actions: [] })
  const eff = await req(`/api/objects/${A}/effective-rights`, { token: alice.token })
  t.check('die effektiven Rechte führen edit',
    (eff.data?.rights || []).includes('edit'), JSON.stringify(eff.data?.rights))
  r = await patch(alice.token, A)
  t.check('eine Nutzer-ACE mit edit darf schreiben', r.status === 200, `status ${r.status}`)

  // ── Positionen: der Fall „fehlerhafte Geokodierung korrigieren" ────────
  r = await patch(alice.token, A, { lat: 50.4470, lon: 7.5975 })
  t.check('edit umfasst lat/lon', r.status === 200, `status ${r.status}`)

  // ── KEINE Vermischung über Zeilen hinweg ───────────────────────────────
  await ace(B, { subject_type: 'user', subject: bob.id, rights: ['view', 'edit'], interact_actions: [] })
  r = await patch(alice.token, B)
  t.check('Alice kommt NICHT an Bobs Objekt', r.status === 404, `status ${r.status}`)
  r = await patch(bob.token, A)
  t.check('Bob kommt NICHT an Alices Objekt', r.status === 404, `status ${r.status}`)

  // ── Gruppen-ACE: der Fall „Organisation verwaltet fremde Einträge" ─────
  const grp = await req('/api/collections/groups/records', {
    method: 'POST', token: chef.token,
    body: { name: `Prüfgruppe ${Date.now().toString(36).slice(-6)}`, members: [alice.id], owner: chef.id },
  })
  t.check('Gruppe angelegt', grp.status === 200, `status ${grp.status}`)
  if (grp.status === 200) {
    await ace(C, { subject_type: 'group', subject: grp.data.id, rights: ['view', 'edit'], interact_actions: [] })
    r = await patch(alice.token, C)
    t.check('eine Gruppen-ACE mit edit darf schreiben', r.status === 200, `status ${r.status}`)
    r = await patch(bob.token, C)
    t.check('wer nicht in der Gruppe ist, darf nicht', r.status === 404, `status ${r.status}`)

    // Untergruppe: `transitiveGroupsOf` löst sie auf, also muss sie auch
    // schreiben dürfen.
    const unter = await req('/api/collections/groups/records', {
      method: 'POST', token: chef.token,
      body: { name: `Prüf-Untergruppe ${Date.now().toString(36).slice(-6)}`, members: [bob.id], owner: chef.id },
    })
    if (unter.status === 200) {
      const auf = await req(`/api/collections/groups/records/${grp.data.id}`, {
        method: 'PATCH', token: chef.token,
        body: { members: [alice.id], subgroups: [unter.data.id] },
      })
      if (auf.status === 200) {
        r = await patch(bob.token, C)
        t.check('ein Mitglied einer Untergruppe darf ebenfalls schreiben',
          r.status === 200, `status ${r.status}`)
      } else {
        t.check('Untergruppe eintragen', false, `status ${auf.status} ${JSON.stringify(auf.data)}`)
      }
      await req(`/api/collections/groups/records/${unter.data.id}`, { method: 'DELETE', token: chef.token })
    }
    await req(`/api/collections/groups/records/${grp.data.id}`, { method: 'DELETE', token: chef.token })
  }

  // ── view allein genügt nicht ───────────────────────────────────────────
  const nur = await t.user('ace-leser')
  await ace(A, { subject_type: 'user', subject: nur.id, rights: ['view'], interact_actions: [] })
  const sicht = await req(`/api/collections/objects/records/${A}`, { token: nur.token })
  t.check('view erlaubt das Lesen', sicht.status === 200, `status ${sicht.status}`)
  r = await patch(nur.token, A)
  t.check('view allein erlaubt KEIN Schreiben', r.status === 404, `status ${r.status}`)

  // ── `move` ist noch nicht durchgesetzt ─────────────────────────────────
  // Festgehalten, damit die Doku nicht wieder etwas anderes behauptet als die
  // Instanz tut: Wer NUR `move` hat, kann gar nichts. Wird `move` eines Tages
  // umgesetzt (Arbeitspaket 2a), schlägt diese Prüfung fehl und erinnert
  // daran, sie hier und in `docs/permissions.md` nachzuziehen.
  const mover = await t.user('ace-mover')
  await ace(B, { subject_type: 'user', subject: mover.id, rights: ['view', 'move'], interact_actions: [] })
  r = await patch(mover.token, B, { lat: 50.4480, lon: 7.5980 })
  t.check('move allein verschiebt (noch) NICHT — siehe Paket 2a',
    r.status === 404, `status ${r.status}`)
}
