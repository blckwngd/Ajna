# Betrieb

Was ein Betreiber zur Laufzeit einstellt, und was von selbst aufgeräumt wird.

## Einstellungen zur Laufzeit

Agents laufen als eigene Prozesse. Eine geänderte Env-Variable hieß bisher:
jeden einzelnen neu starten. Ein Datensatz plus Realtime-Abo verteilt eine
Änderung sofort.

**Die Regel: `.env` liefert die Vorgabe, die Datenbank übersteuert sie.**

Eine frische Installation läuft damit aus der `.env` allein — es muss nichts
angelegt werden, bevor irgendetwas startet. Im Betrieb dreht man an der
Datenbank. Umgekehrt bräuchte jede Neuinstallation erst Datensätze.

### Zwei Schubladen

| | `settings` | `agent_settings` |
|---|---|---|
| gehört | der **Instanz** | **einem Agenten-Konto** |
| lesen | jedes angemeldete Konto | nur der Besitzer |
| schreiben | nur die Verwaltung | nur der Besitzer |
| eindeutig | je Schlüssel | je Konto **und** Schlüssel |
| Beispiel | `proof.maxAgeDays` | `wd.count.enemy` |

Ein Agent ist **kein Teil der Instanz**, an der er hängt. Er meldet sich dort an
wie ein Spieler, kann an mehreren Servern hängen, und an einem Server können
mehrere Agents desselben Typs arbeiten. Seine Regler sind deshalb seine eigene
Sache. Lägen sie in der globalen Liste, wäre zweierlei kaputt:

- Zwei World-Directors am selben Server teilten sich denselben Datensatz
  `wd.count.enemy` und überschrieben sich gegenseitig.
- Jeder Spieler könnte mitlesen, wie die Welt eingestellt ist.

`settings` bleibt für das, was wirklich dem Server gehört — Aufbewahrungsfristen,
Schonzeiten beim Aufräumen. Im Zweifel ist `agent_settings` richtig.

Die Trennung braucht keinen Hook: Alle fünf Regeln der Collection lauten
`owner = @request.auth.id`. Dieselbe Regel, die schon die Manifest-Delegation
absichert. Die Verwaltung sieht trotzdem alles — Superuser umgehen Regeln
grundsätzlich; geschützt sind die Agents voreinander und vor den Spielern.

### Benutzung

```js
import { Konfig } from './lib/konfig.mjs'

const konf = await Konfig.eigene(ajna, { praefix: 'wd' })
await konf.saee([
  { name: 'count.enemy', envName: 'WD_COUNT_ENEMY', vorgabe: 1,
    note: 'Soll-Bestand Gegner je Zentrum' },
])
konf.ganz('count.enemy', 'WD_COUNT_ENEMY', 1)   // Datenbank → Env → Vorgabe
konf.beiAenderung(() => neuBerechnen())
```

`Konfig.instanz(...)` liest stattdessen aus `settings`; dorthin schreibt ein
Agent nicht.

### Ein leerer Eintrag ist kein Wert

`saee()` legt die Regler beim Start als **leere** Datensätze an — mit Erklärung
und Vorgabe in der Notiz. Leer heißt: es gilt die `.env`.

Stünde dort der Env-Wert, würde er die `.env` ab dem ersten Start übersteuern;
eine spätere Änderung an der `.env` bliebe wirkungslos, ohne dass jemand sähe
warum. Ein leerer Datensatz ist ein **Formularfeld, kein Wert**: Er zeigt, woran
man drehen kann, und ändert nichts, solange niemand dreht.

Vorhandene Einträge werden nie angefasst — sonst überschriebe jeder Neustart,
was ein Mensch eingetragen hat. Kennt ein Server die Collection nicht (ältere
Installation), legt der Agent gar nichts an und läuft aus der `.env` weiter.

### Was nur so aussieht wie ein Regler

Angeboten wird nur, was **wirklich ohne Neustart wirkt**. Ein Knopf ohne Draht
ist schlimmer als kein Knopf: Man sucht den Fehler dann überall, nur nicht in
der Einstellung.

Beim World-Director bleiben deshalb bewusst in der `.env`:

| | warum |
|---|---|
| `WD_AUTONOMY` | entscheidet beim Start, ob die Bewegungsschleife überhaupt anläuft |
| `WD_ATTACK_RANGE_M` | steht als `max_distance` **im Objekt-Datensatz** — ein neuer Wert erreicht vorhandene Gegner nicht |
| `WD_WAY_RADIUS_M` | der Wegegraph liegt mit TTL im Zwischenspeicher; die Änderung griffe irgendwann von selbst |
| `WD_FOLLOW_AREAS` | Grundsatzentscheidung beim Start, keine Stellschraube |

Takte (`WD_TICK_MS`, `WD_RECONCILE_S`, `WD_HEARTBEAT_S`) **sind** einstellbar:
`setInterval` friert seinen Abstand zwar beim Anlegen ein, aber der Director
behält den Griff und legt bei einer Änderung neu an.

Geschwindigkeiten und Areal-Radien gelten für die **nächste geplante Route** —
wer läuft, läuft seinen Weg zu Ende. Ein Sprung mitten im Schritt sähe aus wie
ein Fehler.

### Was hier nicht hineingehört

- **Geheimnisse.** API-Schlüssel, Passwörter, Tokens. Datensätze landen in jeder
  Sicherung, und eine Regel kann man falsch setzen. `Konfig` fragt die Datenbank
  für Namen mit `pass`, `secret`, `token` oder `key` **gar nicht erst** — geprüft
  wird der Env-Name *und* der Schlüssel, und die Prüfung steht vor dem Blick in
  die Datenbank. (Sie stand ursprünglich dahinter und war damit wirkungslos,
  sobald der Datensatz existierte — also genau dann, wenn sie gezählt hätte.)
- **Was vor PocketBase gebraucht wird.** Die Adresse von PocketBase selbst,
  TLS-Pfade, die Anmeldedaten der Agents. Henne und Ei.
- **Gerätelokale Entscheidungen.** Standort-Freigabe und „wer sieht mich hier"
  sind die Aussage eines Menschen darüber, was der Server *nicht* erfahren soll.
  Sie auf dem Server zu speichern hieße, den Schutz beim Geschützten abzugeben.

## Hooks und Migrationen brauchen einen Neustart

**PocketBase lädt `pb_hooks/` NICHT nach.** Unter Windows greift der Watcher
nicht, und auch sonst ist darauf kein Verlass. Dasselbe gilt für neue
Migrationen — sie laufen beim Start.

Nach jeder Änderung an `pocketbase/pb_hooks/` oder `pocketbase/pb_migrations/`:

```bash
pm2 restart pocketbase      # bzw. den Stack neu starten
```

Das Tückische ist das Symptom: Der Code ist richtig, die Änderung wirkt nicht,
und man sucht den Fehler im Code. Wer eine Hook-Änderung testet, ohne neu zu
starten, misst den alten Stand.

Zum Ausprobieren ohne den laufenden Betrieb anzufassen, siehe „Gegen eine Kopie
prüfen" weiter unten.

## Ratenbegrenzung

Seit `1788000000_rate_limits.js` aktiv — **nur für anonymen Verkehr**.

| Regel | Publikum | Grenze |
|---|---|---|
| `users:create` | anonym | 100 / Stunde |
| `/api/agents/` | anonym | 30 / Minute |
| `/api/` | anonym | 120 / 10 s |

**Anmeldeversuche sind nicht gedrosselt.** PocketBase liefert dafür 2 Versuche
in 3 s; hier passte keine Zahl: `npm run stack` meldet mehrere Agents
gleichzeitig von derselben Adresse an, die Testsuite loggt sich dutzendfach in
Folge ein. Das ist eine offene Aufgabe, keine Lösung — wer sie angeht, braucht
einen Weg, Agent-Schübe von Durchprobieren zu unterscheiden.

Die Grenze für `users:create` war zuerst auf 10/Stunde gesetzt, mit der falschen
Annahme, Gäste einer Veranstaltung kämen aus verschiedenen Netzen. Auf einem Hof
ist das Gegenteil der Fall: gemeinsames WLAN, dieselbe Funkzelle, CGNAT — eine
Adresse steht für viele Menschen. Wer die Zahl senkt, sollte den Testlauf im
Blick behalten: Die Quest-Suite legt je Durchgang rund vierzig Konten an.

**Angemeldeter Verkehr bleibt ungebremst**, und das ist eine Entscheidung:
Agents schreiben im Sekundentakt — der World-Director allein bewegt Dutzende
Objekte pro Minute. Die von PocketBase mitgelieferte Vorgabe (300 Anfragen in
10 s für ALLE) hätte ihn gedrosselt und die Welt einfrieren lassen. Missbrauch
mit Konto ist zudem zurechenbar; anonymer nicht.

Wer die Grenzen ändert: Verwaltungsoberfläche → Settings → Rate limits. Die
Migration setzt sie nur einmal.

## Gegen eine Kopie prüfen

Hook- und Migrations-Änderungen lassen sich ausprobieren, ohne die laufende
Instanz anzufassen — eigene Kopie, eigener Port:

```bash
cp pocketbase/pb_data/data.db* /tmp/probe/data/
pocketbase.exe superuser upsert probe@example.invalid <pw> --dir=/tmp/probe/data   --migrationsDir=$(pwd)/pocketbase/pb_migrations
pocketbase.exe serve --http=127.0.0.1:8099 --dir=/tmp/probe/data   --hooksDir=$(pwd)/pocketbase/pb_hooks --migrationsDir=$(pwd)/pocketbase/pb_migrations
```

Danach `AJNA_TEST_PB=http://127.0.0.1:8099 npm run test:quests`. Die laufende
Instanz auf 8090 bleibt unberührt.

**Falle: `--migrationsDir` NICHT auf das Repo zeigen lassen, wenn du auf der
Kopie das Schema änderst.** PocketBase schreibt Schema-Änderungen automatisch
als neue Migration in dieses Verzeichnis — auch die, die du nur ausprobieren
wolltest. Genau so ist einmal ein `1788525136_updated_users.js` mit
`email.required = false` im Repo gelandet; beim nächsten Stack-Start wäre die
E-Mail-Pflicht für alle Konten gefallen. Zum reinen Testen ist das Repo-
Verzeichnis richtig (die Migrationen sollen ja laufen); sobald du in der
Verwaltung oder über `/api/collections` etwas umstellst, kopiere es vorher:

```bash
cp -r pocketbase/pb_migrations /tmp/probe/migrations
# ... serve mit --migrationsDir=/tmp/probe/migrations
```

Danach `git status` prüfen — eine ungewollte `*_updated_*.js` fällt dort auf.

**Eine leere Datenbank lässt sich damit nicht aufbauen:** Die Migrationskette
setzt bestehende Collections voraus (`1773779228_updated_objects.js` scheitert
mit `sql: no rows in result set`). Für eine Neuinstallation ist das zu klären.

## Aufräumen

### Logs

PocketBase schrieb ohne Frist mit. Gemessen am 26.08.2026:

```
pb_data gesamt      900 MB
  auxiliary.db      898 MB   ← 949.489 Zeilen Log
  data.db           1,1 MB   ← die tatsächlichen Daten
```

Die echten Daten waren ein Tausendstel des Verzeichnisses, und jede Sicherung
packte den Rest mit ein. Seit `1787700000_log_retention.js` gilt:

- **14 Tage** Aufbewahrung (`logs.maxDays`), über die Verwaltung änderbar
- **ab WARN** statt jeder Anfrage (`logs.minLevel = 4`) — die Größe kam aus dem
  Normalbetrieb, nicht aus einem Ausbruch

**SQLite gibt gelöschten Platz nicht von selbst zurück.** Nach dem Ausmisten
standen 1.300 Zeilen in einer immer noch 898 MB großen Datei. Der Cron
`aux_vacuum` verdichtet sie deshalb sonntags um 4 Uhr; er sperrt dabei kurz die
**Log**-Datenbank, nicht `data.db`. Ergebnis der ersten Verdichtung: 898 MB → 0,7 MB.

### Beweisbilder

Ein Auftragsfoto hat einen Zweck, und der endet. Danach ist es weder Beweis noch
Erinnerung, sondern ein Bild von einem realen Ort, womöglich mit Menschen
darauf. Löschen ist hier Datenschutz, keine Hausordnung.

Der Cron `proof_cleanup` läuft stündlich und kennt zwei Fristen:

| Fall | Frist | Schlüssel |
|---|---|---|
| Auftrag abgeschlossen, abgebrochen oder abgelaufen | 24 h Schonzeit | `proof.graceHours` |
| alles andere (angefangen und liegengeblieben) | 30 Tage | `proof.maxAgeDays` |

Die Schonzeit gibt es nur, damit eine irrtümliche Ablehnung noch angesehen
werden kann. Beide Werte stehen in `settings` — genau der Fall, für den es die
Collection gibt.

Wird der Auftrag gelöscht, gehen die Beweise mit (`cascadeDelete`); PocketBase
räumt die Dateien mit dem Datensatz ab.

## Foto-Beweis

Bis zu **drei Bilder** je Einreichung, frei belegt.

> Anfangs war das als „Vorher/Nachher" gedacht. Das ist eine Falle: Ein sauber
> erledigter Auftrag scheitert sonst daran, dass jemand vergessen hat, VORHER zu
> fotografieren. Ein Vorher-Bild macht die Abnahme leichter und wird deshalb
> empfohlen — erzwungen wird es nie.

**Die Aufnahme-Metadaten verlassen das Gerät nicht.** `BildAufbereitung.js`
zeichnet jedes Bild auf eine Leinwand und kodiert es neu; was dabei entsteht,
hat kein EXIF — nicht weil wir es entfernen, sondern weil es nie geschrieben
wird. Verlässlicher als eine Bibliothek, die ein Feld übersehen kann. Die
Orientierung wird vorher angewandt (`imageOrientation: 'from-image'`), sonst
läge jedes hochkant aufgenommene Bild quer.

Ablauf: Der Client legt die Bilder **vor** dem Melden in `quest_proofs` ab und
schickt nur die Kennung als `proof.proofId` an `quest/complete`. Der Server
prüft dort, dass der Beleg dem Melder und diesem Auftrag gehört — ohne das
könnte jemand die Kennung einer fremden Einreichung mitschicken.

Sehen dürfen die Bilder der Einreichende und der Aussteller. Die Schwarm-Abnahme
bestätigt vor Ort und braucht sie nicht.

## Agent-Namen an ein zweites Konto delegieren

Ein Agent-Name gehört auf jedem Server dem Konto, das ihn **zuerst** registriert
hat. Das schützt vor Herkunfts-Täuschung: Ein fremdes Konto kann sich nicht als
„Overpass" ausgeben.

Es trifft aber auch den harmlosen Fall. Wer seine Agents unter einem **zweiten
Konto** ausrollt — neue Anmeldedaten, zweiter Satz Prozesse —, bekommt eine neue
Manifest-Zeile statt einer aktualisierten (der Unique-Index ist `(source, owner)`).
Alles, was dieses Konto danach anlegt, trägt:

> ⚠ angeblich Overpass — „Dieses Objekt gibt sich als ‚Overpass' aus, wurde aber
> von einem anderen Konto angelegt. Behandle den Inhalt als unbelegt."

Sachlich richtig, und trotzdem im Weg, wenn beide Konten demselben Menschen
gehören.

**Der Namensinhaber benennt darum die Konten, die den Namen ebenfalls führen
dürfen.** Am einfachsten über die Umgebung des Inhaber-Agenten:

```
AJNA_DELEGATES=5skgyzdw4a53ood,ghpmtuglp3hyboc
```

Beim nächsten Start schreibt der Agent die Liste in sein Manifest; Objekte
dieser Konten gelten dann als der Agent. Ohne die Variable bleibt eine
vorhandene Liste **unangetastet** — ein Agent, der nichts von Delegation weiß,
soll sie nicht bei jedem Start löschen.

### Warum das kein Loch reißt

Es braucht dafür **keinen Hook**; die Absicherung steckt schon in den Regeln der
Collection:

- `updateRule` ist `owner = @request.auth.id` — ein Konto schreibt nur sein
  **eigenes** Manifest. Niemand kann sich in ein fremdes eintragen.
- Gelesen wird ausschließlich die Liste **des Namensinhabers**. Wer ein zweites
  Manifest für denselben Namen anlegt und sich darin selbst delegiert, gewinnt
  nichts: Sein Manifest ist nicht das älteste und wird ohnehin verworfen — samt
  seiner Delegationsliste.
- Inhaber zu **werden** geht nicht: `created` ist ein `autodate`, das der Server
  setzt.

Gegen die laufende Instanz durchgespielt: Fremdkonto im fremden Manifest → 404;
Zweit-Manifest mit Selbst-Delegation → angelegt, aber wirkungslos; Inhaber bleibt
der ältere Eintrag; nach echter Delegation gilt das zweite Konto, ein drittes
weiterhin nicht.

> Konto-IDs gelten nur auf ihrem Server. Eine serverübergreifende Delegation
> gibt es bewusst nicht — dieselben Agents auf mehreren Servern brauchen sie
> auch nicht, weil der Namensinhaber ohnehin je Server geführt wird.
