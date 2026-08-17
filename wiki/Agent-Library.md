# Agent-Library

Alles, was ein Node-Agent zusätzlich zur [Ajna-Library](Ajna-Library.md) braucht: Hochfahren, Konfiguration, Einrichtungsassistent. Liegt unter `agents/lib/`.

**Abgrenzung, die man kennen muss:** In `agents/lib` steht nur Node-Spezifisches — Dateisystem, Umgebungsvariablen, Prozessneustart. Alles Browserfähige — Geo-Mathematik, PocketBase-Zugriff, Manifeste, Interessensbereiche — liegt in `client/core` und wird von Agents aus **derselben Datei** genutzt. Das ist kein Zufall, sondern hält Client und Agent auf einer Wahrheit.

---

## `bootAgent(name, opts?)`

Der Einstieg jedes Agenten.

```js
import { bootAgent, envNum, envStr } from './lib/agent-base.mjs'

const { ajna, url, log, warn } = await bootAgent('mein-agent')
const RADIUS_M = envNum('MEIN_RADIUS_M', 100)

log('läuft gegen', url)
```

Erledigt der Reihe nach:

1. Geschichtete `.env` laden — Prozessumgebung > `agents/.env.<name>` > `.env` im Wurzelverzeichnis
2. Einrichtungsassistent, falls `--setup` übergeben wurde oder eine Pflichtangabe fehlt (nur am Terminal)
3. Einmaliger Neustart mit `--use-system-ca`, wenn `AJNA_URL` HTTPS ist — sonst lehnt Node Caddys interne Zertifizierungsstelle ab
4. Pflichtangaben prüfen (`AJNA_USER`, `AJNA_PASS` plus `opts.require`)
5. `AjnaManager` anlegen und anmelden, optional `connect()`
6. Standard-Handler für Strg+C

### Optionen

| Option | Vorgabe | Wirkung |
|---|---|---|
| `tag` | `name` | Präfix der Protokollzeilen |
| `require` | `[]` | Zusätzliche Pflicht-Umgebungsvariablen |
| `login` | `true` | `AJNA_USER`/`AJNA_PASS` verlangen und anmelden |
| `connect` | `false` | Nach der Anmeldung `connect()` — Objektspeicher und Echtzeit-Abo |
| `sigint` | `true` | Standard-Handler für Strg+C; `false` für eigenes Aufräumen |
| `setup` | — | `{ need: string[], run: () => Promise }` — Einrichtungsassistent |

### Rückgabe

| Feld | Bedeutung |
|---|---|
| `ajna` | Angemeldeter `AjnaManager` |
| `url` | Verwendete Serveradresse |
| `log`, `warn` | Ausgabe mit Präfix, z. B. `[mein-agent] …` |

**`connect: true`** nur setzen, wenn der Agent den Objektspeicher wirklich braucht (weil er Bestehendes lesen oder auf Änderungen reagieren will). Eine Bridge, die nur schreibt, spart sich damit Erstabruf und Echtzeit-Abo.

**`sigint: false`** für Agents mit eigenem Aufräumen — offene Verbindungen schließen, Objekte aufräumen:

```js
const { ajna, log } = await bootAgent('mein-agent', { sigint: false })
process.on('SIGINT', async () => {
  log('räume auf …')
  await aufraeumen()
  process.exit(0)
})
```

---

## Umgebungsvariablen lesen

Alle vier folgen derselben Regel: **nicht gesetzt oder leer → Vorgabe. Gesetzt, aber unbrauchbar → sofortiger Abbruch mit klarer Meldung.** Ein `NaN`, das still durch die Fachlogik wandert, ist teurer als ein Absturz beim Start.

| Funktion | Beschreibung |
|---|---|
| `envStr(key, def = '')` | Zeichenkette; ein leer gesetzter Wert bleibt leer |
| `envNum(key, def)` | Fließkommazahl |
| `envInt(key, def)` | Ganzzahl zur Basis 10 |
| `envBool(key, def = false)` | `1`/`true`/`yes`/`on` (Groß-/Kleinschreibung egal) = an |

```js
const RADIUS_KM = envNum('MEIN_RADIUS_KM', 10)
const MAX       = envInt('MEIN_MAX', 200)
const DEBUG     = envBool('MEIN_DEBUG')
const SCHLUESSEL = envStr('MEIN_API_KEY')
```

## Weitere Helfer

| Funktion | Beschreibung |
|---|---|
| `die(msg)` | Fehlermeldung und Abbruch mit Code 1 — einheitliches Sterben |
| `await publishManifest(ajna, manifest, warn?)` | Manifest veröffentlichen; Fehler warnen nur, sie töten nicht |

```js
await publishManifest(ajna, {
  source: 'mein-agent',
  agent_name: 'Mein Agent',
  description: 'Legt Dinge an',
  layers: [{ key: 'dinge', label: 'Dinge', default: true }],
})
```

---

## Konfigurationsdateien — `lib/env.mjs`

| Funktion | Beschreibung |
|---|---|
| `agentEnvPath(agent)` | Pfad zu `agents/.env.<agent>` |
| `rootEnvPath()` | Pfad zur `.env` im Wurzelverzeichnis |
| `readAgentEnv(agent)` | Agent-`.env` als Objekt lesen, **ohne** `process.env` anzufassen |
| `loadAgentEnv(agent)` | Alle Schichten nach `process.env` laden, ohne zu überschreiben |
| `writeAgentEnv(agent, entries, header?)` | Datei schreiben und `process.env` setzen (überschreibend) |

`writeAgentEnv` setzt die Dateirechte auf `0600` — dort stehen Zugangsdaten. Einträge mit `null` oder `undefined` werden ausgelassen.

---

## Einrichtungsassistent — `lib/setup-wizard.mjs`

### Der einfache Weg

`simpleSetup` deckt den Normalfall ab: ein paar Werte abfragen, Datei schreiben. Felder, deren Name auf `PASS`, `TOKEN`, `SECRET` oder `KEY` endet, werden verdeckt eingegeben.

```js
const { ajna } = await bootAgent('mein-agent', {
  setup: simpleSetup('mein-agent', {
    required: ['AJNA_USER', 'AJNA_PASS', 'MEIN_API_KEY'],
    optional: ['AJNA_URL', 'MEIN_RADIUS_KM'],
    note: 'Schlüssel gibt es unter https://example.com/api',
  }),
})
```

`required` und `optional` sind schlichte Listen von Variablennamen — abgefragt wird unter genau diesem Namen. Vorhandene, nicht abgefragte Schlüssel der Datei bleiben erhalten, und die Liste aus `required` dient `bootAgent` zugleich als `need`: fehlt einer, startet der Assistent von selbst.

### Bausteine für eigene Abläufe

Braucht ein Agent mehr — Erreichbarkeit prüfen, Konten anlegen, Zertifikate finden —, gibt es die Einzelteile:

| Funktion | Beschreibung |
|---|---|
| `banner(title, subtitle?)` | Titelzeile |
| `header(title)` | Schrittüberschrift, z. B. `header('Schritt 2/6 · Benutzer')` |
| `hint(text)` | Gedimmte Erklärung, bricht auf Terminalbreite um |
| `ok / warnLine / failLine / infoLine` | Statuszeilen mit ✓ ⚠ ✗ ℹ |
| `makeRl()` | Readline-Instanz für eigene Abfragen |
| `randomSecret(bytes = 18)` | URL-sicheres Zufallskennwort |
| `httpGet(url, { timeoutMs, insecure })` | Kleiner HTTP-Abruf für Erreichbarkeitsprüfungen |
| `caddyDomains()` | Öffentliche Domains aus der Caddyfile |
| `findCaddyCert(domain)` | Caddys Zertifikat für eine Domain suchen |
| `pm2Available()` · `pm2Processes()` | pm2 vorhanden? Was läuft? |
| `pm2Register({ name, script, args })` · `pm2Restart(name)` | Bei pm2 registrieren, neu starten |
| `C` | ANSI-Farbcodes |
| `REPO_ROOT` | Absoluter Pfad zum Wurzelverzeichnis |

Gibt `run()` ein `{ exit: true }` zurück, endet der Prozess nach dem Assistenten — passend, wenn er die Ausführung an pm2 übergeben hat.

---

## Interessensbereiche verfolgen

In `client/core/interestAreas.js`, also von beiden Seiten nutzbar. Der Weg, auf dem eine Bridge nur dort abfragt, wo Spieler sind.

### `watchInterestAreas(ajna, source, opts?, cb)`

| Parameter | Bedeutung |
|---|---|
| `source` | Filter wie bei `fetchInterestAreas` — `''` heißt alle |
| `opts.intervalMs` | Taktrate, Vorgabe 60 000 |
| `opts.maxAreas` | Obergrenze zum Kontingentschutz; Überschuss wird abgeschnitten |
| `opts.warn` | Ausgabefunktion für Warnungen |
| `cb(areas, { changed })` | Läuft bei **jedem** Takt, auch unverändert |

`changed` ist `true`, wenn sich die Bereiche gegenüber dem letzten Takt unterscheiden — reihenfolgeunabhängig und auf etwa einen Meter gerundet. Der erste Takt zählt als geändert. Ob bei unveränderten Bereichen trotzdem gearbeitet wird, entscheidet der Agent.

Rückgabe: `{ stop, first }` — `first` ist ein Versprechen auf den ersten abgeschlossenen Takt.

```js
import { watchInterestAreas } from '../client/core/interestAreas.js'

const watch = watchInterestAreas(ajna, 'mein-agent',
  { intervalMs: 30_000, maxAreas: 8 },
  async (areas, { changed }) => {
    if (!changed) return                 // nichts Neues → API schonen
    for (const a of areas) await syncBereich(a)
  })

await watch.first
log('bereit.')
```

> **Kein Spieler, keine Bereiche.** Steht niemand mit Freigabe „Gegend" oder höher auf dem Server, kommt eine leere Liste — und der Agent tut nichts. Das ist beabsichtigt. Zum Ausprobieren einen festen Mittelpunkt als Rückfall vorsehen.

---

## Geo-Mathematik

Aus `client/core/geoMath.js` — Kugelnäherung, ausreichend für Meter bis wenige Dutzend Kilometer.

| Funktion | Beschreibung |
|---|---|
| `bboxAroundM(lat, lon, radiusM)` | Achsenparalleles Rechteck um einen Punkt |
| `bboxAroundKm(lat, lon, radiusKm)` | Dasselbe in Kilometern |
| `degDeltas(latDeg, radiusM)` | Grad-Differenzen für einen Radius |
| `centerOf(area)` | Mittelpunkt eines Bereichs |
| `flatDistKm(aLat, aLon, bLat, bLon)` | Planare Distanz in km — für Nachbarschaftsprüfungen |
| `wgs84ToEnu(origin, lat, lon, alt)` | Nach lokalen Metern `{E, N, U}` |
| `enuToWgs84(origin, E, N, U)` | Zurück nach `{lat, lon, altitude}` |

Für echte Navigation ist `haversine()` aus `client/core/StreetNav.js` die richtige Wahl.

## Wege über das Straßennetz

`client/core/StreetNav.js` — reine Graphen- und Geo-Mathematik, ohne DOM und ohne Netzzugriff.

| Funktion | Beschreibung |
|---|---|
| `haversine(aLat, aLon, bLat, bLon)` | Großkreisdistanz in Metern |
| `bearingRad(aLat, aLon, bLat, bLon)` | Kompasskurs in Radiant: 0 = Nord, +π/2 = Ost |
| `buildWayGraph(features)` | Knoten und Kanten, an geteilten OSM-Stützpunkten verknüpft |
| `planRoute(features, lat, lon)` | `{ path, lengthM }` zu einem zufälligen erreichbaren Ziel |
| `stepAlongPath(path, cursor, distM)` | Cursor entlang der Polylinie vorrücken; hält am Ziel |

```js
import { AjnaGeo } from '../client/core/AjnaGeo.js'
import { planRoute, stepAlongPath } from '../client/core/StreetNav.js'

const geo = new AjnaGeo(ajna)
const { features } = await geo.waysNear(lat, lon, 400, 'walkable')
const route = planRoute(features, lat, lon)

let cursor = { segIdx: 0, segT: 0 }
setInterval(async () => {
  const step = stepAlongPath(route.path, cursor, 1.4 * 0.5)   // 1,4 m/s bei 500 ms
  cursor = { segIdx: step.segIdx, segT: step.segT }
  await ajna.moveObject(figurId, step.lat, step.lon)
}, 500)
```

> **Schreiblast.** Ein `updateObject` je Takt und Figur bedeutet Datenbankschreibung **und** Verteilung an alle Clients. Bei mehr als einer Handvoll Figuren wird das teuer. Der schonende Weg ist `state.motion` — der Client rechnet die Bewegung selbst voraus, siehe [Objektmodell](Objektmodell.md).

## Landeplätze

`agents/lib/landing-spots.mjs` — sucht einen freien Platz um eine Position, auf dem Boden oder auf einem Dach.

| Funktion | Beschreibung |
|---|---|
| `findLandingSpot({ lat, lon, buildings, minM, maxM, rng })` | → `{ lat, lon, altitude, kind: 'ground' \| 'roof', distance, building? }` oder `null` |
| `pointInPolygon(lat, lon, ring)` | Punkt-im-Polygon |
| `roofHeight(tags)` | Dachhöhe aus OSM-Tags |
| `centroid(ring)` | Schwerpunkt eines Rings |
| `distM(aLat, aLon, bLat, bLon)` | Distanz in Metern |

`rng` ist einspeisbar — damit sind Tests deterministisch.

---

## Vollständiges Gerüst

```js
#!/usr/bin/env node
import { bootAgent, envNum, publishManifest } from './lib/agent-base.mjs'
import { simpleSetup } from './lib/setup-wizard.mjs'
import { watchInterestAreas } from '../client/core/interestAreas.js'
import { centerOf } from '../client/core/geoMath.js'

const { ajna, log, warn } = await bootAgent('mein-agent', {
  connect: true,
  setup: simpleSetup('mein-agent', {
    required: ['AJNA_USER', 'AJNA_PASS', 'MEIN_API_KEY'],
    optional: ['AJNA_URL'],
  }),
})

const RADIUS_KM = envNum('MEIN_RADIUS_KM', 5)
const TAKT_MS   = envNum('MEIN_TAKT_S', 60) * 1000

await publishManifest(ajna, {
  source: 'mein-agent',
  agent_name: 'Mein Agent',
  layers: [{ key: 'dinge', label: 'Dinge', default: true }],
})

const gesehen = new Map()   // externe ID → Ajna-Objekt-ID

async function takt(areas) {
  for (const area of areas) {
    const { lat, lon } = centerOf(area)
    for (const d of await quelleAbfragen(lat, lon, RADIUS_KM)) {
      const vorhanden = gesehen.get(d.id)
      if (vorhanden) {
        await ajna.moveObject(vorhanden, d.lat, d.lon)
      } else {
        const obj = await ajna.createObject({
          name: d.name, type: 'ding',
          lat: d.lat, lon: d.lon, altitude: 0,
          appearance: { shape: 'emoji', emoji: '📦', label: '{name} · {distance}' },
          state: { source: 'mein-agent', extern_id: d.id },
        })
        gesehen.set(d.id, obj.id)
      }
    }
  }
}

const watch = watchInterestAreas(ajna, 'mein-agent',
  { intervalMs: TAKT_MS, maxAreas: 6 },
  (areas) => takt(areas).catch(err => warn('Takt:', err?.message || err)))

await watch.first
log('bereit. (Strg+C zum Beenden)')
```

Schritt für Schritt erklärt: [Einen Agent bauen](Einen-Agent-bauen.md).
