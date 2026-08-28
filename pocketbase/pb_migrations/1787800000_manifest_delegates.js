/// <reference path="../pb_data/types.d.ts" />
//
// `agent_manifests.delegates` — weitere Konten, die einen Agent-Namen führen
// dürfen.
//
// DAS PROBLEM: Ein Betreiber rollt seine Agents unter einem zweiten Konto aus
// (neue Anmeldedaten, zweiter Satz Prozesse). Der Unique-Index ist
// `(source, owner)` — das zweite Konto legt also eine NEUE Manifest-Zeile an
// statt die vorhandene zu aktualisieren. Der Client führt den Namensinhaber je
// Server über den ältesten Eintrag; alles, was das zweite Konto anlegt, trägt
// danach ein rotes „⚠ angeblich …". Sachlich richtig — und trotzdem falsch,
// weil beide Konten demselben Menschen gehören.
//
// DIE LÖSUNG: Der Namensinhaber benennt die Konten, die den Namen ebenfalls
// führen dürfen. `provenanceOf()` akzeptiert dann Objekte dieser Konten.
//
// WARUM DAS KEIN LOCH REISST — und warum es dafür KEINEN Hook braucht:
//
//   • `updateRule` ist `owner = @request.auth.id`. Ein Konto kann also nur sein
//     EIGENES Manifest schreiben. Ein Fremdkonto kann sich nirgends selbst
//     eintragen.
//   • Gelesen werden ausschließlich die `delegates` DES NAMENSINHABERS. Ein
//     Angreifer, der ein zweites Manifest für „overpass" anlegt und sich darin
//     selbst delegiert, ändert nichts: Sein Manifest ist nicht das älteste,
//     also wird es ohnehin verworfen — samt seiner Delegationsliste.
//   • Inhaber zu WERDEN geht nicht: `created` ist ein autodate, der Server
//     setzt es. Später angelegt heißt später, dagegen hilft kein Trick.
//
// Die Delegation ist damit eine Aussage, die nur derjenige treffen kann, der
// den Namen bereits hält — genau die Eigenschaft, die eine Vertrauenskette
// braucht.
//
// FORMAT: Liste von Konto-IDs (`["5skgyzdw4a53ood", …]`). Konto-IDs gelten nur
// auf ihrem Server; eine serverübergreifende Delegation gibt es bewusst nicht.

migrate((app) => {
  const c = app.findCollectionByNameOrId('agent_manifests')
  c.fields.add(new Field({
    type: 'json',
    name: 'delegates',
    required: false,
    maxSize: 4000,
  }))
  return app.save(c)
}, (app) => {
  const c = app.findCollectionByNameOrId('agent_manifests')
  const f = c.fields.getByName('delegates')
  if (f) c.fields.removeById(f.id)
  return app.save(c)
})
