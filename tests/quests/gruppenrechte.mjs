// Gruppen-Rechte — direkt geprüft, nicht nur nebenbei.
//
// ANLASS: Beim Bau der Prüfgruppe stellte sich heraus, dass
// `transitiveGroupsOf()` IMMER eine leere Liste lieferte — der Filter
// `members ?= {:uid}` trifft in dieser PocketBase-Fassung nicht. Damit gewährte
// eine Gruppen-ACE nie ein Recht und Untergruppen wurden nie aufgelöst, ohne
// dass irgendetwas Alarm schlug: Alle bestehenden Prüfungen benutzten ACEs vom
// Typ `authenticated`, und die kommen ohne Gruppenauflösung aus.
//
// Diese Suite schliesst die Lücke: Sie prüft den Produktionspfad, um den es
// wirklich geht — ein Objekt, das nur einer Gruppe gehört, und die Frage, wer
// es sehen darf.

export const name = 'Gruppen-Rechte und Untergruppen'

export async function run(t) {
  const A = await t.user('owner')     // Besitzer des Objekts
  const M = await t.user('mitglied')  // Mitglied der Gruppe
  const U = await t.user('untergr')   // Mitglied einer UNTERgruppe
  const X = await t.user('fremd')     // gehört nirgends dazu

  const gruppe = async (name, body) => {
    const r = await t.raw('/api/collections/groups/records', {
      method: 'POST', token: A.token, body: { name, owner: A.id, ...body },
    })
    return r.data
  }

  const klein = await gruppe('QTest Untergruppe', { members: [U.id] })
  const gross = await gruppe('QTest Hauptgruppe', { members: [M.id], subgroups: [klein?.id] })
  t.check('beide Gruppen angelegt', !!klein?.id && !!gross?.id,
    JSON.stringify({ klein: klein?.id, gross: gross?.id }))
  if (!klein?.id || !gross?.id) return
  t.check('Untergruppe ist eingehängt', (gross.subgroups || []).includes(klein.id),
    'subgroups=' + JSON.stringify(gross.subgroups))

  // Objekt, das NUR die große Gruppe sehen darf.
  const obj = await t.object(A.token, {
    name: 'QTest Gruppenobjekt', type: 'item',
    lat: 50.4466, lon: 7.5971, altitude: 0, state: {},
  })
  const ace = await t.raw('/api/collections/object_permissions/records', {
    method: 'POST', token: A.token,
    body: { object: obj.id, subject_type: 'group', subject: gross.id, rights: ['view'], interact_actions: [] },
  })
  t.check('Gruppen-ACE angelegt', ace.status === 200,
    'HTTP ' + ace.status + ' ' + JSON.stringify(ace.data).slice(0, 120))

  const sieht = async (u) => (await t.read(u.token, obj.id))?.id === obj.id

  t.check('direktes Mitglied sieht das Objekt', await sieht(M))
  t.check('Mitglied der Untergruppe sieht es ebenfalls', await sieht(U))
  t.check('Aussenstehende sehen es nicht', !(await sieht(X)))
  t.check('der Besitzer sieht es ohnehin', await sieht(A))

  // Nachträgliche Mitgliedschaft muss ebenfalls greifen — daran hängt der
  // Recompute des Rechte-Zwischenspeichers.
  const r = await t.raw(`/api/collections/groups/records/${gross.id}`, {
    method: 'PATCH', token: A.token, body: { members: [M.id, X.id] },
  })
  t.check('Mitglied nachträglich aufgenommen', r.status === 200, 'HTTP ' + r.status)
  t.check('und sieht das Objekt jetzt auch', await sieht(X))
}
