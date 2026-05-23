import PocketBase from 'pocketbase'
import { AjnaClient } from './AjnaClient.js'
import { ServerRegistry } from './ServerRegistry.js'

const FALLBACK_SERVER_ID = 'default'

function hasLocalStorage() {
  try { return typeof localStorage !== 'undefined' && !!localStorage } catch { return false }
}

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

    /** @type {Set<(snapshot: object[]) => void>} */
    this._objectsChangedListeners = new Set()

    /** @type {Set<() => void>}  Listener für Änderungen an der Server-Liste */
    this._serversChangedListeners = new Set()

    if (opts.pb || !hasLocalStorage()) {
      // Node-/Agent-/Test-Pfad: vorkonfiguriertes PB oder kein LocalStorage.
      // Keine Registry, single Client mit der konventionellen ID "default".
      this.registry = null
      this._defaultId = FALLBACK_SERVER_ID
      const client = new AjnaClient({
        id: FALLBACK_SERVER_ID,
        url: opts.url,
        pb: opts.pb,
        label: 'default'
      })
      this.clients.set(client.id, client)
      this._wireClientListeners(client)
      return
    }

    // Browser-Pfad: Registry ist Source of Truth.
    this.registry = new ServerRegistry()
    const defaultEntry = this.registry.seedIfEmpty(opts.url || 'http://localhost:8090')
    this._defaultId = this.registry.defaultId() || defaultEntry.id

    for (const entry of this.registry.list()) {
      this._instantiateClient(entry)
    }
  }

  _instantiateClient(entry) {
    if (this.clients.has(entry.id)) return this.clients.get(entry.id)
    const client = new AjnaClient({
      id: entry.id,
      url: entry.url,
      label: entry.label,
      authStorageKey: this.registry?.tokenKey(entry.id)
    })
    this.clients.set(entry.id, client)
    this._wireClientListeners(client)
    return client
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
  //  Connect / Disconnect
  // ===================================================================

  /**
   * Verbindet den Default-Client (Boot-kritisch — Fehler wird propagiert).
   * Zusatz-Server, die noch einen gültigen Token besitzen, werden
   * "lazy" mitverbunden — Fehler dort kippen den Boot nicht, sondern
   * landen als Warnung in der Konsole. So bleibt das Multi-Server-
   * Setup nach Reload selbsterhaltend, ohne dass der User pro Server
   * manuell verbinden muss.
   */
  async connect() {
    await this.defaultClient.connect()
    for (const c of this.clients.values()) {
      if (c.id === this._defaultId) continue
      if (!c.isLoggedIn()) continue
      c.connect().catch(err =>
        console.warn(`[AjnaManager] connect "${c.label}" failed:`, err?.message || err)
      )
    }
  }

  async disconnect() {
    await Promise.allSettled(Array.from(this.clients.values()).map(c => c.disconnect()))
  }

  async connectServer(serverId) {
    const c = this.clients.get(serverId)
    if (!c) throw new Error(`AjnaManager: unknown server "${serverId}"`)
    return c.connect()
  }

  async disconnectServer(serverId) {
    const c = this.clients.get(serverId)
    if (!c) return
    return c.disconnect()
  }

  // ===================================================================
  //  Server-Verwaltung
  // ===================================================================

  /**
   * Liefert die bekannten Server inkl. Live-Status (Login + Verbindung).
   * @returns {Array<{id, url, label, isDefault, isLoggedIn, currentUser, isConnected}>}
   */
  getServers() {
    const entries = this.registry
      ? this.registry.list()
      : Array.from(this.clients.values()).map(c => ({ id: c.id, url: c.url, label: c.label }))

    return entries.map(e => {
      const c = this.clients.get(e.id)
      return {
        id: e.id,
        url: e.url,
        label: e.label,
        isDefault: e.id === this._defaultId,
        isLoggedIn: c?.isLoggedIn() ?? false,
        currentUser: c?.currentUser() ?? null,
        isConnected: c?._realtimeReady ?? false
      }
    })
  }

  /**
   * Fügt einen Server hinzu und legt sofort den AjnaClient an.
   * @returns {object} Server-Eintrag mit id, url, label.
   * @throws wenn die Registry nicht verfügbar oder die URL doppelt ist.
   */
  addServer(url, label) {
    if (!this.registry) throw new Error('addServer requires localStorage')
    const entry = this.registry.addServer(url, label)
    this._instantiateClient(entry)
    this._emitServersChanged()
    return entry
  }

  /**
   * Entfernt einen Server: disconnect, logout, registry-cleanup. Der
   * Default-Server kann nicht entfernt werden, solange er der Default
   * ist — vorher per setDefaultServer() umstellen.
   */
  async removeServer(serverId) {
    if (!this.registry) throw new Error('removeServer requires localStorage')
    if (serverId === this._defaultId) {
      throw new Error('default server cannot be removed — switch default first')
    }
    const c = this.clients.get(serverId)
    if (c) {
      try { c.logout() } catch {}
      try { await c.disconnect() } catch {}
      this.clients.delete(serverId)
    }
    this.registry.removeServer(serverId)
    this._emitServersChanged()
    // disconnect() hat den per-Client-Cache geleert und emit gefeuert, aber
    // weil der Client jetzt aus dem federation-Map entfernt ist, sehen alle
    // Listener nach diesem Punkt eine andere Topologie — ein expliziter
    // Re-Emit hier garantiert, dass main.js' syncSceneObjects einen frischen
    // Snapshot OHNE den entfernten Server bekommt.
    this._emitObjectsChanged()
  }

  /**
   * Markiert einen anderen Server als Default. Beeinflusst, an welchen
   * Server ID-lose Calls (login, listGroups, createObject ohne explizite
   * Server-Wahl) gehen. Wird in der Registry persistiert.
   */
  setDefaultServer(serverId) {
    if (!this.clients.has(serverId)) {
      throw new Error(`AjnaManager: unknown server "${serverId}"`)
    }
    this._defaultId = serverId
    if (this.registry) {
      this.registry._state.defaultId = serverId
      this.registry._write()
    }
    this._emitServersChanged()
  }

  renameServer(serverId, label) {
    if (!this.registry) return
    if (this.registry.renameServer(serverId, label)) {
      const c = this.clients.get(serverId)
      if (c) c.label = label
      this._emitServersChanged()
    }
  }

  async loginToServer(serverId, email, password) {
    const c = this.clients.get(serverId)
    if (!c) throw new Error(`AjnaManager: unknown server "${serverId}"`)
    const result = await c.login(email, password)
    this._emitServersChanged()
    return result
  }

  logoutFromServer(serverId) {
    const c = this.clients.get(serverId)
    if (!c) return
    c.logout()
    this._emitServersChanged()
  }

  /**
   * Listener für Änderungen an der Server-Liste (add/remove/login/logout/
   * default-switch). Callback erhält keine Argumente — der Caller liest
   * den frischen Zustand via getServers().
   */
  onServersChanged(listener) {
    this._serversChangedListeners.add(listener)
    return () => this._serversChangedListeners.delete(listener)
  }

  _emitServersChanged() {
    for (const l of this._serversChangedListeners) {
      try { l() } catch (e) { console.error('AjnaManager servers listener error', e) }
    }
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
    client.onAuthChanged(() => this._emitServersChanged())
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
