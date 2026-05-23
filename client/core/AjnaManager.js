import PocketBase from 'pocketbase'
import { AjnaClient } from './AjnaClient.js'

const DEFAULT_SERVER_ID = 'default'

/**
 * AjnaManager — Federation über N {@link AjnaClient}-Instanzen.
 *
 * In Phase 1 läuft die Manager-Instanz mit genau einem Default-Client,
 * sodass alle Aufrufstellen unverändert weiterfunktionieren. Spätere
 * Phasen erlauben weitere Clients via `addServer()` / `removeServer()`.
 *
 * **Composite-ID-Konvention:** Records, die der Manager nach außen
 * gibt, haben `id = "<serverId>:<rohId>"` und `_origin = serverId`.
 * Operationen mit composite ID werden anhand des Server-Präfix an den
 * richtigen AjnaClient delegiert. Wer eine rohe ID übergibt, landet
 * implizit beim Default-Client — das hält bestehende Skripte (z. B.
 * agent.js mit hartkodierten PB-IDs) lauffähig.
 *
 * Backward-Compat:
 *   • Constructor-Signatur (String-URL ODER `{url, pb}`) bleibt erhalten.
 *   • `manager.pb` zeigt auf den Default-PB — für Code, der noch direkt
 *     auf PB-Internals zugreift. Diesen Pfad sollte neuer Code meiden;
 *     für ID-tragende Calls gibt es `subscribeInteract()` / `interact()`.
 */
export class AjnaManager {
  /**
   * @param {string | {url?: string, pb?: PocketBase}} [urlOrOpts]
   */
  constructor(urlOrOpts = 'http://localhost:8090') {
    const opts = typeof urlOrOpts === 'string' ? { url: urlOrOpts } : urlOrOpts

    /** @type {Map<string, AjnaClient>}  serverId → client */
    this.clients = new Map()
    this._defaultId = DEFAULT_SERVER_ID

    const defaultClient = new AjnaClient({
      id: this._defaultId,
      url: opts.url,
      pb: opts.pb,
      label: 'default'
    })
    this.clients.set(this._defaultId, defaultClient)

    /** @type {Set<(snapshot: object[]) => void>} */
    this._objectsChangedListeners = new Set()

    // Pro Client einen onObjectsChanged-Subscriber: bei jedem Event
    // emittieren wir den vereinigten Snapshot aller Clients.
    this._wireClientListeners(defaultClient)
  }

  // ===================================================================
  //  Default / Direct-PB Backward-Compat
  // ===================================================================

  /** @returns {AjnaClient} */
  get defaultClient() { return this.clients.get(this._defaultId) }

  /**
   * Rohe PB-Instance des Default-Clients. Für ID-tragende Calls den
   * Manager verwenden — `pb` löst die Routing-Frage nicht.
   */
  get pb() { return this.defaultClient.pb }

  // ===================================================================
  //  ID-Routing
  // ===================================================================

  /** Parst `"<serverId>:<rawId>"`; falls keine Server-Komponente, Default. */
  _split(compositeId) {
    if (typeof compositeId !== 'string') return { serverId: this._defaultId, rawId: compositeId }
    const i = compositeId.indexOf(':')
    if (i < 0) return { serverId: this._defaultId, rawId: compositeId }
    return { serverId: compositeId.slice(0, i), rawId: compositeId.slice(i + 1) }
  }

  /** Findet den passenden Client für eine composite ID. */
  _clientFor(compositeId) {
    const { serverId } = this._split(compositeId)
    const c = this.clients.get(serverId)
    if (!c) throw new Error(`AjnaManager: unknown server "${serverId}" for id "${compositeId}"`)
    return c
  }

  // ===================================================================
  //  Auth — bezieht sich auf den Default-Client (Multi-Server-Auth
  //  kommt in Phase 3 mit getrennten Sessions pro Client)
  // ===================================================================

  async login(email, password)   { return this.defaultClient.login(email, password) }
  logout()                       { return this.defaultClient.logout() }
  isLoggedIn()                   { return this.defaultClient.isLoggedIn() }
  currentUser()                  { return this.defaultClient.currentUser() }
  onAuthChanged(callback)        { return this.defaultClient.onAuthChanged(callback) }

  // ===================================================================
  //  Connect / Disconnect — alle Clients parallel
  // ===================================================================

  async connect() {
    await Promise.all(Array.from(this.clients.values()).map(c => c.connect()))
  }

  async disconnect() {
    await Promise.all(Array.from(this.clients.values()).map(c => c.disconnect()))
  }

  // ===================================================================
  //  Objects — Read (über alle Clients gemerged)
  // ===================================================================

  /**
   * Liefert die vereinigte Objekt-Liste aller Clients. Reihenfolge:
   * stabil nach Server-ID, innerhalb eines Servers Insertion-Order.
   */
  getObjects() {
    const all = []
    for (const c of this.clients.values()) {
      for (const o of c.objectMap.values()) all.push(o)
    }
    return all
  }

  getObjectById(compositeId) {
    try { return this._clientFor(compositeId).getObjectById(compositeId) }
    catch { return undefined }
  }

  /**
   * Snapshot-Lookup als Map (composite-ID → record).
   * Praktisch für Aufrufer, die `objectMap.get(id)` gewohnt sind.
   */
  get objectMap() {
    const merged = new Map()
    for (const c of this.clients.values()) {
      for (const [id, o] of c.objectMap) merged.set(id, o)
    }
    return merged
  }

  async refreshObjects() {
    const results = await Promise.all(
      Array.from(this.clients.values()).map(c => c.refreshObjects())
    )
    return results.flat()
  }

  // ===================================================================
  //  Objects — Write
  // ===================================================================

  /** createObject ohne explizite Server-Wahl → Default-Client. */
  async createObject(data, { serverId } = {}) {
    const c = serverId ? this.clients.get(serverId) : this.defaultClient
    if (!c) throw new Error(`AjnaManager: unknown server "${serverId}"`)
    return c.createObject(data)
  }

  async updateObject(compositeId, data) {
    return this._clientFor(compositeId).updateObject(compositeId, data)
  }

  async deleteObject(compositeId) {
    return this._clientFor(compositeId).deleteObject(compositeId)
  }

  async setAnimation(compositeId, state) {
    return this._clientFor(compositeId).setAnimation(compositeId, state)
  }

  async moveObject(compositeId, lat, lon, altitude) {
    return this._clientFor(compositeId).moveObject(compositeId, lat, lon, altitude)
  }

  // ===================================================================
  //  Subscriptions
  // ===================================================================

  onObjectsChanged(listener) {
    this._objectsChangedListeners.add(listener)
    return () => this._objectsChangedListeners.delete(listener)
  }

  async watchObject(compositeId, callback) {
    return this._clientFor(compositeId).watchObject(compositeId, callback)
  }

  // ===================================================================
  //  Interaktionen
  // ===================================================================

  async interact(compositeId, action, payload) {
    return this._clientFor(compositeId).interact(compositeId, action, payload)
  }

  async onInteract(compositeId, callback) {
    return this._clientFor(compositeId).onInteract(compositeId, callback)
  }

  /**
   * Subscribed auf `interact:*`-Events für ein einzelnes Objekt.
   * Wird vom AR/Map-Client genutzt, um pro Welt-Objekt einen Listener
   * für Broker-Events zu halten. Gibt den Unsubscribe-Callback zurück
   * (genauer: einen Promise<unsubscribe>).
   */
  async subscribeInteract(compositeId, callback) {
    return this._clientFor(compositeId).onInteract(compositeId, callback)
  }

  // ===================================================================
  //  Berechtigungen
  // ===================================================================

  async listPermissions(compositeId) {
    return this._clientFor(compositeId).listPermissions(compositeId)
  }

  async addPermission(compositeId, ace) {
    return this._clientFor(compositeId).addPermission(compositeId, ace)
  }

  async updatePermission(aceId, patch) {
    // ACE-IDs sind ebenfalls composite (kommen aus listPermissions).
    return this._clientFor(aceId).updatePermission(aceId, patch)
  }

  async removePermission(aceId) {
    return this._clientFor(aceId).removePermission(aceId)
  }

  async getEffectiveRights(compositeId) {
    return this._clientFor(compositeId).getEffectiveRights(compositeId)
  }

  // ===================================================================
  //  Gruppen — operieren am Default-Client (Phase 3 erweitert)
  // ===================================================================

  async listGroups({ serverId } = {}) {
    if (serverId) return this.clients.get(serverId)?.listGroups() ?? []
    // Aktuell: nur Default-Client. In Multi-Server-Phasen mergen wir.
    return this.defaultClient.listGroups()
  }

  async createGroup(name, opts) { return this.defaultClient.createGroup(name, opts) }

  async updateGroup(compositeId, patch) {
    return this._clientFor(compositeId).updateGroup(compositeId, patch)
  }

  async deleteGroup(compositeId) {
    return this._clientFor(compositeId).deleteGroup(compositeId)
  }

  // ===================================================================
  //  Einladungen
  // ===================================================================

  async inviteToGroup(groupId, target) {
    return this._clientFor(groupId).inviteToGroup(groupId, target)
  }

  async acceptInvitation(invId) { return this._clientFor(invId).acceptInvitation(invId) }
  async declineInvitation(invId) { return this._clientFor(invId).declineInvitation(invId) }
  async cancelInvitation(invId) { return this._clientFor(invId).cancelInvitation(invId) }

  async listIncomingInvitations() { return this.defaultClient.listIncomingInvitations() }
  async listOutgoingInvitations() { return this.defaultClient.listOutgoingInvitations() }

  // ===================================================================
  //  Users / Defaults — Default-Client
  // ===================================================================

  async listUsers() { return this.defaultClient.listUsers() }
  getMyDefaultPermissions() { return this.defaultClient.getMyDefaultPermissions() }
  async setMyDefaultPermissions(aces) { return this.defaultClient.setMyDefaultPermissions(aces) }
  canCreateObjects() { return this.defaultClient.canCreateObjects() }

  // ===================================================================
  //  Internals
  // ===================================================================

  _wireClientListeners(client) {
    client.onObjectsChanged(() => this._emitObjectsChanged())
  }

  _emitObjectsChanged() {
    const snapshot = this.getObjects()
    for (const l of this._objectsChangedListeners) {
      try { l(snapshot) } catch (e) { console.error('AjnaManager listener error', e) }
    }
  }

  // ===================================================================
  //  Backward-compat aliases
  // ===================================================================

  /** @deprecated benutze getObjects() */
  getObjectList() { return this.getObjects() }

  /** @deprecated benutze refreshObjects() */
  async loadObjects() { return this.refreshObjects() }

  /** @deprecated benutze currentUser() */
  getCurrentUser() { return this.currentUser() }

  /** @deprecated interner Helper */
  emitObjectsChanged() { this._emitObjectsChanged() }
}
