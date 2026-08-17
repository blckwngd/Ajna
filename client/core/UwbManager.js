// UwbManager — UWB precise positioning hub, INDEPENDENT of the wand.
//
// Role-aware: the AR viewer (phone) and the wand controller have different pose
// needs, so the layer carries N independent UWB tags with named roles, each its
// own BLE connection, all sharing ONE anchor→world transform:
//   • 'viewer'      — phone/body, anchors the AR camera's global position
//   • 'wand-origin' — the wand's pointing-ray origin
//   • 'wand-tip'    — optional, magnetometer-free pointing direction
// "1 module vs 2 modules" is then just a band-fitting decision, not an
// architecture change.
//
// Model A (now): each node's onboard Location Engine yields a DWM-local position
// (mm); this hub aligns it to the world via anchors stored in Ajna and emits a
// world position per role. Privacy-first: computed and used ON-DEVICE only.
// Model B (later): on-device multilateration from `uwbDistances` (per role).

import { solvePositionFromRanges } from './UwbMultilateration.js'
import { wgs84ToEnu, enuToWgs84 } from './geoMath.js'

const LOG = '[uwb]'

// Remembered BLE devices per role → gesture-free reconnect by address on boot.
// Native BLE (Capacitor plugin) may reconnect by stored address without a user
// gesture (unlike Web-Bluetooth), so a once-paired tag comes back on its own.
const DEV_KEY  = 'ajna.uwb.devices'      // JSON { [role]: { address, name, ts } }
const AUTO_KEY = 'ajna.uwb.autoconnect'  // '0' disables auto-reconnect; default on

// Normalize a PANS network id to a comparable form. Ids come from JSON, the UI,
// or DRTLS (decimal or hex string); compare as trimmed strings so "0x89AB",
// "0X89AB" and a number all unify. Empty/nullish → null ("all anchors").
function normNet(v) {
  if (v == null || v === '') return null
  const s = String(v).trim().toLowerCase()
  return s === '' ? null : s
}

export class UwbManager {
  /**
   * @param {object} opts
   * @param {import('./AjnaManager.js').AjnaManager} opts.ajna  source of anchors
   * @param {(text:string)=>void} [opts.notify]
   * @param {'onboard'|'ranging'} [opts.mode]  positioning model (default 'onboard' = A)
   * @param {string|number|null} [opts.network]  active PANS network id filter (null = all anchors)
   */
  constructor({ ajna, notify, mode = 'onboard', network = null } = {}) {
    this.ajna = ajna
    this.notify = notify || ((t) => console.log(LOG, t))
    this.mode = mode
    this._networkId = normNet(network)   // active PANS network filter (null = all)
    this._networks = []                  // [{ id, networkId, name, obj }]
    this._networksSig = null             // change-detect signature for callbacks
    this._networkCbs = new Set()
    this._lastAnchorRefresh = 0          // throttles the empty-map refresh on the ranging hot path
    this.Uwb = null
    this._registered = false
    this._listeners = []
    this._nodes = new Map()      // role -> { connected, address, lastWorld }
    this._posCbs = new Map()     // role -> Set<cb>
    this._statusCbs = new Set()
    this._transform = null       // shared { origin, R, t, up }  (model A)
    this._anchorsByNode = new Map()  // nodeId -> { lat, lon, altitude }  (model B)
  }

  /** Switch positioning model: 'onboard' (A) or 'ranging' (B, own multilateration). */
  setMode(mode) {
    this.mode = mode === 'ranging' ? 'ranging' : 'onboard'
    this.notify(`UWB-Modell ${this.mode === 'ranging' ? 'B (eigene Multilateration)' : 'A (Onboard-Engine)'}`)
    return this.mode
  }
  get model() { return this.mode }

  // ── PANS network selection (shared/collaborative anchor sets) ─────────
  //
  // A `uwb_network` Ajna object publishes a PANS network (its real radio
  // network id) so several people can contribute anchors to the SAME network
  // via Ajna's normal object permissions (view = use, edit = add nodes). The
  // active network filters which anchors positioning uses; null = every anchor
  // (back-compatible with single-network deployments that tag no network).

  /** Active PANS network id filter, or null for "all anchors". */
  get network() { return this._networkId }

  /** Select the active network (id matches anchors' `state.uwb.network`). */
  setNetwork(networkId) {
    this._networkId = normNet(networkId)
    this.refreshAnchors()
    const net = this._networks.find(n => n.networkId === this._networkId)
    this.notify(this._networkId == null
      ? 'UWB-Netz: alle Anker'
      : `UWB-Netz: ${net?.name || this._networkId}`)
    // Selecting a network excludes untagged/other-network anchors — warn if that
    // leaves too few for a fix (a common "nothing works after switching" trap).
    if (this._networkId != null && this._anchorsByNode.size < 3) {
      this.notify(`UWB-Netz „${net?.name || this._networkId}": nur ${this._anchorsByNode.size} Anker zugeordnet – mind. 3 nötig`)
    }
    return this._networkId
  }

  /** Known networks (refreshed from Ajna). [{ id, networkId, name, obj }] */
  getNetworks() { this.refreshNetworks(); return this._networks }

  onNetworksChanged(cb) { this._networkCbs.add(cb); return () => this._networkCbs.delete(cb) }

  /** Rebuild the network list from `uwb_network` objects in Ajna. */
  refreshNetworks() {
    const entries = this.ajna?.objectMap ? [...this.ajna.objectMap.values()] : []
    const next = entries
      .filter(o => o?.type === 'uwb_network' && o?.state?.uwb_network)
      .map(o => {
        const networkId = normNet(o.state.uwb_network.networkId ?? o.state.uwb_network.panId)
        return { id: o.id, networkId, name: o.name || `Netz ${networkId}`, obj: o }
      })
      .filter(n => n.networkId != null)
    // refreshNetworks runs on the anchor-refresh path → only notify on a real
    // change, so subscribers don't get a callback storm every refresh.
    const sig = next.map(n => `${n.id}|${n.networkId}|${n.name}`).join(';')
    this._networks = next
    if (sig !== this._networksSig) {
      this._networksSig = sig
      this._networkCbs.forEach(cb => { try { cb(this._networks) } catch {} })
    }
    return this._networks
  }

  static async isAvailable() {
    try {
      const { Capacitor } = await import('@capacitor/core')
      return !!Capacitor?.isNativePlatform?.()
    } catch { return false }
  }

  async _ensurePlugin() {
    if (this._registered) return
    const { registerPlugin } = await import('@capacitor/core')
    this.Uwb = registerPlugin('Uwb')
    this._listeners.push(await this.Uwb.addListener('uwbStatus', (e) => this._onStatus(e)))
    this._listeners.push(await this.Uwb.addListener('uwbPosition', (e) => this._onPosition(e)))
    this._listeners.push(await this.Uwb.addListener('uwbDistances', (e) => this._onDistances(e)))
    this._listeners.push(await this.Uwb.addListener('uwbLog', (e) =>
      console.debug(LOG, e?.role || '?', 'native:', e?.message)))
    this._registered = true
  }

  /** Connect a UWB node for a role. Call multiple times for multiple roles. */
  async connect({ role = 'viewer', name = 'DW', address = null } = {}) {
    await this._ensurePlugin()
    this.refreshAnchors()
    if (!this._nodes.has(role)) this._nodes.set(role, { connected: false, address: null, lastWorld: null })
    // Remember which name we dialled so we can persist {address,name} once the
    // status event confirms the connection (the status carries the address).
    if (!this._pendingConnect) this._pendingConnect = new Map()
    this._pendingConnect.set(role, { name, address })
    await this.Uwb.connect(address ? { role, address } : { role, name })
    this.notify(`Verbinde UWB-Knoten „${role}" …`)
  }

  /** Backwards-compatible single-node entry (defaults to the 'viewer' role). */
  async start(opts = {}) { return this.connect(opts) }

  async disconnect(role = 'viewer') {
    try { await this.Uwb?.disconnect({ role }) } catch {}
    this._nodes.delete(role)
  }

  async stop() {
    for (const role of [...this._nodes.keys()]) { try { await this.Uwb?.disconnect({ role }) } catch {} }
    for (const l of this._listeners) { try { await l.remove() } catch {} }
    this._listeners = []
    this._registered = false
    this._nodes.clear()
  }

  // ── subscriptions / accessors ───────────────────────────────────────

  onPosition(role, cb) {
    if (!this._posCbs.has(role)) this._posCbs.set(role, new Set())
    this._posCbs.get(role).add(cb)
    return () => this._posCbs.get(role)?.delete(cb)
  }

  onStatusChange(cb) { this._statusCbs.add(cb); return () => this._statusCbs.delete(cb) }

  positionFor(role) { return this._nodes.get(role)?.lastWorld || null }
  isConnected(role) { return !!this._nodes.get(role)?.connected }
  roles() { return [...this._nodes.keys()] }

  /** Convenience: the 'viewer' role position (mirrors ajnaGeo.position shape). */
  get position() { return this.positionFor('viewer') }

  /**
   * Adapter so a single role plugs into FusedPositionSource (which expects an
   * object with onPosition(cb)). e.g. new FusedPositionSource(gps, uwb.roleSource('viewer')).
   */
  roleSource(role) {
    const self = this
    return {
      onPosition: (cb) => self.onPosition(role, cb),
      get position() { return self.positionFor(role) }
    }
  }

  /**
   * Wand pointing ray, if the relevant roles are connected. Origin from
   * 'wand-origin'; direction from 'wand-tip' (magnetometer-free) when present,
   * otherwise null (heading to be supplied by the wand's magnetometer later).
   */
  getWandRay() {
    const origin = this.positionFor('wand-origin')
    if (!origin) return null
    const tip = this.positionFor('wand-tip')
    let direction = null
    if (tip?.local && origin.local) {
      const dE = tip.local.E - origin.local.E
      const dN = tip.local.N - origin.local.N
      const dU = tip.local.U - origin.local.U
      const len = Math.hypot(dE, dN, dU)
      if (len > 1e-6) direction = { E: dE / len, N: dN / len, U: dU / len }
    }
    return { origin, direction }
  }

  // ── anchors (shared transform across all roles) ─────────────────────

  /**
   * Anchors are Ajna objects with `type === 'uwb_anchor'` carrying:
   *   lat / lon / altitude                       — world position
   *   state.uwb = { nodeId, local: { x, y, z } }  — DWM-local coords (mm)
   */
  refreshAnchors() {
    this.refreshNetworks()
    const entries = this.ajna?.objectMap ? [...this.ajna.objectMap.values()] : []
    const all = entries.filter(o =>
      o?.type === 'uwb_anchor' &&
      Number.isFinite(o?.lat) && Number.isFinite(o?.lon) &&
      Number.isFinite(o?.state?.uwb?.nodeId) &&
      // Filter to the active network when one is selected. Anchors without a
      // network tag belong to "all", so they're only kept when no network is
      // active (keeps existing single-network deployments working).
      (this._networkId == null || normNet(o.state.uwb.network) === this._networkId))
    // Model B: nodeId → world position (DWM-local coords NOT needed).
    this._anchorsByNode = new Map(all.map(o =>
      [o.state.uwb.nodeId, { lat: o.lat, lon: o.lon, altitude: o.altitude || 0 }]))
    // Model A: alignment transform needs the DWM-local coordinates.
    const withLocal = all.filter(o => o?.state?.uwb?.local && Number.isFinite(o.state.uwb.local.x))
    this._transform = withLocal.length >= 2 ? this._solveTransform(withLocal) : null
    if (this.mode === 'onboard' && !this._transform && withLocal.length) {
      this.notify(`UWB: ${withLocal.length} Anker – mind. 2 mit lokaler Position nötig`)
    }
    return all.length
  }

  // ── native events ───────────────────────────────────────────────────

  _node(role) {
    if (!this._nodes.has(role)) this._nodes.set(role, { connected: false, address: null, lastWorld: null })
    return this._nodes.get(role)
  }

  _onStatus(e) {
    const role = e?.role || 'viewer'
    const node = this._node(role)
    node.connected = !!e?.connected
    node.address = e?.address || null
    // Persist the tag on a successful connect so it reconnects on its own next
    // session (name from the dial we made, address from the plugin's status).
    if (node.connected && node.address) {
      const nm = e?.name || this._pendingConnect?.get(role)?.name || null
      this._rememberDevice(role, node.address, nm)
    }
    this.notify(node.connected ? `UWB „${role}" verbunden` : `UWB „${role}" getrennt`)
    this._statusCbs.forEach(cb => { try { cb(node.connected, node.address, role) } catch {} })
  }

  // ── remembered devices + gesture-free auto-reconnect ────────────────

  static autoConnectEnabled() { try { return localStorage.getItem(AUTO_KEY) !== '0' } catch { return true } }
  static setAutoConnect(on) { try { localStorage.setItem(AUTO_KEY, on ? '1' : '0') } catch {} }

  _loadDevices() { try { return JSON.parse(localStorage.getItem(DEV_KEY)) || {} } catch { return {} } }
  _saveDevices(d) { try { localStorage.setItem(DEV_KEY, JSON.stringify(d)) } catch {} }

  /** All remembered tags as [{ role, address, name, ts }]. */
  rememberedDevices() {
    const d = this._loadDevices()
    return Object.entries(d).map(([role, v]) => ({ role, ...v }))
  }
  /** Remembered tag for a role, or null. */
  rememberedDevice(role = 'viewer') { return this._loadDevices()[role] || null }

  _rememberDevice(role, address, name) {
    if (!address) return
    const d = this._loadDevices()
    const isNew = d[role]?.address !== address
    d[role] = { address, name: name || d[role]?.name || null, ts: Date.now() }
    this._saveDevices(d)
    if (isNew) this.notify(`Gerät gemerkt „${role}": ${name || 'Tag'} (${address}) – verbindet künftig automatisch`)
  }
  /** Forget a remembered tag (user action). */
  forgetDevice(role = 'viewer') {
    const d = this._loadDevices()
    if (d[role]) { delete d[role]; this._saveDevices(d) }
  }

  /**
   * Silently reconnect a remembered tag by address — no scan, no user gesture.
   * No-op if disabled, not native, already connected, or nothing remembered.
   * @returns {Promise<boolean>} whether a reconnect was attempted successfully.
   */
  async autoReconnect(role = 'viewer') {
    if (!UwbManager.autoConnectEnabled()) { this.notify(`Auto-Reconnect „${role}": deaktiviert (Einstellung aus)`); return false }
    if (this.isConnected(role)) { this.notify(`Auto-Reconnect „${role}": bereits verbunden`); return false }
    const dev = this.rememberedDevice(role)
    if (!dev?.address) { this.notify(`Auto-Reconnect „${role}": kein Gerät gemerkt – einmal manuell „UWB verbinden"`); return false }
    if (!(await UwbManager.isAvailable())) { this.notify(`Auto-Reconnect „${role}": nur in der App (Capacitor) verfügbar`); return false }
    this.notify(`Auto-Reconnect „${role}": verbinde ${dev.name || 'Tag'} (${dev.address}) …`)
    try {
      await this.connect({ role, address: dev.address, name: dev.name || undefined })
      // Verbindungserfolg/-fehler bestätigt der Status-Callback (_onStatus); kann
      // ein paar Sekunden dauern (BLE-Scan/GATT).
      return true
    } catch (e) {
      this.notify(`Auto-Reconnect „${role}" fehlgeschlagen: ${e?.message || e}`)
      console.warn(LOG, 'auto-reconnect failed', role, e?.message || e)
      return false
    }
  }

  _onPosition(e) {
    if (this.mode !== 'onboard') return
    const role = e?.role || 'viewer'
    const world = this._solve({ x: e.x, y: e.y, z: e.z, quality: e.quality })
    if (!world) return
    world.role = role
    this._node(role).lastWorld = world
    this._posCbs.get(role)?.forEach(cb => { try { cb(world) } catch {} })
  }

  // Model B: own multilateration from raw ranges + Ajna anchor world positions.
  _onDistances(e) {
    if (this.mode !== 'ranging') return
    const role = e?.role || 'viewer'
    // Anchors not loaded yet? Retry — but THROTTLED: this fires several Hz, and
    // refreshAnchors scans every Ajna object, so a no-anchor deployment must not
    // rescan on every range event. Once anchors exist this never runs.
    if (!this._anchorsByNode.size && this.ajna) {
      const now = Date.now()
      if (now - this._lastAnchorRefresh > 2000) { this._lastAnchorRefresh = now; this.refreshAnchors() }
    }

    const anchors = [], ranges = [], quals = []
    for (const d of (e?.distances || [])) {
      const a = this._anchorsByNode.get(d.nodeId)
      // Skip unknown anchors and non-finite/invalid ranges (a single Infinity
      // would otherwise poison the normal equations and drop the whole fix).
      if (!a || !(d.quality > 0) || !Number.isFinite(d.distance) || d.distance <= 0) continue
      anchors.push(a); ranges.push(d.distance / 1000); quals.push(d.quality)
    }
    if (anchors.length < 3) {
      this.notify(`UWB Ranging: nur ${anchors.length} bekannte Anker (≥3 nötig)`)
      return
    }
    const sol = solvePositionFromRanges({ anchors, ranges })
    if (!sol) return
    const quality = Math.round(quals.reduce((s, q) => s + q, 0) / quals.length)
    const world = {
      lat: sol.lat, lon: sol.lon, altitude: sol.altitude,
      local: sol.local, quality, gdop: sol.gdop, role, t: Date.now()
    }
    this._node(role).lastWorld = world
    this._posCbs.get(role)?.forEach(cb => { try { cb(world) } catch {} })
  }

  // ── positioning (model A: align DWM-local position → world) ──────────

  _solve(tag) {
    if (!this._transform && this.ajna) this.refreshAnchors()
    if (!this._transform) return null
    const { origin, R, t, up } = this._transform
    const lx = tag.x / 1000, ly = tag.y / 1000, lz = tag.z / 1000   // mm → m
    const E = R[0] * lx + R[1] * ly + t[0]
    const N = R[2] * lx + R[3] * ly + t[1]
    const U = lz + up
    const { lat, lon, altitude } = enuToWgs84(origin, E, N, U)
    return { lat, lon, altitude, local: { E, N, U }, quality: tag.quality, t: Date.now() }
  }

  /**
   * Least-squares optimal 2D rigid transform (rotation about vertical +
   * translation) from anchors' DWM-local horizontal coords to world ENU
   * horizontal coords. Vertical as mean offset. Closed-form, no SVD — robust
   * for the common coplanar-anchor (2D RTLS) deployment. ≥2 anchors needed.
   */
  _solveTransform(anchors) {
    const origin = { lat: anchors[0].lat, lon: anchors[0].lon, altitude: anchors[0].altitude || 0 }
    const src = [], dst = []
    let upSum = 0
    for (const a of anchors) {
      const enu = wgs84ToEnu(origin, a.lat, a.lon, a.altitude || 0)
      src.push([a.state.uwb.local.x / 1000, a.state.uwb.local.y / 1000])
      dst.push([enu.E, enu.N])
      upSum += enu.U - (a.state.uwb.local.z / 1000)
    }
    const n = src.length
    const cS = centroid(src), cD = centroid(dst)
    let dot = 0, cross = 0
    for (let i = 0; i < n; i++) {
      const sx = src[i][0] - cS[0], sy = src[i][1] - cS[1]
      const dx = dst[i][0] - cD[0], dy = dst[i][1] - cD[1]
      dot   += sx * dx + sy * dy
      cross += sx * dy - sy * dx
    }
    const theta = Math.atan2(cross, dot)
    const cos = Math.cos(theta), sin = Math.sin(theta)
    const R = [cos, -sin, sin, cos]
    const t = [
      cD[0] - (R[0] * cS[0] + R[1] * cS[1]),
      cD[1] - (R[2] * cS[0] + R[3] * cS[1])
    ]
    this.notify(`UWB-Alignment: ${n} Anker, θ=${(theta * 180 / Math.PI).toFixed(1)}°`)
    return { origin, R, t, up: upSum / n }
  }
}

// ── equirectangular WGS84 ↔ local ENU metres (matches GeoTransformer) ──



function centroid(pts) {
  let x = 0, y = 0
  for (const p of pts) { x += p[0]; y += p[1] }
  return [x / pts.length, y / pts.length]
}
