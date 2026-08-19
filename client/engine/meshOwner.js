// Rückverweis Mesh → GameObject, sicher gegen eine Babylon-Falle.
//
// Für Pointer-Picking, Hover und das Aktionsmenü muss ein angeklicktes Mesh
// sagen können, zu welchem GameObject es gehört. Der übliche Weg ist
// `mesh.metadata.gameObject = go`.
//
// DIE FALLE: Seit dem AssetContainer-Cache wird jedes Modell EINMAL geparst und
// pro Objekt instanziiert (`instantiateModelsToScene`). Babylon kopiert dabei im
// Mesh-Copy-Konstruktor die metadata-REFERENZ, nicht deren Inhalt:
//
//     if (source.metadata && source.metadata.clone) this.metadata = source.metadata.clone()
//     else                                         this.metadata = source.metadata   // ← geteilt
//
// Der glTF-Lader hängt an jedes Mesh ein `metadata`-Objekt (gltf-Pointer). Damit
// ist `source.metadata` immer gesetzt, hat aber kein `clone()` — alle Instanzen
// desselben Modells zeigten auf DASSELBE Objekt. Ein `mesh.metadata.gameObject = this`
// überschrieb dann den Eintrag aller Geschwister: jede Figur mit „Soldier.glb"
// meldete beim Antippen den Namen der zuletzt gebauten Soldier-Figur.
//
// Deshalb hier IMMER ein eigenes Objekt anlegen statt das vorhandene zu ändern.
// Die Felder des Laders bleiben erhalten, die Referenz wird gelöst.

/**
 * Mesh dem GameObject zuordnen, ohne eine geteilte metadata-Referenz zu ändern.
 * @param {object} mesh        Babylon-Mesh/InstancedMesh
 * @param {object} gameObject  Besitzer
 */
export function tagMeshOwner(mesh, gameObject) {
  if (!mesh) return
  mesh.metadata = { ...(mesh.metadata || {}), gameObject }
}

/**
 * Zugehöriges GameObject eines Meshes (oder null).
 * @param {object} mesh
 */
export const ownerOf = (mesh) => mesh?.metadata?.gameObject || null
