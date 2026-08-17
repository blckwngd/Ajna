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
//   shape "image" + texture: Bildtafel. Karte: Thumbnail im Popup; AR:
//             beidseitige Foto-Plane (Billboard-Y). width/height in Metern,
//             y = Schwebehöhe. texture MUSS https sein (strikt validiert).
//   yaw     : Ausrichtungs-Korrektur des 3D-Modells in rad (Modell schaut
//             entlang +Z statt −Z). Übersteuert die Client-Default-Tabelle
//             für mitgelieferte Modelle.
//   animSpeed: Playback-Faktor der Animationen (geclampt 0.1–4; 1 = Original).
//   anim    : Alias-Map logischer Zustand → exakter AnimationGroup-Name des
//             Modells, z. B. { "walk": "Walk", "fly": "FlapFlight" }. Nur
//             Namen der eigenen Groups matchen — reine Daten, kein Code.
//   label   : VORLAGE für die Tafel im 3D-Blick, z. B.
//             "{emoji} {state.strasse} · {distance}". Der Client setzt die
//             Platzhalter ein (u. a. die Entfernung, die nur das Gerät kennt)
//             und zeichnet den Text; Größe nach Entfernung, angeschaute Tafel
//             größer. Siehe resolveLabel() unten und engine/LabelLayer.js.
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

/** Bild-/Textur-URL (validiertes https, attribut-sicher) oder null. */
export function textureOf(record) {
  const a = appearanceOf(record)
  const t = a && typeof a.texture === 'string' ? a.texture.trim() : ''
  return /^https:\/\/[^\s"'<>]+$/i.test(t) ? t : null
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

// ─── Beschriftung (appearance.label) ───────────────────────────────────────
//
// Ein Agent liefert eine VORLAGE, der Client setzt sie ein:
//
//   "label": "{emoji} {state.strasse} {state.hausnummer} · {distance}"
//
// Warum eine Vorlage und keine fertige Zeichenkette: Die Entfernung kennt nur
// das Gerät, und sie ändert sich mit jedem Schritt. Der Agent kann sie gar
// nicht liefern — er beschreibt, WIE die Zeile aussehen soll.
//
// SICHERHEIT: Das Ergebnis landet ausschließlich in `TextBlock.text` (Babylon
// GUI), nie in HTML. Auszeichnung ist damit von Bauart her unmöglich — anders
// als bei `glow`/`texture`, die in Stilangaben fließen und deshalb streng
// geprüft werden müssen. Trotzdem gilt eine Positivliste: `{owner}` und
// Ähnliches bleibt außen vor, und aus `state` kommen nur einfache Werte.

/** Vorlage aus appearance.label oder null. */
export function labelOf(record) {
  const a = appearanceOf(record)
  const l = a && typeof a.label === 'string' ? a.label.trim() : ''
  return l || null
}

/**
 * Entfernung menschenlesbar. Unter 1 km auf 10 m gerundet (mehr Genauigkeit
 * täuscht bei GPS eine Präzision vor, die es nicht gibt), darüber in km mit
 * einer Nachkommastelle.
 */
export function formatDistance(meters, locale = 'de-DE') {
  if (!Number.isFinite(meters) || meters < 0) return ''
  if (meters < 1000) {
    const m = meters < 100 ? Math.round(meters) : Math.round(meters / 10) * 10
    return `${m} m`
  }
  const km = meters / 1000
  return `${km.toLocaleString(locale, { maximumFractionDigits: km < 10 ? 1 : 0 })} km`
}

const LABEL_MAX_LEN = 160
const LABEL_MAX_LINES = 3        // Kopfzeile, Inhalt, Zusatz — mehr liest im
                                 // Vorbeigehen niemand
const STATE_VALUE_MAX = 60

/**
 * Vorlage auflösen.
 *
 * Erlaubte Platzhalter:
 *   {name} {type} {emoji}          aus dem Datensatz
 *   {distance}                     formatiert, z. B. "120 m" / "1,4 km"
 *   {distance_m} {distance_km}     nackte Zahlen (km mit einer Stelle)
 *   {altitude}                     Höhe in m, gerundet
 *   {state.<feld>}                 nur Text/Zahl/Wahrheitswert, gekürzt
 *
 * ZAHLWORT: `{<platzhalter>|Einzahl|Mehrzahl}` ergibt Wert UND passendes Wort,
 * z. B. `{state.anzahl|Stand|Stände}` → „1 Stand" / „3 Stände". Ohne diese
 * Form müsste der Agent die Grammatik selbst in die Daten schreiben — und die
 * hängt an der Sprache, die Daten aber nicht.
 *
 * Unbekannte Platzhalter bleiben unverändert stehen — so fällt ein Tippfehler
 * im Agenten auf, statt still zu verschwinden.
 *
 * `\n` in der Vorlage ergibt einen Zeilenumbruch (max. 3 Zeilen). Zeilen, die
 * nach dem Einsetzen leer sind, entfallen — ein Stand ohne Angebot bekommt
 * keine Lücke, sondern eine Zeile weniger.
 *
 * @param {string} template
 * @param {object} record   Objekt-Datensatz
 * @param {{distanceM?: number, locale?: string}} [ctx]
 */
export function resolveLabel(template, record, ctx = {}) {
  if (typeof template !== 'string' || !template) return ''
  const a = appearanceOf(record) || {}
  const d = ctx.distanceM
  const locale = ctx.locale || 'de-DE'
  const state = (record && typeof record.state === 'object' && record.state) || {}

  // `{schlüssel}` oder `{schlüssel|Einzahl|Mehrzahl}`
  const out = template.replace(/\{([a-zA-Z_][\w.]*)(?:\|([^|{}]*)\|([^|{}]*))?\}/g, (whole, key, ein, mehr) => {
    const wert = resolveKey(key, whole)
    if (ein === undefined) return wert
    // Unbekannter Platzhalter bleibt UNVERÄNDERT stehen — ohne diese Prüfung
    // stünde dahinter noch das Zahlwort ("{tippfehler|a|b} b").
    if (wert === whole) return whole
    // Zahlwort: leerer Wert ⇒ ganze Angabe weglassen (sonst stünde da " Stände").
    if (wert === '') return ''
    const n = Number(wert)
    return `${wert} ${Number.isFinite(n) && Math.abs(n) === 1 ? ein : mehr}`
  })

  function resolveKey(key, whole) {
    switch (key) {
      case 'name':        return record?.name ?? ''
      case 'type':        return record?.type ?? ''
      case 'emoji':       return typeof a.emoji === 'string' ? a.emoji : ''
      case 'distance':    return Number.isFinite(d) ? formatDistance(d, locale) : ''
      case 'distance_m':  return Number.isFinite(d) ? String(Math.round(d)) : ''
      case 'distance_km': return Number.isFinite(d) ? (d / 1000).toFixed(1) : ''
      case 'altitude':    return Number.isFinite(record?.altitude) ? String(Math.round(record.altitude)) : ''
    }
    if (key.startsWith('state.')) {
      const v = state[key.slice(6)]
      // Nur einfache Werte: ein Objekt würde als "[object Object]" landen,
      // ein Array die Zeile sprengen.
      if (v === null || v === undefined) return ''
      if (typeof v === 'object') return ''
      return String(v).slice(0, STATE_VALUE_MAX)
    }
    return whole      // unbekannt → sichtbar stehen lassen
  }

  // Mehrzeilig: `\n` in der Vorlage bleibt ein Umbruch (Babylons TextBlock
  // rendert ihn). LEERE Zeilen fliegen raus — steht bei einem Stand kein
  // Angebot, soll darunter keine Lücke klaffen, sondern nichts.
  return out
    .split(/\r?\n/)
    .map(l => l.replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
    .slice(0, LABEL_MAX_LINES)
    .join('\n')
    .slice(0, LABEL_MAX_LEN)
}

/**
 * Größenfaktor aus der Entfernung — gibt dem Blick ein Gefühl für Tiefe,
 * ohne die Lesbarkeit zu opfern.
 *
 * Bewusst LOGARITHMISCH und geklemmt, nicht perspektivisch: Eine Tafel in der
 * Welt schrumpft mit 1/d und wäre auf 500 m ein Punkt. Über zwei Zehnerpotenzen
 * verteilt sich die Größe hier auf den Bereich 0.6…1.4 — nah wirkt spürbar
 * größer, fern bleibt lesbar.
 *
 *   5 m → 1.35 · 50 m → 1.00 · 500 m → 0.65 · ab ~1 km → 0.70
 *
 * Untergrenze 0.70 und nicht weniger: bei 18 px Grundgröße sind das noch
 * 13 px. Mit 0.60 waren es 10 px — auf dem Telefon gemessen zu klein zum
 * Lesen, und lesbar bleiben ist der ganze Zweck der flachen Kurve.
 */
export function labelScaleForDistance(meters, { ref = 50, min = 0.7, max = 1.4 } = {}) {
  if (!Number.isFinite(meters) || meters <= 0) return max
  const s = 1 - 0.35 * Math.log10(meters / ref)
  return Math.min(max, Math.max(min, s))
}
