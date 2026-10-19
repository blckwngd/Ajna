# Deployment (Server)

Automatisiertes Deployment mit **PM2**: ein Prozessmanager verwaltet PocketBase,
die Express-API und die Agents. **Caddy läuft bewusst separat** (Port 443 /
root-Privileg, ändert sich selten). Für lokale Entwicklung siehe
[dev-setup.md](dev-setup.md).

## Warum PM2 statt screen

- **Ein Befehl** statt „in jede screen-Session, Prozess killen, `git pull`, jeden
  Prozess wieder starten".
- **Auto-Neustart bei Absturz** (Watchdog) — ein abstürzender Agent reißt nichts
  mit (anders als `concurrently --kill-others`).
- **Start beim Server-Boot** (`pm2 startup` + `pm2 save`).
- **Zentrale Logs** (`pm2 logs`) und Status (`pm2 status`).

## Was PM2 verwaltet

Definiert in [`ecosystem.config.cjs`](../ecosystem.config.cjs):

| App | Kommando | Port |
|---|---|---|
| `pocketbase` | `./pocketbase/pocketbase serve --http=127.0.0.1:8090` | 8090 (loopback) |
| `api` | `node server/index.js` | 3000 |
| `client` | `serve client --listen 8888` (statischer Client) | 8888 |
| `poi-bridge`, `ais-bridge`, `wigle-bridge`, `world-director` | `node agents/<name>.mjs` (nach wait-stack) | — |

Die Ports spiegeln die `Caddyfile.prod` wider: Caddy proxyt `/api/*`→8090,
`/ajnaapi/*`→3000 und den restlichen (statischen) Verkehr →8888.

> **Static-Server oder Caddy `file_server`?** Nutzt deine `Caddyfile.prod` für
> den Client `handle { reverse_proxy 127.0.0.1:8888 }`, braucht es den
> `client`-Dienst (so ist es hier vorkonfiguriert). Liefert Caddy den Client
> stattdessen direkt (`root * ./client` + `file_server`, wie im committed
> Template), kann der `client`-Dienst entfallen — ein Prozess weniger.

Nicht benötigte Agents in der `AGENTS`-Liste der Ecosystem-Datei auskommentieren.
`wand-agent` (Online-Teil der Zauberstab-Kette) ist dort als optionaler,
auskommentierter Eintrag hinterlegt — nur einkommentieren, wenn du diese Demo
brauchst.

## Einmalige Einrichtung

Voraussetzungen wie in [dev-setup.md](dev-setup.md) (Node 24 LTS, PocketBase-Binary
unter `pocketbase/pocketbase`, Caddy). Dann:

> **Node-Version wechseln, wenn pm2 schon läuft:** pm2 liegt PRO Node-Version
> im globalen Verzeichnis. Nach einem Wechsel (nvm, NodeSource) ist der
> `pm2`-Befehl weg, während der alte Daemon unter dem alten Node weiterläuft.
> Reihenfolge: `npm i -g pm2` → `pm2 update` (startet den Daemon unter dem neuen
> Node neu) → `pm2 save`. Wer `pm2 startup` benutzt hat: Die erzeugte
> systemd-Unit trägt den PFAD der alten Node-Installation — `pm2 unstartup` und
> `pm2 startup` neu ausführen, sonst startet nach dem nächsten Reboot nichts.

```bash
# 1. PM2 global installieren
npm install -g pm2

# 2. Laufende screen-Prozesse beenden (PB / API / Agents) — Caddy darf laufen.
#    In der jeweiligen Session Ctrl+C, oder von außen:
#      screen -ls                      # Namen auflisten
#      screen -X -S <name> quit        # gezielt beenden

# 3. Einmal bauen + Prozesse starten
npm ci
npm run build
pm2 start ecosystem.config.cjs

# 4. Prozessliste für Boot-Resurrection speichern
pm2 save

# 5. Autostart beim Server-Boot einrichten
#    (gibt ein `sudo env PATH=… pm2 startup …`-Kommando aus → dieses ausführen)
pm2 startup
```

Caddy weiterhin wie gehabt laufen lassen (eigene screen-Session oder – empfohlen
– als systemd-Service). Bei reinen Code-Deploys braucht Caddy keinen Neustart;
nach Änderungen an `Caddyfile.prod`:

```bash
caddy reload --config Caddyfile.prod
```

## Deployen (neue Version ausrollen)

```bash
npm run deploy      # = bash scripts/deploy.sh
```

[`scripts/deploy.sh`](../scripts/deploy.sh) macht idempotent:

1. `git pull --ff-only`
2. `npm ci` — **nur** wenn sich `package.json` / `package-lock.json` geändert haben
3. `npm run build` — Client-Bundles neu bauen (Caddy liefert `client/dist/` statisch)
4. `pm2 startOrReload ecosystem.config.cjs` — Prozesse aktualisieren
5. `pm2 save` + `pm2 status`

> **gitignored bleibt unangetastet:** `.env`, `Caddyfile.prod`, `pb_data/` sind
> gitignored — `git pull` fasst sie nicht an, server-spezifische Anpassungen und
> die Datenbank bleiben erhalten.

## Nützliche PM2-Befehle

```bash
pm2 status                 # Übersicht aller Prozesse
pm2 restart world-director # einzelnen Prozess neu starten
pm2 reload all             # alle neu laden
pm2 stop all               # alle stoppen
pm2 delete all             # alle aus PM2 entfernen
```

## Logs ansehen & in einen Prozess schauen

```bash
pm2 logs                        # alle Prozesse live (folgt, Ctrl+C beendet)
pm2 logs world-director         # nur ein Prozess
pm2 logs world-director --lines 200   # letzte 200 Zeilen zuerst
pm2 logs world-director --err   # nur stderr
pm2 monit                       # Live-Dashboard: CPU/RAM + Log-Tail je Prozess
pm2 describe world-director     # Details: PID, cwd, Env, Restarts, Log-Pfade
pm2 flush                       # alle Logdateien leeren
```

Die Logdateien liegen unter `~/.pm2/logs/<name>-out.log` und
`<name>-error.log` — z. B. mit `tail -f` oder `grep` direkt durchsuchbar.

**Sich „in den Prozess einklinken" (Shell) gibt es bei PM2 nicht** — ein
PM2-Prozess ist kein Container, es gibt kein `exec` hinein. Für interaktives
Debugging stattdessen den Dienst kurz aus PM2 nehmen und das Kommando von Hand in
einer Shell laufen lassen (gleiches cwd + `.env`):

```bash
pm2 stop world-director
node agents/world-director.mjs          # läuft im Vordergrund, volle Ausgabe
# … debuggen, Ctrl+C …
pm2 start world-director                # wieder unter PM2-Aufsicht
```

Node-Inspector bei Bedarf: `node --inspect agents/world-director.mjs` (dann
`chrome://inspect`) statt des PM2-Starts.

## Prozess-Reihenfolge / Timing

Die Agents starten über [`scripts/agent-wrapped.sh`](../scripts/agent-wrapped.sh),
das per `wait-stack.mjs` wartet, bis `https://localhost/api/health` (Caddy →
PocketBase) antwortet (bis 90 s). Ist der Stack nicht rechtzeitig da, exit't der
Wrapper und PM2 startet ihn neu — die Agents laufen also nie gegen ein
halb-hochgefahrenes Backend.

Prüft der Server unter anderer Adresse/Port: `AJNA_WAIT_HOST` / `AJNA_WAIT_PORT` /
`AJNA_WAIT_PATH` als Env setzen.

## Speicher auf einer kleinen Maschine

Der Produktionsserver ist eine VM mit 2 GB. Dort ist im Oktober 2026 mehrfach
PocketBase gestorben und die **ganze Maschine hing**, bis sie neu gestartet
wurde. Beides zusammen ist eine Handschrift, die man wiedererkennt: der
Kernel-OOM-Killer sucht sich den grössten Prozess (das war die Datenbank), und
ohne Swap hat er vorher nichts, womit er Zeit gewinnen könnte — er lässt das
System erst minutenlang zwischen zu wenig Speicher und zu wenig Cache pendeln.

**Vier Schichten, und jede tut etwas anderes.** Die ersten drei stehen im
Repository, die vierte muss auf dem Server eingerichtet werden.

### 1. Heap-Budget je Agent (wirkt vorher)

In [`scripts/agent-wrapped.sh`](../scripts/agent-wrapped.sh). Ohne Vorgabe
richtet V8 seinen Heap nach dem **gesamten** Arbeitsspeicher der Maschine und
lässt ihn wachsen, statt aufzuräumen — bei zehn Agents gleichzeitig.
`--max-old-space-size=N` heisst nicht „der Agent darf nur N MB", sondern „ab N
MB räumt V8 auf, statt zu wachsen". Der Preis ist Rechenzeit fürs Aufräumen,
also etwas langsamere Antworten. Das ist die gewollte Richtung.

```bash
AJNA_HEAP_MB=96                    # Vorgabe für alle Agents
AJNA_HEAP_MB_world_director=160    # einzeln übersteuern (Bindestrich → Unterstrich)
AJNA_HEAP_MB=0                     # ganz abschalten
AJNA_SEMI_MB=8                     # junge Fläche je Halbraum
```

**`--max-old-space-size` allein genügt nicht.** Es begrenzt nur den *alten*
Bereich; die junge Fläche legt V8 nach eigenem Ermessen dazu. Gemessen am
19.10.2026 mit Node 25.8:

| Flags | Heap-Grenze |
|---|---|
| keine | 4288 MB |
| `--max-old-space-size=96` | **288 MB** |
| dazu `--max-semi-space-size=8` | 120 MB |

Ohne den Halbraum-Wert ist das Budget also dreifach überschritten, obwohl eine
Zahl dasteht. Der Wert gilt **je Halbraum**, und es gibt drei davon.

### 2. Auffangnetz in PM2

`max_memory_restart` je Dienst in [`ecosystem.config.cjs`](../ecosystem.config.cjs).
Wächst ein Agent trotz Heap-Budget, holt PM2 ihn geordnet zurück, bevor der
Kernel jemanden aussucht. **Greift das regelmässig, ist es ein Befund und kein
Fall für eine grössere Zahl.**

PocketBase bekommt bewusst **kein** `max_memory_restart`: es ist der Prozess,
den alle anderen brauchen, ein Neustart hält die Welt für eine halbe Minute an,
und ein abgebrochener WAL-Checkpoint kostet beim nächsten Start weit mehr.

### 3. Die Rechnung geht auf — oder PM2 sagt es

Beim Start rechnet `ecosystem.config.cjs` nach, ob die Marken zusammen in die
Maschine passen, und warnt sonst. **Mit allen zehn Agents passen sie nicht:**

```
⚠ SPEICHER ÜBERBUCHT: die Neustart-Marken ergeben zusammen 2288 MB,
  verfügbar sind etwa 1703 MB …
  In dieser Reihenfolge passen 7 der 10 Agents.
```

**Diese Warnung addiert Obergrenzen, nicht den Normalbetrieb.** Der Unterschied
ist gross und sollte nicht verwechselt werden:

| | neun Agents, gemessen | alle Marken gleichzeitig |
|---|---|---|
| Agents | ~510 MB | 1846 MB |
| + PocketBase, Caddy | ~115 MB | ~115 MB |
| **zusammen** | **~625 MB** | **~1961 MB** |

Die Marken selbst sind nicht frei gewählt, sondern eine Rechnung — in
`ecosystem.config.cjs` steht sie als Funktion, damit Budget und Marke nicht
auseinanderlaufen können:

```
Marke = Heap + 3 × Halbraum + 49 MB Node-Grundlast + 25 MB Luft
```

Eine Marke **unter** der Heap-Obergrenze wäre eine Falle: pm2 holt den Agenten
dann zurück, bevor V8 je aufräumen muss, und das Budget wird wirkungslos.

Im Betrieb passen also alle Agents bequem — gemessen mit Heap-Budget:
`world-director` 107 MB, `cits-bridge` 99 MB (ohne Budget waren es 203 bzw.
177), alle übrigen 33–56 MB. Die Marken sind der *schlechteste denkbare* Fall,
und in dem ist die Maschine überbucht.

Was heisst das praktisch? **Die Marken sind richtig gesetzt und die Summe
trotzdem ein Problem** — denn genau dann, wenn mehrere Agents gleichzeitig
einen schlechten Tag haben, soll das Netz halten, und das tut es nicht. Zwei
Wege:

* **Swap einrichten** (unten). Das ist der empfohlene: er tauscht Überbuchung
  gegen Langsamkeit, statt gegen einen Ausfall.
* **Agents auskommentieren**, wenn die Maschine ohne Swap bleiben soll. Die
  Warnung sagt, wie viele in der aufgeführten Reihenfolge passen.

Nicht verhandelbar ist die Grundlast: **ein frischer Node-Prozess kostet 49 MB,
bevor er irgendetwas getan hat** (gemessen, Node 25.8). Zehn davon sind ein
halbes Gigabyte, egal wie klein man die Budgets wählt. Wer dauerhaft mehr
Quellen will, legt sie in einem Agenten zusammen statt in zehn Prozesse.
`AJNA_HOST_MB=4096` setzen, wenn die VM grösser ist als angenommen.

> Die Zahlen oben sind auf dem Entwicklungsrechner (Windows) gemessen. Die
> Heap-Grenzen gelten plattformunabhängig, die RSS-Grundlast kann unter Linux
> abweichen. Deshalb melden die Agents ihren Speicher jetzt selbst (unten) —
> der erste Lauf auf dem Server sagt, ob die Marken passen.

### 4. Swap und OOM-Gewichtung (auf dem Server einzurichten)

Diese Schicht ist die, die aus „die VM hängt" ein „es ist gerade langsam"
macht — genau der Tausch, der hier gewollt ist.

```bash
# Swap anlegen (einmalig). 2 GB Datei auf einer 2-GB-VM ist die übliche Wahl.
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Erst spät auslagern: Swap ist das Sicherheitsnetz, nicht der Normalbetrieb.
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-ajna.conf
sudo sysctl --system
```

**PocketBase vor dem OOM-Killer schützen.** Der Kernel wählt nach Grösse, und
das ist hier die falsche Reihenfolge: ein Agent darf sterben, die Datenbank
nicht. `oom_score_adj` verschiebt die Wahl (−1000 = nie, +1000 = zuerst):

```bash
# PocketBase zum schlechtesten Opfer machen …
sudo bash -c 'echo -800 > /proc/$(pgrep -f "pocketbase serve")/oom_score_adj'
# … und die Agents zum bevorzugten.
for p in $(pgrep -f "agents/.*\.mjs"); do
  sudo bash -c "echo 400 > /proc/$p/oom_score_adj"
done
```

Das überlebt keinen Neustart. Dauerhaft wird es über eine systemd-Unit für PM2
(`OOMScoreAdjust=-800`) oder einen Eintrag in `scripts/deploy.sh` gesetzt.

**`earlyoom`** greift, *bevor* das System ins Thrashing läuft, und tötet
gezielt statt nach Grösse — der eigentliche Grund, warum eine VM hängt statt
einfach einen Prozess zu verlieren:

```bash
sudo apt install earlyoom
sudo systemctl enable --now earlyoom
# /etc/default/earlyoom: EARLYOOM_ARGS="-m 8 -M 100000 --avoid '(^|/)(pocketbase|caddy)$'"
```

### Was im Log steht

Jeder Agent meldet seinen Speicher von selbst
([`agents/lib/memory-report.mjs`](../agents/lib/memory-report.mjs)), standardmässig
alle zehn Minuten:

```
[director] [speicher] RSS 118.4 MB · Heap 74.2/96 MB · +6.1 MB seit der letzten Meldung
           · Figuren 42 · Wegegraphen 24/24 Einträge · 88 % Treffer (712/809) · 31 verdrängt
```

Stellschrauben: `AJNA_MEM_REPORT_S` (Takt, `0` schaltet ab) und
`AJNA_MEM_WARN_MB` (Marke; ohne Angabe 80 % der Heap-Grenze). Die Warnung beim
Überschreiten kommt **einmal** je Überschreitung, nicht bei jeder Meldung —
eine Zeile, die sich alle zehn Minuten wiederholt, wird weggefiltert und warnt
dann niemanden mehr.

## Optional: automatisches Deployment

- **Cronjob** (z. B. stündlich):
  `0 * * * * cd /pfad/zu/Ajna && npm run deploy >> deploy.log 2>&1`
- **Git-Hook / CI-Webhook**: bei Push auf den Deploy-Branch `scripts/deploy.sh`
  triggern.

## Migrations-Historie prüfen

PocketBase führt in `_migrations` Buch, welche Datei aus `pocketbase/pb_migrations/`
schon gelaufen ist. Fehlt dort eine Zeile, wendet PocketBase die Datei beim
nächsten Start erneut an — und eine erzeugte `created_*`-Migration scheitert
dann, weil die Sammlung längst existiert:

```
failed to apply migration 1779439512_created_groups.js:
  id: The model id is invalid or already exists.;
  name: Collection name must be unique (case insensitive)..
```

Das bricht den **ganzen** Start ab. Unter PM2 startet der Prozess sofort neu,
scheitert wieder, und Caddy antwortet auf jede Anfrage mit 502 — der Login
meldet „Something went wrong while processing your request".

Die Datenbank ist dabei in Ordnung. Kaputt ist nur das Buch.

```bash
npm run migrations                          # nur berichten
node tools/migrations-check.mjs --repair    # fehlende Zeilen nachtragen
```

`--repair` legt vorher eine Sicherung `data.db.<zeitstempel>.bak` an und trägt
**nur** Migrationen nach, die älter sind als die jüngste bereits verbuchte —
eine wirklich neue Migration bleibt unangetastet und läuft beim nächsten Start
ganz normal durch.

Vorher `pm2 stop pocketbase`, hinterher `pm2 start pocketbase`.

`scripts/deploy.sh` führt die Prüfung vor jedem Neustart aus und bricht ab,
solange ein Loch offen ist. Die laufenden Prozesse bleiben dabei unberührt —
lieber ein abgebrochener Deploy als ein Server, der nicht mehr hochkommt.

Wie ein Loch entsteht: `pb_data` und `pb_migrations` laufen auseinander. Eine
eingespielte Sicherung, die älter ist als die Dateien; eine von Hand im
Admin-Interface angelegte Sammlung; eine Datenbank von einer anderen Instanz.
Auffallen tut es erst beim nächsten Neustart, und der kann Wochen später sein.

## Fehlerbehebung

- **`pm2 start` findet die Binary nicht:** `./pocketbase/pocketbase` muss
  ausführbar sein (`chmod +x pocketbase/pocketbase`) und existieren.
- **Agent bleibt „errored" / dauernd im Neustart:** `pm2 logs <name>` — meist
  Timeout in wait-stack (Caddy/PB nicht erreichbar) oder fehlende `.env`-Werte
  (`AJNA_USER` / `AJNA_PASS`).
- **Nach Reboot laufen die Prozesse nicht:** `pm2 startup` ausgeführt **und**
  danach `pm2 save`? Beides nötig.
- **PocketBase startet gar nicht, `failed to apply migration …`:** siehe
  „Migrations-Historie prüfen" oben — `npm run migrations`.
- **Caddy bindet 443 nicht:** braucht root oder
  `setcap cap_net_bind_service=+ep $(which caddy)` — deshalb außerhalb von PM2.
