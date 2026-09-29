// Lokal gebündelte GLB-Modelle (client/models/, in der App via /models/ und im
// Bundle verfügbar). Quelle fürs 3D-Modell-Dropdown im Objekt-Editor.
//
// Beim Hinzufügen einer neuen Modelldatei diese Liste ergänzen (kein
// Verzeichnis-Listing zur Laufzeit — Webpack/Caddy liefern die Dateien einzeln
// aus). Einträge mit Schrägstrich liegen in einem Unterordner; der Pfad gehört
// mit in die Liste, weil er in `appearance.gltf` landet.
export const LOCAL_MODELS = [
  'AIMonster.glb',
  'CesiumMan.glb',
  'Diamond.glb',
  'Dragon.glb',
  'Flamingo.glb',
  'Fox.glb',
  'Horse.glb',
  'MawGooey.glb',
  'Parrot.glb',
  'RobotExpressive.glb',
  'Slime.glb',
  'Soldier.glb',
  'Stork.glb',
  'Sword.glb',
  'TreasureChest.glb',
  'wyvern.glb',

  // Quaternius — Männer (CC0)
  'quaternius_men/Adventurer.gltf',
  'quaternius_men/Beach.gltf',
  'quaternius_men/Casual_2.gltf',
  'quaternius_men/Casual_Hoodie.gltf',
  'quaternius_men/Farmer.gltf',
  'quaternius_men/King.gltf',
  'quaternius_men/Punk.gltf',
  'quaternius_men/Spacesuit.gltf',
  'quaternius_men/Suit.gltf',
  'quaternius_men/Swat.gltf',
  'quaternius_men/Worker.gltf',

  // Quaternius — Frauen (CC0)
  'quaternius_women/Adventurer.gltf',
  'quaternius_women/Casual.gltf',
  'quaternius_women/Formal.gltf',
  'quaternius_women/Medieval.gltf',
  'quaternius_women/Punk.gltf',
  'quaternius_women/SciFi.gltf',
  'quaternius_women/Soldier.gltf',
  'quaternius_women/Suit.gltf',
  'quaternius_women/Witch.gltf',
  'quaternius_women/Worker.gltf',

  // Quaternius — Helden (CC0)
  'quaternius_characters/Cleric.gltf',
  'quaternius_characters/Monk.gltf',
  'quaternius_characters/Ranger.gltf',
  'quaternius_characters/Rogue.gltf',
  'quaternius_characters/Warrior.gltf',
  'quaternius_characters/Wizard.gltf',
]
