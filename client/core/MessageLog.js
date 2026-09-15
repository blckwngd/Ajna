// MessageLog — EIN geteilter, persistenter Nachrichten-/Verlaufs-Store, in den
// die ganze App schreibt: Spieler-Dialoge, Interaktionen, System-Hinweise sowie
// UWB-/Debug-Schritte. Zweck: der Spieler sieht Meldungen nicht nur kurz (Toast/
// TTS), sondern kann sie später nachvollziehen. Übersteht einen Reload
// (localStorage), damit der Verlauf erhalten bleibt.
//
// AUSNAHME: flüchtige Einträge (`push(..., { ephemeral: true })`) werden
// angezeigt, aber nie gespeichert — sie überstehen den Reload absichtlich NICHT.
// Damit lassen sich Daten darstellen, die niemand liegen lassen will (etwa von
// einem Agenten im Auftrag des Spielers abgerufene Auskünfte). Siehe
// `docs/fluechtige-daten.md`.
//
// Bewusst DOM-frei — reiner Store. Konsumenten:
//   • MessageLogPanel (das Chat-/Verlaufsfenster)
//   • das Debug-Protokoll in den Einstellungen (MobileShell)
//
// Producer schreiben entweder direkt (window.ajnaLog / import) oder über eine
// injizierte Callback-Seam (UwbManager.notify, Announcer.log) — so bleibt die
// Trennung Netz/Render/Debug erhalten.

const LS_KEY = 'ajna.msglog'
const MAX = 300   // gerollt: älteste fallen raus

// Kategorien → Anzeige + ob spielerseitig (im Chat standardmäßig sichtbar).
export const CATS = {
  dialog:   { label: 'Dialog',    icon: '💬', player: true },
  interact: { label: 'Aktion',    icon: '✨', player: true },
  system:   { label: 'System',    icon: 'ℹ️', player: true },
  uwb:      { label: 'UWB',       icon: '📡', player: false },
  debug:    { label: 'Debug',     icon: '🔧', player: false }
}

class MessageLog {
  constructor() {
    this._entries = this._load()
    // FLÜCHTIGE Einträge liegen bewusst in einem ZWEITEN Feld, nicht mit einem
    // Merker im ersten. Sonst würden sie beim Rollen (MAX) dauerhafte Einträge
    // hinausdrängen — eine Handvoll Abfragen könnte den gespeicherten Verlauf
    // aufzehren, ohne dass jemand es merkt. Getrennt kann das nicht passieren.
    this._fluechtig = []
    this._cbs = new Set()
  }

  _load() {
    try {
      const a = JSON.parse(localStorage.getItem(LS_KEY))
      return Array.isArray(a) ? a.slice(-MAX) : []
    } catch { return [] }
  }
  _save() { try { localStorage.setItem(LS_KEY, JSON.stringify(this._entries.slice(-MAX))) } catch {} }

  /**
   * Eine Nachricht anhängen (oldest-first Reihenfolge).
   *
   * `ephemeral: true` heißt: anzeigen, aber NIEMALS auf die Platte. Der Eintrag
   * ist im Fenster zu sehen, solange die Sitzung läuft, und ist nach einem
   * Neuladen fort. Gedacht für Daten, die ein Agent im Auftrag des Spielers
   * abgerufen hat und die niemand liegen lassen will — siehe
   * `docs/fluechtige-daten.md`.
   *
   * @param {string} text
   * @param {keyof typeof CATS} [cat='system']
   * @param {{ephemeral?: boolean}} [opts]
   * @returns {object|null} der Eintrag { t, text, cat, ephemeral? } oder null bei leer.
   */
  push(text, cat = 'system', { ephemeral = false } = {}) {
    if (text == null || text === '') return null
    const entry = { t: Date.now(), text: String(text), cat: CATS[cat] ? cat : 'system' }
    if (ephemeral) entry.ephemeral = true
    const ziel = ephemeral ? this._fluechtig : this._entries
    ziel.push(entry)
    if (ziel.length > MAX) ziel.splice(0, ziel.length - MAX)
    if (!ephemeral) this._save()
    this._cbs.forEach(cb => { try { cb(entry) } catch {} })
    return entry
  }

  /** Alle Einträge (älteste zuerst = Chat-Reihenfolge). Optionaler Prädikatfilter. */
  entries(filter) {
    const alle = this._fluechtig.length
      ? [...this._entries, ...this._fluechtig].sort((a, b) => a.t - b.t)
      : this._entries.slice()
    return filter ? alle.filter(filter) : alle
  }

  clear() {
    this._entries = []
    this._fluechtig = []
    this._save()
    this._cbs.forEach(cb => { try { cb(null) } catch {} })
  }

  /**
   * Nur die flüchtigen Einträge verwerfen — der dauerhafte Verlauf bleibt.
   * Damit kann eine Anwendung „vergiss, was du gerade angezeigt hast" anbieten,
   * ohne dem Spieler sein Gesprächsprotokoll zu löschen.
   */
  clearEphemeral() {
    if (!this._fluechtig.length) return
    this._fluechtig = []
    this._cbs.forEach(cb => { try { cb(null) } catch {} })
  }

  /** Änderungen abonnieren: cb(entry) bei push, cb(null) bei clear. */
  onChange(cb) { this._cbs.add(cb); return () => this._cbs.delete(cb) }
}

export const messageLog = new MessageLog()
// Global erreichbar, damit auch view-übergreifende Producer (Toast) schreiben
// können, ohne die Instanz durchreichen zu müssen.
if (typeof window !== 'undefined') window.ajnaLog = messageLog
