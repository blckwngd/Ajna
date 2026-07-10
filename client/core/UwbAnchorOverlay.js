// UwbAnchorOverlay — blendet UWB-Anker zu Debug-Zwecken im 3D-Raum ein.
//
// Anker sind Infrastruktur (type 'uwb_anchor') mit EXAKTER 3D-Weltposition
// (lat/lon/altitude). Dieses Overlay zeigt sie NICHT als Spielobjekte, sondern
// als eigene Debug-Marker — jeweils an ihrer echten 3D-Position:
//   • Beacon (Oktaeder) an der Ankerposition (inkl. Höhe),
//   • ein Pfeiler vom Boden (y=0) bis zum Beacon → macht die HÖHE sichtbar,
//   • ein Billboard-Label mit Node-ID + Höhe (+ Netz).
// Umschaltbar (Debug-Flag, per Gerät). Statisch — Anker bewegen sich nicht, also
// kein Per-Frame-Update; nur Reconcile bei Änderung der Anker-Liste.

const FLAG_KEY = 'ajna.debug.show_uwb_anchors'
const COLORS = ['#22d3ee', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#38bdf8']

export class UwbAnchorOverlay {
  /** @param {{scene:object, geo:object, ajna:object}} opts */
  constructor({ scene, geo, ajna }) {
    this.scene = scene
    this.geo = geo
    this.ajna = ajna
    this._root = new BABYLON.TransformNode('uwbAnchorsOverlay', scene)
    this._markers = new Map()   // objectId -> TransformNode
    this._sig = null
    this._visible = UwbAnchorOverlay.isEnabled()
    this._root.setEnabled(this._visible)
  }

  static isEnabled() { try { return localStorage.getItem(FLAG_KEY) === '1' } catch { return false } }
  static setEnabled(on) { try { localStorage.setItem(FLAG_KEY, on ? '1' : '0') } catch {} }

  setVisible(on) {
    this._visible = !!on
    UwbAnchorOverlay.setEnabled(this._visible)
    this._root.setEnabled(this._visible)
    if (this._visible) this.refresh()
  }
  toggle() { this.setVisible(!this._visible) }

  // Marker an die aktuelle Anker-Liste angleichen (nur bei struktureller Änderung
  // neu bauen — id/lat/lon/alt-Signatur, nicht pro Frame).
  refresh() {
    if (!this._visible || !this.geo?.origin) return
    const anchors = (this.ajna.getObjectList?.() || [])
      .filter(o => (o.type || '').toLowerCase() === 'uwb_anchor' &&
                   Number.isFinite(o.lat) && Number.isFinite(o.lon))
    const sig = anchors.map(a => `${a.id}:${a.lat.toFixed(7)}:${a.lon.toFixed(7)}:${a.altitude ?? 0}:${a.state?.uwb?.nodeId ?? ''}`).join('|')
    if (sig === this._sig) return
    this._sig = sig

    const present = new Set(anchors.map(a => a.id))
    for (const [id, node] of this._markers) {
      if (!present.has(id)) { node.dispose(false, true); this._markers.delete(id) }
    }
    for (const a of anchors) this._ensureMarker(a)
  }

  _ensureMarker(a) {
    const old = this._markers.get(a.id)
    if (old) { old.dispose(false, true); this._markers.delete(a.id) }

    const ref = a.state?.altitude_ref === 'msl' ? 'msl' : 'ground'
    const p = this.geo.toLocalRef(a.lat, a.lon, a.altitude || 0, ref)
    if (!p) return
    const height = Math.max(0, p.y)
    const nodeId = a.state?.uwb?.nodeId
    const net = a.state?.uwb?.network
    const color = BABYLON.Color3.FromHexString(COLORS[Number.isFinite(nodeId) ? nodeId % COLORS.length : 0])

    const node = new BABYLON.TransformNode(`uwbAnchor_${a.id}`, this.scene)
    node.parent = this._root
    node.position = new BABYLON.Vector3(p.x, 0, p.z)

    const mat = new BABYLON.StandardMaterial(`uwbMat_${a.id}`, this.scene)
    mat.diffuseColor = color
    mat.emissiveColor = color.scale(0.7)

    // Höhen-Pfeiler vom Boden bis zum Beacon (macht die 3D-Höhe sichtbar).
    if (height > 0.05) {
      const pole = BABYLON.MeshBuilder.CreateCylinder(`uwbPole_${a.id}`,
        { height, diameter: 0.03, tessellation: 6 }, this.scene)
      pole.position.y = height / 2
      pole.material = mat
      pole.isPickable = false
      pole.parent = node
    }

    // Beacon (Oktaeder) an der echten Ankerposition.
    const beacon = BABYLON.MeshBuilder.CreatePolyhedron(`uwbBeacon_${a.id}`,
      { type: 1, size: 0.12 }, this.scene)   // type 1 = Oktaeder
    beacon.position.y = height
    beacon.material = mat
    beacon.isPickable = true
    beacon.metadata = { uwbAnchorId: a.id }   // für späteres „bearbeiten" (Maßnahme 2)
    beacon.parent = node

    // Boden-Ring als Standfuß-Markierung (auch wenn der Anker hoch hängt).
    const base = BABYLON.MeshBuilder.CreateDisc(`uwbBase_${a.id}`,
      { radius: 0.18, tessellation: 20 }, this.scene)
    base.rotation.x = Math.PI / 2
    base.position.y = 0.02
    base.material = mat
    base.isPickable = false
    base.parent = node

    // Billboard-Label: Node-ID + Höhe (+ Netz).
    const label = this._makeLabel(a.id, nodeId, height, net, color)
    if (label) { label.position.y = height + 0.35; label.parent = node }

    this._markers.set(a.id, node)
  }

  _makeLabel(id, nodeId, height, net, color) {
    const lines = [
      `⚓ #${Number.isFinite(nodeId) ? nodeId : '?'}`,
      `${height.toFixed(2)} m${net != null ? ` · ${net}` : ''}`
    ]
    const dt = new BABYLON.DynamicTexture(`uwbLbl_${id}`, { width: 256, height: 128 }, this.scene, true)
    dt.hasAlpha = true
    const ctx = dt.getContext()
    ctx.clearRect(0, 0, 256, 128)
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(0, 0, 256, 128)
    ctx.font = 'bold 40px sans-serif'
    ctx.fillStyle = color.toHexString()
    ctx.textAlign = 'center'
    ctx.fillText(lines[0], 128, 50)
    ctx.font = '30px sans-serif'
    ctx.fillStyle = '#ffffff'
    ctx.fillText(lines[1], 128, 96)
    dt.update()

    const plane = BABYLON.MeshBuilder.CreatePlane(`uwbLblPlane_${id}`, { width: 0.9, height: 0.45 }, this.scene)
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
    plane.isPickable = false
    const lm = new BABYLON.StandardMaterial(`uwbLblMat_${id}`, this.scene)
    lm.diffuseTexture = dt
    lm.emissiveColor = new BABYLON.Color3(1, 1, 1)
    lm.opacityTexture = dt
    lm.backFaceCulling = false
    lm.disableLighting = true
    plane.material = lm
    return plane
  }

  dispose() {
    for (const [, n] of this._markers) n.dispose(false, true)
    this._markers.clear()
    this._root.dispose()
  }
}
