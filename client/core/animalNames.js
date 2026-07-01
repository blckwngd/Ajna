// Tier-Namensgebung passend zum 3D-Modell.
//
// Zufällig generierte Tiere sollen IMMER einen Namen tragen, der zum GLTF-Modell
// passt (kein „Fuchs" namens „Papagei"). Dieses Modul mappt Modell → deutscher
// Name + grammatisches Geschlecht und liefert optional ein Adjektiv. Größen-
// Adjektive („kleiner"/„großer") geben zusätzlich einen Skalierungsfaktor
// zurück, den der Aufrufer als appearance.scale ans Objekt hängt — dann wird das
// Modell passend kleiner/größer gerendert (siehe GameObject.#normalizeModelSize).
//
// Rein & abhängigkeitsfrei (nur Math.random), damit es sowohl der World-Director
// (Node) als auch SpawnHere (Client) importieren können.

// Modell-Dateiname → { Name, Geschlecht }. Geschlecht steuert die Adjektiv-
// Endung. Nicht gelistete Modelle → Dateiname ohne Endung (maskulin angenommen).
export const ANIMAL_NAMES = {
  "Fox.glb":      { name: "Fuchs",    gender: "m" },
  "Horse.glb":    { name: "Pferd",    gender: "n" },
  "Flamingo.glb": { name: "Flamingo", gender: "m" },
  "Stork.glb":    { name: "Storch",   gender: "m" },
  "Parrot.glb":   { name: "Papagei",  gender: "m" },
}

// Adjektiv-Stämme; `scale` (optional) skaliert das Modell mit. Ohne `scale`
// reines Flavor (keine Größenänderung).
const ADJ = [
  { stem: "neugierig" }, { stem: "scheu" }, { stem: "flink" }, { stem: "ruhig" },
  { stem: "jung" }, { stem: "alt" }, { stem: "wachsam" }, { stem: "verspielt" },
  { stem: "klein",     scale: 0.7 },
  { stem: "winzig",    scale: 0.55 },
  { stem: "groß",      scale: 1.4 },
  { stem: "stattlich", scale: 1.5 },
]

const pick = a => a[Math.floor(Math.random() * a.length)]

// Starke Deklination, Nominativ ohne Artikel: maskulin/feminin → +er, neutral
// → +es. Unsere Tiere sind maskulin oder neutral, daher genügt m/n.
const decline = (stem, gender) => stem + (gender === "n" ? "es" : "er")

/**
 * Liefert { name, scale } passend zum Tier-Modell.
 * Meist mit Adjektiv ("scheuer Fuchs"), ~30 % nur der reine Tiername ("Fuchs")
 * — mehrere gleichnamige Tiere sind ausdrücklich in Ordnung. Größen-Adjektive
 * liefern zusätzlich `scale` != 1.
 * @param {string} model  Modell-Dateiname, z. B. "Fox.glb"
 * @returns {{name: string, scale: number}}
 */
export function animalNameFor(model) {
  const e = ANIMAL_NAMES[model] ||
    { name: String(model || "Tier").replace(/\.glb$/i, ""), gender: "m" }
  if (Math.random() < 0.3) return { name: e.name, scale: 1 }
  const adj = pick(ADJ)
  return { name: `${decline(adj.stem, e.gender)} ${e.name}`, scale: adj.scale || 1 }
}
