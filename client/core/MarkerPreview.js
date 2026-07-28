// MarkerPreview — zeigt Bild-Marker als originalgetreue, texturierte Flächen an
// ihrer REALEN Geo-Pose im 3D-Raum. An-/abschaltbar (wie Debug-Wireframes).
//
// Konzept (siehe docs/realworld-remote.md): Ein Marker ist ein Datum am
// Ajna-Objekt — sein Bild + die reale Position/Ausrichtung/Größe. Damit ist die
// Echtwelt-Pose des Objekts exakt festgelegt (visueller Zwilling zu [[ajna-uwb]]).
// Diese Vorschau rendert das Marker-Bild dort, wo es real hängt — nützlich zum
// Platzieren/Prüfen, unabhängig von der Live-Detektion (die den metrischen Snap
// macht). Nutzt das globale window.BABYLON (App-Konvention).
//
// Marker-Datensatz: { id, image, lat, lon, alt?, headingDeg?, widthM?, heightM? }
//   • image      = Bild-URL (dasselbe, das als Target registriert wird)
//   • alt        = Höhe über Boden (m), Default 1.2 (Augenhöhe-nah)
//   • headingDeg = Kompassrichtung, in die die Marker-VORDERSEITE zeigt
//   • widthM     = reale Breite (m); heightM optional (Default = widthM)

const RAD = Math.PI / 180

export class MarkerPreview {
  /** @param {{scene:object, geo:object}} opts  geo = GeoTransformer */
  constructor({ scene, geo }) {
    this.scene = scene
    this.geo = geo
    this._meshes = []
    this._markers = []
    this._visible = true
  }

  /** Marker-Liste setzen und neu zeichnen. */
  set(markers) {
    this._markers = Array.isArray(markers) ? markers.slice() : []
    this._rebuild()
  }

  setVisible(on) { this._visible = !!on; for (const m of this._meshes) m.setEnabled(this._visible) }
  get visible() { return this._visible }

  _rebuild() {
    this.clear()
    if (!this.geo?.origin) return   // ohne Welt-Origin keine lokale Umrechnung
    for (const m of this._markers) { try { this._build(m) } catch (e) { console.warn('[marker] build:', e?.message || e) } }
    this.setVisible(this._visible)
  }

  _build(m) {
    const B = window.BABYLON
    if (!B || m == null || m.lat == null || m.lon == null) return
    const w = +m.widthM || 0.15
    const h = +m.heightM || w
    const plane = B.MeshBuilder.CreatePlane('marker_preview_' + (m.id ?? this._meshes.length),
      { width: w, height: h, sideOrientation: B.Mesh.DOUBLESIDE }, this.scene)
    // Reale Pose: Geo→lokal (alt = über Boden), Ausrichtung um die Hochachse.
    plane.position.copyFrom(this.geo.toLocalRef(m.lat, m.lon, m.alt == null ? 1.2 : +m.alt, 'ground'))
    plane.rotation.y = -(+m.headingDeg || 0) * RAD   // Vorderseite in headingDeg (Vorzeichen ggf. am Gerät justieren)

    const mat = new B.StandardMaterial('marker_mat_' + (m.id ?? this._meshes.length), this.scene)
    const tex = new B.Texture(m.image, this.scene, true /*noMipmap*/)
    mat.diffuseTexture = tex
    mat.emissiveTexture = tex           // selbstleuchtend → im AR-Bild sichtbar ohne Szenenlicht
    mat.disableLighting = true
    mat.backFaceCulling = false
    plane.material = mat
    plane.metadata = { markerId: m.id }
    plane.isPickable = false
    this._meshes.push(plane)
  }

  clear() {
    for (const p of this._meshes) { try { p.material?.dispose(true, true) } catch {} try { p.dispose() } catch {} }
    this._meshes = []
  }

  dispose() { this.clear(); this._markers = [] }
}
