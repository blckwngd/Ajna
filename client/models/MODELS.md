# 3D-Modelle (`client/models/`)

Referenziert über `appearance.gltf` bzw. Legacy `model_url`
(`https://<server>/models/<Datei>.glb`); Caddy liefert sie statisch + mit CORS
aus. Auswahl: animiert (wo sinnvoll), leichtgewichtig (AR übers LAN), aus frei
nutzbaren Quellen.

> **Lizenz/Attribution wird später finalisiert.** Hier sind die **Quellen**
> dokumentiert — über die verlinkten Seiten/Repos lassen sich Autor + genaue
> Lizenz pro Modell ermitteln.

## Bestand nach Kategorie

| Datei | Kategorie | Animiert | Quelle |
|---|---|---|---|
| `CesiumMan.glb` | npc | ✓ | Khronos glTF-Sample-Assets (CC-BY 4.0, © Cesium) |
| `Soldier.glb` | npc / enemy | ✓ | three.js examples |
| `RobotExpressive.glb` | device / npc | ✓ (viele) | three.js examples (CC0, Tomás Laulhé / Don McCurdy) |
| `MawGooey.glb` | enemy / monster | ✓ | Quaternius (CC0) |
| `Slime.glb` | enemy / monster | ✓ | Quaternius (CC0) |
| `Fox.glb` | animal | ✓ | Khronos glTF-Sample-Assets (CC0 / CC-BY) |
| `Horse.glb` | animal | ✓ | three.js examples |
| `Flamingo.glb` | animal / fliegend | ✓ | three.js examples |
| `Stork.glb` | animal / fliegend | ✓ | three.js examples |
| `Parrot.glb` | animal / fliegend | ✓ | three.js examples |
| `Dragon.glb` | dragon | – (rigged) | Poly Pizza · „Dragon Rigged" |
| `Sword.glb` | item | – | Poly Pizza |
| `TreasureChest.glb` | item | – | Poly Pizza |

## Quellen (für Herkunft, Lizenz, Attribution + mehr Modelle)

- **Khronos glTF-Sample-Assets** — CC0/CC-BY, direkt ladbar (raw GitHub):
  <https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models>
  (Lizenz je Modell in `Models/Models.md`).
- **three.js examples** — animierte Demo-Modelle, direkt ladbar (raw GitHub):
  <https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf>
  (Credits/Lizenz im jeweiligen Ordner bzw. three.js-Repo).
- **Quaternius** — CC0, game-ready (rigged + animiert): <https://quaternius.com>.
  MawGooey/Slime stammen aus `Quaternius/TestGltfAssets` (GitHub, direkt ladbar).
- **Poly Pizza** — große Auswahl, GLBs unter `https://static.poly.pizza/<uuid>.glb`
  (URL steckt in der jeweiligen Modellseite `poly.pizza/m/<id>`):
  - Dragon: <https://poly.pizza/m/WIOTISRjeX>
  - Sword: <https://poly.pizza/m/9lLmH8Et4K>
  - TreasureChest: <https://poly.pizza/m/O72u4Drp8k>

## Bewusst weggelassen / entfernt

- Khronos-„Produktvisualisierung" (Avocado/BoomBox/Lantern …): CC0, aber 8–10 MB
  (4K-Texturen) → zu schwer für AR.
- Frühere Modelle mit Lizenz-Problem (BrainStem = Poser-EULA, vanguard* =
  vermutlich Mixamo) bzw. defekten Rigs wurden entfernt.
