// Appearance — interpretiert das agent-definierte `appearance`-JSON eines
// Objekt-Records. Hält den Agent↔Viewer-Contract an EINER Stelle und ist frei
// von Render-Engines (wird von der 2D-Karte UND dem 3D-AR-Viewer genutzt).
//
// Contract (alle Felder optional):
//   shape   : "circle" | "emoji" | "pin" | "box" | "sphere" | …
//             2D-Repräsentation der Karte UND AR-Fallback, wenn kein gltf da ist
//   emoji   : Glyph für shape:"emoji"
//   gltf    : GLTF/GLB-URL — optionales 3D-Upgrade, gewinnt im AR-Viewer
//   color   : CSS/Hex-Farbe (Füllung/Strich/Tönung)
//   radius  : Pixel-Radius für die Map-`circle`; sonst aus `scale`/Default
//   texture : optionaler Render-Hinweis (vom Client interpretiert, falls bekannt)
//   glow    : Hex-Farbe — Objekt "leuchtet" (Karte: Halo ums Symbol, AR:
//             pulsierende Aura). Agents nutzen es für Zustände wie "Gerät an";
//             Feld weglassen/entfernen = kein Leuchten.
//
// Auflösung:
//   • Map  → nutzt nur `shape`(+emoji/color/radius), ignoriert `gltf`
//   • AR   → gültiges `gltf` gewinnt; sonst `shape`-Fallback
//
// Fehlt `appearance`, greift die bisherige Viewer-Logik (model_url /
// MARKER_TYPES / encStyle) — so rendern Alt-Objekte/un-migrierte Agents weiter.

/**
 * Normalisiertes appearance-Objekt oder null. JSON-Felder kommen je nach Pfad
 * (PB-JSVM / Realtime) gelegentlich als String — defensiv reparsen.
 */
export function appearanceOf(record) {
  const a = record?.appearance
  if (!a) return null
  if (typeof a === 'string') {
    try { const p = JSON.parse(a); return (p && typeof p === 'object') ? p : null }
    catch { return null }
  }
  return typeof a === 'object' ? a : null
}

/** shape (lowercase) oder null. */
export function shapeOf(record) {
  const a = appearanceOf(record)
  return a && typeof a.shape === 'string' ? a.shape.toLowerCase() : null
}

/** Emoji-Glyph oder null. */
export function emojiOf(record) {
  const a = appearanceOf(record)
  return a && typeof a.emoji === 'string' && a.emoji ? a.emoji : null
}

/** CSS/Hex-Farbe oder null. */
export function colorOf(record) {
  const a = appearanceOf(record)
  return a && typeof a.color === 'string' && a.color ? a.color : null
}

/** Glow-Farbe (validiertes Hex) oder null. Strikte Validierung, weil der Wert
 *  auf der Karte in ein style-Attribut wandert — kein Freitext durchlassen. */
export function glowOf(record) {
  const a = appearanceOf(record)
  const g = a && typeof a.glow === 'string' ? a.glow.trim() : ''
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(g) ? g : null
}

/** Positiver Pixel-Radius oder null. */
export function radiusOf(record) {
  const a = appearanceOf(record)
  const r = a ? Number(a.radius) : NaN
  return Number.isFinite(r) && r > 0 ? r : null
}

/**
 * AR-Sicht auf appearance: ein optionaler `ar`-Override wird über die
 * Top-Level-Felder gemerged. Für Fälle, in denen sich 2D- und 3D-Darstellung
 * unterscheiden — z. B. WLAN = Karten-Kreis, AR = transparente, schwebende
 * Sphere. Ohne `ar` ist es identisch zu appearance.
 *   Felder (alle optional): shape, color, opacity, y (Höhe in m),
 *   diameter/size/height/thickness (Maße), gltf
 * @returns {object|null}
 */
export function arViewOf(appearance) {
  if (!appearance || typeof appearance !== 'object') return null
  return (appearance.ar && typeof appearance.ar === 'object')
    ? { ...appearance, ...appearance.ar }
    : appearance
}

/**
 * AR-Modell-URL: `appearance.gltf` gewinnt, sonst Legacy `model_url`.
 * @returns {string|null}
 */
export function gltfUrlOf(record) {
  const a = appearanceOf(record)
  const g = a && typeof a.gltf === 'string' ? a.gltf.trim() : ''
  const m = typeof record?.model_url === 'string' ? record.model_url.trim() : ''
  const url = g || m
  if (!url) return null
  // Relativer Pfad ("/models/X.glb") → gegen den Herkunfts-Server auflösen
  // (AjnaClient hat `_serverUrl` beim Empfang gesetzt). Absolute URLs (http…)
  // und protokoll-relative (//host/…) bleiben unverändert.
  if (url.startsWith('/') && !url.startsWith('//') && record?._serverUrl) {
    return record._serverUrl.replace(/\/+$/, '') + url
  }
  return url
}
