# Betrieb

Was ein Betreiber zur Laufzeit einstellt, und was von selbst aufgeräumt wird.

## Einstellungen zur Laufzeit (`settings`)

Agents laufen als eigene Prozesse. Eine geänderte Env-Variable hieß bisher:
jeden einzelnen neu starten. Die Collection `settings` nimmt dieselben Werte
auf, und ein Realtime-Abo verteilt Änderungen sofort.

**Die Regel: `.env` liefert die Vorgabe, die Datenbank übersteuert sie.**

Eine frische Installation läuft damit aus der `.env` allein — es muss nichts
angelegt werden, bevor irgendetwas startet. Im Betrieb dreht man an der
Datenbank. Umgekehrt bräuchte jede Neuinstallation erst Datensätze.

| Feld | |
|---|---|
| `key` | Punkt-getrennt, `<bereich>.<sache>` — hält die Liste sortiert |
| `value` | JSON: Zahl, Text, Wahrheitswert oder Struktur |
| `note` | Wozu das gut ist. Für den Menschen, der es in einem halben Jahr wiederfindet |

Lesen dürfen alle angemeldeten Konten (Agents sind gewöhnliche Konten),
schreiben nur die Verwaltung.

```js
import { Konfig } from './lib/konfig.mjs'

const konf = await Konfig.starte(ajna, { praefix: 'wd' })
konf.ganz('count.enemy', 'WD_COUNT_ENEMY', 1)   // Datenbank → Env → Vorgabe
konf.beiAenderung(() => neuBerechnen())
```

### Was hier nicht hineingehört

- **Geheimnisse.** API-Schlüssel, Passwörter, Tokens. Die Collection ist für
  jedes angemeldete Konto lesbar, und Datensätze landen in jeder Sicherung.
  `Konfig` weigert sich, Env-Namen mit `pass`, `secret`, `token` oder `key`
  aus der Datenbank zu übersteuern — der Wert kommt dort immer aus der Env.
- **Was vor PocketBase gebraucht wird.** Die Adresse von PocketBase selbst,
  TLS-Pfade, die Anmeldedaten der Agents. Henne und Ei.
- **Gerätelokale Entscheidungen.** Standort-Freigabe und „wer sieht mich hier"
  sind die Aussage eines Menschen darüber, was der Server *nicht* erfahren soll.
  Sie auf dem Server zu speichern hieße, den Schutz beim Geschützten abzugeben.

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
