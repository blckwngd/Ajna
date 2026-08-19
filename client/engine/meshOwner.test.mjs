// Validation für meshOwner: Instanzen desselben Modells dürfen sich ihren
// Rückverweis auf das GameObject NICHT teilen.
//
// Warum ein Test mit echtem Babylon statt einer Attrappe: Der Fehler steckte
// nicht in unserem Code, sondern in einer Eigenheit von Babylon — der
// Mesh-Copy-Konstruktor übernimmt die metadata-REFERENZ, wenn das Objekt kein
// `clone()` hat. Eine Attrappe hätte das nachgebaut, was wir glauben, nicht das,
// was passiert. Deshalb: NullEngine, echter AssetContainer, echtes
// instantiateModelsToScene.
//
// Symptom im Feld: jede Figur mit „Soldier.glb" meldete beim Antippen den Namen
// der zuletzt gebauten Soldier-Figur.
//
// Run: node client/engine/meshOwner.test.mjs
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '@babylonjs/core/scene.js'
import { AssetContainer } from '@babylonjs/core/assetContainer.js'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js'
import { Skeleton } from '@babylonjs/core/Bones/skeleton.js'
import { Bone } from '@babylonjs/core/Bones/bone.js'
import { Matrix } from '@babylonjs/core/Maths/math.vector.js'
import { tagMeshOwner, ownerOf } from './meshOwner.js'

let failures = 0
const assert = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failures++ }
}

const engine = new NullEngine()
const scene = new Scene(engine)

/**
 * Ein Modell wie es aus einer GLB kommt: Wurzel + Kind, und an JEDEM Mesh ein
 * metadata-Objekt — der glTF-Lader hängt dort seine Pointer hinein. Genau das
 * macht die Referenz teilbar.
 */
function containerBauen(name, { mitSkelett, mitLaderMetadata }) {
  const root = MeshBuilder.CreateBox(`${name}_root`, {}, scene)
  const kind = MeshBuilder.CreateBox(`${name}_kind`, {}, scene)
  kind.parent = root
  if (mitLaderMetadata) {
    root.metadata = { gltf: { pointers: ['/nodes/0'] } }
    kind.metadata = { gltf: { pointers: ['/nodes/1'] } }
  }
  const c = new AssetContainer(scene)
  c.meshes.push(root, kind)
  c.rootNodes.push(root)
  if (mitSkelett) {
    const sk = new Skeleton(`${name}_sk`, name, scene)
    new Bone('b0', sk, null, Matrix.Identity())
    kind.skeleton = sk
    c.skeletons.push(sk)
  }
  scene.removeMesh(root)
  scene.removeMesh(kind)
  return c
}

const meshesVon = (inst) => {
  const r = inst.rootNodes[0]
  return [r, ...r.getChildMeshes(false)]
}

// Beide Pfade prüfen: instantiateModelsToScene klont Meshes MIT Skelett und
// instanziiert die ohne — die Figuren im Spiel sind geskinnt, Requisiten nicht.
for (const mitSkelett of [true, false]) {
  const art = mitSkelett ? 'geskinnt (Klon)' : 'starr (Instanz)'
  console.log(`\n── ${art}`)

  const container = containerBauen(`m_${mitSkelett}`, { mitSkelett, mitLaderMetadata: true })
  const a = container.instantiateModelsToScene(n => `${n}_A`, false)
  const b = container.instantiateModelsToScene(n => `${n}_B`, false)

  const figurA = { name: 'Nik Kraus' }
  const figurB = { name: 'Mara Vogt' }
  for (const m of meshesVon(a)) tagMeshOwner(m, figurA)
  for (const m of meshesVon(b)) tagMeshOwner(m, figurB)

  assert(meshesVon(a).every(m => ownerOf(m) === figurA),
    'erste Figur behält ihren Rückverweis, nachdem die zweite gebaut wurde')
  assert(meshesVon(b).every(m => ownerOf(m) === figurB),
    'zweite Figur zeigt auf sich selbst')
  assert(meshesVon(a).every(m => m.metadata?.gltf),
    'Felder des glTF-Laders bleiben erhalten')
  assert(meshesVon(a)[0].metadata !== meshesVon(b)[0].metadata,
    'beide Instanzen haben eigene metadata-Objekte')

  // Gegenprobe: der naive Weg (vorhandenes Objekt ändern) fällt herein. Wenn
  // Babylon das eines Tages ändert, schlägt DIESE Zeile fehl — dann ist der
  // Schutz überflüssig geworden, nicht kaputt.
  const c = container.instantiateModelsToScene(n => `${n}_C`, false)
  const d = container.instantiateModelsToScene(n => `${n}_D`, false)
  const naiv = (inst, marke) => {
    for (const m of meshesVon(inst)) {
      if (!m.metadata) m.metadata = {}
      m.metadata.gameObject = marke
    }
  }
  naiv(c, 'C'); naiv(d, 'D')
  assert(meshesVon(c).every(m => m.metadata.gameObject === 'D'),
    'Gegenprobe: der naive Weg teilt die Referenz weiterhin (Schutz nötig)')
}

// Ohne Lader-Metadata gab es das Problem nie — deshalb fiel es bei
// Platzhalter-Meshes und selbst gebauten Formen nicht auf.
console.log('\n── ohne Lader-Metadata')
const blank = containerBauen('blank', { mitSkelett: true, mitLaderMetadata: false })
const e = blank.instantiateModelsToScene(n => `${n}_E`, false)
const f = blank.instantiateModelsToScene(n => `${n}_F`, false)
for (const m of meshesVon(e)) tagMeshOwner(m, 'E')
for (const m of meshesVon(f)) tagMeshOwner(m, 'F')
assert(meshesVon(e).every(m => ownerOf(m) === 'E'), 'auch ohne Lader-Metadata getrennt')

console.log(failures === 0 ? '\nAll meshOwner tests passed.' : `\n${failures} test(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
