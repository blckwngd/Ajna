import PocketBase from 'pocketbase'

/**
 * AjnaManager — Client-Bibliothek für die Ajna-Plattform.
 *
 * Bietet eine einheitliche API für Auth, Objekt-CRUD, Realtime-Updates
 * und Aktions-Interaktionen. Wird gleichermaßen von Game-Clients (AR /
 * Map) und Agenten (NPC-Logik) verwendet.
 *
 * Browser: läuft direkt — PocketBase nutzt das eingebaute `EventSource`.
 * Node:    in Node 22+ existiert `EventSource` global; in älteren
 *          Versionen muss er manuell polyfilled werden, bevor diese
 *          Datei importiert wird:
 *
 *            import { EventSource } from 'eventsource'
 *            globalThis.EventSource = EventSource
 *            const { AjnaManager } = await import('./AjnaManager.js')
 *
 * @example  Minimal-Agent
 *   const ajna = new AjnaManager('http://localhost:8090')
 *   await ajna.login('agent@example.com', 'secret')
 *   await ajna.connect()
 *   const target = ajna.getObjectById('2kjikgp1pvkc4p5')
 *   await ajna.onInteract(target.id, ev => {
 *     if (ev.action === 'attack') ajna.setAnimation(target.id, 'die')
 *   })
 */
export class AjnaManager {
  /**
   * @param {string | {url?: string, pb?: PocketBase}} [urlOrOpts]
   *   String → wird als PocketBase-URL benutzt.
   *   Objekt → kann eine vorkonfigurierte `pb`-Instance mitbringen
   *            (z. B. mit Custom-Headers oder bereits eingeloggt).
   */
  constructor(urlOrOpts = 'http://localhost:8090') {
    const opts = typeof urlOrOpts === 'string' ? { url: urlOrOpts } : urlOrOpts
    this.pb = opts.pb ?? new PocketBase(opts.url ?? 'http://localhost:8090')

    /** @type {Map<string, object>} */
    this.objectMap = new Map()

    this._objectsChangedListeners = new Set()
    this._realtimeReady = false
    this._realtimeUnsubscribe = null
  }

  // ===================================================================
  //  Auth
  // ===================================================================

  /** Login als regulärer User. */
  async login(email, password) {
    return this.pb.collection('users').authWithPassword(email, password)
  }

  /** Wirft die Session weg. */
  logout() {
    this.pb.authStore.clear()
  }

  isLoggedIn() {
    return this.pb.authStore.isValid
  }

  /** Aktuell eingeloggter User-Record (oder null). */
  currentUser() {
    return this.pb.authStore.record || this.pb.authStore.model || null
  }

  /**
   * Lauscht auf Auth-Änderungen (Login, Logout, Token-Refresh).
   * Callback erhält den User-Record (oder null).
   * @returns {() => void} unsubscribe
   */
  onAuthChanged(callback) {
    return this.pb.authStore.onChange((_token, record) => callback(record))
  }

  // ===================================================================
  //  Connect / Disconnect — Lifecycle
  // ===================================================================

  /**
   * Holt die initiale Objekt-Liste und aktiviert die Realtime-Sub auf
   * `objects`. Idempotent — mehrfacher Aufruf re-fetcht die Liste, ohne
   * doppelt zu subscriben.
   */
  async connect() {
    await this.refreshObjects()
  }

  /** Räumt alle internen Subscriptions auf, leert den Objekt-Cache. */
  async disconnect() {
    if (typeof this._realtimeUnsubscribe === 'function') {
      try { this._realtimeUnsubscribe() } catch {}
    }
    this._realtimeUnsubscribe = null
    this._realtimeReady = false
    this.objectMap.clear()
    // pb.realtime.unsubscribe() ohne Topic schließt sämtliche aktiven
    // Realtime-Channels (auch User-eigene wie watchObject/onInteract).
    try { await this.pb.realtime.unsubscribe() } catch {}
  }

  // ===================================================================
  //  Objects — Read
  // ===================================================================

  /** Liefert alle aktuell sichtbaren Objekte aus dem Cache (Snapshot). */
  getObjects() {
    return Array.from(this.objectMap.values())
  }

  /** Liefert ein einzelnes Objekt aus dem Cache, oder undefined. */
  getObjectById(id) {
    return this.objectMap.get(id)
  }

  /**
   * Holt die aktuelle Objekt-Liste vom Server, ersetzt den Cache,
   * feuert onObjectsChanged. Stellt beim ersten Aufruf zusätzlich die
   * Realtime-Sub auf `objects` her.
   */
  async refreshObjects() {
    const objects = await this.pb.collection('objects').getFullList()
    this.objectMap.clear()
    objects.forEach(o => this.objectMap.set(o.id, o))
    this._emitObjectsChanged()
    await this._ensureRealtime()
    return objects
  }

  // ===================================================================
  //  Objects — Write
  // ===================================================================

  async createObject(data) {
    const obj = await this.pb.collection('objects').create(data)
    this.objectMap.set(obj.id, obj)
    this._emitObjectsChanged()
    return obj
  }

  async updateObject(id, data) {
    const obj = await this.pb.collection('objects').update(id, data)
    this.objectMap.set(id, obj)
    this._emitObjectsChanged()
    return obj
  }

  async deleteObject(id) {
    await this.pb.collection('objects').delete(id)
    this.objectMap.delete(id)
    this._emitObjectsChanged()
  }

  /** Shortcut: setzt nur `animation_state` (typischer Agent-Use-Case). */
  async setAnimation(id, state) {
    return this.updateObject(id, { animation_state: state })
  }

  /** Shortcut: setzt nur die Geo-Position. */
  async moveObject(id, lat, lon, altitude = undefined) {
    const patch = altitude === undefined ? { lat, lon } : { lat, lon, altitude }
    return this.updateObject(id, patch)
  }

  // ===================================================================
  //  Subscriptions
  // ===================================================================

  /**
   * Listener auf jede Änderung der Objekt-Liste. Callback erhält den
   * gesamten Cache-Snapshot bei jedem Event (create/update/delete).
   * @returns {() => void} unsubscribe
   */
  onObjectsChanged(listener) {
    this._objectsChangedListeners.add(listener)
    return () => this._objectsChangedListeners.delete(listener)
  }

  /**
   * Subscribed auf Updates eines einzelnen Objekts.
   * Callback erhält `(record, action)` mit action ∈ {create,update,delete}.
   * @returns {Promise<() => void>} unsubscribe-Promise
   */
  async watchObject(id, callback) {
    return this.pb.collection('objects').subscribe(id, e => {
      if (e.action === 'delete') {
        this.objectMap.delete(e.record.id)
      } else {
        this.objectMap.set(e.record.id, e.record)
      }
      this._emitObjectsChanged()
      callback(e.record, e.action)
    })
  }

  // ===================================================================
  //  Interaktionen
  // ===================================================================

  /**
   * Triggert eine Aktion auf einem Objekt. Geht durch den serverseitigen
   * Permission-Check und wird per Broker an alle Subscriber des Topics
   * `interact:<objectId>` verteilt — KEIN DB-Write für den Trigger selbst.
   *
   * @param {string} objectId
   * @param {string} action — z. B. "attack", "turn_on"
   * @param {any}    [payload] — beliebige Zusatzdaten
   * @returns {Promise<{ok: boolean, delivered: number}>}
   */
  async interact(objectId, action, payload) {
    const body = payload === undefined ? { action } : { action, payload }
    return this.pb.send(`/api/objects/${objectId}/interact`, {
      method: 'POST',
      body
    })
  }

  /**
   * Lauscht auf Aktions-Events für ein Objekt. Callback erhält das
   * parsed Payload: `{ action, source, ts, payload? }`.
   * @returns {Promise<() => void>} unsubscribe-Promise
   */
  async onInteract(objectId, callback) {
    return this.pb.realtime.subscribe(`interact:${objectId}`, raw => {
      let data
      try { data = typeof raw === 'string' ? JSON.parse(raw) : raw }
      catch { data = { action: '?', raw } }
      callback(data)
    })
  }

  // ===================================================================
  //  Berechtigungen (ACEs)
  // ===================================================================

  /**
   * Listet alle ACE-Einträge für ein Objekt. Nur der Object-Owner darf
   * das (collection-Rule auf `object_permissions`).
   */
  async listPermissions(objectId) {
    return this.pb.collection('object_permissions').getFullList({
      filter: `object = "${objectId}"`,
      sort: '+created'
    })
  }

  /**
   * Fügt eine ACE hinzu. `ace.subject_type` ∈ {user,group,authenticated,anonymous,everyone}.
   * `subject` bei impliziten Audiences leer lassen.
   */
  async addPermission(objectId, ace) {
    return this.pb.collection('object_permissions').create({
      object: objectId,
      subject_type: ace.subject_type,
      subject: ace.subject || '',
      rights: ace.rights || [],
      interact_actions: ace.interact_actions || []
    })
  }

  async updatePermission(aceId, patch) {
    return this.pb.collection('object_permissions').update(aceId, patch)
  }

  async removePermission(aceId) {
    return this.pb.collection('object_permissions').delete(aceId)
  }

  /**
   * Effektive Rechte des aktuellen Users auf ein Objekt — inkl. impliziter
   * Audiences. Spiegelt das, was der serverseitige Resolver gerade liefern
   * würde; geeignet, um UI-Buttons zu enablen/disablen.
   * @returns {Promise<{rights: string[], interact_actions: string[]}>}
   */
  async getEffectiveRights(objectId) {
    return this.pb.send(`/api/objects/${objectId}/effective-rights`, { method: 'GET' })
  }

  // ===================================================================
  //  Gruppen
  // ===================================================================

  async listGroups() {
    return this.pb.collection('groups').getFullList({ sort: '+name' })
  }

  async createGroup(name, { members = [], subgroups = [] } = {}) {
    const data = { name, members, subgroups }
    // owner wird im PB-Schema typischerweise vom Hook gesetzt oder
    // expliziter Default — wenn weder noch, hier mitsetzen:
    if (this.isLoggedIn()) data.owner = this.currentUser().id
    return this.pb.collection('groups').create(data)
  }

  async updateGroup(id, patch) {
    return this.pb.collection('groups').update(id, patch)
  }

  async deleteGroup(id) {
    return this.pb.collection('groups').delete(id)
  }

  // ===================================================================
  //  Einladungen (Friend-/Group-Invitations)
  // ===================================================================

  /**
   * Lädt einen User in eine eigene Gruppe ein — wahlweise per E-Mail
   * oder per Anzeige-Name.
   *
   * Aus Privacy-Gründen sollte name bevorzugt werden, sobald die User
   * sich nicht persönlich kennen — E-Mails sind PII.
   *
   * @param {string} groupId
   * @param {{email?: string, name?: string} | string} target
   *   Objekt mit einer der beiden Identitäts-Optionen, oder ein String
   *   (wird als E-Mail interpretiert — Backward-Compat).
   */
  async inviteToGroup(groupId, target) {
    const body = typeof target === 'string'
      ? { email: target }
      : { email: target?.email, name: target?.name }
    return this.pb.send(`/api/groups/${groupId}/invite`, {
      method: 'POST',
      body
    })
  }

  async acceptInvitation(invitationId) {
    return this.pb.send(`/api/invitations/${invitationId}/accept`, { method: 'POST' })
  }

  async declineInvitation(invitationId) {
    return this.pb.send(`/api/invitations/${invitationId}/decline`, { method: 'POST' })
  }

  /** Inviter kann eine noch nicht akzeptierte Einladung zurückziehen. */
  async cancelInvitation(invitationId) {
    return this.pb.collection('invitations').delete(invitationId)
  }

  /** Pending-Einladungen, in denen der aktuelle User Empfänger ist. */
  async listIncomingInvitations() {
    if (!this.isLoggedIn()) return []
    const me = this.currentUser().id
    return this.pb.collection('invitations').getFullList({
      filter: `invitee = "${me}" && status = "pending"`,
      sort: '-created'
    })
  }

  /** Pending-Einladungen, die der aktuelle User ausgesprochen hat. */
  async listOutgoingInvitations() {
    if (!this.isLoggedIn()) return []
    const me = this.currentUser().id
    return this.pb.collection('invitations').getFullList({
      filter: `inviter = "${me}" && status = "pending"`,
      sort: '-created'
    })
  }

  // ===================================================================
  //  User (für ACE-Selector)
  // ===================================================================

  /**
   * Liefert eine User-Liste — nur Felder, die auch ohne Spezialrechte
   * sichtbar sein dürften (id, email, name, …). Im PB-Default können
   * eingeloggte User andere User listen; das hängt aber an `users.listRule`.
   */
  async listUsers() {
    return this.pb.collection('users').getFullList({ sort: '+email' })
  }

  /**
   * Standard-Berechtigungen des aktuellen Users — werden beim Anlegen
   * neuer Objekte automatisch übernommen.
   */
  getMyDefaultPermissions() {
    const u = this.currentUser()
    return u?.default_permissions || []
  }

  async setMyDefaultPermissions(aces) {
    const u = this.currentUser()
    if (!u) throw new Error('not logged in')
    return this.pb.collection('users').update(u.id, { default_permissions: aces })
  }

  // ===================================================================
  //  Internals
  // ===================================================================

  _emitObjectsChanged() {
    const snapshot = this.getObjects()
    this._objectsChangedListeners.forEach(l => {
      try { l(snapshot) } catch (e) { console.error('AjnaManager listener error', e) }
    })
  }

  async _ensureRealtime() {
    if (this._realtimeReady) return
    this._realtimeReady = true

    this._realtimeUnsubscribe = await this.pb.collection('objects').subscribe('*', e => {
      if (e.action === 'create' || e.action === 'update') {
        this.objectMap.set(e.record.id, e.record)
      } else if (e.action === 'delete') {
        this.objectMap.delete(e.record.id)
      }
      this._emitObjectsChanged()
    })
  }

  // ===================================================================
  //  Backwards-compat aliases
  // ===================================================================

  /** @deprecated benutze getObjects() */
  getObjectList() { return this.getObjects() }

  /** @deprecated benutze refreshObjects() */
  async loadObjects() { return this.refreshObjects() }

  /** @deprecated benutze currentUser() */
  getCurrentUser() { return this.currentUser() }

  /** @deprecated wird intern aufgerufen — nicht von außen brauchen */
  emitObjectsChanged() { this._emitObjectsChanged() }

  canCreateObjects() { return this.pb.authStore.isValid }
}
