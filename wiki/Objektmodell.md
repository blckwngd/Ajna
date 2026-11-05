# Objektmodell

<!-- nav -->
[← Inhalt](Home.md#inhalt) · Entwickeln: [Einen Agent bauen](Einen-Agent-bauen.md) · [Ajna-Library](Ajna-Library.md) · [Agent-Library](Agent-Library.md) · **Objektmodell** · [Dialoge](Dialoge.md) · [Architektur](Architektur.md)
<!-- /nav -->

<!-- seiteninhalt -->
**Auf dieser Seite:** [Felder](#felder) · [appearance — der Darstellungsvertrag](#appearance--der-darstellungsvertrag) · [state — das freie Feld](#state--das-freie-feld) · [Animationen](#animationen) · [Rechte am Objekt](#rechte-am-objekt) · [Vollständiges Beispiel](#vollständiges-beispiel)
<!-- /seiteninhalt -->

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
| `parent` | Verweis | Das Sammelobjekt, in dem dieses Objekt steckt — siehe unten |
| `local` | JSON | `{ east, north, up, heading }`: Versatz zum Sammelobjekt in Metern und Grad. Leer = eigene Lage |
| `heading` | Zahl | Ausrichtung um die Hochachse, Grad im Uhrzeigersinn ab Nord — Bezug für den Versatz der Kinder |
| `acl_break` | Wahrheitswert | `true` = erbt die Rechte des Sammelobjekts nicht |
| `container` | JSON | Vorhanden = darf andere Objekte enthalten: `{ badge, view, expanded, load }` — siehe unten |

> **`name` ist öffentlich.** Jeder, der das Objekt sehen darf, sieht das Feld. Anwendungen mit Personenbezug legen solche Daten in eigene Felder mit engeren Rechten und lassen `name` neutral.

---

## Sammelobjekte — ein Objekt enthält andere

Ein Serverschrank enthält Server, ein Server Dienste, ein UWB-Netz seine Anker, eine Truhe ihre Beute. Dafür trägt ein Objekt einen **`container`**-Abschnitt — erst dann darf es Kinder aufnehmen — und ein Kind verweist mit **`parent`** auf sein Sammelobjekt. Ein Kind hat genau ein Sammelobjekt, höchstens acht Ebenen tief, Kreise lehnt der Server ab.

```js
// Ein Rack, das seine Server im Kreis zeigt, sobald jemand aufklappt
await ajna.createObject({
  name: 'Rack A3', type: 'poi', lat: 50.4466, lon: 7.5971, altitude: 0, heading: 90,
  container: { badge: 'both', view: 'placed', expanded: false, load: 'always' },
})
```

| `container.` | Werte | Bedeutung |
|---|---|---|
| `badge` | `both` (Vorgabe), `count`, `status`, `none` | Was das eingeklappte Sammelobjekt anzeigt: Anzahl und/oder schlimmsten Status seiner Kinder |
| `view` | `placed` (Vorgabe), `exploded` | Aufgeklappt: Kinder an ihrer Lage — oder im Kreis um das Sammelobjekt (Beute) |
| `expanded` | `false` (Vorgabe) | Anfangs aufgeklappt? Jeder Spieler kann das für sich übersteuern |
| `load` | `always` (Vorgabe), `on_expand` | Kinder sofort mitladen oder erst beim Aufklappen (große Sensorbäume) |

**Lage eines Kindes.** Entweder **relativ**: `local = { east, north, up, heading }` im Rahmen des Sammelobjekts (`north` ist, wohin es blickt, `east` rechts davon); der Server rechnet daraus `lat`/`lon`/`altitude`/`heading` und zieht das Kind nach, wenn sich das Sammelobjekt bewegt oder dreht. Oder **eigen**: `parent` gesetzt, `local` leer, das Kind steht an seinen eigenen Koordinaten (UWB-Anker in ihrem Netz). `local: { from: "world" }` beim Einhängen heißt „bleib, wo du stehst, rechne den Versatz aus". Schickt man einem relativen Kind eine neue Weltlage, wird der Versatz daraus zurückgerechnet.

**Status.** Ein Kind meldet `state.status` als `ok`, `warning`, `error` oder `unknown`; das Sammelobjekt zeigt den schlimmsten Status seiner sichtbaren Nachfahren — ein Rack wird rot, wenn ein Sensor rot ist.

**Rechte.** Kinder erben die Rechte ihres Sammelobjekts wie Dateien die ihres Ordners, bis ein `acl_break` die Kette abschneidet; eigene Rechte kommen dazu. Der *Besitzer* vererbt sich nicht — wer die Kinder anderer verwalten will, gibt sich eine Rechteregel auf das Sammelobjekt ([Berechtigungen](Berechtigungen.md)). Einhängen braucht `edit` am Kind **und** am Sammelobjekt.

**Löschen** eines Sammelobjekts mit Inhalt verlangt eine Ansage: `deleteObject(id, { children: 'delete' })` nimmt alles mit (nur, wenn man jedes Kind löschen darf), `{ children: 'detach' }` lässt die Kinder eine Ebene hochrutschen. Ohne Ansage antwortet der Server 409. **Aufheben** (`pickup`) nimmt ein Objekt aus seinem Sammelobjekt heraus.

Einen ganzen Baum legt `ajna.createTree([...])` in einem Aufruf an ([Ajna-Library](Ajna-Library.md)). Alles Weitere, samt der Entscheidungen dahinter: [`docs/sammelobjekte.md`](https://github.com/blckwngd/Ajna/blob/main/docs/sammelobjekte.md).

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
| `source` | **Wichtigster Schlüssel.** Marke „von diesem Agenten angelegt". Schützt fremde Objekte vor dem Aufräumen und speist den Inhaltsfilter. **Eine Selbstauskunft — siehe unten** |
| `motion` | Bewegungsvektor zur Vorausberechnung — siehe unten |
| `walk_path` | Geplanter Weg als `[[lat, lon], …]`; die Debug-Ebene zeichnet ihn |
| `call` | Auftragszustand; wird von den Auftragsmethoden gepflegt |
| `stackable` | Gleichartige Gegenstände im Inventar stapeln |

Alles andere ist frei. Eigene Schlüssel sollten einen Namensraum tragen, damit zwei Anwendungen auf einer Instanz sich nicht ins Gehege kommen.

### `state.source` ist eine Behauptung, kein Beweis

Der Server schreibt das Feld nicht — jedes angemeldete Konto kann ein Objekt als „von poi-bridge“ ausgeben. Und die Registrierung ist per Voreinstellung offen, ein Konto hat man also schnell.

Zugeschrieben wird deshalb über **`owner`**, die unveränderliche, serverseitig gesetzte Konto-ID. Zwei Dinge kommen aus dem Konto dazu:

| | |
|---|---|
| **`username`** | Optionaler, selbstgewählter, eindeutiger Handle — das lesbare Etikett (`@poi-bridge`). Darf geändert werden und dient zugleich als Login-Kennung neben der E-Mail |
| **`agent_seal`** | Bestätigung des **Betreibers**: „dieses Konto ist ein offizieller Agent dieser Instanz“. Nur über die Administration setzbar |

Warum getrennt: Ein Handle darf frei werden und neu vergeben werden. Technisch bleibt das harmlos — alte Objekte lösen weiter auf ihr ursprüngliches Konto auf — aber **Menschen merken sich Namen, nicht IDs**. Hätte das Vertrauen am Namen gehängt, erbte der neue Inhaber es mit. Am Siegel hängt es nicht: ein neu gegriffener Name trägt schlicht keins.

Daraus ergeben sich fünf Zustände:

| Anzeige | Bedeutung |
|---|---|
| *(nichts)* | Kein `state.source` — ein gewöhnliches Nutzerobjekt, das nichts behauptet |
| **✓ @handle** | Der Owner ist der Inhaber der Quelle **und** vom Betreiber bestätigt |
| **@handle** | Der Owner ist der Inhaber der Quelle, aber ohne Siegel. Kein Verdacht — nur keine Bestätigung |
| **? quelle** | Die Quelle ist auf diesem Server nicht registriert. Kein Alarm: der Agent lief vielleicht nie |
| **⚠ angeblich @handle** | Die Quelle gehört einem anderen Konto. Der Inhalt ist unbelegt |

Angezeigt wird das im AR-Callout, in der Objektliste und im Tap-Menü — in Listen nur die Warnung, damit sie nicht in Bestätigungen untergeht.

Ein Source-Name gehört je Server dem Konto, das ihn **zuerst** registriert hat; spätere Manifeste anderer Konten für denselben Namen werden verworfen. Handle und Siegel stempelt ein Server-Hook aus dem Konto ins Manifest — ein Agent kann sich also weder einen fremden Handle geben noch sich selbst bestätigen.

**Der Server setzt das durch.** Ein Schreibversuch mit einer Quelle, die einem anderen Konto gehört, wird mit **403** abgewiesen — beim Anlegen wie beim nachträglichen Ändern:

```
Die Quelle "poi-bridge" gehört einem anderen Konto.
Registriere einen eigenen Namen über das Agent-Manifest.
```

Ein Name, den **niemand** registriert hat, bleibt bewusst erlaubt: Agents müssten sonst ihr Manifest vor dem ersten Objekt veröffentlichen, und Agents ganz ohne Manifest könnten nichts mehr schreiben. Einen unbeanspruchten Namen zu nutzen ist auch keine Täuschung — solche Objekte zeigt der Client als „Quelle nicht registriert“.

Geprüft wird gegen den **Eigentümer** des Datensatzes, nicht gegen den Aufrufer: Wer fremde Objekte bearbeiten darf, ändert damit nichts an deren Herkunft.

> **Noch offen:** OIDC als Quelle des Siegels statt der Betreiber-Bestätigung.

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

← [Agent-Library](Agent-Library.md) · [Inhalt](Home.md#inhalt) · [Dialoge](Dialoge.md) →
<!-- /navfuss -->
