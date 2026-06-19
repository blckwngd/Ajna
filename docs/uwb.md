# UWB precise positioning (independent subsystem)

Centimetre-accurate positioning for the AR view, **decoupled from the wand**:
UWB works without a wand, the wand works without UWB, and a wand with an
integrated UWB node is just a special case (two drivers, possibly one device).

Privacy-first: the position is computed and used **on-device**. Only resolved
interactions ever reach the server — raw coordinates never do.

## Positioning model

**Model A (implemented):** the DWM1001's onboard Location Engine computes the
tag position; we read it over BLE and align the DWM-local frame to the world
using anchors stored in Ajna (needs each anchor's DWM-local coord + world pos).

**Model B (implemented):** on-device multilateration from the raw ranges. The
native plugin streams `uwbDistances` (mode 2); `UwbManager` (mode `'ranging'`)
matches each range's `nodeId` to its Ajna anchor's **world** position and solves
the tag position with `UwbMultilateration.js` (linearized least-squares +
Gauss-Newton refine). **Auto 2D/3D:** 3D (E,N,U) when ≥4 anchors with vertical
spread (≥0.5 m), else 2D (≥3 anchors, tag in the anchor plane). NOTE the PANS cap:
a tag ranges to at most **4 anchors** per epoch → 3D is exactly determined
(little redundancy → quality-gate ranges, watch GDOP). The anchors' world positions ARE
the frame → the result is directly WGS84, no alignment transform, and the
anchors' DWM-local coords are NOT needed. Validated by
`client/core/UwbMultilateration.test.mjs` (exact with clean ranges; ~2.5 cm at
±5 cm range noise). Switch at runtime via `uwb.setMode('ranging')` or the
Settings → Geräte → "UWB-Modell" selector (persisted as `ajna_uwb_model`).

> Anchor setup difference: Model B still needs the anchors **enrolled in a PANS
> network** (anchor role + shared network ID, via the DRTLS app) so the tag can
> range to them — but it does NOT need their positions configured in the DWM
> network. Ajna is the single position authority (anchors are objects with
> `state.uwb.nodeId` + world lat/lon/alt). Arbitrary non-PANS UWB devices can't
> be used without a custom ranging stack.

### IMU/UWB fusion (moving tags)

`PositionFilter.js` fuses the low-rate, noisy UWB fix with the tag's high-rate
IMU into a smooth, higher-rate world position. The IMU lives **only on the
moving tags** (the wand carries a BNO085); anchors are static and need none.

- The wand streams **gravity-removed linear acceleration** (BNO085
  `SH2_LINEAR_ACCELERATION`), rotated body→world on-device with the same
  quaternion as the pointing vector. `WandManager` then applies the identical
  declination+alignment yaw, so the accel lands in the **same AR/UWB ENU frame**
  as the UWB position (orientation event field `la`, snapshot field `accel`).
- The filter is a **constant-velocity Kalman filter**, E/N/U decoupled (three
  1-D filters), with the IMU accel as the prediction (control) input and the UWB
  fix as the measurement. Benefits: smoother + higher-rate output,
  **dead-reckoning across UWB gaps**, and a **χ²(3 dof, 99%) outlier gate** that
  drops a UWB fix disagreeing too much with the predicted state.
- `AccessoryHub` wires it for the **`wand-origin`** role (UWB fix +
  `wand.onOrientation` accel) and feeds the fused result as the pointing-ray
  origin (`wand.getOrigin`, used when fresh < 2 s; raw UWB otherwise). The
  `viewer` tag has no IMU stream and keeps using raw UWB.
- Validated by `client/core/PositionFilter.test.mjs` (~34 % lower RMS than raw
  UWB on a synthetic trajectory; injected 5 m outlier rejected, no state jump).
  Tunables: `accelNoise` (≈1.5 m/s² default), `measNoise` (≈0.15 m), `gateChi2`.

```
DWM1001 tag → BLE (Network Node Service) → UwbPlugin (native, parses Location Data)
   → uwbPosition (DWM-local mm) → UwbManager.js
   → align with Ajna anchors (world lat/lon + DWM-local coord) → world position
   → AR view / debug   (NOT uploaded)
```

## DWM1001 BLE (verified against the Qorvo/LEAPS PANS BLE doc)

Network Node Service `680c21d9-c946-4c1f-9c11-baa1c21329e7`, **little-endian**.

| Characteristic | UUID | Use |
|---|---|---|
| Location Data | `003bbdf2-c634-4b3d-ab56-7ec889b89a37` | Notify: position and/or ranges |
| Location Data Mode | `a02b947e-df97-4516-996a-1882521e0ead` | `0`=pos, `1`=dist, `2`=both (we set `2`) |
| Operation Mode | `3f0afd88-7770-46b0-b5e7-9fc099598964` | tag/anchor, UWB on, **BLE bit**, Location-Engine bit |
| Update Rate | `7bd47f30-5602-4389-b069-8305731308b6` | 2×uint32 ms (moving / stationary) |
| Device Info | `1e63b1eb-d4ed-444e-af54-c1e965192501` | incl. Node ID |
| Anchor List | `5b10c428-af2f-486f-aee1-9dbd79b6bccb` | visible anchors |

**Location Data layout:** `[type:uint8]` then
- type 0/2 → position: `int32 x, int32 y, int32 z` (**mm**) + `uint8 quality`
- type 1/2 → distances: `uint8 count`, then per anchor `uint16 nodeId, int32 dist(mm), uint8 quality`

> The spec's "TLV tag 0x41" is the **UART/SPI** API, not the BLE characteristic —
> over BLE the layout above applies. Position is **mm**, not cm.

## Anchors in Ajna

Anchors are modelled as normal objects (no schema change):

```
type             = "uwb_anchor"
lat / lon / altitude = exact world position
state.uwb        = { nodeId: <uint16>, local: { x, y, z },     // DWM-local coords, mm
                     network?: <panId> }                       // PANS network membership
```

### Shared PANS networks (collaborative anchors)

A **PANS network** can be published as its own Ajna object so several people add
anchors to the SAME network through Ajna's normal object permissions — no extra
auth code, the ACL *is* the sharing model:

```
type              = "uwb_network"
state.uwb_network = { networkId: <panId> }   // the PAN id, as entered in the DRTLS app
```

- Each `uwb_anchor` references its network via `state.uwb.network` (= the same
  PAN id). `UwbManager` filters positioning to the **active** network
  (`uwb.setNetwork(panId)` / Settings → „UWB-Netz"; persisted `ajna_uwb_network`;
  `null` = every anchor, back-compatible with single-network setups).
- **Sharing = Ajna permissions on the network object:** grant `view` to *use* it
  and `edit` to *contribute* anchors (`authenticated`, a `group`, or named
  `user`s — via the standard permission dialog / „Netz teilen"). Realtime sync
  pushes new anchors to everyone instantly.
- Only the network METADATA + anchor map is shared. The **radio enrollment**
  (anchor role + this PAN id in the DRTLS app) still happens per device; Ajna is
  the position authority, not the radio config. So others read the `networkId`
  from Ajna, flash their physical anchor with it, then register the Ajna
  `uwb_anchor` (in-app „Anker hier anlegen" uses the current position, or
  `npm run uwb-anchors` with the networked JSON — see
  `uwb-anchors-network.example.json`).

`UwbManager` reads every `uwb_anchor` object, converts each anchor's world
position to local ENU metres and pairs it with its DWM-local coordinate, then
solves a least-squares 2D rigid transform (rotation about vertical + translation,
vertical as mean offset). **≥ 2 anchors** with a `state.uwb.local` are required;
3+ non-collinear is recommended. Assumes DWM local (x,y) is horizontal, z up;
full 3D/SVD alignment can replace it later.

### Seed anchors
```bash
cp uwb-anchors.example.json uwb-anchors.json   # edit to your deployment
AJNA_USER=agent@example.com AJNA_PASS=secret npm run uwb-anchors
```
Idempotent over `state.uwb.nodeId` (re-run to update positions).

## Device prerequisites (model A)

Configure the DWM1001 nodes once (e.g. with the Qorvo DRTLS Android app):
- Anchors: set as **anchor**, give each its position **in the DWM network**, note
  its **Node ID** → use the same Node ID + the matching world lat/lon in
  `uwb-anchors.json`.
- The mobile node (tag connected to the phone): set as **tag**, **UWB active**,
  **BLE enabled**, **Location Engine enabled**.

## App usage

Settings → Geräte → **„UWB verbinden"** (scans for a node whose name starts with
`DW`). The shared "Ajna · Zubehör aktiv" foreground notification shows
`UWB: verbunden`. The Debug section shows the resolved world position once ≥ 2
anchors are known and a fix arrives.

Programmatically (role-aware hub — connect one node per role):
```js
const uwb = new UwbManager({ ajna })
uwb.onPosition('viewer', p => { /* p.lat, p.lon, p.altitude, p.local{E,N,U}, p.quality, p.role */ })
await uwb.connect({ role: 'viewer', name: 'DW' })   // also: 'wand-origin', 'wand-tip'
// uwb.positionFor(role) · uwb.roleSource(role) · uwb.getWandRay()
```

## AR integration (camera follows UWB when available)

The AR client (`client/main.js`) feeds positioning through
`FusedPositionSource(gps, uwb)` — a drop-in with the same interface as
`GPSProvider`, so `PlayerGPSComponent` is unchanged. While a recent,
good-quality UWB fix exists it overrides GPS (no jitter); on staleness GPS
resumes. With no UWB node it is a pure GPS passthrough.

UWB is **not auto-connected** in AR (avoids surprise BLE/permission prompts).
Bind/unbind a node at runtime:
```js
await window.ajnaUwbConnect({ name: 'DW' })   // native app only; no-op on web
window.ajnaUwbDisconnect()
```
With `DEBUG_WORLD`, `window.uwb` and `window.positionSource` are exposed
(`positionSource.activeSource` → `'uwb' | 'gps' | null`, `positionSource.quality`
→ UWB quality factor). The world origin is still bootstrapped from the first fix
(GPS or UWB); UWB lat/lon are absolute (from on-device anchor alignment), so they
share the same local frame.

**Smoothing & quality:** the player position is fed through `PositionSmoother`
in `PlayerGPSComponent` and sampled per frame, so low-rate/jumpy fixes and
source switches render smoothly (snaps if a fix is older than 1.5 s). UWB fixes
below `minQuality` (default 1, i.e. quality 0) are dropped in
`FusedPositionSource`. A small on-screen badge (top-left) shows the active
source and UWB quality so it is obvious which source the camera follows.

## Native pieces

| Path | Purpose |
|---|---|
| `android/app/.../accessory/UwbGatt.java` | DWM1001 BLE driver, parses Location Data |
| `android/app/.../accessory/UwbBridge.java` | service ↔ plugin event bus |
| `android/app/.../accessory/UwbPlugin.java` | Capacitor plugin `Uwb` |
| `android/app/.../accessory/AccessoryBleService.java` | shared foreground service (wand + UWB, independent) |
| `client/core/UwbManager.js` | positioning provider + anchor alignment |
| `agents/uwb-anchors.mjs` | seed/update anchors in Ajna |

## Role-based multi-node (implemented)

The AR viewer (phone) and the wand controller have different pose needs and
cannot be served accurately by one module (variable hand/arm offset). The
positioning layer carries **N independent UWB tags with named roles**, each its
own BLE connection, all sharing the one anchor→world transform:

| Role | Carried by | Feeds |
|---|---|---|
| `viewer` | phone / body | AR camera global position (corrects ARKit/ARCore drift) |
| `wand-origin` | wand | pointing-ray origin |
| `wand-tip` | wand (optional) | pointing direction (magnetometer-free option) |

So "1 module vs 2 modules" is a band-fitting choice, not an architecture change.
Connect a node per role: `uwb.connect({ role, name })`; the AR camera consumes
`uwb.roleSource('viewer')`. Every native event (`uwbStatus`/`uwbPosition`/
`uwbDistances`) carries its `role`; `AccessoryBleService` holds one `UwbGatt`
per role; the shared anchor transform is applied to each role's local position.
`uwb.getWandRay()` returns the wand ray once the wand roles are connected.

## Future (decided, not yet implemented)

**AR camera pose** is primarily ARKit/ARCore (visual-inertial 6DoF incl.
orientation); the `viewer` UWB role only anchors/corrects global position — UWB
gives position, not orientation.

**Wand heading** (RP2040 has no magnetometer): **decided → add an external
magnetometer to the wand** (true 9DOF, classic fusion). The firmware will gain a
magnetometer driver. (`getWandRay()` already supports the magnetometer-free
two-tag alternative if ever wanted.)

**Phone-integrated UWB** is not a substitute for the external module under the
DWM1001/PANS scheme (Apple Nearby Interaction / Android FiRa only range to
compatible UWB devices, not a PANS anchor network). It becomes viable only if the
hardware later moves to FiRa-compatible Qorvo modules (DWM3001C/QM33).

## Known limitations (slice scope)

- Model A + model B (multilateration, 2D/3D) + IMU/UWB fusion all implemented;
  validated only in unit tests — on-device accuracy still needs measurement.
- Model A uses 2D rigid alignment (z as offset) — fine for coplanar anchors;
  3D/SVD later. (Model B already solves 3D directly when anchors have height.)
- DWM1001 (legacy). Newer Qorvo modules (DWM3001C/QM33) can be added as a sibling
  driver emitting the same events; their BLE/API differs and must be verified.
- AR uses UWB via `FusedPositionSource` (priority over GPS). Heading/orientation
  still comes from the device sensors — UWB gives position, not bearing.
