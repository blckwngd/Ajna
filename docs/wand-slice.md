# Magic Wand — vertical slice (end-to-end)

This documents the first end-to-end slice that wires the BLE "magic wand" into
Ajna. It proves the whole chain:

```
button on wand → BLE (NUS) → Android foreground service → WandPlugin (native)
   → WandManager.js → ajna.interact(objectId, action) → wand-agent (backend)
   → object.animation_state changes → Realtime → all clients see it
```

Wand and UWB are independent features: the wand works **without** UWB, and UWB
positioning will work **without** the wand. This slice is wand-only.

## Pieces added

| Layer | Path | Purpose |
|------|------|---------|
| Firmware | `WizardStaffNext/` (separate repo) | BLE peripheral, NUS, JSON events, offline LED |
| Native (Java) | `android/app/src/main/java/de/blckwngd/ajna/accessory/` | `WandPlugin` + foreground `AccessoryBleService` + `WandGatt` |
| Manifest | `android/app/src/main/AndroidManifest.xml` | BLE permissions + service + foreground type |
| Registration | `android/app/.../MainActivity.java` | `registerPlugin(WandPlugin.class)` |
| JS glue | `client/core/WandManager.js` | wand event → privacy-local target resolve → `interact()` |
| UI | `client/core/MobileShell.js` | "Zauberstab verbinden" in Settings → Geräte |
| Backend | `agents/wand-agent.mjs` | authoritative reaction; toggles `animation_state` |

The BLE protocol (UUIDs, message shapes) is documented in
`WizardStaffNext/PROTOCOL.md` — both sides must stay in sync.

## Architecture notes

- **Privacy-first:** `WandManager` resolves the *nearest object* to the
  on-device GPS position locally and sends only `interact(id, action)`. No raw
  coordinates are uploaded. (Without a GPS fix it falls back to the first object
  so the slice still demonstrates the chain.)
- **Screen-off:** BLE runs in `AccessoryBleService`, a foreground service with a
  persistent notification + partial wake lock — the WebView alone would be
  suspended when backgrounded.
- **Offline:** the wand toggles its own LED locally on every press regardless of
  connection; `interact()` failures (offline / not logged in) are caught.

## Run it

### 1. Backend + agent
```bash
# from the Ajna repo root
npm run stack            # PocketBase + webpack + express + caddy
# in another terminal — needs a dedicated agent user:
AJNA_USER=agent@example.com AJNA_PASS=secret npm run wand-agent
```
The agent creates a "Zauberstab-Ziel" object (idempotent) and grants every
logged-in user the `wand_*` interact actions on it.

### 2. Android app
```bash
npm run mobile:sync      # webpack + cap sync android
npm run mobile:run       # build + deploy to a connected device/emulator
# or: npm run mobile:open  → run from Android Studio
```
- Requires a **physical device** with Bluetooth (emulators have no BLE).
- On first connect, Android asks for the Bluetooth (and location, pre-API-31)
  permissions.

### 3. Pair & test
1. Power the wand (advertises as `WizardStaff`).
2. In the app: **Einstellungen → Geräte → „Zauberstab verbinden"**.
   The persistent "Ajna · Zubehör aktiv" notification appears.
3. Log in (Einstellungen → Zugang) so `interact()` is permitted.
4. Press a wand button:
   - the wand's on-board LED toggles (local, offline-capable),
   - the `wand-agent` logs `⚡ wand_press` and flips the target object's
     `animation_state` — visible on the Map/AR clients in realtime.

## Known limitations (slice scope)

- Plugin is written in **Java** (not Kotlin) to avoid adding the Kotlin Gradle
  toolchain to the existing Java-only Capacitor project. Functionally identical;
  can be ported later.
- Target resolution is nearest-object by GPS; true point-and-click (IMU ray)
  comes with the UWB/heading phase.
- No device-management UI yet (single hard-coded wand name `WizardStaff`).
- iOS not covered (no iOS platform in the project; would need a Swift plugin).
