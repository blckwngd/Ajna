# SLAM-PoC — Spike-Schritt 1

Beantwortet die eine entscheidende Frage aus [docs/visual-tracking.md](../../../docs/visual-tracking.md):

> **Läuft die 8th-Wall-Engine im (Capacitor-)WebView und liefert sie eine 6DoF-Pose?**

Alles Weitere (Geo-Alignment, Babylon-Integration, UWB-Snap) ist erst sinnvoll,
wenn das hier grün ist. Fällt es durch, ist der SLAM-Weg für euren WebView tot —
dann bleibt UWB die cm-Lösung für präparierte Bereiche (Abbruchkriterium aus dem
Design-Dok).

> **Hinweis:** Ich (Assistent) kann das nicht ausführen — der Test ist per
> Definition eine Geräte-/WebView-Verifikation. Diese Seite ist das Harness;
> unten steht, was ihr zum Ausführen tun müsst.

## 1. Engine besorgen und `ENGINE_URL` setzen

8th Wall ist seit Feb 2026 Open Source; die gehostete Cloud ist weg → **selbst
hosten**. Die Runtime-API ist die stabile `XR8`-API (unverändert); nur der Bezug
der `xr.js` hat sich geändert. Zwei Wege:

- **Distributed Engine Binary** (enthält SLAM): <https://8th.io/xrjs>. Prüfen, ob
  direkt als `<script src>` ladbar oder erst herunterladen + selbst ausliefern.
- **Aus dem Quellcode bauen**: <https://github.com/8thwall/8thwall> →
  `packages/engine` (die README dort ist ein Build-/Serve-Guide). Ergebnis:
  eine `xr.js`, die ihr ausliefert.

**Empfehlung: unter EUREM Origin hosten** (z. B. `client/poc/slam/engine/xr.js` →
Caddy liefert `/poc/slam/engine/xr.js`). Dann keine CSP-/Cross-Origin-Probleme im
WebView. Danach in [`index.html`](./index.html):

```js
const ENGINE_URL = '/poc/slam/engine/xr.js'
```

## 2. Ausliefern + öffnen

Die Seite liegt unter `client/poc/slam/` → Caddy liefert sie unter
`https://<host>/poc/slam/`. **HTTPS ist Pflicht** (`getUserMedia` braucht einen
Secure Context) — Caddy erfüllt das.

Testet in **dieser Reihenfolge** (isoliert „Engine" von „WebView"):

1. **Mobiler Chrome** (`https://<host>/poc/slam/`): funktioniert die Engine
   überhaupt auf dem Gerät? Chrome fragt die Kamerafreigabe normal ab.
2. **Im Capacitor-WebView** (der eigentliche Test): dieselbe URL in der App
   öffnen. Der Android-System-WebView ist restriktiver als Chrome — genau das
   wollen wir wissen.

## 3. Die zwei wahrscheinlichen Stolpersteine im WebView

- **Kamerafreigabe.** Der Capacitor-WebView blockt `getUserMedia` per Default.
  Nötig ist (a) `<uses-permission android:name="android.permission.CAMERA"/>` im
  `AndroidManifest.xml` und (b) dass der WebView `onPermissionRequest` behandelt
  und `request.grant(...)` aufruft. Das ist selbst Teil des Befunds: zeigt Chrome
  das Bild, aber der WebView nicht, ist es DIESES Thema (per Capacitor-Config
  lösbar) — kein Engine-Dealbreaker.
- **WASM-Threads / Cross-Origin-Isolation.** Nutzt die Engine `SharedArrayBuffer`
  (WASM-Threads), braucht die Seite die Header
  `Cross-Origin-Opener-Policy: same-origin` und
  `Cross-Origin-Embedder-Policy: require-corp` (in der Caddyfile für `/poc/slam/*`
  setzen). Symptom sonst: Engine lädt, aber Tracking startet nicht / bricht ab.

## 4. Was ihr seht — Pass/Fail

Die Seite zeigt oben ein HUD (Tracking-Status, Position, Rotation, FPS, „seit
Start bewegt") und unten eine Status-Zeile.

| Beobachtung | Bedeutung |
|---|---|
| Kamerabild + **Tracking: NORMAL** + **Position ändert sich**, v. a. „seit Start bewegt" steigt bei kleiner **Seitwärtsbewegung** | ✅ **PASS.** SLAM läuft im WebView und erfasst genau die Translation, die GPS nicht kann → weiter mit Spike-Schritt 2 (verankerter Würfel in Babylon). |
| Läuft in Chrome, aber im WebView kein Bild / „XR8 nicht definiert" | ⚠ **WebView-Konfig** (Kamerafreigabe / COOP-COEP / CSP), nicht die Engine. Lösbar — Punkt 3. |
| `XR8 nicht definiert` auch in Chrome, oder Engine-Script lädt nicht | ❌ Engine-Bezug/URL falsch — Punkt 1. |
| Engine lädt, aber **nie** eine Pose / Tracking bleibt `LIMITED` | ❌ Kern-Risiko: SLAM startet im WebView nicht. Wenn auch nach COOP/COEP + Kamerafreigabe kein Pose-Stream → **Abbruchkriterium erreicht.** |

## 5. Wenn PASS: der nächste Schritt

Spike-Schritt 2 (visuell verankerter Test-Würfel) — dafür kommt eine dünne
three.js- bzw. Babylon-Anbindung dazu (`XR8.Threejs.pipelineModule()` bzw. ein
Pose-Shim in Babylon), ein weltfester Würfel, und der Sicht-Test „bleibt er beim
Umhergehen an seinem Platz?". Das baue ich, sobald diese Seite bei dir grün ist.

## Was hier bewusst NICHT drin ist

Kein Geo-Alignment, kein Ajna-Code, kein verankertes Objekt — nur die nackte
Frage „läuft die Engine + Pose im WebView?". So scheitert der Test nicht aus dem
falschen Grund. Die `XR8`-API-Aufrufe (`XrController.configure`,
`addCameraPipelineModules`, `GlTextureRenderer`) sind die stabile, dokumentierte
Schnittstelle — falls der Open-Source-Build davon abweicht, meldet das HUD den
Fehler (z. B. „XR8.GlTextureRenderer undefined"), und wir passen an.
