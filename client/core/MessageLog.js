// MessageLog — EIN geteilter, persistenter Nachrichten-/Verlaufs-Store, in den
// die ganze App schreibt: Spieler-Dialoge, Interaktionen, System-Hinweise sowie
// UWB-/Debug-Schritte. Zweck: der Spieler sieht Meldungen nicht nur kurz (Toast/
// TTS), sondern kann sie später nachvollziehen. Übersteht einen Reload
// (localStorage), damit der Verlauf erhalten bleibt.
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
   * @param {string} text
   * @param {keyof typeof CATS} [cat='system']
   * @returns {object|null} der Eintrag { t, text, cat } oder null bei leer.
   */
  push(text, cat = 'system') {
    if (text == null || text === '') return null
    const entry = { t: Date.now(), text: String(text), cat: CATS[cat] ? cat : 'system' }
    this._entries.push(entry)
    if (this._entries.length > MAX) this._entries.splice(0, this._entries.length - MAX)
    this._save()
    this._cbs.forEach(cb => { try { cb(entry) } catch {} })
    return entry
  }

  /** Alle Einträge (älteste zuerst = Chat-Reihenfolge). Optionaler Prädikatfilter. */
  entries(filter) { return filter ? this._entries.filter(filter) : this._entries.slice() }

  clear() {
    this._entries = []
    this._save()
    this._cbs.forEach(cb => { try { cb(null) } catch {} })
  }

  /** Änderungen abonnieren: cb(entry) bei push, cb(null) bei clear. */
  onChange(cb) { this._cbs.add(cb); return () => this._cbs.delete(cb) }
}

export const messageLog = new MessageLog()
// Global erreichbar, damit auch view-übergreifende Producer (Toast) schreiben
// können, ohne die Instanz durchreichen zu müssen.
if (typeof window !== 'undefined') window.ajnaLog = messageLog
