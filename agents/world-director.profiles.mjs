// world-director.profiles.mjs — Physis-Profile der 3D-Modelle (Daten-Modul).
//
// Rollenteilung (bewusst, siehe Memory ajna-world-director):
//   • ARCHETYPES in world-director.mjs = VERHALTEN (Soll-Anzahl, Aktionen,
//     Dialoge, Bewegungsmodus Straße/Freiflug/Streifen).
//   • HIER = PHYSIS pro Modell: Geschwindigkeit, Animations-Playback,
//     Ausrichtungs-Korrektur, Idle-/Flug-Fähigkeit, Animations-Aliase.
//
// Der Director schreibt die darstellungsrelevanten Felder (yaw, animSpeed,
// anim) beim Spawn UND beim Adopt-on-Boot in `appearance` — der Client bleibt
// ein generischer Interpreter dieser Daten (kein Director-Wissen im Client).
// Profil-Korrekturen wirken damit beim nächsten Director-Start auch auf den
// Bestand. Bewegungswerte (speed) bleiben Director-intern.
//
// Felder (alle optional):
//   speed     m/s — gilt für den Bewegungsmodus der Figur (Straße/Streifen/Flug);
//             fehlt es, greifen die globalen Env-Regler (WD_*_SPEED).
//   animSpeed Playback-Faktor der Animationen im Client (1 = Original).
//   yaw       Ausrichtungs-Korrektur in rad (Modell schaut entlang +Z statt −Z).
//   flying    Vogel-Verhalten trotz Boden-Archetyp (leichte Flughöhe, Freiflug).
//   idle      Modell hat eine brauchbare Ruhe-Animation → darf Pausen einlegen.
//   anim      Alias-Map logischer Zustand → exakter Clip-Name des Modells,
//             z. B. { idle: 'Idle_A', fly: 'FlapFlight' } — ersetzt die
//             Namens-Heuristik des Clients für dieses Modell.

export const MODEL_PROFILES = {
  // ── Menschen/Roboter (Straße) ────────────────────────────────────────
  'CesiumMan.glb':       { speed: 1.4, animSpeed: 1.0 },
  'Soldier.glb':         { speed: 1.5, animSpeed: 1.0, yaw: Math.PI, idle: true },
  'RobotExpressive.glb': { speed: 1.2, animSpeed: 1.1, idle: true },

  // ── Gegner ───────────────────────────────────────────────────────────
  'MawGooey.glb':        { speed: 0.9, animSpeed: 1.2, idle: true },
  'Slime.glb':           { speed: 0.7, animSpeed: 1.2, idle: true },

  // ── Boden-Tiere (Streifen) ───────────────────────────────────────────
  'Fox.glb':             { speed: 1.2, animSpeed: 1.3, idle: true },
  'Horse.glb':           { speed: 2.4, animSpeed: 1.5 },

  // ── Vögel (Freiflug trotz animal-Archetyp) ───────────────────────────
  'Flamingo.glb':        { speed: 6, animSpeed: 0.8, flying: true },
  'Stork.glb':           { speed: 7, animSpeed: 0.6, flying: true },
  'Parrot.glb':          { speed: 5, animSpeed: 1.4, flying: true },

  // ── Drachen ──────────────────────────────────────────────────────────
  'Dragon.glb':          { speed: 7, animSpeed: 1.0, idle: true },
  'wyvern.glb':          { speed: 8, animSpeed: 1.0, idle: true },

  // ── Statische Items (kein speed nötig) ───────────────────────────────
  'Sword.glb':           {},
  'TreasureChest.glb':   {},
  'Diamond.glb':         {},
}

/** Profil zum Modell-Dateinamen (oder leeres Objekt). */
export const profileFor = (modelFile) => MODEL_PROFILES[modelFile] || {}

/** Modell-Dateiname eines Objekts (aus appearance.gltf) oder null. */
export const modelOf = (obj) => {
  const gltf = obj?.appearance?.gltf || ''
  const file = String(gltf).split(/[?#]/)[0].split('/').pop()
  return file || null
}

/** Darstellungs-Felder des Profils für appearance (nur belegte Schlüssel). */
export function profileAppearance(modelFile) {
  const p = profileFor(modelFile)
  const out = {}
  if (Number.isFinite(p.yaw)) out.yaw = p.yaw
  if (Number.isFinite(p.animSpeed) && p.animSpeed !== 1) out.animSpeed = p.animSpeed
  if (p.anim && typeof p.anim === 'object') out.anim = p.anim
  return out
}
