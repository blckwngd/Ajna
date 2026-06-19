# Point-and-click (wand pointing → target object)

Resolves *what the wand points at* and triggers an interaction — entirely
on-device. Combines three decoupled pieces:

- **Direction** — the wand's world-frame pointing unit-vector (BNO085 orientation
  → declination + alignment, see `docs/uwb.md` / `WizardStaffNext/PROTOCOL.md`).
- **Origin** — where the ray starts: the wand's UWB tag (`wand-origin` role),
  else the `viewer` tag, else plain GPS.
- **Objects** — Ajna objects (their world lat/lon/alt).

Privacy-first: the ray cast runs locally; only the resolved **object id** is used
for `interact(id, action)` — no raw coordinates leave the device.

## How it resolves

`client/core/PointingResolver.js` — `resolvePointingTarget({origin, direction,
objects, coneDeg, releaseDeg, maxRangeM, currentId})`:
- converts each object to local ENU metres around the origin,
- computes the angular deviation between the ray direction and the
  origin→object vector,
- picks the smallest deviation within `coneDeg` (default 12°) and `maxRangeM`
  (default 50 m), gently preferring nearer objects on ties,
- **hysteresis (tolerance):** a *new* object is only acquired inside `coneDeg`,
  while the *current* object is held until it leaves the wider `releaseDeg`
  (default `coneDeg×1.6`). This absorbs orientation/position noise and stops
  flicker at the cone edge.
- returns `{ id, angleDeg, distanceM }` or `null`.

**Visibility:** only objects that pass the active filter are considered.
`WandManager` filters `ajna.objectMap` by an `isVisible(record)` predicate; the
AR client passes `agentFilters.matches` (the same predicate that decides scene
visibility), so the wand can only target what the user can actually see.

`WandManager`:
- `resolveTarget()` — current pointed-at object (direction + `getOrigin()` +
  visible `ajna.objectMap`, with hysteresis).
- `onTarget(cb)` — fires when the pointed-at object **changes**; payload
  `{id, name, angleDeg, distanceM}` or `null` on focus loss.
- `onInteraction(cb)` — fires when an action is triggered: `{action, id, name, pointed}`.
- on a wand button/gesture, `_interactTarget()` uses the pointed-at object,
  falling back to nearest-by-distance when no orientation is available
  (e.g. pointing mode `disabled`).

## AR highlight + audio cues

In the AR client (`client/main.js`) the wand's `onTarget` drives the existing
`setHighlight(go, on)` — the pointed-at mesh is highlighted, the previous one
cleared. Bind/unbind the wand at runtime with `window.ajnaWandConnect()` /
`window.ajnaWandDisconnect()` (native only).

`client/core/WandAudioFeedback.js` adds optional spoken/audible cues, toggled in
the in-app menu (Settings → Geräte → „Audio-Hinweise", persisted in
localStorage, honoured on both pages):
- new object focused → **TTS speaks its name**,
- action triggered → **TTS speaks the action's name** (German labels for the
  generic wand actions; override via constructor),
- focus lost (no object) → a **discreet Web-Audio tone**; if Web Audio is
  unavailable it falls back to **TTS „aus"**.

Wire the origin to the wand's UWB tag, e.g.:
```js
new WandManager({
  ajna,
  getOrigin: () => uwb.positionFor('wand-origin') || uwb.positionFor('viewer') || window.ajnaGeo?.position,
  pointing: { coneDeg: 12, maxRangeM: 50 }
})
```

## Pointing modes (incl. power saving)

Set via the app config (Settings → Geräte → Zeige-Modus) or later wand buttons;
the wand applies the mode and echoes it back:

| Mode | Meaning |
|---|---|
| `pointer` | forward = staff long axis (point the tip) |
| `walkingstick` | staff ~vertical, forward = horizontal heading |
| `auto` | switch by staff tilt (hysteresis 40°/50°) |
| `disabled` | **stop the BNO085 report — power saving**; no orientation, target falls back to nearest |

## Shared instance (AccessoryHub)

The wand, the UWB hub, the audio-feedback **and the GPS/UWB position source**
live in **one shared instance** per page — `client/core/AccessoryHub.js`
(`getAccessoryHub({ ajna })`). It is stashed on `window`, because the views are
separate webpack bundles and a module-level singleton would be duplicated per
bundle; `window` is how the project already shares `window.ajna`. Consequences:
- map + mobile bundles (same page) reuse one wand/UWB → no double BLE connection.
- the AR client (separate page today) creates its own hub; when AR later moves
  into the shell it transparently reuses the same hub.
- the hub owns the cross-cutting wiring: audio cues on the wand, the ray origin
  (UWB `wand-origin`→`viewer`→shared position), and **`wand.isVisible` defaults to
  `window.agentFilters.matches`** so pointing respects the active filter in every
  view. Each view attaches its own context — AR sets `wand.getName` and the
  highlight `onTarget`.

**Shared position (#3):** the hub owns one `GPSProvider` + `FusedPositionSource`
(`hub.gps`, `hub.positionSource`). The AR camera and the **map marker** both
render from it (`MapGpsControl` accepts `positionSource`), so map and AR show the
same UWB-corrected position. `AjnaManager` is already shared via `window.ajna`.

**Shared filter (#4):** `AgentFilters` persists its selection in localStorage
(`ajna.layer_filters`) and is exposed as `window.agentFilters`; the wand/pointing
consult it, so what you can target matches what each view shows.

## Auto-declination (true north)

The wand reports orientation relative to **magnetic** north; pointing at world
objects needs **true** north. The hub computes magnetic declination from the
on-device position via the **World Magnetic Model (WMM2025)** and applies it to
the wand's pointing vector (`wand.setDeclinationDeg`). Fully **offline**:

- `client/core/geomag/wmm2025.js` — coefficients auto-generated from NOAA's
  official `WMM_2025.COF` (degree 12, valid 2025–2030).
- `client/core/geomag/WorldMagneticModel.js` — spherical-harmonic synthesis;
  `wmm.declination(lat, lon, altKm, decimalYear)`.
- Validated against NOAA's official WMM2025 test values (all 100 within ~0.005°);
  regression test `client/core/geomag/wmm.test.mjs` (`node …/wmm.test.mjs`).

The hub recomputes only when the position moves enough (~2 km) — declination
varies slowly. A residual `wand.setAlignmentDeg` offset can still correct any
mounting/frame bias on top of declination.

## Pointing-ray visualisation

When orientation + origin are available, the ray is drawn from the origin along
the pointing direction (length = `wand.maxRangeM`), updated each orientation
frame and removed when unavailable (e.g. pointing mode `disabled`):
- **AR** (`main.js`): a Babylon `CreateLines` segment in the scene.
- **Map** (`map.js`): a Leaflet polyline (shared wand via the hub).
Endpoint helper: `rayEndpointWgs84(origin, direction, rangeM)` in PointingResolver.

## Known limitations (slice scope)

- Single-target cone pick; no occlusion/precedence beyond angle+distance.
- Needs orientation calibration (staff axis) + frame alignment/declination for
  accuracy; without UWB the origin is the phone/GPS (origin offset grows the
  near-field error).
- Continuous target resolution runs at the orientation rate (~20 Hz) over
  `objectMap`; fine for modest object counts, add spatial indexing if needed.
