// PathOverlay — zeichnet die in `object.state.walk_path` hinterlegten
// Polylines als Debug-Hilfslinien in die AR-Szene.
//
// Der Agent setzt das Feld zu Beginn eines Walks und löscht es beim
// Stoppen. Der Overlay reagiert auf jedes onObjectsChanged-Event und
// hält die Linien synchron mit den Records — Hinzufügen, Aktualisieren,
// Entfernen.
//
// Render: pro Pfad ein `CreateLines`-Mesh, leuchtend grün, knapp über
// dem Boden. Y-Offset größer als OSMContext, damit die Debug-Linie
// nicht im Straßen-Wireframe verschwindet.

const PATH_COLOR = new BABYLON.Color4(0.2, 1.0, 0.5, 1.0)
const Y_OFFSET   = 0.15

export class PathOverlay {
  /**
   * @param {BABYLON.Scene} scene
   * @param {object} geo  GeoTransformer mit `toLocal(lat, lon, alt)`
   */
  constructor(scene, geo) {
    this.scene = scene
    this.geo = geo
    /** @type {Map<string, BABYLON.LinesMesh>} */
    this.meshes = new Map()
  }

  /**
   * Mit jeder onObjectsChanged-Liste füttern. Idempotent — gleicher Pfad
   * wird nicht neu gemesht.
   */
  update(objects) {
    const seen = new Set()
    for (const obj of objects) {
      const path = obj.state?.walk_path
      if (!Array.isArray(path) || path.length < 2) continue
      seen.add(obj.id)
      this._drawIfChanged(obj.id, path)
    }
    for (const id of Array.from(this.meshes.keys())) {
      if (!seen.has(id)) this._remove(id)
    }
  }

  _drawIfChanged(id, path) {
    const key = JSON.stringify(path)
    const existing = this.meshes.get(id)
    if (existing && existing._pathKey === key) return
    if (existing) existing.dispose()

    const points = path.map(([lat, lon]) => {
      const v = this.geo.toLocal(lat, lon, 0)
      return new BABYLON.Vector3(v.x, Y_OFFSET, v.z)
    })
    const mesh = BABYLON.MeshBuilder.CreateLines(
      `path_${id}`, { points }, this.scene
    )
    mesh.color = PATH_COLOR
    mesh.isPickable = false
    mesh._pathKey = key
    this.meshes.set(id, mesh)
  }

  _remove(id) {
    const m = this.meshes.get(id)
    if (m) { try { m.dispose() } catch {} }
    this.meshes.delete(id)
  }

  dispose() {
    for (const id of Array.from(this.meshes.keys())) this._remove(id)
  }
}
