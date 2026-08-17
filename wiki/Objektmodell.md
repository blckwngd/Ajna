# Objektmodell

<!-- nav -->
[← Wiki-Übersicht](Home.md) · Entwickeln: [Einen Agent bauen](Einen-Agent-bauen.md) · [Ajna-Library](Ajna-Library.md) · [Agent-Library](Agent-Library.md) · **Objektmodell** · [Architektur](Architektur.md)
<!-- /nav -->

Ein Objekt ist ein Datensatz der `objects`-Collection. Es ist die einzige Sache, die es in Ajna gibt — Figuren, Schiffe, Punkte von Interesse, Lampen, Aufträge und Inventargegenstände sind alle Objekte.

## Felder

| Feld | Typ | Bedeutung |
|---|---|---|
| `id` | Text | Über den Manager als `"<server>:<roh>"` |
| `name` | Text | Anzeigename. **Öffentlich sichtbar — keine Klarnamen** |
| `description` | Text | Freitext, erscheint bei „Untersuchen" |
| `type` | Text | Gattung: `npc`, `animal`, `ship`, `aircraft`, `poi`, `wifi`, `item`, `uwb_anchor`, … Steuert Rückfall-Darstellung und Filter |
| `lat`, `lon` | Zahl | WGS84 |
| `altitude` | Zahl | Meter über Grund |
| `rotation` | JSON | `{ x, y, z }` in Radiant. Für die Blickrichtung zählt `y` |
| `scale` | JSON | `{ x, y, z }` |
| `appearance` | JSON | Wie es aussehen soll — siehe unten |
| `state` | JSON | Freies Feld des Agenten — siehe unten |
| `animation_state` | Text | Logischer Animationszustand: `idle`, `walk`, `fly`, … |
| `owner` | Verweis | Wird serverseitig gesetzt |
| `carried_by` | Verweis | Gesetzt heißt: im Inventar, nicht in der Welt |

> **`name` ist öffentlich.** Jeder, der das Objekt sehen darf, sieht das Feld. Anwendungen mit Personenbezug legen solche Daten in eigene Felder mit engeren Rechten und lassen `name` neutral.

---

## `appearance` — der Darstellungsvertrag

Das Kernstück der Regel **Agents liefern Daten, niemals Code**. Der Agent beschreibt deklarativ, wie ein Objekt aussehen soll; der Client entscheidet, was er daraus macht. Alle Felder sind freiwillig.

| Feld | Bedeutung |
|---|---|
| `shape` | `circle`, `emoji`, `pin`, `box`, `sphere`, `image`, … — 2D auf der Karte **und** 3D-Rückfall ohne Modell |
| `emoji` | Zeichen für `shape: "emoji"` |
| `gltf` | URL eines GLTF/GLB-Modells. Gewinnt in der AR-Ansicht |
| `color` | CSS- oder Hex-Farbe |
| `radius` | Pixelradius für den Kartenkreis |
| `texture` | Bild-URL. Bei `shape: "image"` die Bildtafel — **muss HTTPS sein**, wird streng geprüft |
| `glow` | Hex-Farbe: Objekt leuchtet. Karte als Halo, AR als pulsierende Aura. Für Zustände wie „Gerät an" |
| `yaw` | Ausrichtungskorrektur des Modells in Radiant, falls es entlang `+Z` statt `−Z` schaut |
| `animSpeed` | Abspielfaktor, begrenzt auf 0,1–4 |
| `anim` | Namensabbildung logischer Zustand → Animationsgruppe des Modells |
| `label` | Vorlage für die Tafel im 3D-Blick — siehe unten |

**Auflösung:** Die Karte nutzt nur `shape` samt `emoji`, `color`, `radius` und ignoriert `gltf`. Die AR-Ansicht nimmt ein gültiges `gltf`, sonst den `shape`-Rückfall. Fehlt `appearance` ganz, greift die ältere Logik über `model_url` und Typtabellen — Altbestände rendern also weiter.

```json
{
  "gltf": "/models/Fox.glb",
  "anim": { "walk": "Walk", "idle": "Survey", "fly": "FlapFlight" },
  "animSpeed": 1.2,
  "label": "{name} · {distance}"
}
```

### `label` — Beschriftung im 3D-Blick

Der Agent liefert eine **Vorlage**, der Client setzt ein und zeichnet. Die Entfernung kennt nur das Gerät, deshalb kann sie gar nicht vom Agenten kommen.

| Platzhalter | Ergibt |
|---|---|
| `{name}`, `{type}`, `{emoji}` | Felder des Objekts |
| `{distance}` | Formatiert: unter 100 m metergenau, unter 1 km auf 10 m, darüber Kilometer |
| `{distance_m}`, `{distance_km}` | Rohwerte |
| `{altitude}` | Höhe |
| `{state.<feld>}` | Einfacher Wert aus `state` |
| `{state.n\|Stand\|Stände}` | Ein- und Mehrzahl nach dem Zahlwert davor |

Zeilenumbrüche sind erlaubt, bis zu drei Zeilen. Unbekannte Platzhalter bleiben **sichtbar stehen** — ein Tippfehler im Agenten soll auffallen, nicht still verschwinden.

```json
{ "label": "🛍️ {state.strasse} {state.hausnummer}\n{state.anzahl|Stand|Stände} · {distance}" }
```

Sicherheit ist hier baulich gelöst: Das Ergebnis geht in einen Textknoten, nie in HTML. Auszeichnung ist damit unmöglich. Anders `glow` und `texture` — die fließen in Stilangaben und werden streng geprüft.

---

## `state` — das freie Feld

`state` gehört dem Agenten. Ein paar Schlüssel haben allerdings eine feste Bedeutung, weil Client oder Server sie auswerten.

| Schlüssel | Bedeutung |
|---|---|
| `source` | **Wichtigster Schlüssel.** Marke „von diesem Agenten angelegt". Schützt fremde Objekte vor dem Aufräumen und speist den Inhaltsfilter |
| `motion` | Bewegungsvektor zur Vorausberechnung — siehe unten |
| `walk_path` | Geplanter Weg als `[[lat, lon], …]`; die Debug-Ebene zeichnet ihn |
| `call` | Auftragszustand; wird von den Auftragsmethoden gepflegt |
| `stackable` | Gleichartige Gegenstände im Inventar stapeln |

Alles andere ist frei. Eigene Schlüssel sollten einen Namensraum tragen, damit zwei Anwendungen auf einer Instanz sich nicht ins Gehege kommen.

### `state.motion` — Bewegung ohne Schreiblast

Das wichtigste Muster für alles, was sich bewegt.

**Das Problem:** Ein `updateObject` je Takt und Objekt heißt Datenbankschreibung **plus** Verteilung an alle Clients. Bei einem halben Dutzend Figuren im Halbsekundentakt ist die Grenze erreicht — und bei Quellen mit Kontingent (Flugzeuge alle 30 s) springen die Objekte ohnehin.

**Die Lösung:** Der Agent veröffentlicht statt einer Position einen **Bewegungsvektor**. Der Client rechnet daraus jedes Einzelbild die aktuelle Position voraus.

```js
await ajna.updateObject(id, {
  lat, lon, altitude,
  state: {
    ...basis,
    motion: {
      v: 12.5,          // Geschwindigkeit über Grund, m/s
      trk: 275.4,       // Kurs in Grad, 0 = Nord, im Uhrzeigersinn
      vrate: 0,         // Steigrate, m/s
      lat0: lat, lon0: lon, alt0: altitude,   // Bezugspunkt der Messung
      t: Date.now(),    // Zeitpunkt der Messung
    },
  },
})
```

Der `PositionSmoother` im Client übernimmt das automatisch — für Karte **und** AR, ohne Zutun. Bleibt der Agent aus, friert die Vorausberechnung nach einer Schonfrist ein.

`state.adsb` ist derselbe Vertrag unter dem historischen Namen aus der Flugzeug-Bridge und wird weiter unterstützt. Für Neues `state.motion` nehmen.

> Bei Wegen mit Ecken muss an **jedem Knick** neu veröffentlicht werden — die Vorausberechnung läuft geradeaus und würde Kurven sonst abschneiden.

---

## Animationen

`animation_state` trägt den **logischen** Zustand: `idle`, `walk`, `fly`. Wie der beim konkreten Modell heißt, sagt `appearance.anim`:

```json
{ "anim": { "walk": "Walk", "idle": "Survey", "fly": "FlapFlight" } }
```

Nur Namen von Animationsgruppen des Modells greifen — reine Daten, kein Code. Passt nichts, bleibt das Modell in seiner Ruhelage.

```js
await ajna.setAnimation(id, 'walk')
```

---

## Rechte am Objekt

Jedes Objekt trägt eine Liste von Zugriffseinträgen. Rechte: `view`, `edit`, `move`, `owner`. Dazu getrennt die erlaubten Interaktionen:

```js
await ajna.addPermission(id, {
  subject_type: 'authenticated',
  rights: ['view'],
  interact_actions: ['pet', 'feed'],   // oder ['*']
})
```

Für Agents ist meist die Standardvorlage am Konto der richtige Ort — sie gilt dann für alles, was der Agent anlegt. Siehe [Berechtigungen](Berechtigungen.md).

---

## Vollständiges Beispiel

```js
const drache = await ajna.createObject({
  name: 'Alter Drache',
  description: 'Schläft seit Jahrhunderten auf dem Kirchendach.',
  type: 'dragon',
  lat: 50.45132, lon: 7.53627, altitude: 24,
  rotation: { x: 0, y: 1.2, z: 0 },
  appearance: {
    gltf: '/models/Dragon.glb',
    anim: { idle: 'Idle', fly: 'FlapFlight' },
    animSpeed: 0.8,
    glow: '#ff6600',
    label: '🐉 {name}\n{distance}',
  },
  state: {
    source: 'mein-agent',
    stimmung: 'schlafend',
  },
})

await ajna.setAnimation(drache.id, 'idle')
```

<!-- navfuss -->
---

← [Agent-Library](Agent-Library.md) · [Übersicht](Home.md) · [Architektur](Architektur.md) →
<!-- /navfuss -->
