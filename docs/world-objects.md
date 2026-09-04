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

| Modell | idle | fly (klappen) | glide (gleiten) | walk | takeoff (abheben) |
|---|---|---|---|---|---|
| `Dragon.glb`  | `Idle` | `FlapFlight` | `GlideFlight` | `Walk` | — (→ `FlapFlight`) |
| `wyvern.glb`  | `metarig\|idol` | `metarig\|flaping` | `metarig\|flying` | `metarig\|walk` | `metarig\|take off` |

Neue lokale GLB-Dateien in **zwei** Listen eintragen: `MODEL_POOL` (agents/world-director.mjs,
welcher Archetyp welches Modell spawnt) UND [`LOCAL_MODELS`](../client/core/localModels.js)
(client — speist das 3D-Modell-Dropdown im Editor).

> Der wyvern hat abweichende/fehlerbehaftete Clip-Namen (`idol` statt idle,
> `flaping` statt flapping). Die Aliase `idol` (→ idle) und `flying` (→ glide)
> fangen das ab — beim Ergänzen ähnlich benannter Modelle die passenden
> Teilstrings zu `ANIM_ALIASES` hinzufügen, statt Clips umzubenennen.
>
> Quelle wyvern.glb: [Sketchfab „Wyvern Animated"](https://sketchfab.com/3d-models/wyvern-animated-1dc70bbf15c2456a85290c8613b6c1ff)
> — Lizenzbedingungen (Namensnennung o. Ä.) vor einer Veröffentlichung prüfen.

## Ausrichtung (`rotation.y`)

Ein Objekt, das sich bewegt, soll dorthin schauen, wohin es läuft. Dafür gibt es
**genau eine** Umrechnung: `yawFuerKurs()` in
[`client/core/yaw.js`](../client/core/yaw.js).

```js
import { yawFuerKurs, yawFuerKursGrad } from '../client/core/yaw.js'

rotation: { x: 0, y: yawFuerKurs(kursRad), z: 0 }
```

**Die Konvention**

| | |
|---|---|
| Kurs | Kompass: 0 = Nord, im Uhrzeigersinn (wie `StreetNav.bearingRad`) |
| Ost | +X |
| Nord | **−Z** (`GeoTransformer` läuft mit `invertNorthSouth`) |
| Modellfront | **+Z** — das ist die Annahme, mit der jeder Agent rechnet |

Daraus folgt `yaw = π − kurs`. Die Herleitung steht in `yaw.js` und wird in
`yaw.test.mjs` nachgerechnet: Für jeden Kurs wird die Blickrichtung ausgerechnet
und mit der Bewegungsrichtung verglichen.

**Die Trennlinie — wichtig beim Hinzufügen von Modellen**

Agents rechnen **immer** mit der +Z-Annahme. Ist ein GLB anders herum
modelliert, wird das im Client korrigiert: `MODEL_YAW_RAD` in
`client/engine/GameObject.js`, je Datei, auf einem Wrapper-Node zwischen `root`
und Modell — die Geo-Rotation bleibt unberührt.

> Ein Agent kennt die GLB-Datei gar nicht. Jede Umrechnung, die die Eigenheit
> eines Modells im Agent auszugleichen versucht, sitzt an der falschen Stelle.

**Zeigt eine neue Figur in die falsche Richtung?**

1. Läuft sie **rückwärts** (180° daneben): Eintrag in `MODEL_YAW_RAD` mit `Math.PI`.
2. Läuft sie **seitwärts** (90° daneben): Die Front des Modells liegt auf +X.
   Entweder `MODEL_YAW_RAD` mit `±Math.PI/2`, oder das Modell im
   3D-Werkzeug ausrichten — Letzteres ist sauberer, weil es die Ausnahme entfernt
   statt sie zu verwalten.
3. Zeigt sie mal richtig, mal falsch: Dann rechnet jemand doch wieder selbst.
   `yaw.test.mjs` prüft, dass keine Agent-Datei eine eigene `π/2`-Formel enthält.

**Historie.** Bis 2026-08-24 gab es drei Formeln: `π − h` (Director, Boden),
dieselbe mit Env-Regler `WD_FLY_YAW_OFFSET` (Flug) und `h − π/2` in den
Fahrzeug-Brücken. Die letzte war gegen die *ungekippte* Achsenlage (Z = Nord)
gestimmt, die es hier nicht gibt. Aufgefallen ist es nie, weil Schiffe und
Flugzeuge als Emoji-Tafel mit Kugel gezeichnet werden — eine Kugel hat keine
Vorderseite.


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

## Aktions-Reichweite (`max_distance`)

Jede Aktion in `state.actions` kann eine Reichweite tragen:

```json
{ "key": "attack", "label": "Angreifen", "max_distance": 30 }
```

Ab da gilt sie nur noch in der Nähe. Fehlt die Angabe oder ist sie `0`, gibt es
keine Einschränkung — bestehende Objekte ändern ihr Verhalten also nicht.

**Nähe lässt sich nur prüfen, wenn der Standort freigegeben ist.** Deshalb
ergibt sich aus dem Wert, welche Stufe der Spieler mindestens eingestellt haben
muss ([Privatsphäre-Stufen](../client/core/PrivacyPolicy.js)):

| `max_distance` | nötige Stufe | warum |
|---|---|---|
| nicht gesetzt / 0 | keine | keine Prüfung |
| ≥ 500 m | **Gegend** | die auf ~100 m gerundete Position reicht |
| < 500 m | **Nähe** oder **Genau** | 100-m-Rundung kann eine 30-m-Frage nicht beantworten |

Der Tausch ist bewusst und nachvollziehbar: **Wer kämpfen will, lässt für den
Kampf die Deckung fallen.** Niemand wird gedrängt — die Aktion ist dann eben
nicht verfügbar, mit sichtbarer Begründung im Menü.

Bei Stufe **Nähe** gibt es gar keine Koordinaten, nur die Meldung „jemand ist an
diesem Objekt" (`ProximityReporter`). Für eine Nahbereichs-Aktion ist das die
**beste** Auskunft, nicht die schlechteste: Sie beantwortet genau die Frage,
ohne einen Ort preiszugeben.

Die Logik steht in [`client/core/aktionsReichweite.js`](../client/core/aktionsReichweite.js)
und wird von beiden Seiten benutzt — der Client entscheidet damit, ob er den
Menüpunkt anbietet, der Agent prüft damit, was bei ihm ankommt. Zwei
Implementierungen würden auseinanderlaufen.

### Auftrag nur vor Ort annehmen

Derselbe Mechanismus, zweiter Nutzer. Ein Auftrag trägt
`state.call.annahmeRadiusM` (0 oder fehlend = überall annehmbar, bestehende
Aufträge ändern sich also nicht). Im Auftrags-Editor steht das als „Wo
annehmbar": überall / 50 m / 250 m / 1 km.

**Wogegen das hilft:** Ohne Auflage kann jemand vom Sofa aus alle Aufträge der
Stadt für sich reservieren und liegen lassen. Dagegen genügt eine Schranke, die
man nur mit Absicht umgeht.

**Was es nicht ist: ein Nachweis.** Die Position kommt vom Gerät des
Bearbeiters, er kann sie also erfinden — dieselbe Grenze, die schon über
`POST /api/proximity` steht. Belastbare Anwesenheit braucht einen zweiten Faktor
(UWB-Anker, NFC-Marke, signierter Sensor-Report). Das gilt genauso für den
`vorOrt`-Nachweis beim Melden.

Was beim Annehmen mitgeht, entscheidet die Stufe — im `AjnaManager`, dem einen
Ort, an dem Positionen freigegeben werden:

| Stufe | geht raus |
|---|---|
| Genau | exakte Koordinate |
| Gegend | auf 100 m gerundete Koordinate (Server rechnet 150 m Kulanz dazu) |
| Nähe | **keine Koordinate** — nur `nah: true/false` |
| Verborgen | nichts; der Knopf bleibt gesperrt, mit Begründung |

Die Stufe „Nähe" ist hier kein Notbehelf, sondern die genaueste Antwort: Der
Client rechnet den Umkreis selbst und meldet nur das Ergebnis. Das ist genauso
belastbar wie eine gesendete Koordinate — beide kommen von ihm —, kostet aber
keinen Ort.

Der Server prüft **zuletzt**, nach Frist und Karma: Wer das Karma nicht hat,
soll nicht erst hinlaufen. Abgelehnt wird mit `accept_needs_position` oder
`accept_too_far` samt `maxDistanceM`/`distanceM` — Codes, keine übersetzten
Sätze.

> Die Regel steht zweimal: `client/core/aktionsReichweite.js` und
> `pocketbase/pb_hooks/quests.js`. `pb_hooks` läuft in goja und kann kein
> ES-Modul laden. Ein Test in `tests/run-ui.mjs` hält die Konstanten zusammen —
> sonst böte der Client einen Knopf an, den die Route ablehnt.

### Melden nur vor Ort

`state.call.vorOrtRadiusM` steuert den Nachweis `vorOrt` beim **Melden** —
50 / 150 / 500 m, Vorgabe 150 m. Nicht zu verwechseln mit `annahmeRadiusM`: Das
eine begrenzt, wer den Auftrag übernimmt, das andere, was als erledigt gemeldet
werden darf. Ein Auftrag kann weiträumig annehmbar und trotzdem nur am Ort
meldbar sein.

Die Meldung trägt `precise` — ob die Stufe „Genau" galt. Daran hängt ein
**Nachlass für eine Rundung, die wir selbst verlangt haben**: Bei „Gegend"
meldet der Client auf 100 m gerundet, also gelten oberhalb von 500 m dieselben
150 m Kulanz wie beim Annehmen. Wer „genau" behauptet, bekommt sie nicht, und
unterhalb der Schwelle gibt es sie gar nicht — eine 50-m-Frage mit 100-m-Rundung
zu bejahen hieße raten. Der Prüfer sieht `precise` am Nachweis und weiß damit,
wie belastbar die Angabe ist.

## Die Stufe gilt auch für die FRAGE

Nicht nur für das, was man meldet. Die Regionsliste (`quests/near`) ist eine
Frage mit einem Ort darin — „was gibt es HIER". Sie ging unverändert an jeden
verbundenen Server, ein Server auf „Verborgen" bekam die exakte Position also
beim ersten Blick in die Auftragsliste.

**Wer keinen Ort bekommt, bekommt auch keine Frage gestellt.** Seine Aufträge
fehlen dann in der Liste; das Fenster sagt das, als **Hinweis, nicht als
Fehler** — ein Fehler heißt „versuch es nochmal", hier hat jemand etwas
entschieden. `mine=1` läuft weiter: Die eigenen Ausschreibungen sind keine
Aussage darüber, wo man ist.

Freigegeben wird an genau drei Stellen, alle im `AjnaManager`: `questsNear`
(Regionsliste), `_annahmeOrt` (Annehmen), `_nachweisOrt` (Melden). Eine zweite
Stelle, die Positionen durchreicht, wäre eine zweite, die es falsch machen kann.


---

## Kampf

Kampf ist eine **Spielregel, keine Plattformregel**. Es gibt dafür keine
PocketBase-Route und kein Feld im Schema: Treuhand, Rechte und Karma gehören ins
Basissystem, weil sie über Besitz entscheiden — Trefferpunkte nicht. Ein
Vereins- oder Firmenserver will vielleicht gar keine Gegner.

Alles steht deshalb in [`agents/lib/kampf.mjs`](../agents/lib/kampf.mjs) und ist
für **jeden Agent** nutzbar. Der World-Director ist nur der erste Nutzer.

### Eigene Gegner in die Welt bringen

```js
import { bootAgent } from './lib/agent-base.mjs'
import { Kampf, hpVon, beuteObjekt } from './lib/kampf.mjs'

const { ajna } = await bootAgent('mein-agent')
const kampf = new Kampf()

// Gegner anlegen — Reichweite an der Aktion setzt die Standort-Anforderung.
await ajna.createObject({
  name: 'Wegelagerer', type: 'enemy',
  lat, lon, altitude: 0,
  state: {
    source: 'mein-agent',
    hp: { ist: 40, max: 40 },
    schaden: 8,                       // was EIN Schlag gegen ihn ausrichtet
    actions: [{ key: 'attack', label: 'Angreifen', max_distance: 30 }],
    // Optional: feste Beute statt Tabelle
    loot: [{ name: 'Beutel', anzahl: 1, chance: 0.5 }],
  },
})

ajna.onInteract(id, async (evt) => {
  if (evt.action !== 'attack') return
  const ziel = ajna.getObjectById(id)
  const r = kampf.schlag({ ziel, angreifer: evt.source, absender: evt.payload?.at })
  if (!r.ok) return                                  // zu weit, zu schnell, schon tot
  await ajna.updateObject(id, {
    state: { ...ziel.state, hp: r.hp },
    animation_state: r.tot ? 'death' : 'hit',
  })
  if (r.tot) for (const name of r.beute) {
    await ajna.createObject(beuteObjekt(name, { lat: ziel.lat, lon: ziel.lon }))
  }
})

// Liegezeit abwarten, dann abräumen
setInterval(async () => {
  for (const tot of kampf.abgelaufen()) { kampf.vergiss(tot); await ajna.deleteObject(tot) }
}, 2000)
```

### Wer schreibt die Zahlen

Der **Besitzer** des Objekts, also der Agent. `state` darf sein Besitzer frei
schreiben — ein Angreifer kann Trefferpunkte damit nicht selbst setzen.
Dieselbe Trennlinie wie beim Karma: Eine Zahl, die der Client setzen darf, ist
keine Zahl, sondern eine Behauptung.

`Kampf.schlag()` **rechnet und entscheidet, schreibt aber nicht**. Der Aufrufer
schreibt. So lässt sich die Regel ohne laufenden Server prüfen, und ein Agent
kann das Ergebnis anders umsetzen als der World-Director.

### Beute

**Beute wird erzeugt, nicht gedeckt.** Auftrags-Belohnungen kommen
treuhänderisch aus einem echten Inventar; Beute entsteht aus dem Nichts. Damit
„ein Diamant" seine Bedeutung behält, sind Diamanten in den Tabellen
ausdrücklich selten (unter 1 %), der Rest sind eigene Gattungen — brauchbar als
Material für spätere Aufträge („bring mir drei Wolfsfelle"), ohne die
Auftragswährung zu verwässern.

Die Beute **gehört niemandem**: Sie liegt herum und ist tragbar. Das erspart die
Frage nach Schadensanteilen und Todesstoß und passt zum Weltmodell.

`state.loot` am Objekt geht vor jeder Tabelle — ein besonderer Gegner soll etwas
Bestimmtes hinterlassen können.

### Anzeige

Ein verletztes Objekt bekommt **von selbst** einen schmalen Balken über dem
Kopf — grün, dann gelb, dann rot. Er erscheint nur bei Verletzung und nur in
der Nähe; eine `appearance.label` braucht es dafür nicht. Wer die Zahl im Text
haben will, schreibt `{hp}` in die Vorlage (`15/30`, leer solange unverletzt).

Für **Treffer** und **Tod** nutzt der Client die Clips `Hit`/`Death` des
Modells, falls vorhanden. Fehlen sie, zuckt die Figur kurz zurück bzw. kippt
zur Seite — jedes Modell reagiert also sichtbar, ohne dass ein Agent etwas
dafür tun muss. **Beide laufen EINMAL** und halten die Endpose; in der Schleife
fiele ein Gefallener alle zwei Sekunden neu in sich zusammen.

`hit` ist dabei eine Geste, kein Zustand: Der Agent schreibt kurz darauf `idle`
nach (der Director nach 1,2 s). Bliebe `hit` stehen, liefe die Figur beim
Betrachter ihre Geh-Animation auf der Stelle weiter.

### Aussehen von Modellen steuern

`appearance.color` färbt **untexturierte** Materialien eines geladenen Modells,
`appearance.opacity` (0…1) macht es durchscheinend. Damit werden aus den grauen
Gallert-Modellen farbige Wesen, ohne dass eine neue Datei nötig wäre.

Materialien, deren Name auf ein Auge hindeutet (`eye`, `auge`, `pupil`, `iris`),
bleiben von beidem verschont — ein durchsichtiges Auge in einem durchsichtigen
Körper ist kein Auge mehr.

> Farbe pro Figur aus einer Palette zu wählen, ist reizvoll — dann aber
> **deterministisch aus einer stabilen Saat** (z. B. `state.spawn_id`), nicht
> mit `Math.random()`. Der Director rechnet die appearance bei jedem Start neu
> aus; mit Zufall bekäme jede Figur bei jedem Neustart eine andere Farbe, und
> er schriebe sie jedes Mal neu.

### Ein Getroffener bleibt stehen

Wer angegriffen wird, setzt seine Runde nicht fort. Dafür genügt es **nicht**,
den Agenten intern anhalten zu lassen: Solange kein neuer `state.motion` mit
`v: 0` geschrieben ist, rechnet der Betrachter den alten Kurs weiter — die
Figur spaziert dem Angreifer davon, während sie beim Agenten längst steht.

```js
plan.haltAn({ lat, lon, altitude, trk })   // → state.motion mit v = 0
```

Dasselbe gilt fürs Zuhören bei „Sprechen". Der Director hält Kämpfende deutlich
länger an als Gesprächspartner (`WD_KAMPF_HALT_S`, Vorgabe 30 s) und dreht sie
zum Angreifer.

### Fallen

- **Abklingzeit nicht vergessen.** Ohne sie erschlägt ein Skript die halbe Welt.
  `Kampf` führt sie je (Spieler, Ziel).
- **Eine Leiche ist kein Ziel.** `schlag()` lehnt mit `schon-tot` ab, bis
  `vergiss()` gerufen wurde.
- **Nachspawnen ist geschenkt**, wenn der Agent eine Soll-Population führt: Die
  Leiche löschen genügt, der nächste Abgleich stellt anderswo einen neuen hin.
- **Gegen die LIVE-Position prüfen und ablegen.** Zwischen zwei
  Bewegungs-Schreibvorgängen liegen Sekunden Weg. Wer `record.lat` benutzt,
  lehnt Treffer ab, die aus Spielersicht sitzen — und legt die Beute meterweit
  neben die Leiche.
- **Beute braucht `state.portable`.** Ohne das Flag blendet der Client kein
  „🎒 Einsammeln" ein und die Pickup-Route lehnt ab: Das Fundstück liegt für
  immer da.
- **Beute braucht eine Manifest-Schicht.** Ein Agent-Objekt, das zu keiner
  Schicht des eigenen Manifests passt, wird vom Inhaltsfilter ausgeblendet,
  sobald ein Spieler dort einmal etwas ausgewählt hat. `beuteObjekt()` setzt
  darum `state.archetype: 'item'`.


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
