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
| `poi-bridge`, `ais-bridge`, `wigle-bridge`, `world-director` | `node agents/<name>.mjs` (nach wait-stack) | — |

Nicht benötigte Agents in der `AGENTS`-Liste der Ecosystem-Datei auskommentieren.

## Einmalige Einrichtung

Voraussetzungen wie in [dev-setup.md](dev-setup.md) (Node 22+, PocketBase-Binary
unter `pocketbase/pocketbase`, Caddy). Dann:

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
pm2 logs                   # alle Logs (folgen)
pm2 logs world-director    # nur ein Prozess
pm2 restart world-director # einzelnen Prozess neu starten
pm2 reload all             # alle neu laden
pm2 stop all               # alle stoppen
pm2 delete all             # alle aus PM2 entfernen
pm2 monit                  # Live-Ressourcen (CPU / RAM)
```

## Prozess-Reihenfolge / Timing

Die Agents starten über [`scripts/agent-wrapped.sh`](../scripts/agent-wrapped.sh),
das per `wait-stack.mjs` wartet, bis `https://localhost/api/health` (Caddy →
PocketBase) antwortet (bis 90 s). Ist der Stack nicht rechtzeitig da, exit't der
Wrapper und PM2 startet ihn neu — die Agents laufen also nie gegen ein
halb-hochgefahrenes Backend.

Prüft der Server unter anderer Adresse/Port: `AJNA_WAIT_HOST` / `AJNA_WAIT_PORT` /
`AJNA_WAIT_PATH` als Env setzen.

## Optional: automatisches Deployment

- **Cronjob** (z. B. stündlich):
  `0 * * * * cd /pfad/zu/Ajna && npm run deploy >> deploy.log 2>&1`
- **Git-Hook / CI-Webhook**: bei Push auf den Deploy-Branch `scripts/deploy.sh`
  triggern.

## Fehlerbehebung

- **`pm2 start` findet die Binary nicht:** `./pocketbase/pocketbase` muss
  ausführbar sein (`chmod +x pocketbase/pocketbase`) und existieren.
- **Agent bleibt „errored" / dauernd im Neustart:** `pm2 logs <name>` — meist
  Timeout in wait-stack (Caddy/PB nicht erreichbar) oder fehlende `.env`-Werte
  (`AJNA_USER` / `AJNA_PASS`).
- **Nach Reboot laufen die Prozesse nicht:** `pm2 startup` ausgeführt **und**
  danach `pm2 save`? Beides nötig.
- **Caddy bindet 443 nicht:** braucht root oder
  `setcap cap_net_bind_service=+ep $(which caddy)` — deshalb außerhalb von PM2.
