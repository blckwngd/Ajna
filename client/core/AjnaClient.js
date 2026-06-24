import PocketBase, { LocalAuthStore } from 'pocketbase'

// Resilience: proaktiver Token-Refresh und Catch-up nach Realtime-Reconnect.
// PB-Default-Token-Exp ist 7 Tage; 1h-Heartbeat lässt sehr viel Puffer und
// merkt serverseitig revoked Tokens zeitnah. Catch-up-Poll ist Safety-Net,
// falls PB_CONNECT mal nicht feuert oder ein SSE-Event verloren geht.
const TOKEN_REFRESH_INTERVAL_MS = 60 * 60 * 1000  // 1h
const CATCHUP_POLL_INTERVAL_MS  = 30 * 1000       // 30s
// Dedup-Fenster: ein PB_CONNECT-Trigger ignoriert refreshes, die innerhalb
// dieser Zeit nach dem letzten Refresh feuern — verhindert Doppel-Calls
// beim initialen Boot, wo connect() ohnehin direkt refreshObjects() macht.
const REFRESH_DEDUP_WINDOW_MS   = 5 * 1000        // 5s

/**
 * AjnaClient — Eine PocketBase-Verbindung zu **einem** Ajna-Server.
 *
 * Sieht aus wie die ursprüngliche AjnaManager-API, aber strikt mit
 * EINER PB-Instance. Die Federation-Schicht (AjnaManager) bündelt
 * mehrere dieser Clients und routet Operationen anhand der Composite-ID.
 *
 * **Composite-ID-Strategie:**
 * Composite-IDs (`"<serverId>:<rohId>"`) werden NUR auf `objects.id`
 * angewendet, weil das die Records sind, die durch die Engine (GameObject,
 * objectMap, Realtime-Routing) wandern und der Federation das Ziel-
 * Routing ermöglichen müssen. Foreign-Key-Felder (owner, members,
 * subgroups, ace.subject, ace.object …) bleiben roh — sie referenzieren
 * Records auf demselben Server, FK-zu-FK-Vergleiche bleiben damit
 * konsistent (raw vs. raw). Ebenso bleiben Gruppen-, ACE-, Invitation-
 * und User-IDs roh; Federation routet sie in Phase 1 immer am Default-
 * Client.
 *
 * Records bekommen alle ein `_origin = serverId`-Tag, damit Consumer
 * (UI-Server-Badges etc.) den Origin abfragen können, ohne IDs zu parsen.
 *
 * Eingehende ID-Parameter dürfen sowohl composite (`"<server>:<raw>"`)
 * als auch roh sein; `_toRaw()` macht beides idempotent.
 *
 * @example
 *   const client = new AjnaClient({ id: 'srv-home', url: 'http://home:8090' })
 *   await client.login('me@x', 'pwd')
 *   await client.connect()
 *   const obj = client.getObjects()[0]
 *   obj.id           // → "srv-home:2kjikgp1pvkc4p5"
 *   obj._origin      // → "srv-home"
 *   obj.owner        // → roh, z. B. "xyz789"  (FK auf users im selben Server)
 */
export class AjnaClient {
  /**
   * @param {object} opts
   * @param {string} opts.id              — stabile Server-ID (UUID o. ä.)
   * @param {string} [opts.url]           — PocketBase-URL
   * @param {string} [opts.label]         — Anzeigename (UI)
   * @param {string} [opts.authStorageKey] — LocalStorage-Key für den Auth-Token
   *                                         (Default: `ajna_auth_<id>`).
   * @param {PocketBase} [opts.pb]        — vorkonfigurierte PB-Instance
   *                                         (überschreibt url + authStorageKey)
   */
  constructor(opts) {
    if (!opts?.id) throw new Error('AjnaClient: opts.id required')
    this.id = opts.id
    this.url = opts.url ?? opts.pb?.baseUrl ?? null
    this.label = opts.label ?? this.url ?? this.id

    if (opts.pb) {
      this.pb = opts.pb
    } else {
      // Pro Server eigener LocalAuthStore-Key, damit mehrere parallele
      // PB-Instances nicht denselben "pocketbase_auth"-Slot überschreiben.
      const storageKey = opts.authStorageKey ?? `ajna_auth_${this.id}`
      this.pb = new PocketBase(opts.url, new LocalAuthStore(storageKey))
    }

    /** @type {Map<string, object>}  composite-ID → record */
    this.objectMap = new Map()

    this._objectsChangedListeners = new Set()
    this._objectEventListeners = new Set()
    this._realtimeReady = false
    this._realtimeUnsubscribe = null

    // Resilience-State (Phase 5):
    this._tokenHeartbeatTimer = null
    this._catchupPollTimer = null
    this._connectUnsubscribe = null
    this._lastRefreshAt = 0
  }

  // ===================================================================
  //  Composite-ID-Helpers
  // ===================================================================

  /** Akzeptiert composite oder roh; gibt immer roh zurück. */
  _toRaw(id) {
    if (!id) return id
    const i = String(id).indexOf(':')
    return i < 0 ? id : id.slice(i + 1)
  }

  /** Für objects-Records: composite ID + `_origin`. */
  _rewriteRecord(record) {
    if (!record) return record
    if (typeof record.id === 'string' && !record.id.startsWith(`${this.id}:`)) {
      record.id = `${this.id}:${record.id}`
    }
    record._origin = this.id
    return record
  }

  /** Für nicht-objects-Records: nur `_origin` taggen, id bleibt roh. */
  _tagOrigin(record) {
    if (!record) return record
    record._origin = this.id
    return record
  }

  _tagOriginList(list) {
    return Array.isArray(list) ? list.map(r => this._tagOrigin(r)) : list
  }

  // ===================================================================
  //  Auth
  // ===================================================================

  async login(email, password) {
    return this.pb.collection('users').authWithPassword(email, password)
  }

  logout() {
    this.pb.authStore.clear()
  }

  isLoggedIn() {
    return this.pb.authStore.isValid
  }

  /**
   * Aktuell eingeloggter User auf DIESEM Server. ID wird composite-form
   * normalisiert, damit Vergleiche mit Object-Owner-Feldern konsistent
   * möglich sind — Foreign-Keys werden NICHT vom Server umgeschrieben,
   * deshalb wandelt der Caller bei Bedarf via composeId() um.
   */
  currentUser() {
    const u = this.pb.authStore.record || this.pb.authStore.model || null
    return u ? { ...u, _origin: this.id } : null
  }

  /** Roher User-Record ohne ID-Umschrift — für Federation-internen Gebrauch. */
  currentUserRaw() {
    return this.pb.authStore.record || this.pb.authStore.model || null
  }

  onAuthChanged(callback) {
    return this.pb.authStore.onChange((_token, record) =>
      callback(record ? { ...record, _origin: this.id } : null)
    )
  }

  // ===================================================================
  //  Connect / Disconnect
  // ===================================================================

  async connect() {
    // Boot-Refresh: prüft, ob das gespeicherte Token serverseitig noch
    // akzeptiert wird. `authStore.isValid` macht nur eine lokale JWT-Exp-
    // Prüfung — ein revoked Token oder ein PB-Restart mit gesäuberter
    // Session bleibt sonst unbemerkt, bis der erste Request 401 wirft.
    // SDK leert den AuthStore bei 401 NICHT von selbst, das machen wir hier.
    if (this.pb.authStore.isValid) {
      try {
        await this.pb.collection('users').authRefresh()
      } catch (err) {
        if (err?.status === 401) {
          console.warn(`[ajna:${this.id}] gespeichertes Token revoked → authStore geleert`)
          this.pb.authStore.clear()
        } else {
          // Netz-Fehler etc.: Token bleibt, Heartbeat probiert später erneut.
          console.warn(`[ajna:${this.id}] boot authRefresh fehlgeschlagen:`, err?.message || err)
        }
      }
    }

    this._startTokenHeartbeat()
    this._wireRealtimeReconnect()
    this._startCatchupPoll()

    await this.refreshObjects()
  }

  async disconnect() {
    this._stopTokenHeartbeat()
    this._stopCatchupPoll()
    this._unwireRealtimeReconnect()

    if (typeof this._realtimeUnsubscribe === 'function') {
      try { this._realtimeUnsubscribe() } catch {}
    }
    this._realtimeUnsubscribe = null
    this._realtimeReady = false
    this.objectMap.clear()
    // World-View nachziehen — sonst bleiben die Objekte dieses Clients
    // im merged Snapshot stehen, bis der nächste Realtime-Event kommt.
    this._emitObjectsChanged()
    try { await this.pb.realtime.unsubscribe() } catch {}
  }

  // ===================================================================
  //  Objects — Read
  // ===================================================================

  getObjects() {
    return Array.from(this.objectMap.values())
  }

  getObjectById(id) {
    // Erlaubt composite ODER roh — wir indexieren intern composite.
    if (typeof id === 'string' && id.includes(':')) return this.objectMap.get(id)
    return this.objectMap.get(`${this.id}:${id}`)
  }

  async refreshObjects() {
    // Timestamp VOR dem Request stempeln — der Catch-up-Trigger aus
    // PB_CONNECT prüft das Fenster, um Doppel-Calls beim Boot zu sparen.
    this._lastRefreshAt = Date.now()
    const objects = await this.pb.collection('objects').getFullList()
    this.objectMap.clear()
    for (const o of objects) {
      this._rewriteRecord(o)
      this.objectMap.set(o.id, o)
    }
    this._emitObjectsChanged()
    await this._ensureRealtime()
    return this.getObjects()
  }

  // ===================================================================
  //  Objects — Write
  // ===================================================================

  async createObject(data) {
    const obj = this._rewriteRecord(await this.pb.collection('objects').create(data))
    this.objectMap.set(obj.id, obj)
    this._emitObjectsChanged()
    return obj
  }

  async updateObject(id, data) {
    const raw = this._toRaw(id)
    const obj = this._rewriteRecord(await this.pb.collection('objects').update(raw, data))
    this.objectMap.set(obj.id, obj)
    this._emitObjectsChanged()
    return obj
  }

  async deleteObject(id) {
    const raw = this._toRaw(id)
    await this.pb.collection('objects').delete(raw)
    this.objectMap.delete(`${this.id}:${raw}`)
    this._emitObjectsChanged()
  }

  async setAnimation(id, state) {
    return this.updateObject(id, { animation_state: state })
  }

  async moveObject(id, lat, lon, altitude = undefined) {
    const patch = altitude === undefined ? { lat, lon } : { lat, lon, altitude }
    return this.updateObject(id, patch)
  }

  // ===================================================================
  //  Subscriptions
  // ===================================================================

  onObjectsChanged(listener) {
    this._objectsChangedListeners.add(listener)
    return () => this._objectsChangedListeners.delete(listener)
  }

  /**
   * Collection-weiter Realtime-Hook MIT Action. Liefert pro Event
   * `(record, action)` mit action ∈ {create, update, delete} aus dem
   * `objects`-`*`-Abo — anders als onObjectsChanged (nur Snapshot) und
   * watchObject (nur für eine bekannte ID). Für Agents/Bridges, die auf
   * neue/geänderte Objekte action-abhängig reagieren. Feuert NICHT für den
   * initialen Load (der läuft über refreshObjects/getFullList, nicht über
   * das Abo). Gibt unsubscribe zurück.
   */
  onObjectEvent(listener) {
    this._objectEventListeners.add(listener)
    return () => this._objectEventListeners.delete(listener)
  }

  async watchObject(id, callback) {
    const raw = this._toRaw(id)
    return this.pb.collection('objects').subscribe(raw, e => {
      const rec = this._rewriteRecord(e.record)
      if (e.action === 'delete') this.objectMap.delete(rec.id)
      else this.objectMap.set(rec.id, rec)
      this._emitObjectsChanged()
      callback(rec, e.action)
    })
  }

  // ===================================================================
  //  Interaktionen
  // ===================================================================

  async interact(objectId, action, payload) {
    const raw = this._toRaw(objectId)
    const body = payload === undefined ? { action } : { action, payload }
    return this.pb.send(`/api/objects/${raw}/interact`, { method: 'POST', body })
  }

  /** Subscribed auf `interact:<rawId>`-Events. */
  async onInteract(objectId, callback) {
    const raw = this._toRaw(objectId)
    return this.pb.realtime.subscribe(`interact:${raw}`, msg => {
      let data
      try { data = typeof msg === 'string' ? JSON.parse(msg) : msg }
      catch { data = { action: '?', raw: msg } }
      callback(data)
    })
  }

  // ===================================================================
  //  Interest-Areas — datenschutzfreundliche Präsenz (/ajnaapi)
  // ===================================================================
  // Server-Logik (kein PB-Hook): /ajnaapi/* läuft über den Express-API-Server.
  // `pb.send` löst Base-URL (= dieser Server, via Caddy) und das Auth-Token
  // automatisch — Viewer wie Agents nutzen denselben Pfad, statt fetch/Base/
  // Token von Hand zu bauen (das führte in Agents zu /ajnaapi-404).

  /**
   * Veröffentlicht den eigenen UNSCHARFEN Interessensbereich (Opt-in-Präsenz).
   * @param {{latMin:number,latMax:number,lonMin:number,lonMax:number}} bbox  bereits gefuzzte BBOX
   * @param {string[]} [sources]  eingeblendete Agent-Quellen (z. B. ['wigle'])
   */
  async publishInterestArea(bbox, sources = []) {
    return this.pb.send('/ajnaapi/interest-areas', { method: 'POST', body: { bbox, sources } })
  }

  /** Entfernt den eigenen Interessensbereich (Opt-out / Logout). */
  async deleteInterestArea() {
    return this.pb.send('/ajnaapi/interest-areas', { method: 'DELETE' })
  }

  /**
   * Liest das anonymisierte Aggregat aktiver Interessensbereiche (für Agents).
   * @param {string} [source]  nur Bereiche von Spielern, die diese Quelle zeigen
   * @returns {Promise<Array<{latMin:number,latMax:number,lonMin:number,lonMax:number}>>}
   */
  async fetchInterestAreas(source) {
    const q = source ? `?source=${encodeURIComponent(source)}` : ''
    const res = await this.pb.send(`/ajnaapi/interest-areas${q}`, { method: 'GET' })
    return Array.isArray(res?.areas) ? res.areas : []
  }

  // ===================================================================
  //  Berechtigungen
  // ===================================================================

  async listPermissions(objectId) {
    const raw = this._toRaw(objectId)
    const list = await this.pb.collection('object_permissions').getFullList({
      filter: `object = "${raw}"`,
      sort: '+created'
    })
    return this._tagOriginList(list)
  }

  async addPermission(objectId, ace) {
    const raw = this._toRaw(objectId)
    const rec = await this.pb.collection('object_permissions').create({
      object: raw,
      subject_type: ace.subject_type,
      subject: ace.subject || '',
      rights: ace.rights || [],
      interact_actions: ace.interact_actions || []
    })
    return this._tagOrigin(rec)
  }

  async updatePermission(aceId, patch) {
    const raw = this._toRaw(aceId)
    return this._tagOrigin(await this.pb.collection('object_permissions').update(raw, patch))
  }

  async removePermission(aceId) {
    const raw = this._toRaw(aceId)
    return this.pb.collection('object_permissions').delete(raw)
  }

  async getEffectiveRights(objectId) {
    const raw = this._toRaw(objectId)
    return this.pb.send(`/api/objects/${raw}/effective-rights`, { method: 'GET' })
  }

  // ===================================================================
  //  Gruppen
  // ===================================================================

  async listGroups() {
    const list = await this.pb.collection('groups').getFullList({ sort: '+name' })
    return this._tagOriginList(list)
  }

  async createGroup(name, { members = [], subgroups = [] } = {}) {
    const data = { name, members, subgroups }
    if (this.isLoggedIn()) data.owner = this.currentUserRaw().id
    return this._tagOrigin(await this.pb.collection('groups').create(data))
  }

  async updateGroup(id, patch) {
    const raw = this._toRaw(id)
    return this._tagOrigin(await this.pb.collection('groups').update(raw, patch))
  }

  async deleteGroup(id) {
    const raw = this._toRaw(id)
    return this.pb.collection('groups').delete(raw)
  }

  // ===================================================================
  //  Einladungen
  // ===================================================================

  async inviteToGroup(groupId, target) {
    const raw = this._toRaw(groupId)
    const body = typeof target === 'string'
      ? { email: target }
      : { email: target?.email, name: target?.name }
    return this.pb.send(`/api/groups/${raw}/invite`, { method: 'POST', body })
  }

  async acceptInvitation(invitationId) {
    const raw = this._toRaw(invitationId)
    return this.pb.send(`/api/invitations/${raw}/accept`, { method: 'POST' })
  }

  async declineInvitation(invitationId) {
    const raw = this._toRaw(invitationId)
    return this.pb.send(`/api/invitations/${raw}/decline`, { method: 'POST' })
  }

  async cancelInvitation(invitationId) {
    const raw = this._toRaw(invitationId)
    return this.pb.collection('invitations').delete(raw)
  }

  async listIncomingInvitations() {
    if (!this.isLoggedIn()) return []
    const me = this.currentUserRaw().id
    const list = await this.pb.collection('invitations').getFullList({
      filter: `invitee = "${me}" && status = "pending"`,
      sort: '-created'
    })
    return this._tagOriginList(list)
  }

  async listOutgoingInvitations() {
    if (!this.isLoggedIn()) return []
    const me = this.currentUserRaw().id
    const list = await this.pb.collection('invitations').getFullList({
      filter: `inviter = "${me}" && status = "pending"`,
      sort: '-created'
    })
    return this._tagOriginList(list)
  }

  // ===================================================================
  //  Users
  // ===================================================================

  async listUsers() {
    const list = await this.pb.collection('users').getFullList({ sort: '+email' })
    return this._tagOriginList(list)
  }

  // ===================================================================
  //  Agent-Manifests
  // ===================================================================

  /** Liest alle Manifests (was auf diesem Server an Agents aktiv ist). */
  async listAgentManifests() {
    const list = await this.pb.collection('agent_manifests').getFullList({ sort: '+agent_name' })
    return this._tagOriginList(list)
  }

  /**
   * Upsert: findet das eigene Manifest für eine source (owner = me) und
   * aktualisiert es, oder legt ein neues an. Wird von Bridge-Agents beim
   * Boot aufgerufen.
   *
   * @param {{source: string, agent_name: string, description?: string, layers?: any[]}} manifest
   */
  async upsertAgentManifest(manifest) {
    if (!manifest?.source) throw new Error('upsertAgentManifest: source missing')
    const me = this.currentUserRaw()
    if (!me) throw new Error('upsertAgentManifest: not logged in')

    let existing = null
    try {
      existing = await this.pb.collection('agent_manifests').getFirstListItem(
        `source = {:source} && owner = {:owner}`,
        { filter: `source = "${manifest.source.replace(/"/g, '\\"')}" && owner = "${me.id}"` }
      )
    } catch (err) {
      if (err?.status !== 404) throw err
    }

    const payload = {
      source: manifest.source,
      agent_name: manifest.agent_name || manifest.source,
      description: manifest.description || '',
      layers: manifest.layers || [],
      owner: me.id
    }

    if (existing) {
      return this._tagOrigin(await this.pb.collection('agent_manifests').update(existing.id, payload))
    }
    return this._tagOrigin(await this.pb.collection('agent_manifests').create(payload))
  }

  getMyDefaultPermissions() {
    return this.currentUserRaw()?.default_permissions || []
  }

  async setMyDefaultPermissions(aces) {
    const me = this.currentUserRaw()
    if (!me) throw new Error('not logged in')
    return this._tagOrigin(
      await this.pb.collection('users').update(me.id, { default_permissions: aces })
    )
  }

  canCreateObjects() { return this.pb.authStore.isValid }

  // ===================================================================
  //  Resilience — Token-Refresh + Realtime-Catch-up (Phase 5)
  // ===================================================================

  // 1h-Heartbeat, der `authRefresh()` proaktiv triggert. PB-Default-Exp ist
  // 7 Tage; mit 1h Intervall haben wir massiv Puffer und merken auch ein
  // serverseitig revoked Token zeitnah (→ authStore.clear → onAuthChanged
  // feuert → UI zeigt Re-Login).
  _startTokenHeartbeat() {
    if (this._tokenHeartbeatTimer) return
    this._tokenHeartbeatTimer = setInterval(() => {
      if (!this.pb.authStore.isValid) return
      this.pb.collection('users').authRefresh().catch(err => {
        if (err?.status === 401) {
          console.warn(`[ajna:${this.id}] token revoked → authStore geleert`)
          this.pb.authStore.clear()
        }
        // Andere Fehler (Netz etc.): nächstes Intervall versucht es wieder.
      })
    }, TOKEN_REFRESH_INTERVAL_MS)
  }

  _stopTokenHeartbeat() {
    if (this._tokenHeartbeatTimer) {
      clearInterval(this._tokenHeartbeatTimer)
      this._tokenHeartbeatTimer = null
    }
  }

  // PB_CONNECT feuert jedes Mal, wenn das SDK eine (neue) EventSource-
  // Verbindung etabliert — initial UND nach Re-Connects (Backoff macht das
  // SDK intern, ab Version 0.20.1). Wir nutzen das als Trigger, um die
  // Objekt-Liste neu zu laden: PB hat keinen Replay-Mechanismus für SSE,
  // also würden Events, die während des Disconnects geschahen, sonst nie
  // beim Client ankommen.
  _wireRealtimeReconnect() {
    if (this._connectUnsubscribe) return
    this.pb.realtime.subscribe('PB_CONNECT', () => {
      // Dedup: refreshObjects() (aus connect() oder dem Catch-up-Poll) ist
      // gerade erst durchgelaufen — kein Doppel-Call.
      if (Date.now() - this._lastRefreshAt < REFRESH_DEDUP_WINDOW_MS) return
      console.log(`[ajna:${this.id}] PB realtime re-connected → catch-up refresh`)
      this.refreshObjects().catch(err =>
        console.warn(`[ajna:${this.id}] catch-up refresh on reconnect failed:`, err?.message || err)
      )
    })
      .then(unsub => { this._connectUnsubscribe = unsub })
      .catch(err =>
        console.warn(`[ajna:${this.id}] PB_CONNECT subscribe failed:`, err?.message || err)
      )
  }

  _unwireRealtimeReconnect() {
    if (typeof this._connectUnsubscribe === 'function') {
      try { this._connectUnsubscribe() } catch {}
    }
    this._connectUnsubscribe = null
  }

  // Catch-up-Poll als Safety-Net: alle 30s die Objekt-Liste neu laden, falls
  // PB_CONNECT mal nicht feuert (z. B. Browser-Tab-Sleep / Capacitor-Background
  // mit eingeschränkter EventSource) oder ein einzelner Realtime-Event auf
  // der Leitung verloren ging. getFullList ist bei unserer Größenordnung
  // billig genug, um das laufen zu lassen.
  _startCatchupPoll() {
    if (this._catchupPollTimer) return
    this._catchupPollTimer = setInterval(() => {
      if (!this.pb.authStore.isValid) return
      this.refreshObjects().catch(err =>
        console.warn(`[ajna:${this.id}] catch-up poll failed:`, err?.message || err)
      )
    }, CATCHUP_POLL_INTERVAL_MS)
  }

  _stopCatchupPoll() {
    if (this._catchupPollTimer) {
      clearInterval(this._catchupPollTimer)
      this._catchupPollTimer = null
    }
  }

  // ===================================================================
  //  Internals
  // ===================================================================

  _emitObjectsChanged() {
    const snapshot = this.getObjects()
    for (const l of this._objectsChangedListeners) {
      try { l(snapshot) } catch (e) { console.error('AjnaClient listener error', e) }
    }
  }

  _emitObjectEvent(record, action) {
    for (const l of this._objectEventListeners) {
      try { l(record, action) } catch (e) { console.error('AjnaClient object-event listener error', e) }
    }
  }

  async _ensureRealtime() {
    if (this._realtimeReady) return
    this._realtimeReady = true
    this._realtimeUnsubscribe = await this.pb.collection('objects').subscribe('*', e => {
      const rec = this._rewriteRecord(e.record)
      if (e.action === 'delete') this.objectMap.delete(rec.id)
      else this.objectMap.set(rec.id, rec)
      this._emitObjectsChanged()
      this._emitObjectEvent(rec, e.action)
    })
  }
}
