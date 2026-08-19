/// <reference path="../pb_data/types.d.ts" />
//
// `agent_manifests` bekommt `created`/`updated`.
//
// WARUM: Der Client bestimmt den Inhaber eines Source-Namens über den ZUERST
// registrierten Eintrag (siehe AgentFilters.refreshManifests) — ein fremdes
// Konto soll den Anzeigenamen einer bestehenden Quelle nicht überschreiben
// können. Ohne Zeitstempel gibt es kein „zuerst".
//
// Die ursprüngliche Migration notierte „System-Felder (created/updated) werden
// von PB automatisch ergänzt". Das stimmt für PocketBase 0.36 nicht mehr:
// Zeitstempel sind explizite `autodate`-Felder. Die Manifeste hatten deshalb
// gar kein `created` — die API lieferte `undefined`.
//
// GRENZE: Bestehende Datensätze bekommen alle denselben Zeitpunkt (den der
// Migration). Für sie entscheidet weiterhin der stabile Zweitschlüssel (kleinste
// ID) — willkürlich, aber wenigstens deterministisch. Erst ab jetzt bildet die
// Reihenfolge die echte Registrierung ab. Die dauerhafte Lösung ist eine
// serverseitige Bindung von `state.source` an den Inhaber.

migrate((app) => {
  const c = app.findCollectionByNameOrId('agent_manifests')
  c.fields.add(new Field({
    id: 'autodate2990389176', name: 'created', type: 'autodate',
    onCreate: true, onUpdate: false, hidden: false, presentable: false, system: false,
  }))
  c.fields.add(new Field({
    id: 'autodate3332085495', name: 'updated', type: 'autodate',
    onCreate: true, onUpdate: true, hidden: false, presentable: false, system: false,
  }))
  return app.save(c)
}, (app) => {
  const c = app.findCollectionByNameOrId('agent_manifests')
  for (const name of ['created', 'updated']) {
    const f = c.fields.getByName(name)
    if (f) c.fields.removeById(f.id)
  }
  return app.save(c)
})
