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
  // Kein `yaw` mehr: Der Client kennt diese Datei und korrigiert sie selbst
  // (MODEL_YAW_RAD). Zwei Quellen für dieselbe Zahl laufen irgendwann
  // auseinander. `yaw` bleibt für Modelle, die der Client NICHT kennt.
  'Soldier.glb':         { speed: 1.5, animSpeed: 1.0, idle: true, kampf: true },
  'RobotExpressive.glb': { speed: 1.2, animSpeed: 1.1, idle: true },

  // ── Gegner ───────────────────────────────────────────────────────────
  // Gallertwesen: Beide Modelle sind UNTEXTURIERT und damit von Haus aus grau.
  // Der „Jelly"-Charakter steckt in Farbe und Durchsicht, nicht in der Form.
  'MawGooey.glb':        { speed: 0.9, animSpeed: 1.2, idle: true, kampf: true,
                           gelee: ['#5fd08a', '#4fb8d0', '#c86fd0', '#d8b44f'], deckkraft: 0.72 },
  'Slime.glb':           { speed: 0.7, animSpeed: 1.2, idle: true, kampf: true,
                           gelee: ['#7fd04f', '#4fd0b8', '#d0724f', '#8f7fd0'], deckkraft: 0.68 },

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
/**
 * Kleiner, stabiler Hash über eine Zeichenkette. Nur zur Auswahl aus einer
 * Palette — er muss nicht gut streuen, nur IMMER dasselbe liefern.
 */
function saatZahl(text) {
  let h = 0
  for (let i = 0; i < String(text).length; i++) h = (h * 31 + String(text).charCodeAt(i)) >>> 0
  return h
}

export function profileAppearance(modelFile, saat = '') {
  const p = profileFor(modelFile)
  const out = {}
  if (Number.isFinite(p.yaw)) out.yaw = p.yaw
  if (Number.isFinite(p.animSpeed) && p.animSpeed !== 1) out.animSpeed = p.animSpeed
  if (p.anim && typeof p.anim === 'object') out.anim = p.anim
  // ABSICHTLICH KEINE Beschriftung für kampffähige Figuren: Der
  // Trefferpunkte-Balken ist ein eigenes Element in der LabelLayer und braucht
  // keine Tafel. Stand hier einmal `{name} {hp}` — damit hingen die Namen aller
  // Gegner, nah wie fern, dauerhaft fett im Bild.

  // Für welches Tempo der Gehzyklus dieses Modells gezeichnet ist (m/s).
  //
  // Diese Zahl steckte schon immer in der Tabelle, nur verkleidet: `animSpeed`
  // ist der von Hand gefundene Faktor, bei dem die Figur BEI IHREM `speed`
  // richtig aussieht. Also gilt  Zyklus-Tempo = speed / animSpeed.
  //
  // Der Client braucht sie, um das Abspieltempo mitzuführen, wenn die Figur mal
  // schneller oder langsamer läuft als ihr Normaltempo. Sie zu RATEN — etwa
  // über die Figurengröße — geht schief: Beim Fuchs kam so ein Zyklus-Tempo von
  // 0,47 m/s heraus statt 0,92, und er lief auf der Stelle.
  if (Number.isFinite(p.speed) && p.speed > 0) {
    const anim = Number.isFinite(p.animSpeed) && p.animSpeed > 0 ? p.animSpeed : 1
    out.gehTempo = Math.round((p.speed / anim) * 100) / 100
  }

  // Gallertfarbe aus der Palette — über die Saat (Spawn-ID), NICHT zufällig:
  // Die Profil-Heilung beim Boot rechnet dieselbe appearance neu aus. Mit
  // Math.random() bekäme jede Figur bei jedem Neustart eine andere Farbe, und
  // der Director schriebe sie jedes Mal neu.
  if (Array.isArray(p.gelee) && p.gelee.length) {
    out.color = p.gelee[saatZahl(saat) % p.gelee.length]
  }
  if (Number.isFinite(p.deckkraft) && p.deckkraft > 0 && p.deckkraft < 1) {
    out.opacity = p.deckkraft
  }
  return out
}
