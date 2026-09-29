# Schlüssel auf Englisch umstellen — die Zuordnung

**Ausgeführt am 23.09.2026.** Diese Datei ist die Zuordnung: alle deutschen
Namen, die in **Nutzdaten** oder **über die Leitung** gehen, mit ihrem neuen
englischen Namen. Sie bleibt stehen, solange die Übergangszeit läuft — jeder
`?? alt`-Zweig im Code verweist hierher.

Die drei offenen Entscheidungen sind gefallen: `stolperstein` bleibt Eigenname,
`quelle` ist ersatzlos gestrichen, die Figuren-Dateien sind mitgezogen.

**Warum diese Gruppe zuerst:** Sie ist die einzige, die mit der Zeit teurer wird.
Bezeichner im Code lassen sich jederzeit umbenennen; ein Schlüssel, der in
zehntausend Datensätzen steht, nicht mehr. Reine Code-Bezeichner stehen deshalb
NICHT hier (siehe `CLAUDE.md`: wer eine Datei anfasst, benennt sie beim Verlassen
um).


---

## A · In der Datenbank (`objects.state`)

Diese brauchen eine Migration und eine Übergangszeit, in der **beide**
Schreibweisen gelesen werden.

| alt | neu | geschrieben von | Bemerkung |
|---|---|---|---|
| `figur_id` | `figure_id` | `lib/figuren.mjs` | Anker, an dem der Director seine Figur wiedererkennt |
| `figur_auftrag` | `figure_quest` | `lib/figuren.mjs` | Bindung Auftrag → Figur |
| `figur_belohnung` | `figure_reward` | `lib/figuren.mjs` | Herkunftsmarke der hinterlegten Gegenstände |
| `beute` | `loot` | `lib/kampf.mjs` | Marker am Beute-Objekt |
| `werkzeug` | `tool` | `address-bridge.mjs` | „das hier ist ein benutzbares Werkzeug" |
| `hinweis` | `hint` | `address-bridge.mjs` | Erklärsatz an der Lupe. Kollidiert NICHT mit dem Archetyp `hint` — anderes Feld |
| `quelle` | **entfällt** | `address-bridge.mjs` | Dublette: `source` steht direkt daneben und trägt dasselbe. Ersatzlos streichen, nicht übersetzen |
| `bewegung` | `movement` | `lib/figuren.mjs` | Werte siehe D |
| `hp.ist` | `hp.current` | `lib/kampf.mjs` | `hp.max` bleibt |
| `osm_gruppe` | `osm_group` | `poi-bridge.mjs` | |
| `dm_art` | `monument_kind` | `poi-bridge.mjs` | Werte siehe D |
| `dm_erloschen` | `monument_revoked` | `poi-bridge.mjs` | |
| `dm_key` | `monument_key` | `poi-bridge.mjs` | |
| `dm_liste` | `monument_list` | `poi-bridge.mjs` | |
| `dm_nummer` | `monument_ref` | `poi-bridge.mjs` | `ref` ist die OSM-Konvention für amtliche Nummern |
| `dm_ort` | `monument_place` | `poi-bridge.mjs` | |

**Schon englisch, bleibt:** `source`, `archetype`, `persistent`, `on_demand`,
`portable`, `realtime`, `spawn_id`, `walk_path`, `motion`, `escrow`,
`dialog_set`, `dialog_vars`, `director`, `actions`, `altitude_ref`.

## B · In der Datenbank (`objects.state.call`)

Der Server schreibt diese Felder; er ist die Wahrheit, nicht der Editor.

| alt | neu | Bemerkung |
|---|---|---|
| `kurz` | `summary` | Zeile in der Liste |
| `ort` | `place` | Ortsangabe im Klartext |
| `nachweis` | `proof` | Liste von Nachweisarten — Werte siehe D |
| `steigt` | `rewardStep` | Steigerung je Durchlauf |
| `vorOrtRadiusM` | `onSiteRadiusM` | |
| `annahmeRadiusM` | `acceptRadiusM` | |
| `anbietenNachH` | `listAfterHours` | |
| `angeboten` | `offered` | |
| `probelauf` | `dryRun` | |
| `pruefgruppe` | `reviewGroup` | |
| `schwarmZahl` | `crowdCount` | |

**`karma` bleibt.** Lehnwort, im Englischen dasselbe Wort.

**Schon englisch, bleibt:** `task`, `status`, `listed`, `deadline`, `verify`,
`repeatable`, `rewardItems`, `rewardPerRun`, `requires`, `requiresItems`,
`claimedBy`, `completedBy`, `pendingBy`, `completions`, `publishedAt`,
`submission`, `submissionProof`, `submittedAt`, `rejectReason`, `votesNeeded`.

## C · Layer-Schlüssel in `agent_manifests`

**Diese stehen zusätzlich im Browser jedes Spielers** (`ajna.layer_filters`,
Format `{ [source]: [layerKey, …] }`). Ohne Umschlüsselung beim Lesen stehen nach
dem Umbenennen alle Inhaltsfilter wieder auf Anfang.

| Quelle | alt | neu |
|---|---|---|
| poi | `gastro` | `food` |
| poi | `rast` | `rest` |
| poi | `historisch` | `historic` |
| poi | `natur` | `nature` |
| denkmal | `natur` | `nature` |
| denkmal | `kultur` | `cultural` |
| denkmal | `stolperstein` | `stolperstein` — Eigenname, bleibt (auch im Englischen) |
| denkmal | `geschuetzt` | `protected` |
| denkmal | `erloschen` | `revoked` |

Gleiche Schlüssel in verschiedenen Quellen stören nicht — die Ablage ist nach
Quelle getrennt.

## D · Werte, nicht Schlüssel

Aufzählungswerte liegen genauso in der Datenbank wie die Schlüssel.

| Feld | alt | neu |
|---|---|---|
| `call.proof[]` | `foto` | `photo` |
| `call.proof[]` | `vorOrt` | `onSite` |
| `call.proof[]` | `gegenstand` | `item` |
| `state.monument_kind` | `natur` / `kultur` / `stolperstein` | `nature` / `cultural` / `stolperstein` |
| `state.movement` | `steht` / `frei` | `still` / `free` |

**Schon englisch, bleibt:** `call.verify` (`items`, `issuer`, `agent`, `group`,
`crowd`), `subject_type` in den Rechten, alle Archetypen (`npc`, `enemy`,
`animal`, …).

## E · Über die Leitung, nicht in der Datenbank

Das Ergebnis der Adress-Lupe geht als flüchtige Chat-Nachricht vom Agenten an den
Client (`meta`). Kein Bestand — aber eine ältere App auf dem Telefon versteht die
neue Fassung nicht, solange sie nicht mitgezogen ist.

| alt | neu |
|---|---|
| `adressen` | `addresses` |
| `geprueft` | `checked` |
| `titel` | `title` |
| `ort` | `place` |
| `genauigkeit` | `precision` — Werte `genau`/`geschaetzt` → `exact`/`estimated` |
| `felder` | `fields` |
| `felder[].feld` | `fields[].field` |
| `felder[].wert` | `fields[].value` |
| `felder[].herkunft` | `fields[].origin` |
| `felder[].ausfall` | `fields[].failed` |
| `entfernungM` | `distanceM` |
| `werkzeug` | `tool` |

## F · Dateien im Repo (`figuren/*.figur.json`)

Kein Bestand in der Datenbank, nur Dateien — billig, aber ein öffentliches Schema
(dokumentiert in `figuren/README.md`). Die **Werte** bleiben deutsch; Inhalt ist
keine Programmierung.

| alt | neu |
|---|---|
| `typ` | `type` |
| `beschreibung` | `description` |
| `bewegung` | `movement` |
| `aussehen` | `appearance` |
| `auftrag` | `quest` |
| `auftrag.kurz` | `quest.summary` |
| `auftrag.ort` | `quest.place` |
| `auftrag.nachweis` | `quest.proof` |
| `auftrag.abnahme` | `quest.review` |
| `auftrag.anbieten` | `quest.listAfter` |
| `auftrag.wiederholbar` | `quest.repeatable` |
| `auftrag.belohnung` | `quest.reward` |
| `belohnung.anzahl` | `reward.count` |
| `belohnung.jeDurchlauf` | `reward.perRun` |
| `belohnung.beschreibung` | `reward.description` |

## Was ausdrücklich NICHT umbenannt wird

* **Dialogpakete** (`dialogs/*.parley.json`) — ihr Schema ist bereits englisch
  (`when`, `then`, `if`, `set`, `once`, `suggest`). Paketnamen und Listennamen
  sind Inhalt.
* **Figuren-Kennungen** (`baumhueterin-wollendorf`) — Eigennamen und zugleich der
  Anker, an dem der Director wiedererkennt. Ändern hieße: zweite Figur.
* **Oberflächentexte** in `t('…')` — der deutsche Satz IST der Schlüssel, siehe
  `mehrsprachigkeit.md`.
* **Reine Client-Zustände** wie die Reiter `meine` und `verfuegbar` in der
  Auftragsliste — die verlassen den Browser nie und gehören in die laufende
  Umbenennung des Codes, nicht hierher.

## Ablauf der Umstellung

Die Reihenfolge ist nicht beliebig. Die Datenbank ist immer VOR den Clients dran.

1. **Lesen beidseitig machen.** Jede Lesestelle akzeptiert alt und neu
   (`state.figure_id ?? state.figur_id`). Ab hier ist jede Reihenfolge
   ungefährlich.
2. **Schreiben umstellen** — Agents und Server schreiben nur noch neu.
3. **Migration** über den Bestand (`objects.state`, `agent_manifests.layers`).
4. **Umschlüsselung im Browser**: beim Lesen von `ajna.layer_filters` alte
   Layer-Schlüssel auf neue abbilden und einmal zurückschreiben. Sonst verliert
   jeder Spieler seine Filtereinstellung.
5. **Übergangszeit stehen lassen**, bis die Android-App nachgezogen ist. Erst
   danach das doppelte Lesen aus Schritt 1 entfernen.

**Prüfbar unterwegs:** Nach Schritt 1 und nach Schritt 2 müssen alle Suiten grün
sein; nach Schritt 3 darf `state.figur_id` — und jeder andere alte Schlüssel — in
der Datenbank kein einziges Mal mehr vorkommen. Das ist die Abnahme.

## Was beim Ausführen passiert ist

**Die Migration liegt in zwei Dateien**, und der Grund dafür ist lehrreich:

`1789000000_schluessel_englisch.js` zieht die Schlüssel in `objects.state` um —
in SQL, mit `json_set`/`json_remove`, weil jeder Umweg durch den JSVM eine
Gelegenheit ist, Umlaute zu zerlegen (siehe `utf8.js`).

**Die Falle:** `json_extract` gibt für JSON-`true` eine **Zahl 1** zurück, nicht
den Wahrheitswert. Nach dem ersten Lauf stand `"dryRun": 1` im Datensatz — und
`c.dryRun === true` ist gegen eine 1 still falsch. Ein Probelauf wäre damit ein
ganz normaler Auftrag geworden und hätte Karma ausgezahlt; das Filterprädikat
`{ field: 'state.monument_revoked', equals: false }` hätte kein Denkmal mehr
getroffen. Gemerkt beim Nachsehen in der Datenbank, nicht durch einen roten Test
— die Suiten prüfen den Code, nicht den Bestand.

Behoben ist es an beiden Enden: `1789000000` unterscheidet jetzt mit
`json_type` und setzt `json('true')`, und `1789000100_wahrheitswerte_reparieren.js`
zieht die fünf betroffenen Felder (`loot`, `tool`, `monument_revoked`,
`call.offered`, `call.dryRun`) auf einer Instanz gerade, die die erste Fassung
schon gesehen hat. Auf einer frischen Instanz findet sie nichts.

**Wo die Übergangszeit noch sichtbar ist** — diese Stellen dürfen weg, sobald
die Android-App nachgezogen ist:

| Stelle | was sie tut |
|---|---|
| `quests.js` · `callDataOf` | normalisiert `state.call` beim Lesen; schreibt die neuen Namen beim nächsten Speichern mit |
| `questMapping.js` · `callFelder` | dasselbe im Client, für beide Zugangswege (Liste und Objekt) |
| `main.pb.js` · `/api/quests/near` | schickt jedes umbenannte Feld **zweimal**, alt und neu |
| `AgentFilters.js` · `LAYER_ALT_NEU` | schlüsselt die gespeicherte Filterauswahl im Browser um |
| `AdressMarker.js` · `adresseFelder` | versteht eine ältere Lupen-Antwort vom VPS |
| `figuren.mjs` | liest `typ`/`beschreibung`/`auftrag`/… weiter |
| `geo.js` · `ALT` | `POI_FILTER=…,natur` bleibt gültig |
| `kampf.mjs`, `world-director.mjs`, `poi-bridge.mjs`, `address-bridge.mjs`, `karma.js`, `Appearance.js` | je ein `?? alt` an der Lesestelle |

## Beim Ausrollen

1. **Server zuerst.** Die Migration läuft beim Start von PocketBase.
2. **Danach `pm2 restart all`.** Die Layer-Schlüssel stehen in
   `agent_manifests`, und die schreiben die Agents beim Start neu — ohne
   Neustart bietet der Filterdialog die alten Schichten weiter an.
3. **Prüfen:** Kein `figur_id` und kein `call.kurz` mehr in der Datenbank. Das
   ist die Abnahme.
