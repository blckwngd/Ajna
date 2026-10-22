# Berechtigungen

Ajna hat ein NTFS-artiges Berechtigungssystem auf Objekt-Ebene: pro Objekt eine Liste von Access Control Entries (ACEs), die einem Subjekt (User, Gruppe, oder einer impliziten Audience) Rechte zuweisen.

## Konzeptionelles Modell

```
                              ┌─────────────┐
                              │  user (PB)  │
                              └──────┬──────┘
                                     │ owner
                                     ▼
                ┌───────────────────────────────────┐
                │             objects               │
                │  + animation_state, actions, …    │
                └──────┬───────────────────────────┘
                       │
                       │ aces (per object)
                       ▼
        ┌───────────────────────────────────────────┐
        │           object_permissions              │   Source of Truth
        │  subject_type, subject, rights,           │
        │  interact_actions                         │
        └──────┬────────────────────────────────────┘
               │
               │ resolver (transitive groups)
               ▼
        ┌───────────────────────────────────────────┐
        │         effective_permissions             │   Cache (auto-pflegt)
        │  user × object → rights, interact_actions │
        └───────────────────────────────────────────┘
```

- **Source of Truth** sind die ACEs in `object_permissions`.
- **`effective_permissions`** ist ein automatisch gepflegter Cache pro `(user, object)`, damit die API-Rules von `objects` einen schnellen Filter haben (PocketBase-Filter können keine rekursiven Group-Auflösungen).
- **Implicit Audiences** (`authenticated`, `anonymous`, `everyone`) sind nicht im Cache — werden direkt in den Rules gegen `object_permissions` geprüft.

## Rechte

| Recht | Wirkung |
|---|---|
| `view` | Objekt ist im Client sichtbar (List/Get/Realtime) |
| `edit` | Beliebige Felder (Name, Animation, Position) änderbar |
| `move` | Nur die Lage änderbar: `lat`/`lon`/`altitude` und `rotation`. Jedes andere Feld → 403 |
| `owner` | Darf ACEs verwalten (Eigentümer-Recht). Nur für `user`/`group`-Subjekte zulässig |

### `move`: bewegen, nicht umschreiben

Seit dem 22.10.2026 (Arbeitspaket 2a) wirkt `move` — vorher stand es nur im
Vokabular, und wer **nur** `move` hatte, konnte gar nichts. Zwei Teile:

* `objects.updateRule` lässt `move` zusätzlich zu `edit` durch
  (`1792900000_update_rule_move.js`, in der `?=`-Fassung).
* Der Hook `moveNurPosition` in `main.pb.js` vergleicht jedes Feld gegen den
  gespeicherten Stand. Geändert sein dürfen nur `lat`, `lon`, `altitude` und
  `rotation`; alles andere beantwortet er mit 403 und nennt das Feld.

Er greift nur, wenn `move` das **einzige** Schreibrecht ist. Besitzer und
`edit`-Inhaber verschieben weiterhin ohne `move`. Die Drehung gehört dazu,
weil „einen Wegweiser gerade ziehen" ohne sie nicht geht.

Wozu: ein Schwert ablegen und mitnehmen — ja; ihm Trefferpunkte geben — nein.
Marker einer Geokodierung korrigieren, Möbel in einem Raumplan schieben,
fremde Dinge an fester Welt ordnen. Netz: `tests/privacy/ace-schreiben.mjs`.

`interact_actions` ist ein eigenes Set: erlaubte Action-Keys wie `["attack","pet"]` oder `["*"]` für alles. Wird in `/api/objects/:id/interact` gegen den Action-Parameter geprüft.

Die Liste ist **offen** — jede Zeichenkette ist ein gültiger Action-Key. Das ist
die vorgesehene Achse für „darf X mit diesem Objekt tun", während `rights` vier
feste Bedeutungen hat. Eine Aktion mit Sonderstellung ist `contact`: sie gibt
die Kontaktdaten des eintragenden Kontos frei (siehe unten).

### `contact` — wer hat das Objekt angelegt?

`users.viewRule` ist `id = @request.auth.id`; niemand sieht ein fremdes Konto,
und das bleibt so. Wer ein Objekt aber **verwaltet**, muss den Menschen dahinter
erreichen können — eine Hofflohmarkt-Organisation, die eine Anmeldung prüft,
braucht Name und Rückfragemöglichkeit.

```
GET /api/objects/{id}/owner[?app=<name>]
→ 200 { id, name, username, email, telefon, guest, app_data? }
→ 401 nicht eingeloggt · 403 nicht berechtigt · 404 Objekt/Konto weg
```

Erlaubt ist der Zugriff, wenn der Aufrufer **selbst Besitzer** ist, oder wenn
eine ACE auf dem Objekt ihm `contact` (oder `*`) in `interact_actions` gibt —
und zwar über `subject_type` `user` oder `group`. **`everyone`,
`authenticated` und `anonymous` zählen hier absichtlich nicht**: eine einzige
öffentliche ACE würde sonst die Kontaktdaten aller Teilnehmer freigeben, mit
einem Haken als einziger Hürde. Personendaten brauchen ein benanntes Subjekt.

`?app=` gibt zusätzlich einen Abschnitt aus `app_data` heraus, nie das ganze
Feld — dort stehen die Daten *aller* Anwendungen über diesen Menschen.
Client-seitig: `client.getObjectOwner(id, { app: 'heimatradar' })`.

## Subjekt-Typen

| `subject_type` | `subject` | Bedeutung |
|---|---|---|
| `user` | User-ID | Konkreter Spieler |
| `group` | Group-ID | Alle (transitiven) Mitglieder einer Gruppe |
| `authenticated` | *leer* | Jeder eingeloggte Spieler |
| `anonymous` | *leer* | Jeder nicht-eingeloggte Spieler |
| `everyone` | *leer* | Beide impliziten Audiences zusammen |

## Gruppen mit Sub-Gruppen

`groups` enthält `members` (User) und `subgroups` (andere Groups, self-referenced). Members einer Untergruppe sind transitive Members der Obergruppe.

```
Familie Barth
├── members: [Andre, Anna]
└── subgroups:
    └── Kinder
        ├── members: [Tim, Lara]
        └── subgroups: []
```
Eine ACE auf "Familie Barth" mit `rights = ["view"]` erlaubt Andre, Anna, Tim und Lara den Zugriff. Eine ACE auf "Kinder" würde nur Tim und Lara erfassen.

Der Resolver erkennt Zyklen nicht — beim Hinzufügen einer Sub-Group muss die UI das verhindern. (TODO)

## Resolver-Logik

`resolveEffective(user, object)` (im Hook):

1. **Owner-Shortcut** — wenn `object.owner === user.id`, ALLE Rechte + `interact_actions = ["*"]`.
2. **Sammle Subjekt-Keys** des Users:
   - `user:<id>`
   - `group:<id>` für jede transitive Gruppen-Mitgliedschaft (BFS aufwärts über `subgroups`)
   - bei Logged-in: `authenticated:`, `everyone:`
   - bei Anonymous: `anonymous:`, `everyone:`
3. **Aggregate** alle `object_permissions` des Objekts, deren `subject_type:subject`-Key in der Subjekt-Liste liegt. Union über `rights` und `interact_actions`.

`resolveExplicit(userId, object)` — wie oben, aber ohne implicit audiences. Wird für den Cache benutzt.

## Cache-Invalidation

Hooks in [`pb_hooks/main.pb.js`](../pocketbase/pb_hooks/main.pb.js) sorgen für automatischen Refresh:

| Trigger | Effekt |
|---|---|
| `objects.afterCreate` | Default-Permissions aus `users.default_permissions` materialisieren + `recomputeForObject` |
| `object_permissions.afterCreate/Update/Delete` | `recomputeForObject(ace.object)` |
| `groups.afterUpdate/Delete` | `recomputeForGroup` → alle Objekte mit ACE auf diese Gruppe (oder Vorfahre-Gruppe) neu berechnen |

`recomputeForObject` sammelt alle (User-IDs + transitive Group-Member), die durch ACEs Rechte am Objekt haben, und schreibt einen Cache-Eintrag pro User. Stale Einträge werden entfernt. Owner bekommt keinen Cache-Eintrag (die `viewRule` deckt `owner = @request.auth.id` direkt ab).

### Debug-Endpoint

`POST /api/objects/:id/recompute-permissions` triggert den Refresh manuell. Nur Object-Owner.

```js
await ajna.pb.send(`/api/objects/${id}/recompute-permissions`, { method: "POST" })
// { ok: true, result: { objectId, aces, affectedUsers: [...] } }
```

## Default-Permissions

Jeder User kann ein Template hinterlegen, das beim Erstellen neuer Objekte als ACE-Set materialisiert wird:

```json
// users.default_permissions
[
  { "subject_type": "group", "subject": "<id_familie>", "rights": ["view","edit"], "interact_actions": ["*"] },
  { "subject_type": "authenticated", "rights": ["view"], "interact_actions": [] }
]
```

- Wird beim **Object-Create** vom Hook materialisiert — pro Eintrag eine echte ACE in `object_permissions`.
- **Nicht retroactive**: ändert man das Template, sind nur künftige Objekte betroffen.
- `owner`-Recht ist für implicit audiences nicht zulässig (würde sonst jedem Login die Rechte-Verwaltung erlauben). Wird beim Materialisieren gefiltert.

## API-Rules der `objects`-Collection

> **Immer `?=`, nie `=`, auf einer `@collection.…`-Referenz.**
>
> In einer API-Regel heisst ein nacktes `=` auf `@collection.x.feld` nicht „es
> gibt eine Zeile, die passt", sondern „**alle** Zeilen der Tabelle erfüllen
> das" (PocketBase baut daraus ein NOT-EXISTS über die ganze Tabelle). Nur die
> Fragezeichen-Operatoren `?=`, `?~`, `?!=` meinen „mindestens eine Zeile".
>
> Eine Regel in der `=`-Fassung trifft deshalb genau so lange, wie die Tabelle
> leer ist — lokal grün, in Betrieb 404. Das ist in Ajna zweimal passiert
> (Pakete 2 / 1786800000); in diesem Dokument stand bis zum 20.10. die falsche
> Fassung zum Abschreiben. Wer eine Regel in der Verwaltungsoberfläche anfasst:
> `pb_migrations/1792600000_update_rule_any_match.js` ist die Wahrheit, und
> `tests/privacy/ace-schreiben.mjs` merkt es, wenn sie wieder wandert.

So filtert PocketBase Objekt-Reads (List, View, Realtime) — der Wortlaut aus
`1788300000_audience_flags.js`:

```
owner = @request.auth.id
|| (@collection.effective_permissions.object ?= id
    && @collection.effective_permissions.user ?= @request.auth.id
    && @collection.effective_permissions.rights ?~ "view")
|| ((@request.auth.id != "" && view_auth = true)
    || (@request.auth.id = "" && view_anon = true))
```

Die beiden impliziten Zielgruppen stehen nicht mehr als Unterabfrage in der
Regel, sondern als **Spalten** `view_auth` / `view_anon` am Objekt — die Hooks
pflegen sie aus den ACEs. Das war nötig, weil eine Unterabfrage über
`object_permissions` in jeder Listenanfrage mitlief.

`updateRule` ist dieselbe Cache-Klausel mit `"edit"`, `deleteRule` mit
`"owner"` — **ohne** die Zielgruppen-Spalten: `authenticated`/`everyone`
erlauben nur Sehen, niemals Schreiben.

Die Zielgruppen-Spalten sind seit `1788300000_audience_flags.js` in der
view-Regel aktiv; die Rechnung „welche ACE macht ein Objekt öffentlich"
passiert in den Hooks, nicht in der Regel.

## UI-Workflow

Im AR-/Map-Client: Klick auf ein Objekt → "Berechtigungen" → Dialog:

- **Aktuelle ACEs** sind farbcodiert: gelb Owner, grün User-ACE, orange Group-ACE, blau implicit Audience.
- **Hinzufügen** → Subjekt-Typ + Subjekt + Rechte + Interaktionen → Speichern triggert Cache-Refresh.

### Privacy-Festlegung

`users.listRule` / `viewRule` sind strikt — jeder eingeloggte Spieler sieht nur sich selbst. Konsequenz:

- **Direkte User-zu-User-ACEs sind in der UI nicht möglich** (Dropdown wäre leer). Der Dialog blockiert die Auswahl mit Hinweis.
- Berechtigungen für andere Spieler laufen über **Gruppen** oder **implicit Audiences**.
- Member werden via **Einladungs-System** (siehe unten) in Gruppen aufgenommen, nicht durch direktes Eintragen einer User-ID.

## Einladungs-System

Damit User andere Spieler in ihre Gruppen aufnehmen können, ohne dass die privacy-strenge `users.listRule` gelockert werden muss, gibt es einen Server-vermittelten Einladungs-Flow.

### Datenmodell — `invitations` Collection

| Feld | Typ | Zweck |
|---|---|---|
| `group` | Relation → groups | Welche Gruppe |
| `group_name` | Text (Snapshot) | für Anzeige beim Empfänger |
| `inviter` | Relation → users | Einladende:r |
| `inviter_email` | Text (Snapshot) | für Anzeige beim Empfänger |
| `invitee` | Relation → users | Eingeladene:r |
| `invitee_email` | Text (Snapshot) | für Anzeige beim Inviter |
| `status` | Select: pending / accepted / declined | |

**Snapshot-Pattern**: `*_email` und `group_name` werden serverseitig beim Anlegen kopiert, damit beide Seiten den Eintrag verständlich angezeigt bekommen, ohne die jeweils andere Identität direkt aus der `users`-Collection lesen zu müssen.

### Routen

| Endpoint | Wer darf | Was passiert |
|---|---|---|
| `POST /api/groups/:id/invite` body `{ email }` oder `{ name }` | Group-Owner | Sucht User per E-Mail oder per Anzeige-Name (mit App-Privilege), legt Invitation mit `status=pending` an. 404 wenn nicht gefunden, 409 wenn schon Member, pending oder Name nicht eindeutig |
| `POST /api/invitations/:id/accept` | nur Invitee | User wird zur `groups.members` hinzugefügt, Invitation → `accepted`. Cache-Refresh läuft automatisch über die `groups.afterUpdate`-Hook |
| `POST /api/invitations/:id/decline` | nur Invitee | Invitation → `declined`, Gruppe unverändert |
| `DELETE /api/collections/invitations/records/:id` | Inviter (via Collection-Rule) | Pending-Einladung zurückziehen |

### API-Rules

| Rule | Wert |
|---|---|
| List / View | `inviter = @request.auth.id \|\| invitee = @request.auth.id` |
| Create | `false` (nur via Server-Route) |
| Update | `false` (Status-Wechsel nur via Server-Route) |
| Delete | `inviter = @request.auth.id` (Owner kann zurückziehen) |

### Client-API

Über `AjnaManager`:
```js
// E-Mail
await ajna.inviteToGroup(groupId, { email: "user@example.com" })

// Oder per Anzeige-Name (für Privacy in Spielrunden-Kontexten)
await ajna.inviteToGroup(groupId, { name: "MaxMustermann" })

const incoming = await ajna.listIncomingInvitations()
const outgoing = await ajna.listOutgoingInvitations()
await ajna.acceptInvitation(id)
await ajna.declineInvitation(id)
await ajna.cancelInvitation(id)
```

Der `GroupDialog` zeigt eingehende Einladungen oben (mit "Annehmen"/"Ablehnen") und pro eigener Gruppe die ausstehenden ausgehenden Einladungen + Cancel-Buttons.

## Selbsttest gegen eine laufende Instanz

[`tools/acl-selftest.mjs`](../tools/acl-selftest.mjs) prüft die Berechtigungs-Kette End-to-End: legt einen Wegwerf-User plus Testobjekt und eine User-ACE an und geht dann als dieser User jeden Regel-Pfad einzeln durch (Cache-Read, `view`, `edit`, ACE-Liste, ACE-Create, `delete`). Räumt das Testobjekt hinterher weg.

```bash
node tools/acl-selftest.mjs                                    # gegen AJNA_URL
AJNA_URL=http://127.0.0.1:8090 node tools/acl-selftest.mjs     # an Caddy vorbei
```

`AJNA_USER`/`AJNA_PASS` sind der Besitzer der Testobjekte; die Env wird geschichtet gelesen wie bei [`tools/ajna.mjs`](../tools/ajna.mjs).

## Aktueller Stand

- ✅ Schema: `groups`, `object_permissions`, `effective_permissions`, plus `users.default_permissions`
- ✅ Resolver mit transitiven Gruppen, Union-Logik, Implicit Audiences
- ✅ Cache-Invalidation per Hook bei jeder relevanten Änderung
- ✅ Default-Permissions beim Object-Create
- ✅ AjnaManager-API für ACE-Verwaltung
- ✅ PermissionDialog ans Backend angebunden
- ✅ Group-Management-UI (Anlegen, Members verwalten, Untergruppen)
- ✅ Einladungs-System für Gruppen-Mitgliedschaften
- ✅ Schreiben über eine ACE (`edit`), auch über Gruppen und Untergruppen — war
  bis 20.10. durch einen Operator in `objects.updateRule` blockiert (404 trotz
  korrekter Rechte, Arbeitspaket 2). Netz dagegen:
  `tests/privacy/ace-schreiben.mjs`
- ✅ `GET /api/objects/{id}/owner` — Kontaktdaten des Eintragenden über die
  Interaktion `contact`
- ✅ `move` wirkt: Lage und Drehung, sonst nichts (Hook `moveNurPosition`,
  Regel `1792900000`; Paket 2a, 22.10.)
- 🚧 Self-Leave: Member verlässt eine Gruppe selbst
- 🚧 Default-Permissions-Editor im User-Profil
- ✅ `objects.viewRule` deckt die impliziten Zielgruppen ab — über die Spalten
  `view_auth`/`view_anon`, nicht über eine Unterabfrage
- 🚧 Zyklus-Erkennung beim Hinzufügen von Sub-Groups

## Roadmap

1. **Self-Leave**: Member kann sich selbst aus einer Gruppe entfernen (Server-Route, da Member-Update sonst nur dem Owner erlaubt ist).
2. **Default-Permissions-Editor**: UI-Tab im User-Profil, damit Owner ihre Templates pflegen können.
3. ~~Implicit-Audience-Klauseln in `objects.viewRule`~~ — erledigt mit
   `1788300000_audience_flags.js`.
4. **Zyklus-Erkennung** für tiefere Sub-Group-Hierarchien (aktuell nur 1-Hop verhindert).
5. **Object-Container** für hierarchische Inheritance (Räume → Wohnungen). Optional, falls Use-Case auftaucht.
6. **Conditional Rules** ("Level ≥ 10", "Item X im Inventar") via Object-Scripting-Schicht.

Siehe [`memory/ajna-permissions-concept.md`](../.claude/projects/c--Users-abarth-Documents-Workspace-Ajna/memory/ajna-permissions-concept.md) für noch ausführlichere Architektur-Hintergründe (nur im Repo-Dev-Setup verfügbar).
