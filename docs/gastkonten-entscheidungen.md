# Gastkonten, anonyme Kommandos — Entscheidungen

Antwort auf `HeimatRadar/docs/ajna-auftrag-gastkonten.md` (4. September 2026).
Je Frage: Entscheidung, Begründung, betroffene Dateien.

**Leitlinie, an der ich alles gemessen habe:** Der Ajna-Server stellt Ajna
bereit. Was nur HeimatRadar braucht, gehört in den Agent — was jede zweite App
auch bräuchte, gehört in den Server. Diese Trennlinie fällt bei F1 und F5
unterschiedlich aus, und das ist Absicht.

---

## Zuerst: drei Messungen, die Annahmen im Auftrag korrigieren

### 1. Das Topic ist nicht privat — und war es nie

Ein **gewöhnliches Konto** kann `agent:<source>:public` abonnieren und liest
jedes anonyme Kommando mit, samt HMAC-Token:

```
Kommando: 200 {"delivered":1}
Fremdes Konto hat mitgelesen: JA
  {"command":"freigeben","payload":{"token":"GEHEIM-HMAC-abc123",…},"anonymous":true}
```

Das `delivered: 1` war der Lauscher, nicht der Agent.

**Wichtig für die Einordnung: Das ist nicht neu.** Dasselbe gilt für das
angemeldete Topic `agent:<source>` — auch dort liest jedes Konto mit
(ebenfalls gemessen). Die andere Sitzung hat einen bereits offenen Kanal
erweitert, keinen geöffnet. Custom-Topics des Subscription-Brokers unterliegen
keiner Regel; PocketBase prüft dort nichts.

**Folge für den Freigabe-Link:** Das signierte Token ist im Transport **kein
Geheimnis**. Wer mitliest, kann es weiterverwenden, bevor der Agent es sieht.
Der Entwurf trägt trotzdem, wenn der Agent das Token **einmalig** macht — beim
Verarbeiten als verbraucht markieren und ein zweites Mal ablehnen. Kurze
Gültigkeit hilft zusätzlich. Ohne Einmaligkeit ist die Freigabe von jedem
angemeldeten Konto übernehmbar.

Das ist eine Empfehlung an die HeimatRadar-Seite, keine Ajna-Änderung: Ein
Topic pro Aufruf abzusichern hieße, den Broker um ein Rechtemodell zu
erweitern — dafür ist der Anlass zu klein und die Alternative (Einmal-Token)
zu einfach.

### 2. Keine Schema-Drift bei `users.name`

Der Auftrag meldet, die Entwicklungs-DB habe `name` als required+unique,
während das committete Schema es optional habe. **Das stimmt nicht.** Die
Migration `1779453568_updated_users.js` setzt ausdrücklich `required: true` und
legt `idx_3SaF9RhB5p` als Unique-Index an; die laufende Datenbank entspricht
ihr exakt. Es gibt nichts zu bereinigen.

Für Gastkonten heißt das aber: **jeder Gast braucht einen eindeutigen Namen.**
Siehe F2.

### 3. `users.email` ist heute Pflichtfeld — lässt sich aber lösen

Gemessen an der laufenden Collection: `email required=true (system)`,
`createRule: ""` (offen), `viewRule: "id = @request.auth.id"` (streng
selbst-only). Im **heutigen** Schema ist ein Gast ohne E-Mail nicht anlegbar.

Dass es dabei bleiben müsse, stand hier zuerst — **falsch, und nachgemessen
widerlegt.** Siehe F2.

---

## F1 · Ist „Gastkonto" ein Ajna-Konzept?

**Ja — als Feld `users.guest`.** Der Empfehlung gefolgt.

Ein Konto ohne Passwort, das sein Besitzer kennt, ist ein Zustand des Kontos,
nicht eine Eigenschaft einer App: Aufräumen, Anzeige („Gast") und Rechte müssen
generisch darauf reagieren können. Bliebe es bei `app_data.<app>.…`, erfände
jede App ihre eigene Markierung, und Ajnas eigener Gastweg (F8) hätte gar keine.

**Wann es gesetzt wird:** in einem `onRecordCreateRequest`-Hook auf `users`,
wenn kein angemeldeter Aufrufer da ist.
**Wann es fällt:** wenn `verified` auf `true` geht. Das ist der beobachtbare
Moment, in dem der Mensch bewiesen hat, dass ihm die Adresse gehört — und in
Ajna der einzige, den ein Hook sicher mitbekommt. Ein „selbst gewähltes
Passwort" ist von außen nicht erkennbar.

Dateien: neue Migration (Feld), `pocketbase/pb_hooks/main.pb.js` (zwei Hooks).

## F2 · Muss ein Gastkonto eine E-Mail haben?

**Nein.** Ein Gast braucht keine Adresse; erforderlich wird sie erst, wenn das
Gastkonto in ein echtes Nutzerkonto übergehen soll.

**Diese Antwort ist eine Korrektur.** Hier stand zuerst „heute ja, technisch
bedingt" — begründet damit, `email` sei ein Pflicht-Systemfeld, an dem man nicht
schrauben solle. Das war eine Behauptung, keine Messung. Nachgeholt an einer
Wegwerf-Kopie (Port 8099, laufende Instanz unberührt):

| Versuch | Ergebnis |
|---|---|
| `email.required` auf `false` setzen | **200** — danach `required=false` |
| Konto ohne E-Mail anlegen | **200** |
| zweites und drittes Konto ohne E-Mail | **200, 200** — keine Index-Kollision |
| Login per `username` | **200** |

Der Weg ist also offen, und `username` steht seit Migration 1787100000 bereits
in `passwordAuth.identityFields` — der Login braucht keine Adresse.

**Zwei Folgen, die man dabei aussprechen muss:**

1. **`email.required = false` gilt für die ganze Collection**, nicht nur für
   Gäste. Ohne Gegenmassnahme könnte damit auch eine gewöhnliche Registrierung
   die Adresse weglassen. Der Hook aus F4 muss sie deshalb für alle Konten mit
   `guest = false` **erzwingen** — das Schema hält die Tür auf, zumachen muss
   der Hook. Das ist der eigentliche Preis dieser Entscheidung.
2. **Ein Gast ohne Adresse kann kein Kennwort zurücksetzen** — gemessen:
   `request-password-reset` mit leerer Adresse ist `400`. Sein einziger
   Schlüssel ist die Anmeldung auf dem Gerät. Geht das Gerät verloren, ist das
   Konto verloren. Für ein Gastkonto ist das vertretbar, aber es darf niemanden
   überraschen: Die Anmeldeseite sollte es sagen, statt es zu verschweigen.

**Übergang Gast → echtes Konto:** Adresse setzen, Mail über
`requestPasswordReset` (F3), danach `guest = false`. Erst ab diesem Schritt ist
die Adresse Pflicht — genau dort, wo sie gebraucht wird.

**`signup.require_email`** (F4) schaltet damit eine echte Wahl und nicht nur
eine Hook-Prüfung: Instanzen, die jeden Gast mit Adresse wollen, stellen ihn an.

**Namensgebung:** `users.name` ist required und unique. Ein Gast bekommt
deshalb einen erzeugten Handle `gast-<6 Zeichen aus base36>`, kollisionssicher
über einen Wiederholungsversuch. **Nicht `animalNames.js`** — dessen Namen sind
Tiernamen für Weltobjekte; ein Mensch, der als „Fuchs" auftaucht, ist eine
Verwechslung mit dem Wildtier-Agenten.

Der Handle `gast-<6>` passt auf das Muster von `username`
(`^[a-z0-9][a-z0-9_-]{1,31}$`) — er kann beide Felder füllen.

Dateien: Migration für `email.required = false` + `guest`-Feld, `main.pb.js`
(Hook: Adresse erzwingen, sobald `guest = false`), `docs/gastkonten.md`
(Handle-Format).

## F3 · Verifizierung und Kennwortvergabe

**Kontomails macht PocketBase, Anwendungsmails macht der Agent.** Der
Empfehlung gefolgt — mit einer Vereinfachung: **ein Mail-Schritt, nicht zwei.**

Für einen Gast ist `requestPasswordReset` der bessere Weg als
`requestVerification`: Er beweist die Adresse **und** setzt das Passwort in
einem Zug. Zwei Mails hintereinander („bestätige", dann „vergib ein Passwort")
sind für denselben Nachweis zwei Gelegenheiten zum Abspringen.

Ajna setzt `verified = true` und `guest = false`, wenn die Passwortvergabe
bestätigt wurde — wer die Mail bekommen hat, hat die Adresse.

**Bestätigungsseiten:** die von PocketBase mitgelieferten genügen; sie sind
über `meta.appURL` und die Vorlagen anpassbar. Eigene Seiten lohnen erst, wenn
jemand sie vermisst.

**Was der Agent NICHT verschicken darf:** Konto-Mails (Verifizierung,
Passwort). Sonst gibt es zwei Absender für dieselbe Sache.

**Was `requestPasswordReset` ohne SMTP antwortet — nachgefragt von der
HeimatRadar-Seite, hier gemessen:**

| Aufruf | Antwort |
|---|---|
| ohne Feld / leere Adresse | `400 validation_required` |
| „keine-adresse" | `400 validation_is_email` |
| unbekannte, gültige Adresse | **`204`** |
| vorhandene Adresse, **kein SMTP** | **`204`** |

**Die Anmeldeseite kann am Statuscode NICHT erkennen, ob eine Mail rausging.**
`204` heisst nur „Eingabe war eine Adresse". Dass unbekannte Adressen ebenfalls
`204` bekommen, ist Absicht — sonst liesse sich über den Endpunkt durchprobieren,
welche Adressen ein Konto haben. Dass ein SMTP-Fehler genauso aussieht, ist
Beifang: PocketBase stellt die Mail hinter der Antwort zu und protokolliert
Fehler nur in der Server-Ausgabe (im Test: kein Eintrag, keine Rückmeldung).

Für HeimatRadar heisst das: „Wir haben dir eine Mail geschickt" ist nach einem
`204` eine **Vermutung**, keine Tatsache. Wer es genau wissen will, prüft die
SMTP-Einstellung der Instanz beim Ausrollen (Verwaltung → *Settings* → *Mail*),
nicht bei jeder Anmeldung. Falls das öfter gebraucht wird, wäre ein winziger
Lesezugriff („hat diese Instanz Mailversand?") die passende Ajna-Ergänzung —
sagt Bescheid, gebaut ist er nicht.

Dateien: `main.pb.js` (Hook auf die Passwort-Bestätigung), Instanz-Einstellungen
(SMTP, `meta.appURL`, deutsche Vorlagen — nicht im Repo, das ist Betrieb).

## F4 · Konfiguration je Instanz

**`settings`-Schlüssel plus Hook, `createRule` bleibt offen.** Der Empfehlung
gefolgt.

Das passt zum vorhandenen Modell (`.env` liefert die Vorgabe, die Datenbank
übersteuert) und ist zur Laufzeit änderbar; die Regel selbst umzuschalten wäre
es nicht. Schlüssel:

| Schlüssel | Vorgabe | Wirkung |
|---|---|---|
| `signup.guests` | `true` | Konten ohne angemeldeten Aufrufer erlaubt |
| `signup.require_email` | `true` | Gast ohne Adresse wird abgelehnt |
| `signup.guest_ttl_days` | `30` | Gäste ohne Objekt und ohne `verified` werden aufgeräumt |

Abgelehnter Gast-Signup antwortet **403** mit `code: "guest_signup_disabled"`
bzw. `code: "guest_email_required"` — Codes, keine übersetzten Sätze, wie
überall sonst (siehe `docs/mehrsprachigkeit.md`).

Aufräumen als `cronAdd("guest_cleanup", …)` neben `proof_cleanup`. **Nur Gäste
ohne ein einziges Objekt** — wer etwas eingetragen hat, verliert es nicht,
bloß weil er die Mail nicht bestätigt hat; das wäre Datenverlust durch Frist.

Dateien: `main.pb.js` (Hook + Cron), `docs/betrieb.md` (Tabelle).

## F5 · Admin-Verifikation des Eintrags

**App-Sache. Bleibt beim Agent.** Der Empfehlung gefolgt.

Ajna garantiert genau eine Sache: Ein Objekt ohne ACE ist privat. Was „geprüft"
heißt, wer prüfen darf und was danach passiert, ist von App zu App verschieden
— ein generisches Moderationskonzept jetzt zu bauen hieße, es für einen
einzigen Nutzer zu erfinden und beim zweiten umzubauen. Wenn eine zweite App
dasselbe braucht, ist der Zeitpunkt da.

Dateien: keine.

## F6 · Kurator-Agent statt Superuser

**Phase 2 — mit einer Einschränkung, die vorher zu klären ist.** Der Empfehlung
im Zeitplan gefolgt, nicht im Umfang.

Die Teile (b) und (c) sind unstrittig: ein ACE-Recht `manage` bzw. eine Ausnahme
für gesiegelte Agents in `object_permissions.createRule`, und Ablehnen als Flag
statt Löschen. Das sind saubere Erweiterungen des vorhandenen Modells.

**Teil (a) ist es nicht.** `users.viewRule` lautet heute `id = @request.auth.id`
— streng selbst-only, und das ist eine ausdrückliche Datenschutz-Festlegung
(siehe `ajna-permissions-concept`). Sie um `@request.auth.agent_seal = true` zu
erweitern hieße: **jeder gesiegelte Agent liest die Kontaktdaten aller Konten**,
nicht nur der von ihm kuratierten. Das ist eine viel größere Öffnung als der
Anlass hergibt.

Tragfähiger wäre eine der beiden: der Agent bekommt Kontaktdaten **vom Besitzer
mitgegeben** (der Client schickt sie beim Eintragen an den Agent, der Server
gibt nichts preis), oder ein enger Server-Endpunkt „Kontakt des Besitzers von
Objekt X, wenn ich dessen Quelle kuratiere" — auf ein Objekt bezogen statt auf
die Konto-Tabelle. Bis dahin bleibt der Agent Superuser; auf einer Instanz,
deren Betreiber zugleich HeimatRadar betreibt, ist das vertretbar.

Dateien: Phase 2.

## F7 · Quellenanspruch bei Inhalten Dritter

**Manifest-Feld `contributions: "open"`.** Der Empfehlung gefolgt.

Der Quellenanspruch schützt heute davor, dass ein fremdes Konto sich als
„Overpass" ausgibt. Bei kuratierten Inhalten ist genau das der Normalfall:
Viele Konten tragen unter einem Namen ein, und eine Delegierten-Liste aus
Konto-IDs kann wechselnde Gäste nicht abbilden.

**Was sich damit ändert, gehört benannt:** Die Herkunftsangabe bedeutet dann
nicht mehr „dieses Konto hat es angelegt", sondern „dieser Agent steht dafür
ein". Der Client muss das anders schreiben — **„kuratiert von HeimatRadar"**
statt „von HeimatRadar". Sonst verspricht die Oberfläche eine Prüfung, die
nicht stattgefunden hat.

Dateien: `pocketbase/pb_hooks/main.pb.js` (`pruefeQuellenanspruch`),
Migration (Manifest-Feld), `client/core/AgentFilters.js` (Text).

## F8 · Gastweg in Ajnas eigenen Clients

**Jetzt nicht.** Abweichung von keiner Empfehlung — die Frage war offen.

Der Serverteil wird generisch gebaut (F1–F4), HeimatRadar ist sein erster
Nutzer. Ob Ajnas Karte/AR/Mobile einen „Als Gast fortfahren"-Weg anbieten,
entscheidet sich besser, wenn es einen laufenden Gastweg gibt, den man ansehen
kann. Vorher wäre es eine Oberfläche für eine Vermutung.

Dateien: keine.

## F9 · Betrieb

**Neustart-Regel:** PocketBase lädt `pb_hooks` **nicht** nach — unter Windows
greift der Watcher nicht, und auch sonst ist darauf kein Verlass. Nach jeder
Änderung an `pb_hooks/` oder `pb_migrations/` muss die Instanz neu starten.
Steht ab jetzt in `docs/betrieb.md`; ich bin heute mehrfach darauf
hereingefallen (Symptom: Änderung wirkt nicht, Code ist aber richtig).

**Schema-Drift:** existiert nicht, siehe oben.

**Ratenbegrenzung:** gebaut, siehe unten.

---

## Was in diesem Zug gebaut wurde (Phase A)

**Ratenbegrenzung** — `pocketbase/pb_migrations/1788000000_rate_limits.js`.
PocketBase 0.36 bringt sie mit; sie war ausgeschaltet.

Begrenzt wird, was **ohne Anmeldung** hereinkommt. Angemeldeter Verkehr bleibt
frei — Agents schreiben im Sekundentakt, und eine pauschale Grenze über `/api/`
(so die Vorgabe von PocketBase: 300/10 s für alle) hätte den World-Director
gedrosselt und die Welt einfrieren lassen. Missbrauch mit Konto ist zudem
zurechenbar.

| Regel | Publikum | Grenze |
|---|---|---|
| `users:create` | anonym | 100 / Stunde |
| `/api/agents/` | anonym | 30 / Minute |
| `/api/` | anonym | 120 / 10 s |

**Diese Tabelle stand hier zuerst falsch** (`users:create` mit 10/Stunde, dazu
eine `*:auth`-Regel mit 2 Versuchen in 3 s). Beide Zeilen sind Geschichte, nicht
Zustand — nachgereicht, weil die HeimatRadar-Seite auf den Widerspruch zur
Nachricht gestossen ist:

* **`users:create` steht auf 100/Stunde.** 10/Stunde beruhte auf der Annahme,
  Gäste einer Veranstaltung kämen aus verschiedenen Netzen. Auf einem Hof ist das
  Gegenteil der Fall — gemeinsames WLAN, dieselbe Funkzelle, CGNAT: eine Adresse
  steht für viele Menschen. PocketBase zählt je Client-IP, die Sorge der
  HeimatRadar-Seite ist also berechtigt und war der Auslöser für die Korrektur.
* **`*:auth` ist ersatzlos entfallen.** Keine Zahl passte: `npm run stack` meldet
  mehrere Agents gleichzeitig von derselben Adresse an, die Testsuite loggt sich
  dutzendfach in Folge ein. Anmeldeversuche sind damit **ungebremst** — eine
  offene Aufgabe, keine Lösung.

**Je Instanz einstellbar:** ja. Verwaltungsoberfläche → *Settings* → *Rate
limits*; die Migration setzt die Werte nur beim ersten Lauf und schreibt sie
später nicht zurück. Wer sie senkt, sollte den Testlauf im Blick behalten — die
Quest-Suite legt je Durchgang rund vierzig Konten an.

Gemessen: 40 anonyme Kommandos → 25 durch, 15 mit 429 gebremst; **200
angemeldete Anfragen → 200 durch, 0 gebremst**.

**Nutzlast-Deckel** — `main.pb.js`. `command` war auf 64 Zeichen begrenzt,
`payload` gar nicht; 200 KB gingen anonym durch den Broker an jeden Abonnenten.
Jetzt 8 KB, darüber `400 payload_too_large`. Gemessen.

**Die fünf Dateien aus Abschnitt 2 sind NICHT committet** — hier stand zuerst das
Gegenteil, und das war falsch. Nachgeprüft nach dem Hinweis der HeimatRadar-Seite:
`git show 6e101a0:client/core/AjnaClient.js` kennt kein `public`-Opt-in, und
`git show 6e101a0:pocketbase/pb_hooks/main.pb.js` enthält das `:public`-Topic
nicht. Der anonyme Kanal liegt vollständig unversioniert im Arbeitsbaum.

Woher die Verwechslung kam: Der Code tauchte im Arbeitsbaum auf, ohne dass ich
ihn geschrieben hatte (eine zweite Sitzung arbeitete am selben Verzeichnis), und
ich hielt ihn für Teil des letzten Commits, statt nachzusehen. Geprüft habe ich
danach immerhin den Vertrag selbst: `:public`-Suffix, `anonymous: true`,
`source: null` sind in Ordnung und bleiben so. Agents ohne Opt-in bekommen
nichts; `commandAllowed()` wirkt unverändert.

**Rückkanal über `sendChat(<Kennung>)`:** bleibt wie vorgeschlagen. Ein eigener
`reply_to`-Vertrag wäre ein zweiter Mechanismus für dasselbe, und die
Vertraulichkeit gewänne nichts — Chat-Topics sind genauso mitlesbar wie
Agent-Topics (s. o.). Wer den Rückkanal vertraulich braucht, braucht ein
Rechtemodell im Broker, nicht ein anderes Topic-Schema.

---

### Der Vertrag, gegen den die Anwendungsseite programmiert

Das Wichtigste stand bisher nur in Nachrichten zwischen den Sitzungen — und die
überleben das Ende einer Sitzung nicht. Deshalb hier vollständig.

**Server:** `POST /api/agents/{source}/command` nimmt Aufrufe **mit und ohne**
Anmeldung an. Das Ziel-Topic entscheidet sich am Absender:

| Absender | Topic | `source` | `anonymous` |
|---|---|---|---|
| angemeldet | `agent:<source>` | Nutzer-ID (serverseitig gesetzt) | `false` |
| anonym | `agent:<source>:public` | `null` | `true` |

`source` kommt in beiden Fällen vom Server, nie aus dem Body — Kommandos im
Namen eines anderen sind damit ausgeschlossen.

**Client:**

```js
const off = await ajna.onAgentCommand('mein-agent', (evt) => {
  // evt = { command, payload, source, anonymous, ts }
}, { public: true })   // ohne diese Option: NUR angemeldete Kommandos
off()                  // meldet beide Topics wieder ab
```

Beim `AjnaManager` war das dritte Argument bisher eine blosse `serverId`; beides
geht weiter. Wer einen bestimmten Server meint, schreibt
`{ serverId: 'x', public: true }` — ein blosses `{ public: true }` nimmt den
Standard-Server. Am `AjnaClient` gibt es nur die Optionsform.

**Ohne `{ public: true }` bekommt ein Agent von anonymen Aufrufen nichts.** Das
ist die Zusicherung, die den offenen Endpunkt trägt; sie wird in
`tests/privacy/agent-command.mjs` gemessen, indem der Test auf beiden Topics
mithört. Ein Agent, der das Opt-in setzt, prüft die Berechtigung **selbst** —
der Server kennt dafür kein Geheimnis.

**Grenzen:** `command` höchstens 64 Zeichen, `payload` höchstens 8 KB
(`400 payload_too_large`), Quellname nur `[A-Za-z0-9_-]{1,64}`, anonym 30
Aufrufe je Minute (`429`).

**Antwortweg:** `sendChat(<Kennung>)` — kein eigener `reply_to`-Vertrag, siehe
Begründung oben.

**Antwort `{ ok: true, delivered: n }`:** `delivered = 0` heisst, dass gerade
kein Agent zuhört — kein Fehler, aber sagbar.

**Belegt durch:** `tests/privacy/agent-command.mjs` (27 Prüfungen grün, darunter
die Kanaltrennung in beide Richtungen). Vollständiger Lauf nach Phase A: Quests
280, UI 797, Privatsphäre 27, Landeplatz 33, Geo 14, Module 14, Sichtprobe 12 —
alles grün.

---

## Übergabe: hier setzt die Anwendungsseite wieder an

**Phase A ist fertig und benutzbar** — der Vertrag oben gilt, ohne dass an Ajna
noch etwas zu tun wäre.

**Phase A ist NICHT committet.** Die Dateien liegen im Arbeitsbaum; der
Betreiber entscheidet über den Commit. Bis dahin ist der Stand nach einem
`git checkout` weg — wer darauf aufbaut, sollte das wissen. Nach dem Commit
braucht die laufende Instanz einen Neustart, weil PocketBase `pb_hooks` nicht
neu einliest (siehe `docs/betrieb.md`).

**Phase B ist entschieden, aber nicht gebaut.** Was fehlt: `users.guest`-Feld
samt Migration, die Umstellung `email.required = false` **zusammen mit** dem
Hook, der die Adresse für `guest = false` erzwingt (einzeln ausgeliefert wäre
die Migration ein Loch, siehe F2), die Einstellungen aus F4, der
`guest_cleanup`-Cron und SMTP samt Vorlagen.

**Was Phase B auslöst:** der Betreiber, nicht eine der beiden Sitzungen.

**Offen geblieben und bewusst nicht hier gelöst:** Anmeldeversuche sind
ungedrosselt (s. o.), und Realtime-Topics haben kein Rechtemodell (Abschnitt 1).
Beides ist Bestand, keine Folge dieses Auftrags.

## Was die HeimatRadar-Seite jetzt weiß

Für Phase B, wie in Abschnitt 6 erbeten:

- **Feld:** `users.guest` (bool). Gesetzt beim Anlegen ohne Anmeldung, fällt
  bei `verified = true`.
- **Settings-Schlüssel:** `signup.guests`, `signup.require_email`,
  `signup.guest_ttl_days`.
- **Fehlercodes:** `403 guest_signup_disabled`, `403 guest_email_required`,
  `400 payload_too_large` (Agent-Kommandos), `429` bei Ratenbegrenzung.
- **Mails von PocketBase:** Passwort-Vergabe (`requestPasswordReset`). Sonst
  keine. Verifizierungsmail wird **nicht** verschickt — die Adresse gilt mit
  der Passwortvergabe als bewiesen.
- **Mails vom Agent:** alles Anwendungsbezogene (neuer Eintrag an
  Organisator:innen, Bestätigung an Teilnehmende).
- **Empfehlung zum Freigabe-Token:** einmalig machen. Das Topic ist mitlesbar.
  *Nachtrag:* Die HeimatRadar-Seite hat es anders und besser gelöst — das Token
  verlässt die Seite gar nicht mehr, geschickt wird ein HMAC-Nachweis über
  Aktion, ID, Antwort und Zeitstempel, gültig zehn Minuten und je Antwort nur
  einmal. Ein Mitleser bekommt damit nichts Wiederverwendbares. An Ajna ist
  dafür nichts zu tun; der Vertrag (`:public`, `anonymous`, `source: null`,
  Rückkanal über `sendChat`) bleibt unverändert.

**Rückgemeldet und abgeschlossen:**

- Der angebotene Lesezugriff „hat diese Instanz Mailversand?" wird **nicht
  gebraucht** und ist damit ausdrücklich *nicht* zu bauen. Die HeimatRadar-Seite
  prüft SMTP beim Ausrollen über `/api/settings` — ihr Setup-Assistent läuft
  ohnehin als Superuser. Wer später denselben Gedanken hat: Er war da, er wurde
  geprüft, er wurde verworfen.
- Nach `requestPasswordReset` zeigt die Anmeldeseite „falls die Adresse stimmt,
  kommt eine Mail" statt „Mail ist raus" — die richtige Formulierung zu einer
  Antwort, die `204` auch für unbekannte Adressen und stummen Mailversand gibt.
- `100/Stunde` für anonymes Kontoanlegen ist für einen Anmeldetag tragbar,
  bestätigt von der Anwendungsseite.

**Noch nicht gebaut:** F1–F4 sind entschieden, aber der Code dafür (Feld, Hooks,
Cron) steht aus — das ist Phase B und braucht eine eigene Runde. Sie beginnt
erst, wenn der Betreiber sie startet; die HeimatRadar-Seite wartet darauf und
hat von sich aus keine offenen Forderungen mehr an Ajna.
