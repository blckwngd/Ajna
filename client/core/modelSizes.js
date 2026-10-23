// Ziel-Welthöhe (Meter) pro Modell-Datei — EINE Quelle für Client und Agents.
//
// Manche GLBs (three.js-Tiere, der Khronos-Fox) sind in Eigen-Einheiten
// riesig; ohne Normierung füllen sie die halbe Szene. Der Client skaliert
// das geladene Modell auf diese Höhe (GameObject.js #normalizeModelSize,
// das Record-`scale` wirkt als Multiplikator obendrauf). Nicht gelistete
// Modelle bleiben 1:1 — außer die Quaternius-Figuren, die alle auf 1,8 m
// kommen.
//
// WARUM HIER UND NICHT IN GameObject.js: Die Agents brauchen dieselbe Zahl.
// Eine Persona, die ihr Blickfeld rechnet, muss wissen, dass der Fuchs 0,6 m
// hoch ist und nicht 79 — sonst versteckt ein Fuchs einen Drachen.
export const MODEL_TARGET_HEIGHT = {
  "Fox.glb": 0.6,
  "Horse.glb": 1.7,
  "Flamingo.glb": 1.3,
  "Stork.glb": 1.1,
  "Parrot.glb": 0.35,
  "Diamond.glb": 0.4,
}

/** Figuren aus den Quaternius-Paketen kommen alle auf Menschenmaß. */
export function zielHoeheFuerPfad(pfad) {
  return /\/quaternius_/.test(pfad) ? 1.8 : undefined
}

/**
 * Zielhöhe für eine Modell-URL, oder undefined (1:1).
 * @param {string} url
 */
export function targetHeightFor(url) {
  const pfad = String(url || '').split(/[?#]/)[0]
  const file = pfad.split('/').pop() || ''
  return MODEL_TARGET_HEIGHT[file] ?? zielHoeheFuerPfad(pfad)
}
