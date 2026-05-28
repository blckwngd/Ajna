// ServerBadge — kleines Anzeige-Element neben Objekt-Einträgen, das den
// Origin-Server zeigt. Bei nur einem registrierten Server wird gar nichts
// gerendert (kein visueller Lärm im Single-Server-Default).
//
// Stabile Farbe je Server: Palette-Index = Position in `ajna.getServers()`.
// Da die Registry insertion-order hält und persistiert, ist die Zuordnung
// auch über Reloads stabil. Default-Server bekommt PALETTE[0] (Amber,
// passt zur restlichen Akzentfarbe der UI).

const PALETTE = [
  '#f1c40f',   // 0  Standard (Amber, matcht Akzent-Farbe)
  '#6fc8c8',   // 1  Teal
  '#8fd25c',   // 2  Green
  '#c878dd',   // 3  Magenta
  '#e87d3e',   // 4  Orange
  '#7da6e8'    // 5  Blue
]

const STYLE_ID = 'ajnaServerBadgeStyles'

export function injectServerBadgeStyles() {
  if (document.getElementById(STYLE_ID)) return
  const s = document.createElement('style')
  s.id = STYLE_ID
  s.textContent = `
    .ajna-server-badge {
      display: inline-block;
      font-size: 9px;
      padding: 1px 6px;
      border-radius: 8px;
      border: 1px solid currentColor;
      margin-left: 6px;
      vertical-align: middle;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      line-height: 1.4;
      white-space: nowrap;
      cursor: default;
    }
  `
  document.head.appendChild(s)
}

/** Index in der getServers()-Liste; -1 wenn unbekannt. */
function serverIndex(ajna, originId) {
  const servers = ajna.getServers?.() ?? []
  return servers.findIndex(s => s.id === originId)
}

function serverEntry(ajna, originId) {
  const servers = ajna.getServers?.() ?? []
  return servers.find(s => s.id === originId) || null
}

export function serverColorFor(ajna, originId) {
  const i = serverIndex(ajna, originId)
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length]
}

export function serverLabelFor(ajna, originId) {
  const s = serverEntry(ajna, originId)
  return s?.label || s?.url || '?'
}

/**
 * Hat der Anwender mehr als einen Server registriert? Wird von den
 * Konsumenten als Schnellprüfung benutzt: keine zwei Server → Badges
 * weglassen.
 */
export function isMultiServer(ajna) {
  return (ajna.getServers?.() ?? []).length > 1
}

/**
 * HTML-Snippet für ein Server-Badge. Liefert leer-String, wenn nur ein
 * Server registriert ist — Caller können das Ergebnis dann direkt in
 * Template-Literals einsetzen, ohne Bedingungen drumherum zu schreiben.
 */
export function renderServerBadge(ajna, originId) {
  if (!isMultiServer(ajna)) return ''
  const label = serverLabelFor(ajna, originId)
  const color = serverColorFor(ajna, originId)
  const safe = escapeHtml(label)
  return `<span class="ajna-server-badge" style="color:${color}" title="${safe}">${safe}</span>`
}

/** Plain-Text-Variante für Kontexte ohne HTML (z. B. ContextMenu-Titel). */
export function renderServerBadgeText(ajna, originId) {
  if (!isMultiServer(ajna)) return ''
  return `[${serverLabelFor(ajna, originId)}]`
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'
  })[c])
}
