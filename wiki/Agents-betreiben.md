# Agents betreiben

<!-- nav -->
[← Wiki-Übersicht](Home.md) · Betreiben: [Server betreiben](Server-betreiben.md) · **Agents betreiben** · [Berechtigungen](Berechtigungen.md)
<!-- /nav -->

Agents sind normale Node-Prozesse, die sich als regulärer Benutzer anmelden und Objekte pflegen. Ein leerer Server ist funktionsfähig, aber leer — die Agents machen die Welt aus.

## Mitgelieferte Agents

| Agent | Start | Was er tut | Braucht |
|---|---|---|---|
| **World-Director** | `npm run director` | Belebt die Welt: setzt Figuren, plant Wege über das Straßennetz, lässt Vögel und Drachen fliegen. Folgt den Interessensbereichen der Spieler. | — |
| **POI-Bridge** | `npm run poi` | Legt Punkte von Interesse aus OpenStreetMap an (Bänke, Cafés, Brunnen). | — |
| **AIS-Bridge** | `npm run ais` | Schiffspositionen von aisstream.io. | API-Schlüssel |
| **ADS-B-Bridge** | `npm run adsb` | Flugzeuge aus dem OpenSky-Network. | optional OAuth2 |
| **WiGLE-Bridge** | `npm run wigle` | WLAN-Netze aus WiGLE. | Zugangsdaten |
| **Movebank-Bridge** | `npm run movebank` | Besenderte Wildtiere aus Movebank. | Zugangsdaten |
| **Home-Assistant-Gateway** | `npm run ha-gateway` | Smart-Home-Geräte als Objekte, in beide Richtungen. Eigene Anleitung: [`docs/homeassistant.md`](https://github.com/blckwngd/Ajna/blob/main/docs/homeassistant.md) | HA-Instanz |
| **UWB-Anker** | `npm run uwb-anchors` | Legt UWB-Anker aus einer JSON-Datei als Objekte an. Siehe [`docs/uwb.md`](https://github.com/blckwngd/Ajna/blob/main/docs/uwb.md) | Ankerdatei |
| **Wand-Agent** | `npm run wand-agent` | Gegenstück zum Zeigegerät. Siehe [`docs/wand-slice.md`](https://github.com/blckwngd/Ajna/blob/main/docs/wand-slice.md) | Zauberstab |

## Erststart

Jeder Agent bringt einen Einrichtungsassistenten mit. Fehlt eine Pflichtangabe, startet er von selbst; erzwingen lässt er sich mit `--setup`:

```bash
node agents/ais-bridge.mjs --setup
```

Der Assistent fragt die nötigen Werte ab (Kennwörter verdeckt) und schreibt sie nach `agents/.env.<name>` mit Dateirechten `0600`. Ohne Terminal — etwa unter pm2 — bricht ein Agent mit fehlender Konfiguration mit einer klaren Meldung ab, statt still nichts zu tun.

### Konto für den Agenten

Jeder Agent braucht ein eigenes Benutzerkonto (kein Administrator). Das lohnt sich doppelt: Rechte lassen sich pro Agent vergeben, und `state.source` plus Eigentümerschaft machen sichtbar, wer was angelegt hat.

Damit Spieler die Objekte sehen, braucht das Konto Standard-Rechte:

```json
[{ "subject_type": "authenticated", "rights": ["view"] }]
```

Ohne diesen Eintrag legt der Agent fleißig Objekte an, die niemand sieht — der häufigste Anfängerfehler.

## Interessensbereiche

Die meisten Bridges fragen ihre Quelle **nur dort ab, wo Spieler sind**. Grundlage ist das anonymisierte Aggregat der Interessensbereiche ([Privatsphäre](Privatsphaere.md)).

Das hat eine Folge, die man kennen sollte: **Steht kein Spieler mit Freigabe „Gegend" oder höher auf dem Server, tun diese Agents nichts** — und das ist richtig so. Wer zum Ausprobieren trotzdem Daten sehen will, setzt einen festen Mittelpunkt, etwa `ADSB_CENTER_LAT`/`ADSB_CENTER_LON`, der als Rückfallposition dient.

## Dauerbetrieb

```bash
pm2 start agents/world-director.mjs --name ajna-director
pm2 start agents/poi-bridge.mjs     --name ajna-poi
pm2 save
```

Die Assistenten einiger Agents bieten die Registrierung bei pm2 direkt an.

Zum Ausprobieren startet `npm run stack:all` den Stack zusammen mit POI, AIS, WiGLE und World-Director in einem Terminal.

> **Ein Agent je Objekt.** Mehrere Agents dürfen dasselbe Objekt anfassen, aber sie stimmen sich nicht ab — bei gleichzeitigen Änderungen gewinnt die letzte. Unter Windows ist die häufigste Ursache ein zweiter, vergessener Prozess: zwei Schreiber lassen Figuren springen.

## Läuft es?

```bash
node tools/ajna.mjs objects --limit 5      # was liegt auf dem Server?
pm2 logs ajna-director                     # was macht der Agent?
```

Jeder Agent protokolliert mit seinem Namen als Präfix, etwa `[director] …`. Bridges melden beim Start ihre Konfiguration — Radius, Taktrate, Grenzen —, sodass Fehlkonfigurationen in der ersten Zeile auffallen.

<!-- navfuss -->
---

← [Server betreiben](Server-betreiben.md) · [Übersicht](Home.md) · [Berechtigungen](Berechtigungen.md) →
<!-- /navfuss -->
