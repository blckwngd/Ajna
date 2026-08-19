# Ajna-Library

<!-- nav -->
[← Inhalt](Home.md#inhalt) · Entwickeln: [Einen Agent bauen](Einen-Agent-bauen.md) · **Ajna-Library** · [Agent-Library](Agent-Library.md) · [Objektmodell](Objektmodell.md) · [Dialoge](Dialoge.md) · [Architektur](Architektur.md)
<!-- /nav -->

<!-- seiteninhalt -->
**Auf dieser Seite:** [Zwei Klassen](#zwei-klassen) · [Einstieg](#einstieg) · [Anmeldung](#anmeldung) · [Lebenszyklus](#lebenszyklus) · [Objekte lesen](#objekte-lesen) · [Objekte schreiben](#objekte-schreiben) · [Echtzeit](#echtzeit) · [Interaktionen](#interaktionen) · [Nachrichten](#nachrichten) · [Dialoge](#dialoge) · [Inventar](#inventar) · [Aufträge](#aufträge) · [Rechte](#rechte) · [Gruppen und Einladungen](#gruppen-und-einladungen) · [Standard-Rechte](#standard-rechte) · [Interessensbereiche](#interessensbereiche) · [Herkunft eines Objekts](#herkunft-eines-objekts) · [Agent-Manifeste](#agent-manifeste) · [Mehrere Server](#mehrere-server) · [Geo-API](#geo-api) · [Eigenen Client bauen](#eigenen-client-bauen) · [Roher Zugriff](#roher-zugriff)
<!-- /seiteninhalt -->






Eine Bibliothek für Auth, Objekte, Echtzeit, Interaktionen, Rechte, Gruppen, Inventar und Aufträge. Sie ist **isomorph**: derselbe Quelltext läuft im Browser (gebündelt) und in Node (Agents, Werkzeuge, Tests).

```js
import { AjnaManager } from './client/core/AjnaManager.js'
```

## Zwei Klassen

| Klasse | Rolle |
|---|---|
| **`AjnaManager`** | Die Klasse, die man benutzt. Bündelt beliebig viele Server und leitet jeden Aufruf an den richtigen weiter. |
| **`AjnaClient`** | Genau **eine** Verbindung zu **einem** Server. Der Manager hält davon einen je Server. Direkt braucht man sie selten. |

Beide haben nahezu dieselbe Oberfläche. Alles unten Beschriebene gibt es auf dem `AjnaManager`; wo sich Verhalten unterscheidet, steht es dabei.

### Zusammengesetzte IDs

Der Manager gibt Objekte mit `id = "<serverId>:<rohId>"` heraus und setzt zusätzlich `_origin = serverId`. Aufrufe mit so einer ID landen automatisch beim richtigen Server; eine rohe ID landet beim Standard-Server. Beides ist erlaubt, damit ältere Skripte mit fest eingetragenen IDs weiterlaufen.

**Nur `objects.id` wird so umgeschrieben.** Fremdschlüssel (`owner`, `carried_by`, Gruppenmitglieder, ACE-Subjekte) bleiben roh — sie zeigen auf Datensätze desselben Servers, und roh-gegen-roh bleibt vergleichbar.

```js
const obj = ajna.getObjects()[0]
obj.id        // "srv-home:2kjikgp1pvkc4p5"
obj._origin   // "srv-home"
obj.owner     // "xyz789"  ← roh
```

---

## Einstieg

```js
const ajna = new AjnaManager('https://ajna.example.com')
await ajna.login('agent@example.com', 'geheim')
await ajna.connect()

console.log(ajna.getObjects().length)
```

### `new AjnaManager(urlOrOpts?)`

`urlOrOpts` ist eine URL-Zeichenkette oder `{ url, pb }`. Mit `pb` lässt sich eine vorkonfigurierte PocketBase-Instanz einsetzen (eigene Kopfzeilen, eigenes `fetch`, bereits angemeldet). Vorgabe: `http://localhost:8090`.

Im Browser ist fast immer `location.origin` richtig — Caddy reicht `/api` an PocketBase weiter.

---

## Anmeldung

| Methode | Beschreibung |
|---|---|
| `await login(email, password)` | Anmeldung am Standard-Server |
| `logout()` | Sitzung lokal verwerfen |
| `isLoggedIn()` | Nur lokale Prüfung des gespeicherten Tokens |
| `currentUser()` | Angemeldeter Datensatz oder `null` |
| `await updateCurrentUser(fields)` | Eigenen Datensatz ändern — Anzeigename, `app_data`, … |
| `onAuthChanged(cb)` → `unsubscribe` | Feuert bei Anmeldung, Abmeldung und Token-Erneuerung |
| `await verifyServerSession(serverId)` | Token **gegen den Server** prüfen |

`verifyServerSession` liefert `'logged-out' | 'confirmed' | 'revoked' | 'unreachable'`. Anders als `isLoggedIn()` ist das eine echte Aussage über Erreichbarkeit; bei `'revoked'` wird das lokale Token geleert.

**`username`** ist der optionale, eindeutige Handle — zugleich zweite Login-Kennung neben der E-Mail. Erlaubt sind `[a-z0-9_-]`, 2–32 Zeichen; die Eindeutigkeit ist case-insensitiv. `agent_seal` lässt sich hier**nicht** setzen, das ist dem Betreiber vorbehalten.

**`app_data`** ist das generische Feld für anwendungseigene Nutzerdaten. Jede Anwendung legt dort ihren eigenen Schlüssel ab:

```js
await ajna.updateCurrentUser({
  app_data: { ...user.app_data, meineApp: { stufe: 3 } }
})
```

---

## Lebenszyklus

| Methode | Beschreibung |
|---|---|
| `await connect()` | Objektliste laden und Echtzeit-Abo aufbauen. Mehrfach aufrufbar |
| `await disconnect()` | Alle Abos beenden, Zwischenspeicher leeren |

`connect()` verbindet den Standard-Server verbindlich; Zusatz-Server mit gültigem Token kommen nebenher dazu, ihre Fehler kippen den Start nicht.

---

## Objekte lesen

| Methode | Beschreibung |
|---|---|
| `getObjects()` | Momentaufnahme aller sichtbaren Objekte, über alle Server vereinigt |
| `getObjectById(id)` | Einzelnes Objekt aus dem Zwischenspeicher |
| `get objectMap` | Dieselbe Momentaufnahme als `Map` (ID → Datensatz) |
| `await refreshObjects()` | Neu vom Server laden, ersetzt den Zwischenspeicher |

Alle drei sind synchron und lesen nur lokal — teuer ist ausschließlich `refreshObjects()`.

## Objekte schreiben

| Methode | Beschreibung |
|---|---|
| `await createObject(data, { serverId })` | Neu anlegen. `owner` setzt der Server |
| `await updateObject(id, patch)` | Beliebige Felder ändern |
| `await deleteObject(id)` | Löschen |
| `await setAnimation(id, state)` | Kurzform für `{ animation_state: state }` |
| `await moveObject(id, lat, lon, altitude?)` | Kurzform für reine Positionsänderungen |

```js
const npc = await ajna.createObject({
  name: 'Wanderer',
  type: 'npc',
  lat: 50.4513, lon: 7.5363, altitude: 0,
  appearance: { gltf: '/models/Fox.glb', label: '{name} · {distance}' },
  state: { source: 'mein-agent' },
})
await ajna.moveObject(npc.id, 50.4514, 7.5364)
await ajna.setAnimation(npc.id, 'walk')
```

Welche Felder es gibt und was in `appearance` und `state` gehört: [Objektmodell](Objektmodell.md).

---

## Echtzeit

| Methode | Beschreibung |
|---|---|
| `onObjectsChanged(cb)` → `unsubscribe` | Bei **jeder** Änderung; Rückruf bekommt die vollständige Momentaufnahme |
| `onObjectEvent(cb)` → `unsubscribe` | Pro Ereignis `(record, action)` mit `action ∈ create \| update \| delete` |
| `await watchObject(id, cb)` → `unsubscribe` | Nur ein bestimmtes Objekt, Rückruf `(record, action)` |

`onObjectEvent` ist der richtige Haken für Agents, die auf **neue** Objekte reagieren wollen. Er feuert **nicht** für den Erstabruf — der läuft über `refreshObjects()`, nicht über das Abo.

```js
ajna.onObjectEvent((rec, action) => {
  if (action === 'create' && rec.type === 'ship') console.log('neu:', rec.name)
})
```

> **Vorsicht bei `onObjectsChanged`.** Der Rückruf bekommt *alle* Objekte und feuert bei jeder Positionsänderung irgendeines Objekts. Wer darin über die ganze Liste iteriert, baut sich bei belebten Servern eine Bremse. Für laufende Positionsdaten `onObjectEvent` nehmen und gezielt reagieren.

---

## Interaktionen

Kurzlebige Ereignisse ohne Datenbankschreibung — der Weg, auf dem ein Spieler ein Objekt „anspricht".

| Methode | Beschreibung |
|---|---|
| `await interact(id, action, payload?)` | Aktion auslösen. Server prüft `interact_actions` und verteilt |
| `await onInteract(id, cb)` → `unsubscribe` | Rückruf `{ action, source, ts, payload }` |
| `await subscribeInteract(id, cb)` | Wie `onInteract`, für Clients mit einem Abo je Weltobjekt |

```js
// Client
await ajna.interact(objId, 'attack', { staerke: 7 })

// Agent
await ajna.onInteract(objId, async ev => {
  if (ev.action === 'attack') await ajna.setAnimation(objId, 'die')
})
```

### Nähe

| Methode | Beschreibung |
|---|---|
| `await onProximity(id, cb)` → `unsubscribe` | Rückruf `{ state: 'enter' \| 'leave', source, ts }` |
| `await reportProximity({ enter, leave })` | Meldet Übergänge — macht der Viewer, Agents brauchen es nicht |

```js
await ajna.onProximity(npc.id, async ev => {
  await ajna.setAnimation(npc.id, ev.state === 'enter' ? 'wave' : 'idle')
})
```

Übertragen werden nur Objekt-IDs, nie Koordinaten, und nur ab Freigabestufe „Nähe". Grenzen und Missbrauchsfestigkeit: [Privatsphäre](Privatsphaere.md).

### Agent-Kommandos

Objektlose Nachrichten an einen laufenden Agent.

| Methode | Beschreibung |
|---|---|
| `await sendAgentCommand(source, command, payload?, serverId?)` | → `{ ok, delivered }`; `delivered = 0` heißt: Agent läuft nicht |
| `await onAgentCommand(source, cb, serverId?)` | Rückruf `{ command, payload, source, ts }` |

```js
await ajna.sendAgentCommand('world-director', 'spawn', { archetype: 'dragon' })
```

---

## Nachrichten

Konto-zu-Konto, ephemer wie `interact` — kein Datenbankschreibvorgang, keine
Ablage. Wer nicht verbunden ist, bekommt nichts.

| Methode | Beschreibung |
|---|---|
| `await sendChat(to, { text, object?, meta?, serverId? })` | → `{ ok, delivered }`; `delivered = 0` heißt: Empfänger nicht verbunden |
| `await onChat(cb)` | Rückruf `{ from, to, object, text, meta, ts, _origin }`; über alle angemeldeten Server |

`to` ist eine **Konto-ID**, nicht die eines Objekts. Wer eine Figur anspricht,
schreibt deren Besitzer (`record.owner`) und legt die Figur als `object` bei —
so weiß der Agent, welche seiner Figuren gemeint war. Für eine Direktnachricht
bleibt `object` leer.

`from` setzt der Server ein und ist nicht fälschbar. `meta` ist frei; die
mitgelieferten Dialoge transportieren darin Auswahlantworten
(`{ choices: [{ label, send }], input }`).

```js
await ajna.sendChat(figur.owner, { text: 'hallo', object: figur.id })

await ajna.onChat((m) => {
  console.log(`${m.from} über ${m.object || '—'}: ${m.text}`)
})
```

---

## Dialoge

`client/core/Parley.js` bindet die Dialogsprache [Parley](Dialoge.md) an das
Ajna-Objektmodell an. Die Sprache selbst steht in
[`/parley/README.md`](../parley/README.md).

| Export | Beschreibung |
|---|---|
| `Parley`, `Conversation` | die Klassen des Pakets, unverändert weitergereicht |
| `createParley(docs, opts?)` | Maschine mit einem Satz Dokumente bauen |
| `dialogNameFor(record)` | Dialogsatz des Objekts — `state.dialog_set`, sonst nach Archetyp, sonst `basis` |
| `dialogVarsFor(record)` | Startvariablen: `name`, `art`, `objekt` plus `state.dialog_vars` |
| `talkSessionId(userId, objectId)` | Sitzungsschlüssel — ein Gespräch je Spieler UND Figur |
| `objectDialog(record)` | Dialogsatz aus `state.parley`, auf sichere Größen begrenzt |
| `ARCHETYPE_DIALOG` | Zuordnung Archetyp → Dialogsatz |
| `STANDARD_DIALOGS` | Namen der mitgelieferten Sätze |

```js
import { createParley, dialogNameFor, dialogVarsFor, talkSessionId } from './core/Parley.js'

const parley = createParley(meineDokumente)
const chat = parley.open(dialogNameFor(figur), talkSessionId(meineId, figur.id),
                         { vars: dialogVarsFor(figur) })
const antwort = chat.say('hallo')     // { text, choices, input, do, label }
```

Node-seitig lädt `npcParley()` aus der [Agent-Library](Agent-Library.md) die
mitgelieferten Sätze von Platte.

---

## Inventar

| Methode | Beschreibung |
|---|---|
| `await pickup(id)` | Objekt aufnehmen — setzt `carried_by` serverseitig |
| `await place(id, { lat, lon, altitude })` | Getragenes Objekt wieder ablegen |
| `inventoryItems()` | Getragene Objekte des angemeldeten Nutzers, serverübergreifend |
| `isCarried(record)` | Wird gerade getragen (also nicht in der Welt)? |

---

## Aufträge

Ein Auftrag hängt an einem Objekt. Die Belohnung wird beim Veröffentlichen **treuhänderisch gebunden** — der Server tauscht atomar, es kann nichts aus dem Nichts entstehen.

| Methode | Beschreibung |
|---|---|
| `await publishQuest(id, opts)` | Veröffentlichen und Belohnung binden (nur Aussteller) |
| `await acceptQuest(id)` | Annehmen, reserviert ihn |
| `await completeQuest(id)` | Abschließen: geforderte Gegenstände ↔ Belohnung |
| `await cancelQuest(id)` | Abbrechen (nur Aussteller), gibt die Treuhand frei |
| `await approveQuest(id, opts)` | Für Agents: Abschluss freigeben |
| `await rejectQuest(id, opts)` | Für Agents: ablehnen, Auftrag geht zurück in den Umlauf |
| `onQuestPending(cb)` → `unsubscribe` | Für Agents: anstehende Prüfungen eigener Aufträge |

**`publishQuest(callId, opts)`**

| Feld | Bedeutung |
|---|---|
| `rewardItems: string[]` | Objekt-IDs aus dem **eigenen** Inventar, die gebunden werden |
| `requires: [{ match: { type?, name?, tag? }, count? }]` | Gattungsforderung — „bring mir 3 Wolfsfelle" |
| `requiresItems: string[]` | Konkrete Instanzen — „bring mir genau dieses Objekt" |
| `verify: 'items' \| 'agent'` | Wer entscheidet: der Server oder du |
| `repeatable: boolean` | Mehrfach spielbar |
| `rewardPerRun: number` | Ausschüttung je Durchlauf |

Bei `verify: 'items'` prüft der Server deterministisch. Bei `verify: 'agent'` löst der Spieler `completeQuest()` aus, der Auftrag geht auf `pending`, du bekommst ihn über `onQuestPending()` und entscheidest selbst:

```js
await ajna.publishQuest(auftragId, {
  rewardItems: [schwertId],
  requires: [{ match: { name: 'Wolfsfell' }, count: 3 }],
  verify: 'agent',
})

ajna.onQuestPending(async (call, ctx) => {
  const erfuellt = await meinePruefung(ctx.completer)
  if (erfuellt) await ajna.approveQuest(call.id)
  else await ajna.rejectQuest(call.id, { reason: 'Bedingung offen' })
})
```

Bei `approveQuest` bestimmst du über `requiresItems` **selbst**, welche Gegenstände eingezogen werden — Mengen- und Sonderregeln lassen sich damit komplett agentseitig abbilden. Der Server prüft nur, dass sie dem Spieler gehören und die Belohnung gedeckt ist. `repeatable` begrenzt sich von selbst: der hinterlegte Vorrat erschöpft sich.

---

## Rechte

| Methode | Beschreibung |
|---|---|
| `await listPermissions(id)` | ACE-Liste eines Objekts (nur Eigentümer) |
| `await addPermission(id, ace)` | ACE hinzufügen |
| `await updatePermission(aceId, patch)` | ACE ändern |
| `await removePermission(aceId)` | ACE löschen |
| `await getEffectiveRights(id)` | Effektive Rechte inklusive impliziter Zielgruppen |
| `await myRights(id)` | Eigene Rechte aus dem Server-Zwischenspeicher |

```js
await ajna.addPermission(obj.id, {
  subject_type: 'group',
  subject: gruppenId,
  rights: ['view', 'move'],
  interact_actions: ['pet', 'feed'],
})
```

Rechte: `view`, `edit`, `move`, `owner`. Subjekttypen: `user`, `group`, `authenticated`, `anonymous`, `everyone`. Details unter [Berechtigungen](Berechtigungen.md).

> `myRights()` deckt Besitz sowie Benutzer- und Gruppen-ACEs ab. Implizite Zielgruppen landen **nicht** im Zwischenspeicher — für sie bleibt es bei „sichtbar heißt `view`".

## Gruppen und Einladungen

| Methode | Beschreibung |
|---|---|
| `await listGroups()` | Sichtbare Gruppen |
| `await createGroup(name, { members, subgroups })` | Anlegen, man wird Eigentümer |
| `await updateGroup(id, patch)` · `await deleteGroup(id)` | Ändern, löschen |
| `await inviteToGroup(groupId, target)` | Einladen |
| `await acceptInvitation(id)` · `declineInvitation(id)` · `cancelInvitation(id)` | Einladung beantworten |
| `await listIncomingInvitations()` · `listOutgoingInvitations()` | Offene Einladungen |
| `await listUsers()` | Benutzerliste — meist nur der eigene Datensatz sichtbar |

## Standard-Rechte

| Methode | Beschreibung |
|---|---|
| `getMyDefaultPermissions()` | Vorlagen, die neue Objekte automatisch erben |
| `await setMyDefaultPermissions(aces)` | Vorlagen speichern |

```js
await ajna.setMyDefaultPermissions([
  { subject_type: 'authenticated', rights: ['view'] }
])
```

**Für Agents die wichtigste Zeile überhaupt** — ohne sie sieht niemand außer dem Agenten selbst, was er anlegt.

---

## Interessensbereiche

| Methode | Beschreibung |
|---|---|
| `await publishInterestArea(variants, sources?)` | Eigenen unscharfen Bereich veröffentlichen (Opt-in) |
| `await deleteInterestArea()` | Auf allen Servern entfernen |
| `await deleteInterestAreaOn(serverId)` | Nur auf einem Server entfernen |
| `await fetchInterestAreas(source?, serverId?)` | Anonymisiertes Aggregat lesen — **für Agents** |

Agents nehmen dafür meist nicht diese Methoden direkt, sondern `watchInterestAreas()` aus der [Agent-Library](Agent-Library.md).

## Herkunft eines Objekts

`state.source` ist eine Selbstauskunft — belastbar ist nur `owner`. Die Bewertung macht `AgentFilters`, die Darstellung `Provenance`:

```js
import { provenanceInfo } from './client/core/Provenance.js'

const p = filters.provenanceOf(record)
// { status: 'user' | 'agent' | 'unsealed' | 'unregistered' | 'mismatch',
//   source, agentName, handle, sealed }

const info = provenanceInfo(filters, record)   // null bei Nutzerobjekten
// { status, text: '✓ @poi-bridge', color: '#6fae7a', title: '…' }
```

| Funktion | Beschreibung |
|---|---|
| `filters.provenanceOf(record)` | Urteil über die Herkunft |
| `filters.ownerFor(source, origin)` | Konto, dem ein Source-Name auf einem Server gehört |
| `provenanceInfo(filters, record)` | Anzeige-Angaben oder `null` |
| `renderProvenanceBadge(filters, record, { onlyWarnings })` | Badge als HTML |
| `provenanceText(filters, record)` | Klartext für Kopfzeilen |
| `isProvenanceWarning(info)` | Verdient das Aufmerksamkeit? |

Bedeutung der Zustände und warum Handle und Siegel getrennt sind: [Objektmodell](Objektmodell.md).

## Agent-Manifeste

| Methode | Beschreibung |
|---|---|
| `await listAgentManifests()` | Was auf diesem Server an Agents aktiv ist |
| `await upsertAgentManifest(manifest)` | Eigenes Manifest anlegen oder aktualisieren |

Das Manifest speist den Inhaltsfilter der App: Spieler wählen darüber pro Agent aus, welche Ebenen sie sehen wollen.

```js
await ajna.upsertAgentManifest({
  source: 'mein-agent',
  agent_name: 'Mein Agent',
  description: 'Legt Dinge an',
  layers: [{ key: 'dinge', label: 'Dinge', default: true }],
})
```

---

## Mehrere Server

| Methode | Beschreibung |
|---|---|
| `getServers()` | Bekannte Server mit Live-Status |
| `addServer(url, label)` | Hinzufügen, legt sofort einen Client an |
| `await removeServer(id)` | Trennen, abmelden, aus der Registrierung nehmen |
| `setDefaultServer(id)` | Bestimmt, wohin ID-lose Aufrufe gehen |
| `renameServer(id, label)` | Anzeigenamen ändern |
| `await connectServer(id)` · `disconnectServer(id)` | Einzeln verbinden und trennen |
| `await loginToServer(id, email, pass)` · `logoutFromServer(id)` | Anmeldung je Server |
| `onServersChanged(cb)` → `unsubscribe` | Liste hat sich geändert; frischen Stand über `getServers()` holen |

`getServers()` liefert `{ id, url, label, isDefault, isLoggedIn, currentUser, isConnected }`.

---

## Geo-API

Straßen, Gebäude und Punkte von Interesse aus OpenStreetMap, über den Ajna-Server zwischengespeichert.

```js
import { AjnaGeo } from './client/core/AjnaGeo.js'
const geo = new AjnaGeo(ajna)

const wege     = await geo.waysNear(lat, lon, 300, 'walkable')  // walkable | all
const pois     = await geo.poisNear(lat, lon, 200, 'common')    // common | amenity | shops | tourism
const gebaeude = await geo.buildingsNear(lat, lon, 250)
await geo.info()        // erlaubte Filter und Serverkonfiguration
geo.clearCache()
```

Rückgabe sind Merkmale mit `coordinates` als `[[lat, lon], …]` und `tags`. Der Endpunkt verlangt Anmeldung.

---

## Eigenen Client bauen

Die Bibliothek ist nicht an die mitgelieferten Ansichten gebunden. Eine eigene Seite braucht nur die Bibliothek und einen Anmeldevorgang.

### Als gebündelte Seite im Repository

1. `client/mein-client.js` anlegen
2. `client/index-mein-client.html` dazu, das `/dist/mein-client.bundle.js` lädt
3. Einstiegspunkt in `webpack.config.cjs` eintragen:

```js
entry: {
  ar: './client/main.js',
  map: './client/map.js',
  'mein-client': './client/mein-client.js',
}
```

4. Den Webpack-Watcher **neu starten** — Änderungen an der Konfiguration übernimmt er nicht im Lauf.

### Ohne Bündelung

Die Bibliothek besteht aus ES-Modulen, importiert aber `pocketbase` unter seinem nackten Paketnamen. Ohne Bündelung braucht der Browser deshalb eine **Import-Map**, sonst scheitert der Import:

```html
<script type="importmap">
{ "imports": { "pocketbase": "https://esm.sh/pocketbase@0.21.5" } }
</script>
<script type="module">
  import { AjnaManager } from '/core/AjnaManager.js'

  const ajna = new AjnaManager(location.origin)
  await ajna.login('mein@konto', 'geheim')
  await ajna.connect()

  for (const o of ajna.getObjects()) {
    console.log(o.name, o.lat, o.lon)
  }

  ajna.onObjectEvent((rec, action) => console.log(action, rec.name))
</script>
```

`location.origin` ist im Normalfall richtig — Caddy reicht `/api` an PocketBase weiter. Nur wenn PocketBase ohne Caddy direkt angesprochen wird, gehört dort `:8090` hin.

Die Version in der Import-Map muss zu der in `package.json` passen (derzeit `^0.21.5`) — zwei PocketBase-Versionen auf einer Seite führen zu schwer auffindbaren Fehlern. Für alles über einen Versuch hinaus ist der Bündel-Weg die verlässlichere Wahl.

### In einem eigenen Projekt

Die Bibliothek hängt an `pocketbase` als einziger Abhängigkeit. In Node ab Version 22 sind `fetch` und `EventSource` eingebaut; darunter braucht es das `eventsource`-Paket:

```js
import { EventSource } from 'eventsource'
globalThis.EventSource = EventSource      // nur unterhalb Node 22
```

---

## Roher Zugriff

`ajna.pb` ist die darunterliegende PocketBase-Instanz des Standard-Servers — für eigene Collections, Datei-Uploads und alles, was die Bibliothek nicht abdeckt.

Für alles mit einer Objekt-ID trotzdem den Manager nehmen: `pb` löst die Frage nicht, an welchen Server ein Aufruf gehört.

<!-- navfuss -->
---

← [Einen Agent bauen](Einen-Agent-bauen.md) · [Inhalt](Home.md#inhalt) · [Agent-Library](Agent-Library.md) →
<!-- /navfuss -->
