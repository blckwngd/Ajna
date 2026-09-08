# Gastkonten

Ein **Gastkonto** ist ein Konto, dessen Besitzer:in kein Passwort kennt. Eine
Anwendung legt es ohne angemeldeten Aufrufer an, damit jemand sofort ein
Weltobjekt eintragen kann — ohne Registrierung, ohne Mail, ohne Wartezeit. Erst
wenn die Person ihre E-Mail-Adresse bestätigt, wird daraus ein echtes Konto.

Das ist ein Zustand des Kontos, keine Eigenschaft einer App: Feld `users.guest`,
gesetzt vom Server, gelesen von allen. Entscheidungen und Messungen dazu stehen
in [gastkonten-entscheidungen.md](gastkonten-entscheidungen.md).

## Ablauf

```
anonym: users.create(…)          → guest = true, verified = false
        objects.create(…)        → als Besitzer:in, wie jedes Konto
optional, mit Adresse:
        requestPasswordReset(email)   PocketBase schickt die Konten-Mail
        confirmPasswordReset(token, pw)   → verified = true, guest = false
```

Der Server entscheidet, wer Gast ist:

| Anlage durch | `guest` | Adresse |
|---|---|---|
| niemanden (anonym) | `true` | nur, wenn `signup.require_email` es verlangt |
| ein angemeldetes Konto | `false` | Pflicht |
| die Verwaltung (Superuser) | wie gesetzt | Pflicht bei `guest = false` |

Ein Konto kann `guest` **nicht selbst** ändern — der Wert wird beim Update vom
Server zurückgeschrieben, wie bei `agent_seal`. Es fällt genau dann, wenn
`verified` auf `true` geht: nach der Passwortvergabe per Konten-Mail
(`onRecordConfirmPasswordResetRequest`), nach der klassischen Verifizierung
oder wenn die Verwaltung das Häkchen setzt.

## Namen

`users.name` ist Pflicht und eindeutig, `username` ist Login-Kennung. Fehlt beim
anonymen Anlegen eines davon, vergibt der Server einen Handle:

```
gast-<6 Zeichen aus a–z, 0–9>      z. B. gast-k7x2q9
```

Er passt auf das Muster von `username` und füllt beide Felder — damit kann sich
auch ein Gast ohne Adresse anmelden. Bewusst **nicht** aus `animalNames.js`:
Das sind Tiernamen für Weltobjekte, ein Mensch namens „Fuchs" wäre eine
Verwechslung mit dem Wildtier-Agenten. Anwendungen, die den Namen der Person
brauchen, legen ihn in `app_data.<app>.…` ab.

## E-Mail

Seit Migration `1788100000_users_guest.js` ist `users.email` **optional** — für
die ganze Collection, PocketBase kennt keine Pflicht je Zustand. Zumachen tut
der Hook: Ein Konto mit `guest = false` braucht eine Adresse, sonst 400
(`data.email.code = validation_required`). Migration und Hook gehören deshalb
**zusammen** ausgeliefert.

Ein Gast ohne Adresse lebt nur auf dem Gerät, auf dem er angemeldet ist:
`request-password-reset` mit leerer Adresse ist 400, es gibt keinen zweiten
Schlüssel. Geht das Gerät verloren, ist das Konto verloren. Für ein Gastkonto
ist das vertretbar — aber die Anmeldeseite einer Anwendung sollte es sagen.

## Einstellungen

In der `settings`-Collection, zur Laufzeit änderbar; fehlt der Datensatz, gilt
die Vorgabe.

| Schlüssel | Vorgabe | Wirkung |
|---|---|---|
| `signup.guests` | `true` | Konten ohne angemeldeten Aufrufer erlaubt |
| `signup.require_email` | `true` | Gast ohne Adresse wird abgewiesen |
| `signup.guest_ttl_days` | `30` | Gäste ohne Objekt und ohne `verified` werden aufgeräumt; `0` = nie |

Die ersten beiden sind **öffentlich** (`public = true`, View `public_settings`,
siehe [betrieb.md](betrieb.md)): Ein Anmeldeformular liest sie vor dem Login
mit `client.signupPolicy()` → `{ guests, requireEmail }` und richtet seine
Felder danach aus, statt eine eigene Kopie der Regel zu pflegen. Fehlt ein
Datensatz, gilt die Vorgabe — im Hook wie im Client.

Ablehnungen antworten **403** mit einem stabilen Code, den der Client übersetzt
(siehe [mehrsprachigkeit.md](mehrsprachigkeit.md)):

```json
{ "status": 403, "message": "…", "data": { "signup": { "code": "guest_signup_disabled", "message": "…" } } }
```

Codes: `guest_signup_disabled`, `guest_email_required`.

## Aufräumen

`cronAdd("guest_cleanup", "41 3 * * *")` löscht täglich Gäste, die älter als
`signup.guest_ttl_days` sind, **nicht** verifiziert sind und **kein einziges
Objekt** besitzen. Wer etwas eingetragen hat, bleibt — auch ohne bestätigte
Adresse. Ein Konto zu löschen, weil eine Mail nicht bestätigt wurde, wäre
Datenverlust durch Frist.

## Was eine Anwendung wissen muss

- **Konten-Mails macht PocketBase** (`requestPasswordReset`), Anwendungsmails
  der Agent. Zwei Absender für dieselbe Sache gibt es nicht.
- `requestPasswordReset` antwortet **204 auch bei unbekannter Adresse und ohne
  SMTP** — „wir haben dir eine Mail geschickt" ist danach eine Vermutung.
  Richtig ist: „Falls die Adresse stimmt, kommt eine Mail." SMTP prüft man beim
  Ausrollen (Verwaltung → Settings → Mail), nicht bei jeder Anmeldung.
- Anonymes Anlegen ist auf 100 Konten je Stunde und Adresse begrenzt
  ([betrieb.md](betrieb.md), Ratenbegrenzung) — 429 abfangen.
- Erster Nutzer ist HeimatRadar: `frontend/registrierung.html` dort zeigt den
  ganzen Weg, inklusive der Fehlerabbildung.
