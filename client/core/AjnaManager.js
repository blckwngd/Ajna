import PocketBase from 'pocketbase'
import { AjnaClient } from './AjnaClient.js'
import { ServerRegistry } from './ServerRegistry.js'
import { privacy, fuzzPoint } from './PrivacyPolicy.js'
import { abstandM } from './aktionsReichweite.js'

const FALLBACK_SERVER_ID = 'default'

function hasLocalStorage() {
  // Die Registry/Multi-Server ist ein BROWSER-Feature. Node 22+/25 stellt
  // `localStorage` inzwischen als (teils dateigestützten) Global bereit —
  // verlässt man sich nur auf dessen Existenz/Funktion, nimmt ein Agent
  // fälschlich den Registry-Pfad und nutzt eine persistierte (ggf. stale)
  // Server-URL statt der konfigurierten AJNA_URL (führte zu /ajnaapi-404).
  // Daher zwingend einen echten Browser-Kontext (window) verlangen.
  if (typeof window === 'undefined') return false
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return false
    localStorage.getItem('__ajna_storage_probe__')
    return true
  } catch { return false }
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

    /** @type {Set<(record: object, action: string) => void>} */
    this._objectEventListeners = new Set()

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
  updateCurrentUser(fields)      { return this.defaultClient.updateCurrentUser(fields) }
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
    // Auch der Standard-Server bleibt getrennt, wenn der Nutzer ihn getrennt
    // hat. Früher wurde er bedingungslos verbunden — bei einer Instanz mit nur
    // einem Server war „Trennen“ damit nach jedem Reload wirkungslos, also
    // genau der gemeldete Fehler. Die Ansicht bleibt dann leer, das ist die
    // gewollte Folge; über die Server-Verwaltung ist sie mit einem Griff
    // rückgängig zu machen, und `isDisconnected` sagt der Oberfläche warum.
    if (!this.registry?.isDisconnected(this._defaultId)) {
      await this.defaultClient.connect()
    }
    for (const c of this.clients.values()) {
      if (c.id === this._defaultId) continue
      if (!c.isLoggedIn()) continue
      // Bewusst getrennte Server bleiben getrennt. Ohne diese Prüfung wäre
      // „Trennen“ nur bis zum nächsten Reload wirksam — die Anmeldung besteht
      // ja weiter, und ein gültiges Token genügte früher als Verbindungsgrund.
      if (this.registry?.isDisconnected(c.id)) continue
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
    this.registry?.setDisconnected(serverId, false)
    try { return await c.connect() }
    finally { this._emitServersChanged() }
  }

  async disconnectServer(serverId) {
    const c = this.clients.get(serverId)
    if (!c) return
    // Absicht festhalten, nicht nur die Verbindung kappen — sonst käme sie
    // beim nächsten connect() von selbst zurück.
    this.registry?.setDisconnected(serverId, true)
    try { return await c.disconnect() }
    finally { this._emitServersChanged() }
  }

  // ===================================================================
  //  Server-Verwaltung
  // ===================================================================

  /**
   * Liefert die bekannten Server inkl. Live-Status (Login + Verbindung).
   * @returns {Array<{id, url, label, isDefault, isLoggedIn, currentUser, isConnected, isDisconnected}>}
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
        isConnected: c?._realtimeReady ?? false,
        // Bewusst getrennt (überdauert den Reload) — unterscheidet „aus“ von
        // „noch nicht verbunden“, was in der Server-Liste sonst gleich aussieht.
        isDisconnected: !!e.disconnected
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
   * Verifiziert das Token eines Servers gegen den Server (siehe
   * AjnaClient.verifySession). Bei 'revoked' wurde das lokale Token geleert,
   * daher anschließend ein onServersChanged feuern.
   * @returns {Promise<'logged-out'|'confirmed'|'revoked'|'unreachable'>}
   */
  async verifyServerSession(serverId) {
    const c = this.clients.get(serverId)
    if (!c) return 'logged-out'
    const status = await c.verifySession()
    if (status === 'revoked') this._emitServersChanged()
    return status
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

  /**
   * Collection-weiter Realtime-Hook MIT Action `(record, action)`, gemerged
   * über alle Clients. Siehe AjnaClient.onObjectEvent(). Für Agents/Bridges,
   * die action-abhängig auf neue/geänderte Objekte reagieren.
   */
  onObjectEvent(listener) {
    this._objectEventListeners.add(listener)
    return () => this._objectEventListeners.delete(listener)
  }

  async watchObject(compositeId, callback) {
    return this._clientFor(compositeId).watchObject(compositeId, callback)
  }

  // ===================================================================
  //  Interaktionen
  // ===================================================================

  async ladeNachweisHoch(compositeId, opts) {
    return this._clientFor(compositeId).ladeNachweisHoch(compositeId, opts)
  }

  async nachweiseZu(compositeId) {
    return this._clientFor(compositeId).nachweiseZu(compositeId)
  }

  nachweisBildUrl(rec, dateiname, opts) {
    return this._clientFor(rec?.id || '').nachweisBildUrl(rec, dateiname, opts)
  }

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

  /**
   * Nähe melden — zweiter Choke-Point neben publishInterestArea. Composite-IDs
   * werden nach Server sortiert; jeder Server erfährt nur Übergänge bei SEINEN
   * Objekten.
   *
   * Die Stufe gated NUR `enter`, nie `leave`: „ich bin da" verrät etwas, „ich
   * bin weg" nimmt etwas zurück. Würde man beide gleich behandeln, bliebe beim
   * Herunterstufen die letzte Anwesenheit ewig stehen — die Sperre haette
   * genau das Gegenteil dessen bewirkt, wofuer man sie gesetzt hat.
   * @param {{enter?: string[], leave?: string[]}} moves  Composite-IDs
   */
  async reportProximity({ enter = [], leave = [] } = {}) {
    const byServer = new Map()
    const bucket = (id, key) => {
      const sid = this._split(id).serverId
      if (!sid) return
      if (key === 'enter' && !privacy.allows(sid, 'proximity')) return
      if (!byServer.has(sid)) byServer.set(sid, { enter: [], leave: [] })
      byServer.get(sid)[key].push(id)
    }
    for (const id of enter) bucket(id, 'enter')
    for (const id of leave) bucket(id, 'leave')

    return Promise.allSettled(Array.from(byServer.entries()).map(([sid, moves]) => {
      const c = this.clients.get(sid)
      return c?.isLoggedIn() ? c.reportProximity(moves) : Promise.resolve(null)
    }))
  }

  /** Für Agents: Näherungs-Auslöser am eigenen Objekt. */
  async onProximity(compositeId, callback) {
    return this._clientFor(compositeId).onProximity(compositeId, callback)
  }

  /**
   * Kommando an einen Agent eines BESTIMMTEN Servers (Default: Standard-Server).
   * Objektlos — es gibt keine composite ID, aus der sich der Server ableiten
   * ließe, also muss er benannt werden.
   */
  async sendAgentCommand(source, command, payload, serverId = null) {
    const c = serverId ? this.clients.get(serverId) : this.defaultClient
    if (!c) throw new Error(`AjnaManager: unbekannter Server "${serverId}"`)
    return c.sendAgentCommand(source, command, payload)
  }

  // ===================================================================
  //  Chat
  // ===================================================================

  /**
   * Nachricht an ein Konto schicken. Der Server ergibt sich aus dem
   * Objekt-Kontext, sonst aus `serverId`, sonst der Standard-Server —
   * Konto-IDs sind je Server verschieden und nur dort gültig.
   *
   * @param {string} to  Konto-ID (roh; bei Objekt-Kontext dessen `owner`)
   * @param {{text:string, object?:string, meta?:any, serverId?:string}} msg
   */
  async sendChat(to, { text, object = null, meta = null, serverId = null } = {}) {
    const client = object ? this._clientFor(object)
      : (serverId ? this.clients.get(serverId) : this.defaultClient)
    if (!client) throw new Error('sendChat: unknown server')
    return client.sendChat(to, { text, object, meta })
  }

  /**
   * Eingehende Nachrichten abonnieren — über ALLE Server, bei denen der
   * Spieler angemeldet ist. Jede Nachricht trägt `_origin`.
   * @returns {Promise<() => void>} gemeinsames unsubscribe
   */
  async onChat(callback) {
    const offs = []
    for (const c of this.clients.values()) {
      if (!c.isLoggedIn()) continue
      try { offs.push(await c.onChat(callback)) }
      catch (err) { console.warn(`[AjnaManager] onChat "${c.label}":`, err?.message || err) }
    }
    return () => { for (const off of offs) { try { off() } catch {} } }
  }

  /**
   * Für Agents: eigene Kommandos abonnieren (Default-Server).
   *
   * Drittes Argument entweder die Server-ID (wie bisher) oder Optionen
   * `{ serverId?, public? }` — `public: true` nimmt auch ANONYME Aufrufer an,
   * siehe AjnaClient.onAgentCommand.
   */
  async onAgentCommand(source, callback, serverIdOrOpts = null) {
    const opts = (serverIdOrOpts && typeof serverIdOrOpts === 'object') ? serverIdOrOpts : { serverId: serverIdOrOpts }
    const c = opts.serverId ? this.clients.get(opts.serverId) : this.defaultClient
    if (!c) throw new Error(`AjnaManager: unbekannter Server "${opts.serverId}"`)
    return c.onAgentCommand(source, callback, { public: !!opts.public })
  }

  // ===================================================================
  //  Inventar
  // ===================================================================

  /** Objekt ins Inventar aufnehmen (carried_by = ich). */
  async pickup(compositeId) {
    return this._clientFor(compositeId).pickup(compositeId)
  }

  /** Getragenes Objekt an neuer Position wieder in die Welt setzen. */
  async place(compositeId, pos) {
    return this._clientFor(compositeId).place(compositeId, pos)
  }

  // ── Quests / Handel (gedeckte Belohnungen, server-autoritativ) ───────
  // Auftrag + Belohnungs-Items müssen auf DEMSELBEN Server liegen — der
  // Tausch ist eine Server-Transaktion. Der Client wird über den Auftrag
  // bestimmt; Reward-IDs reicht der AjnaClient roh durch.

  /** Auftrag veröffentlichen + Belohnung treuhänderisch binden (nur Aussteller). */
  async publishQuest(compositeId, opts) {
    return this._clientFor(compositeId).publishQuest(compositeId, opts)
  }

  /**
   * Auftrag annehmen (reserviert ihn für dich).
   *
   * @param {string} compositeId
   * @param {{ich?: {lat, lon}, ziel?: {lat, lon}, radiusM?: number}} [ort]
   *        Nur nötig, wenn der Auftrag „nur vor Ort" verlangt. Übergeben wird
   *        die EXAKTE Position — was davon den Server erreicht, entscheidet
   *        die Stufe unten.
   */
  async acceptQuest(compositeId, ort = null) {
    const client = this._clientFor(compositeId)
    return client.acceptQuest(compositeId, this._annahmeOrt(client.id, ort))
  }

  /**
   * Was beim Annehmen über den Standort mitgeht — nach der Stufe DIESES Servers.
   *
   * Die Entscheidung liegt hier und nicht im Auftrags-Dienst, weil sie hierhin
   * gehört: Der Manager ist der eine Ort, an dem die Stufe angewandt wird
   * (wie bei `reportProximity` und den Interessensbereichen). Eine zweite
   * Stelle, die Positionen freigibt, wäre eine zweite Stelle, die es falsch
   * machen kann.
   *
   * @returns {{at?: {lat, lon}, nah?: boolean}|null} `null` = es geht nichts raus
   */
  _annahmeOrt(serverId, ort) {
    const r = Number(ort?.radiusM) || 0
    const ich = ort?.ich
    if (!r || !Number.isFinite(ich?.lat) || !Number.isFinite(ich?.lon)) return null

    const stufe = privacy.levelFor(serverId)
    if (stufe === 'exact') return { at: { lat: ich.lat, lon: ich.lon } }
    if (stufe === 'area') {
      const p = fuzzPoint(ich.lat, ich.lon)
      return { at: { lat: p.lat, lon: p.lon } }
    }
    if (stufe === 'proximity') {
      // Keine Koordinate. Der Client rechnet den Umkreis selbst aus und meldet
      // nur das Ergebnis — dieselbe Linie wie ProximityReporter, und für diese
      // Frage die vollständige Antwort.
      const z = ort?.ziel
      if (!Number.isFinite(z?.lat) || !Number.isFinite(z?.lon)) return null
      const d = abstandM(z.lat, z.lon, ich.lat, ich.lon)
      if (!Number.isFinite(d)) return null
      return { nah: d <= r }
    }
    return null   // „Verborgen" — der Server erfährt gar nichts
  }

  /**
   * Die Position im Nachweis nach der Stufe DIESES Servers zusenden.
   *
   * Derselbe Grund wie bei `_annahmeOrt`: Ein Nachweis mit Ortsangabe ist eine
   * Aussage darüber, wo jemand war. Sie ging bisher roh raus, egal was der
   * Nutzer für diesen Server eingestellt hatte.
   *
   * `precise` reicht die Wahrheit über die eigene Angabe mit: Der Server
   * schreibt es an den Nachweis, damit der Prüfer eine gerundete Angabe nicht
   * für eine exakte hält. Ohne dieses Feld wäre der Nachlass für die Rundung
   * ein stiller Rabatt für jeden.
   */
  _nachweisOrt(serverId, proof) {
    if (!proof || typeof proof !== 'object') return proof
    if (!proof.at) return proof
    const p = privacy.positionFor(serverId, proof.at)
    const { at, ...rest } = proof
    // Kein Ort freigegeben: Die Angabe fällt weg. Verlangt der Auftrag sie,
    // sagt der Server das — mit derselben Liste wie bei jedem anderen fehlenden
    // Nachweis.
    return p ? { ...rest, at: { lat: p.lat, lon: p.lon, precise: p.precise } } : rest
  }

  /** Auftrag abschließen: atomarer Tausch geforderte Items ↔ Belohnung. */
  async completeQuest(compositeId, proof = null) {
    const client = this._clientFor(compositeId)
    return client.completeQuest(compositeId, this._nachweisOrt(client.id, proof))
  }

  /** Schwarm-Abnahme: eine Einreichung bestätigen oder zurückweisen. */
  async confirmQuest(compositeId, verdict, note = '') {
    return this._clientFor(compositeId).confirmQuest(compositeId, verdict, note)
  }

  /**
   * Aufträge der Gegend — über ALLE verbundenen Server.
   *
   * Jeder Server führt seine eigenen Aufträge und sein eigenes Karma; die
   * Liste wird zusammengelegt, die IDs bleiben zusammengesetzt („server:id"),
   * damit jede Aktion wieder beim richtigen Server landet. Ein Server, der
   * nicht antwortet, lässt die übrigen stehen — sonst nähme ein einzelner
   * Ausfall die ganze Liste mit.
   *
   * @returns {Promise<{quests: object[], karma: Object<string, number>, fehler: object[]}>}
   */
  /**
   * Aufträge in der Umgebung — je Server nach dessen Freigabe-Stufe.
   *
   * DIE STELLE, AN DER DIE STUFE HÄNGEN MUSS: Die Regionsliste ist eine Frage
   * mit einem Ort darin („was gibt es HIER"). Sie unverändert an jeden Server
   * zu schicken hiess, dass ein Server auf „Verborgen" die exakte Position
   * beim ersten Blick in die Auftragsliste bekam — die Stufe stand daneben und
   * galt für alles ausser genau diesen Aufruf.
   *
   * Wer keinen Ort bekommt, bekommt auch keine Frage gestellt. Seine Aufträge
   * fehlen dann in der Liste; das ist die gewollte Folge und wird als
   * `verborgen` gemeldet, NICHT als Fehler. Ein Fehler heisst „etwas ist
   * schiefgegangen" — hier hat jemand etwas entschieden.
   *
   * `mine: true` läuft immer: Die eigenen Ausschreibungen sind keine Aussage
   * darüber, wo man gerade ist.
   */
  async questsNear(opts = {}) {
    const karma = {}
    const fehler = []
    const verborgen = []
    const mitOrt = !opts.mine && Number.isFinite(opts.lat) && Number.isFinite(opts.lon)

    const teile = await Promise.all([...this.clients.values()].map(async (client) => {
      let frage = opts
      if (mitOrt) {
        const p = privacy.positionFor(client.id, { lat: opts.lat, lon: opts.lon })
        if (!p) {
          verborgen.push({ server: client.id, label: client.label || client.id })
          return []
        }
        frage = { ...opts, lat: p.lat, lon: p.lon }
      }
      try {
        const res = await client.questsNear(frage)
        karma[client.id] = res.karma
        return res.quests
      } catch (err) {
        // ABGEBROCHENE ANFRAGEN SIND KEINE FEHLER. Das SDK storniert eine
        // laufende Anfrage, sobald dieselbe erneut gestellt wird — das ist
        // gewollt (die neuere Antwort zählt). Sie dem Nutzer als Störung zu
        // zeigen, macht aus einer Optimierung eine Fehlermeldung.
        if (err?.isAbort || /autocancelled/i.test(err?.message || '')) return []
        // Namen UND Ursache mitgeben. Eine rohe Server-Kennung samt „Something
        // went wrong" sagt niemandem etwas — 401 heisst schlicht: dort
        // abgemeldet, und dann hilft Anmelden, nicht Neuladen.
        fehler.push({
          server: client.id,
          label: client.label || client.url || client.id,
          status: err?.status || err?.response?.status || 0,
          error: err?.message || String(err),
        })
        return []
      }
    }))
    return { quests: teile.flat(), karma, fehler, verborgen }
  }

  /** Angenommenen Auftrag zurückgeben (nur Bearbeiter) — bleibt ausgeschrieben. */
  async abandonQuest(compositeId) {
    return this._clientFor(compositeId).abandonQuest(compositeId)
  }

  /** Auftrag abbrechen (nur Aussteller) — Treuhand wird frei. */
  async cancelQuest(compositeId) {
    return this._clientFor(compositeId).cancelQuest(compositeId)
  }

  /** Für Agents: Abschluss freigeben (nach eigener Bedingungsprüfung). */
  async approveQuest(compositeId, opts) {
    return this._clientFor(compositeId).approveQuest(compositeId, opts)
  }

  /** Für Agents: Abschluss ablehnen — Auftrag geht zurück in den Umlauf. */
  async rejectQuest(compositeId, opts) {
    return this._clientFor(compositeId).rejectQuest(compositeId, opts)
  }

  /**
   * Für Agents: anstehende Abschluss-Prüfungen eigener Aufträge — über ALLE
   * verbundenen Server. Gibt ein gemeinsames unsubscribe zurück.
   */
  onQuestPending(callback) {
    const offs = []
    this.clients.forEach(client => {
      try { offs.push(client.onQuestPending(callback)) } catch {}
    })
    return () => offs.forEach(off => { try { off() } catch {} })
  }

  /**
   * Objekte im Inventar des angemeldeten Users (carried_by = eigener User),
   * server-übergreifend. carried_by ist die User-ID auf dem jeweiligen Server.
   */
  inventoryItems() {
    const items = []
    for (const o of this.getObjects()) {
      const uid = this._clientFor(o.id)?.currentUser?.()?.id
      if (uid && o.carried_by === uid) items.push(o)
    }
    return items
  }

  /** True, wenn das Objekt gerade getragen wird (nicht in der Welt). */
  isCarried(record) {
    return !!(record && record.carried_by)
  }

  // ===================================================================
  //  Interest-Areas — datenschutzfreundliche Präsenz (alle Server)
  // ===================================================================

  // Alle Server, bei denen der Spieler eingeloggt ist (der Presence-Endpoint
  // verlangt Auth). Anonyme Verbindungen werden übersprungen.
  _presenceTargets() {
    return Array.from(this.clients.values()).filter(c => c.isLoggedIn())
  }

  /**
   * Eigenen unscharfen Interessensbereich veröffentlichen (Opt-in) — an ALLE
   * verbundenen Server, damit auch deren Agents (World-Director etc.) um die
   * Position herum bevölkern. Jeder Server anonymisiert für sich.
   */
  async publishInterestArea(variants, sources) {
    // Privatsphäre wird HIER durchgesetzt, am einzigen Fan-out — nicht bei den
    // Aufrufern. Sonst wäre der nächste vergessene Aufruf ein Datenleck.
    // `variants` = { fuzzed, exact }; je Server wird die zur Stufe passende
    // Ausprägung gewählt, „Verborgen" fällt ganz raus.
    const fuzzed = variants?.fuzzed || variants   // Alt-Aufruf mit blanker BBOX tolerieren
    const exact = variants?.exact || fuzzed
    return Promise.allSettled(this._presenceTargets().map(c => {
      const level = privacy.levelFor(c.id)
      if (privacy.rank(level) < 1) return Promise.resolve({ skipped: 'off', server: c.id })
      return c.publishInterestArea(level === 'exact' ? exact : fuzzed, sources)
    }))
  }

  /** Eigenen Interessensbereich entfernen (Opt-out / Logout) — auf allen Servern. */
  async deleteInterestArea() {
    return Promise.allSettled(this._presenceTargets().map(c => c.deleteInterestArea()))
  }

  /** Nur auf EINEM Server entfernen — z. B. wenn dessen Stufe auf „Verborgen" fällt. */
  async deleteInterestAreaOn(serverId) {
    const c = this.clients.get(serverId)
    if (!c?.isLoggedIn()) return null
    try { return await c.deleteInterestArea() } catch { return null }
  }

  /**
   * Anonymisiertes Aggregat aktiver Interessensbereiche lesen. Optional für einen
   * bestimmten Server; ohne serverId der Default-Server (Agents lesen ohnehin je
   * ihren eigenen Server; das Debug-Overlay zeigt den Default).
   */
  async fetchInterestAreas(source, serverId = null) {
    const c = serverId ? this.clients.get(serverId) : this.defaultClient
    return c ? c.fetchInterestAreas(source) : []
  }

  // ===================================================================
  //  Berechtigungen
  // ===================================================================

  async listPermissions(compositeId) {
    return this._clientFor(compositeId).listPermissions(compositeId)
  }

  /**
   * Eigene effektive Rechte auf ein Objekt: Besitzer → alles; sonst der
   * serverseitige effective_permissions-Cache (user-/group-ACEs; implizite
   * Audiences landen dort nicht). null = keine expliziten Rechte.
   */
  async myRights(compositeId) {
    const cli = this._clientFor(compositeId)
    const rec = this.objectMap?.get(compositeId)
    const me = cli?.currentUser?.()
    if (me && rec?.owner === me.id) return { rights: ['view', 'edit', 'move', 'owner'], interact_actions: ['*'] }
    return cli.myRights(compositeId)
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
  //  Agent-Manifests (Filter-Dialog-Vorbau)
  // ===================================================================

  /**
   * Liefert die Manifests aller Server gemerged. Aus jedem Manifest geht
   * `_origin` als Tag mit, damit Multi-Server-aware der Filter-Dialog
   * z. B. "POI-Bridge (Heim)" vs "POI-Bridge (Büro)" unterscheiden kann.
   */
  async listAgentManifests() {
    const results = await Promise.allSettled(
      Array.from(this.clients.values()).map(c => c.listAgentManifests())
    )
    return results.filter(r => r.status === 'fulfilled').flatMap(r => r.value)
  }

  /** Upsert am Default-Client (Agent läuft typischerweise gegen einen Server). */
  async upsertAgentManifest(manifest) {
    return this.defaultClient.upsertAgentManifest(manifest)
  }

  // ===================================================================
  //  Internals
  // ===================================================================

  _wireClientListeners(client) {
    client.onObjectsChanged(() => this._emitObjectsChanged())
    client.onObjectEvent((rec, action) => this._emitObjectEvent(rec, action))
    client.onAuthChanged(() => this._emitServersChanged())
  }

  _emitObjectsChanged() {
    const snapshot = this.getObjects()
    for (const l of this._objectsChangedListeners) {
      try { l(snapshot) } catch (e) { console.error('AjnaManager listener error', e) }
    }
  }

  _emitObjectEvent(record, action) {
    for (const l of this._objectEventListeners) {
      try { l(record, action) } catch (e) { console.error('AjnaManager object-event listener error', e) }
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
