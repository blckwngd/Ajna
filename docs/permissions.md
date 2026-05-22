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
| `move` | Nur Position (`lat`/`lon`/`altitude`) änderbar |
| `owner` | Darf ACEs verwalten (Eigentümer-Recht). Nur für `user`/`group`-Subjekte zulässig |

`interact_actions` ist ein eigenes Set: erlaubte Action-Keys wie `["attack","pet"]` oder `["*"]` für alles. Wird in `/api/objects/:id/interact` gegen den Action-Parameter geprüft.

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

So filtert PocketBase Objekt-Reads (List, View, Realtime):

```
owner = @request.auth.id
|| (@collection.effective_permissions.object = id
    && @collection.effective_permissions.user = @request.auth.id
    && @collection.effective_permissions.rights ?~ "view")
```

`updateRule` analog mit `"edit"`. Für Implicit Audiences ist die Rule um zwei zusätzliche Klauseln zu erweitern:

```
|| (@request.auth.id != ""
    && @collection.object_permissions.object = id
    && (@collection.object_permissions.subject_type = "authenticated"
        || @collection.object_permissions.subject_type = "everyone")
    && @collection.object_permissions.rights ?~ "view")
|| (@request.auth.id = ""
    && @collection.object_permissions.object = id
    && (@collection.object_permissions.subject_type = "anonymous"
        || @collection.object_permissions.subject_type = "everyone")
    && @collection.object_permissions.rights ?~ "view")
```

Aktueller Stand: die Rule deckt nur Owner + Cache ab. Die Implicit-Audience-Klauseln werden ergänzt, sobald die UI Audience-ACEs sauber pflegen kann.

## UI-Workflow

Im AR-/Map-Client: Klick auf ein Objekt → "Berechtigungen" → Dialog:

- **Aktuelle ACEs** sind farbcodiert: gelb Owner, grün User-ACE, orange Group-ACE, blau implicit Audience.
- **Hinzufügen** → Subjekt-Typ + Subjekt + Rechte + Interaktionen → Speichern triggert Cache-Refresh.

### Privacy-Festlegung

`users.listRule` / `viewRule` sind strikt — jeder eingeloggte Spieler sieht nur sich selbst. Konsequenz:

- **Direkte User-zu-User-ACEs sind in der UI nicht möglich** (Dropdown wäre leer). Der Dialog blockiert die Auswahl mit Hinweis.
- Berechtigungen für andere Spieler laufen über **Gruppen** oder **implicit Audiences**.
- Für direkte Sichtbarkeit zwischen zwei spezifischen Spielern: geplantes **Friends-/Invitation-System**.

## Aktueller Stand

- ✅ Schema: `groups`, `object_permissions`, `effective_permissions`, plus `users.default_permissions`
- ✅ Resolver mit transitiven Gruppen, Union-Logik, Implicit Audiences
- ✅ Cache-Invalidation per Hook bei jeder relevanten Änderung
- ✅ Default-Permissions beim Object-Create
- ✅ AjnaManager-API für ACE-Verwaltung
- ✅ PermissionDialog ans Backend angebunden
- 🚧 Group-Management-UI (Anlegen, Members verwalten)
- 🚧 Default-Permissions-Editor im User-Profil
- 🚧 Friends-/Invitation-System
- 🚧 `objects.viewRule` mit Implicit-Audience-Klauseln (siehe oben)
- 🚧 Zyklus-Erkennung beim Hinzufügen von Sub-Groups

## Roadmap

1. **Group-Management-UI**: Owner kann Gruppen anlegen, Members hinzufügen (per User-ID, später Friend-Lookup).
2. **Default-Permissions-Editor**: UI-Tab im User-Profil.
3. **Friends/Invitation-System**:
   - User A schickt Einladung an `email@example.com` → Server-Hook prüft, ob ein User mit der E-Mail existiert, legt einen Invitation-Record an.
   - User B akzeptiert → beide werden "friends", können einander in `users`-Lookups finden (mit `emailVisibility`-Bool).
4. **Implicit-Audience-Klauseln** in `objects.viewRule` aktivieren.
5. **Object-Container** für hierarchische Inheritance (Räume → Wohnungen). Optional, falls Use-Case auftaucht.
6. **Conditional Rules** ("Level ≥ 10", "Item X im Inventar") via Object-Scripting-Schicht.

Siehe [`memory/ajna-permissions-concept.md`](../.claude/projects/c--Users-abarth-Documents-Workspace-Ajna/memory/ajna-permissions-concept.md) für noch ausführlichere Architektur-Hintergründe (nur im Repo-Dev-Setup verfügbar).
