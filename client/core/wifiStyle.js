// wifiStyle — gemeinsame WLAN-Verschlüsselungs-Kategorisierung + Optik.
//
// Eine Quelle der Wahrheit für: die WiGLE-Bridge (agents/wigle-bridge.mjs),
// den 3D-Platzhalter (client/engine/GameObject.js) und die Karte (client/map.js).
// Reines JS ohne DOM/BABYLON → von Node UND Browser importierbar.
//
// Verschlüsselung wird auf eine Kategorie normalisiert (state.enc_category),
// damit sie (a) farblich/symbolisch unterscheidbar und (b) über den
// Agent-Filter (Predicate auf state.enc_category) filterbar ist.

export const ENC_CATEGORIES = ['open', 'wep', 'wpa', 'wpa2', 'wpa3', 'other']

export const ENC_STYLE = {
  open:  { label: 'Offen',    symbol: '🔓', hex: '#e74c3c', rgb: [0.91, 0.30, 0.24] },
  wep:   { label: 'WEP',      symbol: '⚠️', hex: '#e67e22', rgb: [0.90, 0.49, 0.13] },
  wpa:   { label: 'WPA',      symbol: '🔑', hex: '#f1c40f', rgb: [0.95, 0.77, 0.06] },
  wpa2:  { label: 'WPA2',     symbol: '🔒', hex: '#2ecc71', rgb: [0.18, 0.80, 0.44] },
  wpa3:  { label: 'WPA3',     symbol: '🛡️', hex: '#3498db', rgb: [0.20, 0.60, 0.86] },
  other: { label: 'Sonstige', symbol: '📶', hex: '#95a5a6', rgb: [0.58, 0.65, 0.65] }
}

/** Normalisiert eine WiGLE-Verschlüsselungsangabe auf eine Kategorie. */
export function encCategory(raw) {
  const s = String(raw || '').toLowerCase()
  if (!s || s === 'none' || s.includes('open')) return 'open'
  if (s.includes('wpa3')) return 'wpa3'
  if (s.includes('wpa2')) return 'wpa2'
  if (s.includes('wpa'))  return 'wpa'
  if (s.includes('wep'))  return 'wep'
  return 'other'
}

/** Style für einen Objekt-Record (nutzt state.enc_category, sonst state.encryption). */
export function encStyleOf(record) {
  const cat = record?.state?.enc_category || encCategory(record?.state?.encryption)
  return ENC_STYLE[cat] || ENC_STYLE.other
}

/** Manifest-Layer für den Filter-Dialog: "Alle" + ein Layer je Verschlüsselung. */
export function wifiManifestLayers() {
  return [
    { key: 'all', label: 'Alle WLANs', predicate: null },
    ...ENC_CATEGORIES.map(cat => ({
      key: cat,
      label: `${ENC_STYLE[cat].symbol} ${ENC_STYLE[cat].label}`,
      predicate: { field: 'state.enc_category', equals: cat }
    }))
  ]
}
