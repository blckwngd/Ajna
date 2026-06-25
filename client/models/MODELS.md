# 3D-Modelle (`client/models/`)

Werden über das Objekt-Feld `appearance.gltf` bzw. das Legacy-`model_url`
referenziert (siehe `client/core/Appearance.js`, `client/engine/GameObject.js`).
URL-Form: `https://<server>/models/<Datei>.glb`. Caddy liefert sie statisch aus
(inkl. CORS für Cross-Origin-Viewer).

Auswahlkriterien: **animiert** (wo sinnvoll), **leichtgewichtig** (AR übers LAN)
und **frei lizenziert** (CC0 bevorzugt, CC-BY mit Attribution unten).

## Bestand

| Datei | Kategorie | Animiert | Lizenz | Quelle / Attribution |
|---|---|---|---|---|
| `Fox.glb` | animal | ✓ (Survey/Walk/Run) | CC0 (Modell) · CC-BY 4.0 (Animationen) | Khronos glTF-Sample-Assets · PixelMannen / Tomás Laulhé |
| `Stag.glb` | animal | ✓ | CC0 | Quaternius |
| `Wolf.glb` | animal / enemy | ✓ | CC0 | Quaternius |
| `Deer.glb` | animal | ✓ | CC0 | Quaternius |
| `MawGooey.glb` | enemy / monster | ✓ | CC0 | Quaternius (Ultimate Monsters) |
| `Slime.glb` | enemy / monster | ✓ | CC0 | Quaternius (Ultimate Monsters) |
| `CesiumMan.glb` | npc | ✓ (Walk) | CC-BY 4.0 | Khronos glTF-Sample-Assets · © Cesium |
| `RiggedFigure.glb` | npc / enemy | ✓ | CC-BY 4.0 | Khronos glTF-Sample-Assets |
| `BrainStem.glb` | device / robot | ✓ | ⚠️ **Poser EULA** | Smith Micro Software — **siehe Warnung** |
| `vanguard.glb` | npc / enemy | (T-Pose) | ⚠️ **vermutlich Mixamo** | Adobe Mixamo — **siehe Warnung** |
| `vanguard@samba.glb` | npc (Animation) | ✓ (Samba) | ⚠️ **vermutlich Mixamo** | Adobe Mixamo — **siehe Warnung** |

## ⚠️ Lizenz-Warnungen (vor Public-Repo / Release prüfen)

- **`BrainStem.glb` — Poser EULA (Smith Micro Software, Inc.):** NICHT frei
  redistributierbar. In einem öffentlichen Repo problematisch. Empfehlung:
  entfernen und durch ein CC0-Roboter-Modell ersetzen (Quaternius „Robot"-Packs).
- **`vanguard.glb` / `vanguard@samba.glb` — vermutlich Adobe Mixamo:** Mixamo-
  Inhalte dürfen in eigenen Projekten genutzt, aber **nicht als Asset
  weiterverteilt** werden (z. B. in einem öffentlichen Asset-Repo). Herkunft/
  Lizenz prüfen; ggf. durch CC0-Charaktere ersetzen (Quaternius „RPG/Survival
  Characters").

CC0 = keine Attribution nötig. CC-BY 4.0 = Nutzung frei, **Namensnennung
erforderlich** (siehe Spalte „Attribution"). Diese Datei dient als Nachweis.

## Quellen für mehr (CC0, game-tauglich, leichtgewichtig)

- **Quaternius** — alles CC0, klein & game-ready (rigged + animiert):
  <https://quaternius.com> bzw. <https://quaternius.itch.io>.
  Passende Packs: *Ultimate Monsters* (Gegner), *Animated Animals* (Tiere),
  *RPG/Survival Characters* (NPCs), *Cute Robots* (Geräte), *RPG Items* (Items),
  *Cyberpunk/Sci-Fi Props* (Geräte). Stag/Wolf/Deer/MawGooey/Slime stammen daher.
- **Khronos glTF-Sample-Assets** (CC0/CC-BY, direkt ladbar):
  <https://github.com/KhronosGroup/glTF-Sample-Assets> — eher Test-/Demo-Modelle.
- **Poly Pizza** (CC0/CC-BY, große Auswahl): <https://poly.pizza>.

Hinweis: Die Khronos-„Produktvisualisierungs"-Modelle (Avocado, BoomBox, Lantern
…) sind zwar CC0, aber mit 8–10 MB (4K-Texturen) **zu schwer für AR übers LAN** —
deshalb bewusst nicht aufgenommen. Für Items/Geräte die leichten Quaternius-Packs
nehmen.
