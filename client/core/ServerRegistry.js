// Persistente Registry der bekannten Ajna-Server.
//
// Layout im LocalStorage:
//
//   ajna.servers.v1 = {
//     version: 1,
//     servers: [
//       { id: "uuid", url: "http://...", label: "Local",  addedAt: "2026-05-..." },
//       { id: "uuid", url: "http://...", label: "Office", addedAt: "2026-05-..." }
//     ],
//     defaultId: "uuid"
//   }
//
// Pro Server speichert PocketBase seinen Auth-Token separat unter
// `ajna_auth_<id>` — geht NICHT durch diese Klasse, sondern direkt
// über `new LocalAuthStore(...)`. Beim removeServer() räumen wir diesen
// Token zusätzlich auf.
//
// Konzeptionell:
//   • Erstes Boot ohne Registry → seed() mit der vom Code übergebenen URL.
//   • Folgeboot → hydratisiert die vorhandene Liste; die Default-URL im
//     Code wird nicht mehr berücksichtigt (Registry ist Source of Truth).
//   • URL-Dedup beim addServer(): Hostname-+Pfad-Vergleich case-insensitive,
//     Trailing-Slash ignorierend. Bei Match wirft addServer.

const STORAGE_KEY = 'ajna.servers.v1'
const TOKEN_KEY_PREFIX = 'ajna_auth_'

export class ServerRegistry {
  constructor() {
    /** @type {{servers: Array<{id,url,label,addedAt}>, defaultId: string|null, version: number}} */
    this._state = this._read()
  }

  // ===================================================================
  //  Lesen / Schreiben
  // ===================================================================

  _read() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return { version: 1, servers: [], defaultId: null }
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed?.servers)) {
        return { version: 1, servers: [], defaultId: null }
      }
      return parsed
    } catch (e) {
      console.warn('ServerRegistry: corrupt storage, resetting', e)
      return { version: 1, servers: [], defaultId: null }
    }
  }

  _write() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this._state))
  }

  // ===================================================================
  //  Public API
  // ===================================================================

  /** Alle Server in Insertion-Reihenfolge. */
  list() {
    return [...this._state.servers]
  }

  defaultId() {
    return this._state.defaultId
  }

  byId(id) {
    return this._state.servers.find(s => s.id === id) || null
  }

  /**
   * Beim ersten Boot: gibt es noch keinen Eintrag, fügen wir die in der
   * Konstruktor-URL hinterlegte Standard-Adresse als Default-Server hinzu.
   * @param {string} initialUrl
   * @param {string} [label='Lokaler Server']
   * @returns {{id, url, label, addedAt}}  Der Default-Server-Eintrag.
   */
  seedIfEmpty(initialUrl, label = 'Lokaler Server') {
    if (this._state.servers.length > 0) return this.byId(this._state.defaultId) || this._state.servers[0]
    const entry = this._makeEntry(initialUrl, label)
    this._state.servers.push(entry)
    this._state.defaultId = entry.id
    this._write()

    // Einmaliger Migrationspfad: wer vorher mit dem PB-Standard-Slot
    // `pocketbase_auth` eingeloggt war, soll nach dem Upgrade nicht
    // ausgeloggt werden. Token in den per-Server-Slot kopieren.
    try {
      const legacy = localStorage.getItem('pocketbase_auth')
      const newKey = this.tokenKey(entry.id)
      if (legacy && !localStorage.getItem(newKey)) {
        localStorage.setItem(newKey, legacy)
      }
    } catch {}

    return entry
  }

  /**
   * @param {string} url
   * @param {string} [label]
   * @throws wenn die URL schon registriert ist
   */
  addServer(url, label) {
    const normalized = this._normalize(url)
    const existing = this._state.servers.find(s => this._normalize(s.url) === normalized)
    if (existing) {
      throw new Error(`Server unter "${url}" ist bereits registriert (id=${existing.id})`)
    }
    const entry = this._makeEntry(url, label || url)
    this._state.servers.push(entry)
    if (!this._state.defaultId) this._state.defaultId = entry.id
    this._write()
    return entry
  }

  /**
   * Entfernt einen Server aus der Registry und räumt seinen Auth-Token.
   * Wenn der Default entfernt wird, wird der erste verbleibende zum
   * neuen Default. Der zugehörige AjnaClient muss vom Aufrufer separat
   * disposed werden.
   */
  removeServer(id) {
    const idx = this._state.servers.findIndex(s => s.id === id)
    if (idx < 0) return false
    this._state.servers.splice(idx, 1)
    if (this._state.defaultId === id) {
      this._state.defaultId = this._state.servers[0]?.id || null
    }
    try { localStorage.removeItem(this.tokenKey(id)) } catch {}
    this._write()
    return true
  }

  /** Setzt das Label nachträglich (UI: "Umbenennen"). */
  renameServer(id, label) {
    const s = this.byId(id)
    if (!s) return false
    s.label = label
    this._write()
    return true
  }

  /** Storage-Key des Auth-Tokens für diesen Server — wird an LocalAuthStore gegeben. */
  tokenKey(id) {
    return `${TOKEN_KEY_PREFIX}${id}`
  }

  // ===================================================================
  //  Helpers
  // ===================================================================

  _makeEntry(url, label) {
    return {
      id: this._uuid(),
      url: url.trim().replace(/\/+$/, ''),
      label: (label || url).trim(),
      addedAt: new Date().toISOString()
    }
  }

  _normalize(url) {
    return String(url || '').trim().toLowerCase().replace(/\/+$/, '')
  }

  _uuid() {
    // crypto.randomUUID ist in modernen Browsern + Node 19+ verfügbar.
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
    // Fallback (genug Entropie für unsere Zwecke — collision-resistant ist
    // hier nicht sicherheitskritisch, weil IDs nur lokal vergeben werden).
    return 'srv-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
  }
}
