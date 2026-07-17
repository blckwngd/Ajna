// PrivacyPolicy — was erfährt WELCHER Server über meinen Standort?
//
// Vier aufeinander aufbauende Stufen, PRO SERVER einstellbar: man vertraut
// Servern unterschiedlich, und ein globaler Wert wäre zwangsläufig der kleinste
// gemeinsame Nenner — oder ein Leck zum unvertrauenswürdigsten Server.
//
// GERÄTELOKAL gespeichert, mit Absicht:
//   • Der Default gilt für NEUE Server — er kann schlecht auf einem Server
//     liegen, den man noch gar nicht kennt.
//   • Die Regel, die einen Server begrenzt, gehört nicht auf diesen Server.
//   • Und: das Handy im Feld darf eine andere Stufe verdienen als der Desktop.
//     (Deshalb ist die fehlende Geräte-Synchronisation hier ein Feature.)
//
// DURCHGESETZT wird die Stufe im Fan-out (AjnaManager) — am Choke-Point. Läge
// die Prüfung bei den Aufrufern, wäre der nächste vergessene Aufruf ein Leck.

export const LEVELS = ['off', 'area', 'proximity', 'exact']
const RANK = { off: 0, area: 1, proximity: 2, exact: 3 }

export const LEVEL_INFO = {
  off: {
    label: 'Verborgen',
    hint: 'Nichts wird übermittelt. Agents wissen nicht, dass du da bist.',
  },
  area: {
    label: 'Gegend',
    hint: 'Nur ein unscharfer Bereich (~500 m, aufs Raster gerundet). Agents bevölkern die Gegend um dich.',
  },
  proximity: {
    label: 'Nähe',
    hint: 'Zusätzlich erfahren Agents in deiner Nähe, dass jemand bei ihnen ist — über die Objekt-ID, nie über Koordinaten. Ermöglicht Näherungs-Auslöser. Der Server kann deine Position dadurch enger eingrenzen als bei „Gegend".',
  },
  exact: {
    label: 'Genau',
    hint: 'Der Server erhält deine exakte Position. Agents sehen weiterhin nur das grobe Aggregat — den Genauigkeitsgewinn hat der Server selbst. Nur für Server, denen du wirklich vertraust.',
  },
}

const DEFAULT_KEY = 'ajna.privacy.default'
const levelKey = id => `ajna.privacy.level.${id}`
const LEGACY_KEY = 'ajna.share_location'   // alter Boolean-Schalter „Standort teilen"

const norm = l => (LEVELS.includes(l) ? l : null)
const cbs = new Set()
const emit = () => cbs.forEach(cb => { try { cb() } catch {} })

// Default lesen — inkl. einmaliger Migration des alten Boolean-Schalters:
// „Standort teilen" an == „Gegend", aus == „Verborgen".
function readDefault() {
  try {
    const v = norm(localStorage.getItem(DEFAULT_KEY))
    if (v) return v
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy !== null) {
      const migrated = legacy === '1' ? 'area' : 'off'
      localStorage.setItem(DEFAULT_KEY, migrated)
      return migrated
    }
  } catch { /* localStorage gesperrt → sicherer Default unten */ }
  return 'off'
}

export const privacy = {
  LEVELS, LEVEL_INFO,

  /** Rang der Stufe (off=0 … exact=3) — für „mindestens"-Vergleiche. */
  rank: l => RANK[l] ?? 0,
  label: l => LEVEL_INFO[l]?.label || l,

  getDefault: () => readDefault(),
  setDefault(level) {
    const v = norm(level); if (!v) return
    try { localStorage.setItem(DEFAULT_KEY, v) } catch {}
    emit()
  },

  /** Stufe für diesen Server: explizite Übersteuerung, sonst der Default. */
  levelFor(serverId) {
    if (!serverId) return readDefault()
    try { const v = norm(localStorage.getItem(levelKey(serverId))); if (v) return v } catch {}
    return readDefault()
  },
  /** Hat dieser Server eine eigene Einstellung (statt „folgt dem Default")? */
  hasOverride(serverId) {
    try { return !!norm(localStorage.getItem(levelKey(serverId))) } catch { return false }
  },
  setLevel(serverId, level) {
    const v = norm(level); if (!v || !serverId) return
    try { localStorage.setItem(levelKey(serverId), v) } catch {}
    emit()
  },
  /** Übersteuerung entfernen → Server folgt wieder dem Default. */
  clearLevel(serverId) {
    try { localStorage.removeItem(levelKey(serverId)) } catch {}
    emit()
  },

  /** Default UND alle bekannten Server auf eine Stufe setzen. */
  applyToAll(level, serverIds = []) {
    const v = norm(level); if (!v) return
    try {
      localStorage.setItem(DEFAULT_KEY, v)
      for (const id of serverIds) localStorage.setItem(levelKey(id), v)
    } catch {}
    emit()
  },

  /** Erlaubt dieser Server mindestens Stufe `min`? */
  allows(serverId, min) { return (RANK[this.levelFor(serverId)] ?? 0) >= (RANK[min] ?? 99) },

  /** Teilt überhaupt EIN Server etwas? (lohnt sich Publishing/Timer?) */
  anyEnabled(serverIds = []) { return serverIds.some(id => (RANK[this.levelFor(id)] ?? 0) >= 1) },

  onChange(cb) { cbs.add(cb); return () => cbs.delete(cb) },
}
