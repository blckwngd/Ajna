# Smoketest — Multi-Server-Federation + Resilience

Manueller End-to-End-Test für das Federation-Setup mit **zwei parallelen
PocketBase-Instanzen** sowie für die Resilience-Schicht aus Phase 5
(Token-Refresh + Realtime-Catch-up). Reproduziert die Szenarien, die das
gewöhnliche Single-PB-Setup nicht abdeckt: Server-Ausfall mittendrin,
verpasste SSE-Events, abgelaufene Tokens.

## Setup

Zwei PocketBase-Instanzen lokal parallel laufen lassen:

```bash
# Terminal 1 — PB #1 (Default-Server für den Webclient)
cd pocketbase
./pocketbase serve --http 127.0.0.1:8090 --dir pb_data

# Terminal 2 — PB #2 (zusätzlicher Federation-Server)
cd pocketbase
./pocketbase serve --http 127.0.0.1:8091 --dir pb_data_2
```

Beim ersten Start jeder Instanz:
- `/_/` aufrufen, Admin-User anlegen
- In den Migrations laufen automatisch (Collections, Hooks, agent_manifests)
- Einen Test-User pro Server registrieren — gerne dieselbe E-Mail, das ist
  pro PB-Instanz isoliert (separate `auth`-Tabelle)

Webclient via `npm run start` starten und auf `https://localhost` einloggen.

## Test 1 — Zweiten Server hinzufügen

1. In der Editor-Sidebar **Server**-Button öffnen → "Server hinzufügen"
2. URL `http://127.0.0.1:8091` eintragen, Label z. B. "PB Büro"
3. Auf der neuen Karte einloggen
4. ✅ Beide Server zeigen "verbunden", grünes Badge

## Test 2 — Objekte über beide Server gemischt

1. Auf PB #1: ein Objekt anlegen (Rechtsklick auf Karte → "Neues Objekt…")
2. Auf PB #2: ebenfalls ein Objekt anlegen (im Editor-Panel den Server umstellen,
   ODER kurzfristig den Default-Server wechseln)
3. ✅ Karte zeigt beide Marker
4. ✅ Beim Hover/Klick erscheint im Popup das jeweilige Server-Badge
5. ✅ Composite-IDs in der Objekt-Liste: `<server-id>:<raw-id>`

## Test 3 — Realtime gemischt

1. In PB #1 Admin-UI (`http://127.0.0.1:8090/_/`) eine Coordinate eines Objekts
   händisch ändern
2. ✅ Marker auf der Karte rutscht innerhalb von 1–2 Sekunden zur neuen Position
3. Dasselbe mit einem Objekt aus PB #2
4. ✅ Auch dieser Marker reagiert in Echtzeit

## Test 4 — Server-Ausfall (Resilience)

1. PB #2 stoppen (Strg-C im 2. Terminal)
2. ✅ UI bleibt voll funktional — PB #1-Objekte reagieren weiter live
3. ✅ Objekte von PB #2 bleiben sichtbar (last-known State); kein
   `getObjects()`-Crash
4. PB #2 nach 10–30 Sek wieder starten
5. ✅ Console-Log: `[ajna:<server-id>] PB realtime re-connected → catch-up refresh`
6. ✅ Während des Ausfalls am Admin-UI von PB #2 geänderte Objekte sind nach dem
   Reconnect korrekt auf der Karte

## Test 5 — Token-Revocation

1. In PB #1 Admin-UI den Test-User aus `users` löschen (oder dessen Token-Salt
   zurücksetzen — das invalidiert alle ausgegebenen Tokens)
2. Webclient-Tab kurz minimieren / `setInterval` abwarten (Heartbeat = 1h —
   für den Test schneller: PB #1 stoppen + leeres `pb_data` neu starten + Migration
   laufen lassen + User wieder anlegen)
3. ✅ Nächster Boot/Refresh-Cycle räumt den authStore: Console-Log
   `[ajna:<server-id>] gespeichertes Token revoked → authStore geleert`
4. ✅ UI zeigt Login-Maske — kein Hänger, kein endloser 401-Loop

## Test 6 — Catch-up-Poll-Heartbeat

1. Mit geöffneten DevTools die Netzwerk-Tab beobachten
2. ✅ Alle 30 Sekunden ein `GET /api/collections/objects/records` pro Server
3. ✅ Wenn der Client gerade einen Reconnect hatte und die Liste neu geladen
   hat, überspringt der Catch-up den nächsten Aufruf nicht — der Poll läuft
   weiter (Dedup gilt nur für PB_CONNECT-getriggerte Refreshes innerhalb 5s)

## Bekannte Einschränkungen

- **Cross-Server-Relations** (z. B. ein Objekt auf PB #1, dessen Owner ein User
  auf PB #2 ist) sind **nicht unterstützt**. Foreign-Keys bleiben innerhalb
  einer PB-Instanz; siehe Federation-Konzept in `AjnaClient.js`.
- **Gruppen + ACEs** werden in Phase 1 nur am Default-Server abgefragt. Für
  Multi-Server-Permissions kommt Phase 6.
- **Agent-Manifeste** werden über alle Server gemerged (Filter-Dialog).
  Upsert läuft am Default-Server — Agents loggen sich gegen den Server ein,
  der bei `--pb-url` konfiguriert ist.
