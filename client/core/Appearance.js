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

/** Positiver Pixel-Radius oder null. */
export function radiusOf(record) {
  const a = appearanceOf(record)
  const r = a ? Number(a.radius) : NaN
  return Number.isFinite(r) && r > 0 ? r : null
}

/**
 * AR-Modell-URL: `appearance.gltf` gewinnt, sonst Legacy `model_url`.
 * @returns {string|null}
 */
export function gltfUrlOf(record) {
  const a = appearanceOf(record)
  const g = a && typeof a.gltf === 'string' ? a.gltf.trim() : ''
  if (g) return g
  const m = typeof record?.model_url === 'string' ? record.model_url.trim() : ''
  return m || null
}
