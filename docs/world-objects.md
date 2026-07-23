# World-Director: Archetypen & Objekt-Contract

Der **World-Director** ([agents/world-director.mjs](../agents/world-director.mjs)) bevölkert die
Welt vollautomatisch mit Figuren (NPCs, Gegner, Tiere, Drachen), Hinweisen und
Items. Dieses Dokument ist der **Contract** zwischen Director, Client-Renderer und
späteren 3D-Modell-Autoren — nicht der Implementierungsplan.

## Archetypen

| `type`   | Rolle              | Bewegung (ab P2/P3)            | Default-Interaktionen   |
|----------|--------------------|--------------------------------|-------------------------|
| `npc`    | Personen           | Straßennetz (begehbare Wege)   | `talk`, `examine`       |
| `enemy`  | Gegner             | Straßennetz (Patrouille; Verfolgung später mit Presence) | `attack`, `examine` |
| `animal` | Tiere              | Freiflächen (Parks/Wiesen)     | `feed`, `examine`       |
| `dragon` | fliegende Wesen    | freier Flug (ignoriert Straßen, nutzt `altitude`) | `examine` |
| `item`   | Gegenstände        | statisch                       | — (vorerst ohne Funktion) |
| `hint`   | Hinweise/Tipps     | statisch                       | `examine`               |

Unbekannte Types rendern als roter Würfel (3D) bzw. ❌-Marker (Karte) — nie ein Fehler.

## Animations-Vokabular (animation_state)

[GameObject._applyAnimationState](../client/engine/GameObject.js) matcht `animation_state`
**case-insensitiv** gegen die `AnimationGroup`-Namen einer geladenen GLB. Der Director
setzt diese Werte **schon jetzt**, obwohl die Platzhalter sie ignorieren — sobald ein
`model_url` mit passend benannten Gruppen gesetzt wird, animiert alles **ohne
Code-Änderung**.

| Archetyp | Erwartete AnimationGroup-Namen          |
|----------|------------------------------------------|
| `npc`    | `idle`, `walk`, `run`, `talk`            |
| `enemy`  | `idle`, `walk`, `run`, `attack`          |
| `animal` | `idle`, `walk`, `run`                    |
| `dragon` | `idle` (Schweben), `fly`                 |
| `item`   | `idle`                                   |
| `hint`   | `idle`                                   |

**Für Modell-Autoren:** Benenne die AnimationGroups wie oben (Groß-/Kleinschreibung
egal). Der Resolver ([`ANIM_ALIASES`](../client/engine/GameObject.js)) matcht **per
Teilstring** und über eine Alias-Prioritätsliste — ein Präfix wie `metarig|` stört
also nicht, und modell-spezifische Namen (`FlapFlight`, `GlideFlight`) werden
erkannt. Fehlt jeder Treffer, fällt der Renderer auf die erste Gruppe zurück.

**Verfügbare Flug-Modelle** (`MODEL_POOL.dragon` im World-Director):

| Modell | idle | fly (aktiv/klappen) | glide (gleiten) | walk |
|---|---|---|---|---|
| `Dragon.glb`  | `Idle` | `FlapFlight` | `GlideFlight` | `Walk` |
| `wyvern.glb`  | `metarig\|idol` | `metarig\|flaping` | `metarig\|flying` | `metarig\|walk` |

> Der wyvern hat abweichende/fehlerbehaftete Clip-Namen (`idol` statt idle,
> `flaping` statt flapping). Die Aliase `idol` (→ idle) und `flying` (→ glide)
> fangen das ab — beim Ergänzen ähnlich benannter Modelle die passenden
> Teilstrings zu `ANIM_ALIASES` hinzufügen, statt Clips umzubenennen.
>
> Quelle wyvern.glb: [Sketchfab „Wyvern Animated"](https://sketchfab.com/3d-models/wyvern-animated-1dc70bbf15c2456a85290c8613b6c1ff)
> — Lizenzbedingungen (Namensnennung o. Ä.) vor einer Veröffentlichung prüfen.

## Objekt-`state`-Identitätsschema

Jedes vom Director erzeugte Objekt trägt eine stabile Identität im `state`-JSON, damit
**bestehende Records später gezielt angepasst** werden können (Aussehen via `model_url`,
Position, Name, `interact_actions`, Ausmustern) — durch den Director beim Neustart
(Adopt-on-Boot) oder durch Wartungs-Skripte ([tools/ajna.mjs](../tools/ajna.mjs)).

```jsonc
state: {
  "director":  true,        // Eigentums-/Herkunftsmarker des World-Director
  "archetype": "npc",       // npc | enemy | animal | dragon | item | hint
  "species":   "passerby",  // optionaler Subtyp (z. B. Tierart, NPC-Rolle)
  "spawn_id":  "<uuid>",    // stabile ID über Neustarts hinweg
  "actions":   [{ "key": "talk", "label": "Sprechen" }],  // Menü-Aktionen (Client)
  "dialog":    "…",         // npc: Antworttext bei talk/examine (Client zeigt ihn)
  "hint":      "…"          // hint: Hinweistext bei examine
}
```

**Dialog/Antwort-Kanal:** Ein `interact(id, action)` läuft über den Server
(Permission-Check) und wird als Realtime-Event an alle Subscriber gebroadcastet.
Der Map-Client (`handleMarkerInteract`) zeigt bei `talk`/`examine` die im `state`
hinterlegte Zeile (`dialog`/`hint`) als Toast — so „antwortet" das Objekt allen
Zuschauern, nicht nur dem Auslöser. `state.actions` bestimmt, welche Aktionen das
Kontextmenü anbietet (es gibt kein Top-Level-`actions`-Feld im Schema). Dynamische,
agent-gesteuerte Dialoge (variable/verzweigte Antworten, `talk`-Animation) sind der
nächste Schritt — der Director abonniert dann die interact-Events seiner Objekte
(wie der wand-agent) und antwortet aktiv.

Felder, die der Client/Director sonst nutzt: `walk_path` (aktuell verfolgte Polyline,
für die grüne AR-Debug-Linie), `hp` (enemy, ab P3).

## Sichtbarkeit (ACE)

Der Director setzt pro Objekt eine ACE `subject_type: authenticated, rights: [view]`
plus die archetyp-spezifischen `interact_actions`, damit alle eingeloggten Spieler die
Figuren sehen und (sinnvoll) mit ihnen interagieren können.

## Roadmap-Bezug

- **P0** (jetzt): Platzhalter-Optik + Map-Icons + dieser Contract + Director-Skelett.
- **P1**: statische Spawns mit generierten Namen + Dialog/Hinweis im `state`.
- **P2**: NPC/Gegner-Autonomie auf dem Straßennetz (Ziel → Route → laufen → Pause → repeat).
- **P3**: Drachen-Freiflug + Tiere auf Freiflächen (`/ajnaapi/geo/areas`).
- **P4**: dekorative Items + Dichte/Lifecycle/Skalierung.
- **P5**: GLB-Modelle über `model_url`, echte Interaktionen/Belohnungen, Filter-UI, Presence.
