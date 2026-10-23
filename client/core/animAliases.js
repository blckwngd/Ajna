// Logische Animationszustände → Prioritätsliste von Namens-Teilstrings.
//
// So mappt derselbe Zustand (walk, idle, wave …) auf modell-spezifische
// Clip-Namen: ein fliegendes Wesen nutzt für „fly" FlapFlight, für „glide"
// GlideFlight; ein Vogel mit nur einem Clip fällt auf dessen erste Group
// zurück. Groß-/Kleinschreibung ist egal, gematcht wird per includes() —
// der Präfix „metarig|" stört deshalb nicht. Reihenfolge = Priorität.
//
// EIGENES MODUL OHNE ABHÄNGIGKEITEN, weil zwei Seiten die Tabelle brauchen:
// der Client beim Abspielen (GameObject.js) und die Agents beim Prüfen,
// welche Gesten eine Figur WIRKLICH hat (agents/lib/model-clips.mjs). Eine
// Persona bot „dance" an, weil die Liste es kannte — das Modell hatte keinen
// Tanz-Clip, die Alias-Kette endete bei „idle", und die Figur stand nur da.
//
// Zusätzliche Teilstrings decken abweichende/fehlerbehaftete Clip-Namen ab:
// „idol" (wyvern.glb, Tippfehler für idle), „flying" (wyvern glide-Clip).
export const ANIM_ALIASES = {
  walk:  ["walk", "move", "trot", "flapflight", "fly", "run"],
  run:   ["run", "gallop", "sprint", "flapflight", "fly", "walk"],
  idle:  ["idle", "idol", "survey", "rest", "stand", "glideflight", "glide", "hover"],
  fly:   ["flapflight", "flap", "fly", "flight", "wing", "walk", "run", "move"],
  glide: ["glideflight", "glide", "flying", "soar", "hover", "idle", "flight", "flapflight"],
  // Abheben: der wyvern hat „metarig|take off"; Modelle ohne eigenen Takeoff-Clip
  // (z. B. Dragon.glb) fallen sauber auf ihre Flap-/Flug-Animation zurück.
  takeoff: ["take off", "takeoff", "take_off", "launch", "flapflight", "flap", "fly", "flight"],
  // Kampf. Dragon.glb bringt „Hit" mit, MawGooey und RobotExpressive „Death";
  // Soldier und Slime haben nichts dergleichen. Für die steht der nachgebaute
  // Ersatz bereit (GameObject #kampfGeste) — deshalb dürfen diese beiden
  // Zustände NICHT auf groups[0] zurückfallen: Ein zufälliger Clip als „Tod"
  // sähe aus wie ein Fehler, und der Ersatz käme nie zum Zug.
  hit:   ["hit", "damage", "hurt", "flinch", "recoil", "impact"],
  death: ["death", "die", "dead", "defeat"],
  // Gesten aus Dialogen (Parley). Letzter Eintrag ist immer "idle": Modelle
  // ohne passenden Clip sollen ruhig stehen bleiben statt irgendeine Animation
  // zu erwischen (der Fallback auf groups[0] greift sonst).
  wave:  ["wave", "waving", "greet", "salute", "yes", "idle"],
  dance: ["dance", "dancing", "idle"],
  jump:  ["jump", "hop", "idle"],
  // Nachdenken — eine Figur, die auf ihr Sprachmodell wartet, soll nicht
  // wie eingefroren wirken. Die Alltagsleute haben „Interact", die Helden
  // „Spell"; wer nichts dergleichen hat, steht ruhig.
  think: ["think", "thinking", "ponder", "interact", "spell", "idle"],
}

/**
 * Hat dieses Modell für den Alias einen ECHTEN Clip — einen, der nicht bloß
 * der Rückfall auf „idle" ist? Dieselbe Regel wie beim Abspielen: Teilstring,
 * Groß-/Kleinschreibung egal.
 * @param {string} alias
 * @param {string[]} clips  Clip-Namen des Modells
 * @returns {string|null} der Clip, der gespielt würde
 */
export function clipForAlias(alias, clips) {
  const needles = ANIM_ALIASES[String(alias || '').toLowerCase()]
  if (!needles) return null
  const names = (clips || []).map(c => [String(c), String(c).toLowerCase()])
  for (const needle of needles) {
    if (needle === 'idle' && alias !== 'idle') continue   // der Rückfall zählt nicht als Geste
    const hit = names.find(([, l]) => l.includes(needle))
    if (hit) return hit[0]
  }
  return null
}
