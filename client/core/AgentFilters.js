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
    /** @type {Record<string, string[]>}  source → ausgewählte Layer-Keys */
    this._selection = this._loadSelection()
    this._listeners = new Set()
  }

  // ───────────────────────────────────────────────────────────────────
  //  Manifest-Loading
  // ───────────────────────────────────────────────────────────────────

  /**
   * Lädt alle Manifests vom Server und merged sie pro `source`. Mehrere
   * Manifests gleicher Source (z. B. zwei Owner) werden zu einer
   * vereinten Layer-Liste verschmolzen (dedup nach key).
   */
  async refreshManifests() {
    const manifests = await this.ajna.listAgentManifests().catch(err => {
      console.warn('[filters] manifest fetch failed:', err?.message || err)
      return []
    })
    const bySource = {}
    for (const m of manifests) {
      const src = m.source
      if (!src) continue
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
      }
      // Layer dedup nach key (späterer überschreibt — der letzte Owner gewinnt)
      const existingKeys = new Set(bySource[src].layers.map(l => l.key))
      for (const layer of (m.layers || [])) {
        if (!layer?.key) continue
        if (existingKeys.has(layer.key)) continue
        bySource[src].layers.push(layer)
        existingKeys.add(layer.key)
      }
    }
    this._layersBySource = bySource
    this._emit()
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
    return false
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
