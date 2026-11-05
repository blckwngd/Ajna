// Sammelobjekte — was der Server beim Einhängen, Bewegen, Vererben und
// Löschen durchlässt (docs/sammelobjekte.md).
//
// Die Geometrie ist in pb_hooks/hierarchy.test.mjs geprüft; hier geht es um
// die Hooks am lebenden System: Weltlage eines relativen Kindes, Nachziehen
// beim Bewegen des Eltern, Zyklus und Tiefe, das beidseitige `edit` beim
// Einhängen, die NTFS-artige Vererbung der ACEs (auch der impliziten
// Zielgruppen über die Spalten view_auth/view_anon), der Löschschutz und
// der Baum-Endpunkt.

export const name = 'Sammelobjekte'

const LAT = 50.4466, LON = 7.5971
const M_LAT = 1 / 111195            // Grad je Meter, Nord
const M_LON = 1 / (111195 * Math.cos(LAT * Math.PI / 180))
const near = (a, b, eps) => Math.abs(a - b) < eps

export async function run(t) {
  const { req } = await import('../_harness.mjs')

  const chef = await t.user('sam-chef')
  const alice = await t.user('sam-alice')
  const bob = await t.user('sam-bob')
  const dora = await t.user('sam-dora')

  const ace = (token, object, body) => req('/api/collections/object_permissions/records', {
    method: 'POST', token, body: Object.assign({ object, interact_actions: [] }, body),
  })
  const read = (token, id) => req(`/api/collections/objects/records/${id}`, { token })

  // ── Einhängen: das Objekt bleibt, wo es steht ───────────────────────────
  const rack = await t.object(chef.token, { name: 'Prüf-Rack', type: 'poi', lat: LAT, lon: LON, altitude: 100, heading: 0, container: {}, state: {} })
  t.check('ein Container-Abschnitt wird mit Vorgaben gefüllt',
    rack.container?.badge === 'both' && rack.container?.view === 'placed' && rack.container?.load === 'always', JSON.stringify(rack.container))

  const server = await t.object(chef.token, { name: 'Prüf-Server', type: 'poi', lat: LAT + 10 * M_LAT, lon: LON, altitude: 101, state: {} })
  let r = await t.patch(chef.token, server.id, { parent: rack.id, local: { from: 'world' } })
  t.check('„Hierin platzieren" lässt das Objekt stehen und rechnet den Versatz',
    r.status === 200 && near(r.data?.local?.north, 10, 0.01) && near(r.data?.local?.east, 0, 0.01)
      && near(r.data?.local?.up, 1, 0.001) && near(r.data?.lat, LAT + 10 * M_LAT, 1e-7),
    `status ${r.status} local ${JSON.stringify(r.data?.local)} lat ${r.data?.lat}`)

  // ── Bewegen des Eltern: das Kind folgt ──────────────────────────────────
  r = await t.patch(chef.token, rack.id, { lon: LON + 20 * M_LON })
  let s = await read(chef.token, server.id)
  t.check('bewegt sich das Rack, wandert der Server mit',
    near(s.data?.lon, LON + 20 * M_LON, 1e-7) && near(s.data?.lat, LAT + 10 * M_LAT, 1e-7), `server lon ${s.data?.lon}`)

  r = await t.patch(chef.token, rack.id, { heading: 90 })
  s = await read(chef.token, server.id)
  t.check('dreht sich das Rack nach Osten, steht „vorn" jetzt östlich',
    near(s.data?.lat, LAT, 1e-7) && s.data?.lon > LON + 25 * M_LON && s.data?.heading === 90,
    `lat ${s.data?.lat} lon ${s.data?.lon} heading ${s.data?.heading}`)
  await t.patch(chef.token, rack.id, { heading: 0, lon: LON })

  // ── Lage direkt setzen: der Versatz folgt der Welt ───────────────────────
  r = await t.patch(chef.token, server.id, { lat: LAT + 5 * M_LAT, lon: LON })
  t.check('eine direkt gesetzte Weltlage wird in den Versatz zurückgerechnet',
    r.status === 200 && near(r.data?.local?.north, 5, 0.01), `local ${JSON.stringify(r.data?.local)}`)

  // ── Nur Container nehmen auf; kein Zyklus ───────────────────────────────
  const stein = await t.object(chef.token, { name: 'Prüf-Stein', type: 'poi', lat: LAT, lon: LON, altitude: 0, state: {} })
  r = await t.patch(chef.token, stein.id, { parent: server.id })
  t.check('ein Objekt ohne Container-Abschnitt nimmt nichts auf', r.status === 400 && r.data?.code === 'not_a_container', `status ${r.status} ${r.data?.code}`)
  await t.patch(chef.token, server.id, { container: { view: 'exploded' } })
  r = await t.patch(chef.token, rack.id, { parent: server.id })
  t.check('das Rack in seinen eigenen Server zu stecken ist ein Zyklus', r.status === 400 && r.data?.code === 'cycle', `status ${r.status} ${r.data?.code}`)
  r = await t.patch(chef.token, rack.id, { container: { badge: 'rot' } })
  t.check('ein unbekannter Abzeichen-Wert wird abgewiesen', r.status === 400 && r.data?.code === 'bad_container', `status ${r.status}`)

  // ── Einhängen braucht edit am Kind UND am Ziel ──────────────────────────
  const eigenes = await t.object(alice.token, { name: 'Alices Gerät', type: 'poi', lat: LAT, lon: LON, altitude: 0, state: {} })
  await ace(chef.token, rack.id, { subject_type: 'user', subject: alice.id, rights: ['view'] })
  r = await t.patch(alice.token, eigenes.id, { parent: rack.id })
  t.check('ohne edit am Rack darf Alice nichts hineinlegen', r.status === 403 && r.data?.code === 'parent_forbidden', `status ${r.status} ${r.data?.code}`)
  const aliceAce = (await req(`/api/collections/object_permissions/records?filter=${encodeURIComponent(`object="${rack.id}" && subject="${alice.id}"`)}`, { token: chef.token })).data?.items?.[0]
  await req(`/api/collections/object_permissions/records/${aliceAce.id}`, { method: 'PATCH', token: chef.token, body: { rights: ['view', 'edit'] } })
  r = await t.patch(alice.token, eigenes.id, { parent: rack.id })
  t.check('mit edit am Rack geht es', r.status === 200 && r.data?.parent === rack.id, `status ${r.status}`)

  // ── Vererbung: Bob sieht den Server über die ACE am Rack ────────────────
  r = await read(bob.token, server.id)
  t.check('ohne ACE sieht Bob den Server nicht', r.status === 404, `status ${r.status}`)
  await ace(chef.token, rack.id, { subject_type: 'user', subject: bob.id, rights: ['view'] })
  r = await read(bob.token, server.id)
  t.check('eine view-ACE am Rack lässt Bob den Server sehen', r.status === 200, `status ${r.status}`)
  r = await read(bob.token, rack.id)
  t.check('… und das Rack selbst', r.status === 200, `status ${r.status}`)

  await t.patch(chef.token, server.id, { acl_break: true })
  r = await read(bob.token, server.id)
  t.check('acl_break am Server kappt die Vererbung', r.status === 404, `status ${r.status}`)
  await t.patch(chef.token, server.id, { acl_break: false })
  r = await read(bob.token, server.id)
  t.check('… und zurück', r.status === 200, `status ${r.status}`)

  // Tiefer: ein Enkel erbt über zwei Stufen.
  const vm = await t.object(chef.token, { name: 'Prüf-VM', type: 'poi', parent: server.id, local: { up: 0.5 }, state: {} })
  t.check('ein Kind ohne Lage sitzt am Eltern (plus Versatz)',
    near(vm.lat, LAT + 5 * M_LAT, 1e-7) && near(vm.altitude, 101.5, 0.001), `lat ${vm.lat} alt ${vm.altitude}`)
  r = await read(bob.token, vm.id)
  t.check('der Enkel erbt die ACE des Racks', r.status === 200, `status ${r.status}`)

  // Implizite Zielgruppe: die Spalten wandern mit.
  r = await read(dora.token, vm.id)
  t.check('Dora (keine ACE) sieht die VM nicht', r.status === 404, `status ${r.status}`)
  await ace(chef.token, rack.id, { subject_type: 'authenticated', rights: ['view'] })
  r = await read(dora.token, vm.id)
  t.check('„alle Angemeldeten" am Rack gilt bis zur VM', r.status === 200 && r.data?.view_auth === true, `status ${r.status} view_auth ${r.data?.view_auth}`)

  // Herausnehmen: die Kette reisst, die Lage bleibt.
  const vorher = await read(chef.token, vm.id)
  r = await t.patch(chef.token, vm.id, { parent: '' })
  t.check('herausgenommen behält die VM ihre Weltlage und verliert den Versatz',
    r.status === 200 && near(r.data?.lat, vorher.data.lat, 1e-9) && !r.data?.local, `local ${JSON.stringify(r.data?.local)}`)
  r = await read(dora.token, vm.id)
  t.check('… und Dora sieht sie nicht mehr', r.status === 404, `status ${r.status}`)
  await t.patch(chef.token, vm.id, { parent: server.id, local: { from: 'world' } })

  // ── Nur move: Versatz ja, Eltern nein ───────────────────────────────────
  await ace(chef.token, vm.id, { subject_type: 'user', subject: dora.id, rights: ['view', 'move'] })
  r = await t.patch(dora.token, vm.id, { local: { up: 2 } })
  t.check('move darf den Versatz ändern', r.status === 200 && r.data?.local?.up === 2, `status ${r.status}`)
  r = await t.patch(dora.token, vm.id, { parent: '' })
  t.check('move darf nicht umhängen', r.status === 403, `status ${r.status}`)

  // ── Löschen: nicht ohne Ansage ──────────────────────────────────────────
  r = await req(`/api/collections/objects/records/${rack.id}`, { method: 'DELETE', token: chef.token })
  t.check('ein Rack mit Inhalt lässt sich nicht nebenbei löschen', r.status === 409 && r.data?.code === 'has_children', `status ${r.status}`)
  r = await req(`/api/collections/objects/records/${rack.id}?children=delete`, { method: 'DELETE', token: chef.token })
  t.check('mitlöschen scheitert an Alices Gerät im Rack', r.status === 403 && r.data?.code === 'children_not_owned'
    && (r.data?.children || []).includes(eigenes.id), `status ${r.status} ${JSON.stringify(r.data)}`)
  r = await t.del(chef.token, `${rack.id}?children=detach`)
  t.check('mit „hochhängen" geht es', r.status === 204 || r.status === 200, `status ${r.status}`)
  s = await read(chef.token, server.id)
  t.check('der Server ist danach frei, mit seiner alten Lage',
    s.status === 200 && !s.data?.parent && near(s.data?.lat, LAT + 5 * M_LAT, 1e-7) && !s.data?.local, `parent ${JSON.stringify(s.data?.parent)} local ${JSON.stringify(s.data?.local)}`)
  s = await read(chef.token, vm.id)
  t.check('die VM hängt noch im Server', s.status === 200 && s.data?.parent === server.id, `parent ${s.data?.parent}`)
  r = await read(bob.token, server.id)
  t.check('Bobs geerbtes Recht ist mit dem Rack weg', r.status === 404, `status ${r.status}`)

  r = await t.del(chef.token, `${server.id}?children=delete`)
  s = await read(chef.token, vm.id)
  t.check('mitlöschen nimmt die VM mit', (r.status === 204 || r.status === 200) && s.status === 404, `del ${r.status} vm ${s.status}`)

  // ── Der Baum-Endpunkt ───────────────────────────────────────────────────
  const baum = (tiefe) => {
    let k = { name: `Ebene ${tiefe}` }
    for (let i = tiefe - 1; i >= 1; i--) k = { name: `Ebene ${i}`, container: {}, local: { up: 1 }, children: [k] }
    return k
  }
  r = await req('/api/objects/tree', { method: 'POST', token: chef.token, body: {
    objects: [{ name: 'Baum-Rack', type: 'poi', lat: LAT, lon: LON, altitude: 50, heading: 0, container: {}, state: {},
      children: [
        { name: 'S1', type: 'poi', local: { up: 1 } },
        { name: 'S2', type: 'poi', local: { up: 2 }, container: { view: 'exploded' }, children: [{ name: 'VM1', type: 'poi' }] },
      ] }],
  } })
  const wurzel = r.data?.objects?.[0]
  t.check('ein Baum entsteht in einem Aufruf', r.status === 200 && r.data?.count === 4 && wurzel?.children?.length === 2, `status ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`)
  if (wurzel) {
    const s2 = await read(chef.token, wurzel.children[1].id)
    const vm1 = await read(chef.token, wurzel.children[1].children[0].id)
    t.check('die Knoten sitzen am Rack, Versatz eingerechnet',
      s2.data?.parent === wurzel.id && near(s2.data?.altitude, 52, 0.001) && vm1.data?.parent === s2.data?.id && near(vm1.data?.altitude, 52, 0.001),
      `s2 ${s2.data?.altitude} vm1 ${vm1.data?.altitude}`)
    r = await req('/api/objects/tree', { method: 'POST', token: alice.token, body: { objects: [{ name: 'Fremd', parent: wurzel.id }] } })
    t.check('unter ein fremdes Rack ohne edit: nein', r.status === 403 && r.data?.code === 'parent_forbidden', `status ${r.status} ${r.data?.code}`)
    r = await req('/api/objects/tree', { method: 'POST', token: chef.token, body: { objects: [Object.assign(baum(7), { parent: wurzel.id })] } })
    t.check('acht Ebenen passen (Rack + 7)', r.status === 200 && r.data?.count === 7, `status ${r.status} ${r.data?.code || ''}`)
    r = await req('/api/objects/tree', { method: 'POST', token: chef.token, body: { objects: [Object.assign(baum(8), { parent: wurzel.id })] } })
    t.check('neun Ebenen nicht', r.status === 400 && r.data?.code === 'too_deep', `status ${r.status} ${r.data?.code}`)
    r = await req('/api/objects/tree', { method: 'POST', token: chef.token, body: { objects: [{ name: 'Ohne Abschnitt', lat: LAT, lon: LON, children: [{ name: 'Kind' }] }] } })
    t.check('Kinder ohne Container-Abschnitt: nein', r.status === 400 && r.data?.code === 'not_a_container', `status ${r.status}`)
    r = await t.del(chef.token, `${wurzel.id}?children=delete`)
    t.check('der Baum lässt sich mit Inhalt wieder löschen', r.status === 204 || r.status === 200, `status ${r.status}`)
  }
}
