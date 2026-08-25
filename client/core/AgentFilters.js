// AgentFilters — verwaltet die per-User-Filter-Einstellungen "welche Layer
// will ich von welchem Agent sehen", lädt die Manifests vom Server, und
// stellt die Match-Funktion bereit, die mapUpdateMarkers + syncSceneObjects
// vor dem Rendern aufrufen.
//
// Speicher: localStorage, Key `ajna.layer_filters`.
//   Format: { [source]: [layerKey1, layerKey2, ...] }
//
// Semantik:
//   • Quelle nicht in localStorage → Default = alles anzeigen
//   • Liste enthält "all" → alles anzeigen (egal welche anderen Layer)
//   • Liste leer ([]) → nichts aus dieser Quelle anzeigen
//   • Sonst: matched, wenn IRGENDEIN gewählter Layer auf das Objekt passt
//
// Layer-Predicate (V1, einfach):
//   null              → matcht alles ("all"-Layer)
//   { field: "...",   → matcht record.<dot.path> === value
//     equals: "..." }

const STORAGE_KEY = 'ajna.layer_filters'

// AR-Render-Budget: maximale Anzahl gleichzeitig gerenderter Objekte JE AGENT
// (Source). Begrenzt die Sichtweite indirekt — gerendert werden nur die X
// kamera-nächsten Objekte einer Source. Dichte Agents (WiGLE) werden so stark
// vereinfacht, dünne (AIS) bleiben komplett sichtbar (Liste < Budget = alle).
// Pro Agent überschreibbar via Manifest-Feld `render_budget` (0/negativ =
// unbegrenzt, z. B. ein Flugzeug-Tracker mit großer Reichweite).
const DEFAULT_RENDER_BUDGET = 50

export class AgentFilters {
  constructor(ajna) {
    this.ajna = ajna
    /** @type {Record<string, any[]>}  source → manifest.layers (gemerged) */
    this._layersBySource = {}
    /** @type {Record<string, Record<string, object>>}  source → { origin: Inhaber-Manifest } */
    this._ownerBySource = {}
    /** @type {Record<string, string[]>}  source → ausgewählte Layer-Keys */
    this._selection = this._loadSelection()
    this._listeners = new Set()
  }

  // ───────────────────────────────────────────────────────────────────
  //  Manifest-Loading
  // ───────────────────────────────────────────────────────────────────

  /**
   * Lädt die Manifests und ordnet sie den Sources zu.
   *
   * NAMENSINHABER: Auf EINEM Server gehört ein Source-Name genau EINEM Konto —
   * dem, das ihn zuerst registriert hat (frühestes `created`). Manifeste
   * desselben Servers mit gleicher Source, aber anderem Owner, sind
   * Namensanmaßungen und werden verworfen. Vorher wurden sie verschmolzen
   * („der letzte Owner gewinnt"), womit ein beliebiges Konto Anzeigename,
   * Beschreibung, Ebenen und Render-Budget einer fremden Quelle überschreiben
   * konnte. Der Unique-Index der Collection ist `(source, owner)` und
   * verhindert das nicht — die Regel lebt hier.
   *
   * ÜBER SERVER HINWEG wird weiter verschmolzen: dass „poi-bridge" auf zwei
   * Servern läuft, ist der Normalfall, und der Filterdialog soll dafür EINEN
   * Eintrag zeigen. Der Namensinhaber wird deshalb JE SERVER geführt — genau
   * so prüft `provenanceOf()` später die Herkunft eines Objekts.
   */
  async refreshManifests() {
    const manifests = await this.ajna.listAgentManifests().catch(err => {
      console.warn('[filters] manifest fetch failed:', err?.message || err)
      return []
    })

    // 1) Je (Server, Source) den frühesten Eintrag bestimmen.
    const inhaber = new Map()          // JSON.stringify([origin, source]) → Manifest
    const verworfen = []
    for (const m of manifests) {
      if (!m?.source) continue
      const schluessel = JSON.stringify([m._origin || '', m.source])
      const bisher = inhaber.get(schluessel)
      if (!bisher) { inhaber.set(schluessel, m); continue }
      // Frühestes `created` gewinnt; bei Gleichstand die kleinere ID (stabil).
      const frueher = (m.created || '') < (bisher.created || '')
        || ((m.created || '') === (bisher.created || '') && String(m.id) < String(bisher.id))
      if (frueher) { verworfen.push(bisher); inhaber.set(schluessel, m) }
      else verworfen.push(m)
    }
    for (const m of verworfen) {
      console.warn(`[filters] Manifest für "${m.source}" verworfen — der Name gehört`
        + ` auf diesem Server einem anderen Konto (Owner ${m.owner}).`)
    }

    // 2) Nur die Namensinhaber zu Sources verschmelzen (über Server hinweg).
    const bySource = {}
    const ownerBySource = {}           // source → { [origin]: ownerId }
    const sortiert = [...inhaber.values()].sort((a, b) => (a.created || '').localeCompare(b.created || ''))
    for (const m of sortiert) {
      const src = m.source
      if (!bySource[src]) {
        bySource[src] = {
          source: src,
          agent_name: m.agent_name || src,
          description: m.description || '',
          // Optional, abwärtskompatibel: erst gesetzt, wenn ein Agent das Feld
          // publisht. undefined → Client-Default (DEFAULT_RENDER_BUDGET).
          render_budget: Number.isFinite(Number(m.render_budget)) ? Number(m.render_budget) : undefined,
          layers: []
        }
        ownerBySource[src] = {}
      }
      // Ganzes Inhaber-Manifest merken: Herkunft braucht Owner, Handle und Siegel.
      ownerBySource[src][m._origin || ''] = m
      // Layer dedup nach key — hier nur noch über SERVER hinweg, nicht über Owner.
      const existingKeys = new Set(bySource[src].layers.map(l => l.key))
      for (const layer of (m.layers || [])) {
        if (!layer?.key) continue
        if (existingKeys.has(layer.key)) continue
        bySource[src].layers.push(layer)
        existingKeys.add(layer.key)
      }
    }

    this._layersBySource = bySource
    this._ownerBySource = ownerBySource
    this._emit()
  }

  /**
   * Inhaber-Manifest eines Source-Namens auf einem bestimmten Server.
   * @returns {object|null} Manifest oder null, wenn dort niemand registriert ist
   */
  _inhaberFor(source, origin = '') {
    return this._ownerBySource?.[source]?.[origin] ?? null
  }

  /**
   * Konto, dem ein Source-Name auf einem Server gehört.
   * @returns {string|null} Owner-ID oder null
   */
  ownerFor(source, origin = '') {
    return this._inhaberFor(source, origin)?.owner ?? null
  }

  /**
   * Herkunft eines Objekts — beantwortet „stammt das wirklich von dem Agenten,
   * als der es sich ausgibt?".
   *
   * `state.source` ist eine ungeprüfte Selbstauskunft: der Server schreibt sie
   * nicht, jedes Konto kann sie setzen. Belastbar ist ausschließlich `owner`
   * (serverseitig in `onRecordCreateRequest` gesetzt). Verglichen wird deshalb
   * der Owner des Objekts mit dem Owner des Manifests — und zwar auf DEMSELBEN
   * Server, weil Konto-IDs nur dort etwas bedeuten.
   *
   * @returns {{status:'user'|'agent'|'unregistered'|'mismatch',
   *            source:string|null, agentName:string|null}}
   */
  provenanceOf(record) {
    const source = record?.state?.source
    if (!source) return { status: 'user', source: null, agentName: null, handle: null, sealed: false }

    const origin = record?._origin || ''
    const inhaber = this._inhaberFor(source, origin)
    if (!inhaber) {
      return { status: 'unregistered', source, agentName: null, handle: null, sealed: false }
    }

    // Objekt-Owner ist roh (Fremdschlüssel werden nicht umgeschrieben),
    // Manifest-Owner ebenso — direkter Vergleich ist also korrekt.
    const passt = record.owner === inhaber.owner
    const handle = inhaber.owner_handle || null
    const agentName = inhaber.agent_name || source
    if (!passt) return { status: 'mismatch', source, agentName, handle, sealed: !!inhaber.owner_sealed }

    // Der Handle stimmt — aber erst das Betreiber-Siegel macht daraus eine
    // Bestätigung. Ohne Siegel ist es nur ein Konto, das diesen Namen führt.
    return inhaber.owner_sealed
      ? { status: 'agent', source, agentName, handle, sealed: true }
      : { status: 'unsealed', source, agentName, handle, sealed: false }
  }

  /**
   * Manifeste selbst aktuell halten: sofort (falls eingeloggt), bei jedem
   * Auth-Wechsel UND periodisch. Nötig, weil onAuthChanged bei BESTEHENDER
   * Session (Reload) NICHT feuert (PB authStore.onChange ohne fireImmediately) —
   * sonst bliebe die (in-memory) Manifest-Liste leer und getSources() gäbe [],
   * womit z. B. die Interest-Area OHNE Quellen publiziert würde (Agents wie der
   * World-Director sehen sie dann nicht). Periodisch, damit neu gestartete Agents
   * ohne Reload sichtbar werden. Idempotent.
   */
  startAutoRefresh(intervalMs = 180000) {
    if (this._autoStarted) return this
    this._autoStarted = true
    const tryRefresh = () => { if (this.ajna.isLoggedIn?.()) this.refreshManifests().catch(() => {}) }
    tryRefresh()
    this.ajna.onAuthChanged?.(u => { if (u) this.refreshManifests().catch(() => {}) })
    this._autoTimer = setInterval(tryRefresh, intervalMs)
    return this
  }

  /** Alle bekannten Sources (typisch: 1–N pro registriertem Agent). */
  getSources() {
    return Object.values(this._layersBySource).sort((a, b) =>
      (a.agent_name || '').localeCompare(b.agent_name || ''))
  }

  /**
   * Render-Budget einer Source (max. gleichzeitig gerenderte Objekte in der
   * AR-Szene). Manifest-`render_budget` überschreibt den Default; 0/negativ
   * bedeutet unbegrenzt (→ Infinity). syncSceneObjects rendert daraufhin nur
   * die kamera-nächsten N Objekte dieser Source.
   * @param {string} source
   * @returns {number}  positive Zahl oder Infinity
   */
  getRenderBudget(source) {
    const manifest = this._layersBySource[source]
    const override = manifest ? manifest.render_budget : undefined
    if (Number.isFinite(override)) return override <= 0 ? Infinity : override
    return DEFAULT_RENDER_BUDGET
  }

  // ───────────────────────────────────────────────────────────────────
  //  Selektion (User-Setting)
  // ───────────────────────────────────────────────────────────────────

  /** Aktuelle Auswahl für eine Source, oder `undefined` wenn nicht gesetzt. */
  getSelection(source) {
    return this._selection[source]
  }

  /** Setzt die ausgewählten Layer-Keys für eine Source und persistiert. */
  setSelection(source, layerKeys) {
    if (Array.isArray(layerKeys) && layerKeys.length === 0) {
      this._selection[source] = []   // explizit "nichts anzeigen"
    } else if (Array.isArray(layerKeys)) {
      this._selection[source] = [...layerKeys]
    } else {
      delete this._selection[source] // null/undefined → default (alles)
    }
    this._saveSelection()
    this._emit()
  }

  /** Alles für eine Source zurücksetzen (Default = alles anzeigen). */
  clearSelection(source) {
    delete this._selection[source]
    this._saveSelection()
    this._emit()
  }

  /**
   * Match-Funktion für mapUpdateMarkers / syncSceneObjects.
   * Returns true → Objekt rendern, false → ausblenden.
   */
  matches(record) {
    const source = record?.state?.source
    if (!source) return true                // user-created / nicht-Agent-Objekte immer sichtbar
    const selected = this._selection[source]
    if (selected === undefined) return true // noch nie konfiguriert → default = alles
    if (selected.length === 0) return false // explizit deaktiviert
    if (selected.includes('all')) return true

    const manifest = this._layersBySource[source]
    if (!manifest) return true              // ohne Manifest können wir nicht filtern

    for (const key of selected) {
      const layer = manifest.layers.find(l => l.key === key)
      if (!layer) continue
      if (!layer.predicate) return true     // null-predicate-Layer → "all"-artig
      if (matchesPredicate(record, layer.predicate)) return true
    }

    // Passt das Objekt zu KEINER Schicht des Manifests, konnte der Spieler es
    // nie abwählen — dann ist Ausblenden kein Filtern, sondern stilles
    // Verschwinden. Solche Nachzügler zeigen wir. (Wer wirklich nichts von
    // dieser Quelle sehen will, wählt alles ab: das greift weiter oben.)
    return !manifest.layers.some(l => l.predicate && matchesPredicate(record, l.predicate))
  }

  /**
   * Event-Subscribe: Listener wird gerufen bei Manifest- oder Selektions-
   * Änderungen. Konsumenten triggern damit ein Re-Render.
   * @returns {() => void} unsubscribe
   */
  onChange(listener) {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  // ───────────────────────────────────────────────────────────────────
  //  Internals
  // ───────────────────────────────────────────────────────────────────

  _emit() {
    for (const l of this._listeners) {
      try { l() } catch (e) { console.warn('[filters] listener error', e) }
    }
  }

  _loadSelection() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw)
      return (parsed && typeof parsed === 'object') ? parsed : {}
    } catch {
      return {}
    }
  }

  _saveSelection() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._selection))
    } catch (err) {
      console.warn('[filters] localStorage write failed:', err?.message || err)
    }
  }
}

function matchesPredicate(record, predicate) {
  if (!predicate || typeof predicate !== 'object') return true
  if (typeof predicate.field === 'string' && 'equals' in predicate) {
    return _getField(record, predicate.field) === predicate.equals
  }
  // Platz für AND/OR/in/regex etc. — V1 nur equals.
  return false
}

function _getField(obj, dotPath) {
  let cur = obj
  for (const part of dotPath.split('.')) {
    if (cur == null) return undefined
    cur = cur[part]
  }
  return cur
}
