import { GeospatialComponent } from "./components/GeospatialComponent.js"
import { TransformComponent } from "./components/TransformComponent.js"
import { NetworkSyncComponent } from "./components/NetworkSyncComponent.js"
import { PositionSmoother } from "../core/PositionSmoother.js"
import { ENC_STYLE, encCategory } from "../core/wifiStyle.js"
import { appearanceOf, arViewOf, gltfUrlOf } from "../core/Appearance.js"

// Ziel-Welthöhe (Meter) pro Modell-Datei. Manche GLBs (three.js-Tiere, der
// Khronos-Fox) sind in Eigen-Einheiten riesig → ohne Normierung füllen sie die
// halbe Szene. Nach dem Laden wird das Modell auf diese Höhe skaliert (das
// Record-`scale` wirkt weiterhin als Multiplikator obendrauf). Nicht gelistete
// Modelle bleiben unverändert (1:1). Werte sind bewusst einfach justierbar.
const MODEL_TARGET_HEIGHT = {
  "Fox.glb": 0.6,
  "Horse.glb": 1.7,
  "Flamingo.glb": 1.3,
  "Stork.glb": 1.1,
  "Parrot.glb": 0.35,
}

export class GameObject {

  constructor(scene, id) {
    this.scene = scene
    this.id = id

    // Neutraler Transform-Node als Wrapper
    this.root = new BABYLON.TransformNode(`go_${id}`, scene)

    this.meshes = []
    this.animationGroups = []
    this.components = []

    // Frameweise Glättung von eingehenden Realtime-Updates. Bewegt sich
    // ein Objekt mit niedriger Update-Rate (z. B. der 5-Hz-Fox-Walk-
    // Agent), würde es sonst ruckartig springen. Der Smoother lerpt
    // jeden Frame zwischen prev und curr — bei einer Lücke > 500 ms
    // wird gesnappt (siehe PositionSmoother).
    this._smoother = new PositionSmoother()
  }

  // Factory-Methode zum Erstellen eines GameObjects mit Standard-Komponenten.
  // Modell-Loading geschieht IM HINTERGRUND und unabhängig — die Factory
  // selbst kehrt synchron mit einem Platzhalter-Würfel zurück. Sobald (und
  // falls) das Modell verfügbar ist, ersetzt es den Platzhalter. Bei Fehler
  // oder ungültiger URL bleibt der Würfel stehen.
  static async createFromPBData(scene, data, geo, includeNetworkSync = false) {
    const go = new GameObject(scene, data.id)
    // Anzeige-Name aus dem PB-Record übernehmen — wird nur in Debug-UI
    // verwendet, gehört nicht zur Engine-Logik. Fallback auf id.
    go.name = data.name || data.id
    go.loadFromData(data, geo)

    // Geospatial Component — Höhen-Referenz aus state.altitude_ref
    // ('msl' = über Normalnull, sonst 'ground' = über Boden, Default).
    go.addComponent(
      new GeospatialComponent(
        geo,
        data.lat,
        data.lon,
        data.altitude ?? 0,
        data.state?.altitude_ref === 'msl' ? 'msl' : 'ground'
      )
    )

    // Transform Component
    go.addComponent(
      new TransformComponent(
        new BABYLON.Vector3(
          data.rotation?.x ?? 0,
          data.rotation?.y ?? 0,
          data.rotation?.z ?? 0
        ),
        new BABYLON.Vector3(
          data.scale?.x ?? 1,
          data.scale?.y ?? 1,
          data.scale?.z ?? 1
        )
      )
    )

    // Network Sync Component (optional)
    if (includeNetworkSync) {
      go.addComponent(new NetworkSyncComponent())
    }

    // Reverse-Lookup für Pointer-Picking / Hover-Tooltips. Zunächst nur
    // der Placeholder; #loadModel taggt später auch die importierten Meshes.
    go.#tagMeshes()

    return go
  }

  loadFromData(data, geo) {

    const position = geo.toLocalRef(
      data.lat,
      data.lon,
      data.altitude ?? 0,
      data.state?.altitude_ref === 'msl' ? 'msl' : 'ground'
    )

    const rotation = new BABYLON.Vector3(
      data.rotation?.x ?? 0,
      data.rotation?.y ?? 0,
      data.rotation?.z ?? 0
    )

    const scaling = new BABYLON.Vector3(
      data.scale?.x ?? 1,
      data.scale?.y ?? 1,
      data.scale?.z ?? 1
    )

    this.root.position = position
    this.root.rotation = rotation
    this.root.scaling = scaling

    // Initial-Animation für den Fall, dass die GLB mehrere AnimationGroups
    // mitbringt — wird im #loadModel-Callback gestartet. applyData(...)
    // wechselt sie später live.
    this._initialAnimationState = data.animation_state || null

    // Object-Type bestimmt die Platzhalter-Optik (siehe #createPlaceholder).
    // Wird vom Agent über das `type`-Feld gesetzt — z. B. "poi" oder "ship".
    this._objectType = (data.type || '').toLowerCase()

    // WLAN-Verschlüsselungskategorie für die Platzhalter-Farbe (siehe wifi-Case).
    this._wifiCat = this._objectType === 'wifi'
      ? encCategory(data.state?.enc_category || data.state?.encryption)
      : null

    // Agent-definierte Darstellung (appearance). Im AR-Viewer gewinnt ein
    // gültiges gltf; sonst dient appearance (shape/color) als Fallback-Look.
    this._appearance = appearanceOf(data)

    // Immer einen Platzhalter — das Modell-Loading ist ein nice-to-have,
    // das Verhalten der Szene darf davon nicht abhängen.
    this.#createPlaceholder()

    // appearance.gltf gewinnt vor Legacy model_url (siehe Appearance.gltfUrlOf).
    const modelUrl = gltfUrlOf(data)
    if (modelUrl) {
      // Fire-and-forget. Bei Erfolg ersetzt #loadModel den Platzhalter,
      // bei Fehler bleibt er stehen — kein Abbruch des syncSceneObjects-Loops.
      this.#loadModel(modelUrl).catch(err => {
        console.warn(
          `GameObject ${this.id}: Modell konnte nicht geladen werden (${modelUrl})`,
          err
        )
      })
    }
  }

  // Lade-Kandidaten für ein Modell, in Reihenfolge der Bevorzugung.
  // In der nativen App (Capacitor) liegen alle mit `client/` ausgelieferten
  // Modelle im APK-Bundle und sind über die App-Origin (https://localhost)
  // OHNE Netzzugriff erreichbar. Wir versuchen daher zuerst die Bundle-Kopie
  // und fallen nur dann auf die (entfernte) Server-URL zurück, wenn das Modell
  // nicht mitgeliefert wurde. Im Browser bleibt es bei der einen Server-URL.
  #modelCandidates(url) {
    const native = !!window.Capacitor?.isNativePlatform?.()
    const idx = url.indexOf("/models/")
    if (native && idx >= 0) {
      const local = window.location.origin + url.slice(idx)   // /models/<x>.glb
      if (local !== url) return [local, url]
    }
    return [url]
  }

  async #loadModel(url) {
    const candidates = this.#modelCandidates(url)
    let result, lastErr
    for (const candidate of candidates) {
      try {
        result = await BABYLON.SceneLoader.ImportMeshAsync("", "", candidate, this.scene)
        break
      } catch (err) {
        lastErr = err   // z. B. nicht im Bundle → nächster Kandidat (Server)
      }
    }
    if (!result) throw lastErr

    // Race-Guard: kam das GameObject während des Loads aus der Szene
    // (z. B. via syncSceneObjects → dispose), die geladenen Meshes wieder
    // entsorgen statt sie an einen toten Root zu hängen.
    if (this.root.isDisposed?.()) {
      result.meshes.forEach(m => m.dispose())
      result.skeletons?.forEach(s => s.dispose())
      result.animationGroups?.forEach(g => g.dispose())
      return
    }

    // Erst nach erfolgreichem Load Platzhalter entfernen — sonst hätte
    // man bei abgebrochenem/spätem Load ein nacktes GameObject in der Szene.
    this.#disposePlaceholder()

    // Wichtig: NUR den vom glTF-Loader erzeugten __root__-Node (= meshes[0])
    // an this.root hängen. Der Loader spannt darunter die GLB-interne
    // Hierarchie + die Koordinaten-Konvertierung (Y-up → Babylon-Konvention)
    // auf. Würden wir die Children einzeln reparenten, ginge diese
    // Transformation verloren — Effekt: "nur Teil sichtbar, verzerrt".
    const importRoot = result.meshes[0]
    if (importRoot) {
      importRoot.parent = this.root
      this.#normalizeModelSize(importRoot, url)
    }

    this.meshes = result.meshes
    this.animationGroups = result.animationGroups || []
    this.skeletons = result.skeletons || []
    this._activeAnim = null

    // Bevorzugt die im animation_state vermerkte AnimationGroup starten.
    // Fallback: erste Group (Skinned Modelle ohne laufende Animation
    // zeigen einen verzerrten "Identity-Bones"-Zustand — siehe Hufe-Bug).
    // Ganz ohne Group: skeletons.returnToRest() als sauberer Default.
    if (this.animationGroups.length > 0) {
      this._applyAnimationState(this._initialAnimationState)
    } else if (this.skeletons.length > 0) {
      this.skeletons.forEach(sk => sk.returnToRest())
    }

    this.#tagMeshes()
  }

  // Normiert die Welthöhe des geladenen Modells auf MODEL_TARGET_HEIGHT[Datei],
  // falls gelistet. Misst die tatsächliche Hierarchie-Bounding-Box (inkl. aller
  // Knoten-Transforms UND eines evtl. Record-`scale`) und skaliert den Import-
  // Root so, dass die finale Welthöhe = Zielhöhe ist — ABSOLUT, unabhängig von
  // einem Record-`scale`. Damit wirkt jedes Vorkommen des Modells konsistent
  // gleich groß; auch Legacy-Objekte mit Kompensations-Scale werden nicht
  // winzig.
  //
  // `appearance.scale` (Skalar, Default 1) ist der GEWOLLTE relative Größen-
  // Regler: z. B. "kleiner Fuchs" → 0.7, "großer Fuchs" → 1.4. Er multipliziert
  // die Zielhöhe (gelistete Modelle) bzw. wirkt direkt auf den Import-Root
  // (nicht gelistete Modelle). Getrennt vom Record-`scale`-Vektor, damit er
  // nicht mit Legacy-Kompensations-Scales kollidiert.
  #normalizeModelSize(importRoot, url) {
    const file = (url.split(/[?#]/)[0].split("/").pop() || "")
    const target = MODEL_TARGET_HEIGHT[file]
    const sizeMult = Number(this._appearance?.scale) || 1
    if (!target) {
      // Nicht normiertes Modell: nur den gewollten Größen-Regler anwenden.
      if (sizeMult !== 1) importRoot.scaling.scaleInPlace(sizeMult)
      return
    }
    try {
      this.root.computeWorldMatrix(true)
      importRoot.computeWorldMatrix(true)
      const { min, max } = importRoot.getHierarchyBoundingVectors(true)
      const height = max.y - min.y
      if (Number.isFinite(height) && height > 1e-4) {
        importRoot.scaling.scaleInPlace((target * sizeMult) / height)
      }
    } catch (err) {
      console.warn(`GameObject ${this.id}: Größen-Normierung fehlgeschlagen`, err?.message || err)
    }
  }

  // Wechselt zur AnimationGroup mit dem passenden Namen (case-insensitive, sonst
  // Teilstring, z. B. "idle" → "IdleFinal"). No-op wenn schon aktiv. Bei
  // unbekanntem Namen: erste Group als Fallback.
  _applyAnimationState(state) {
    if (!this.animationGroups || this.animationGroups.length === 0) return

    // applyData() läuft bei JEDEM Objekt-Update (Realtime) — erneute Anfrage
    // desselben Zustands nichts tun. Verhindert wiederholtes Auflösen UND
    // Warn-Spam (die Warnung feuerte bisher pro syncSceneObjects erneut).
    if (state === this._lastAnimState) return
    this._lastAnimState = state

    let target = null
    if (state) {
      const lower = String(state).toLowerCase()
      target = this.animationGroups.find(g => (g.name || "").toLowerCase() === lower)
            || this.animationGroups.find(g => (g.name || "").toLowerCase().includes(lower))
      if (!target) {
        console.warn(
          `GameObject ${this.id}: animation "${state}" not found. ` +
          `Available: ${this.animationGroups.map(g => g.name).join(", ")}`
        )
      }
    }
    const next = target || this.animationGroups[0]
    if (this._activeAnim === next) return

    // Vorherige stoppen — Babylon spielt sonst beide gleichzeitig.
    this.animationGroups.forEach(g => g.stop())
    next.start(true)
    this._activeAnim = next
  }

  #createPlaceholder() {
    // Type-abhängiger Default-Look. Modell-URL überschreibt das später
    // ohnehin — der Placeholder ist nur sichtbar, bis (oder falls) ein
    // GLB für dieses Objekt geladen wird. Neue Types hier ergänzen UND
    // parallel in client/map.js (markerIconFor) + docs/world-objects.md.
    //
    //   default → roter Würfel (1 m³, Standard-Marker)
    //   poi     → dünner grüner Zylinder (Overpass-Points-of-Interest)
    //   npc     → cyan Kapsel, menschenhoch
    //   enemy   → dunkelrote Kapsel, etwas massiger
    //   animal  → flacher brauner Block, bodennah
    //   dragon  → violetter gestreckter Körper (fliegt via altitude im Record)
    //   item    → goldenes leuchtendes Oktaeder, schwebend
    //   hint    → gelbes leuchtendes Oktaeder, höher schwebend
    const phName = `placeholder_${this.id}`

    // 1) Agent-definierte AR-Darstellung zuerst (appearance / appearance.ar) —
    //    type-UNABHÄNGIG. Erkennt der Helfer ein 3D-Primitiv (z. B. WLAN als
    //    "sphere"), rendern wir es direkt mit Farbe, Transparenz (opacity) und
    //    Schwebehöhe (y) aus appearance. So braucht der Viewer kein Typ-Wissen.
    const ar = arViewOf(this._appearance)
    const apMesh = ar ? this.#primitiveFromShape((ar.shape || '').toLowerCase(), ar, phName) : null
    if (apMesh) {
      const apMat = new BABYLON.StandardMaterial(`mat_${this.id}`, this.scene)
      if (typeof ar.color === 'string') {
        try {
          const c = BABYLON.Color3.FromHexString(ar.color)
          apMat.diffuseColor = c
          apMat.emissiveColor = c.scale(0.5)
        } catch { /* ungültiger Hex → Default-Material */ }
      }
      const op = Number(ar.opacity)
      if (Number.isFinite(op) && op > 0 && op < 1) {
        apMat.alpha = op
        apMat.backFaceCulling = false   // saubere Transparenz (Innen-/Außenflächen)
      }
      const yy = Number(ar.y)
      apMesh.position.y = Number.isFinite(yy) ? yy : 0
      apMesh.material = apMat
      apMesh.parent = this.root
      this.meshes = [apMesh]
      return
    }

    // 2) Fallback: type-abhängiger Default-Look (Legacy), wenn appearance kein
    //    bekanntes 3D-Primitiv vorgibt.
    const mat = new BABYLON.StandardMaterial(`mat_${this.id}`, this.scene)
    let mesh

    switch (this._objectType) {
      case 'poi':
        mesh = BABYLON.MeshBuilder.CreateCylinder(phName, { height: 1.5, diameter: 0.4, tessellation: 12 }, this.scene)
        mat.diffuseColor  = new BABYLON.Color3(0.35, 0.85, 0.45)
        mat.emissiveColor = new BABYLON.Color3(0.10, 0.30, 0.15)
        mesh.position.y = 0.75   // Cylinder ist zentriert → Standfuß auf Y=0
        break
      case 'npc':
        mesh = BABYLON.MeshBuilder.CreateCapsule(phName, { height: 1.7, radius: 0.3 }, this.scene)
        mat.diffuseColor  = new BABYLON.Color3(0.20, 0.75, 0.85)
        mat.emissiveColor = new BABYLON.Color3(0.04, 0.18, 0.22)
        mesh.position.y = 0.85
        break
      case 'enemy':
        mesh = BABYLON.MeshBuilder.CreateCapsule(phName, { height: 1.9, radius: 0.38 }, this.scene)
        mat.diffuseColor  = new BABYLON.Color3(0.75, 0.12, 0.12)
        mat.emissiveColor = new BABYLON.Color3(0.30, 0.02, 0.02)
        mesh.position.y = 0.95
        break
      case 'animal':
        mesh = BABYLON.MeshBuilder.CreateBox(phName, { width: 0.9, height: 0.5, depth: 0.5 }, this.scene)
        mat.diffuseColor  = new BABYLON.Color3(0.55, 0.40, 0.22)
        mesh.position.y = 0.25
        break
      case 'dragon':
        mesh = BABYLON.MeshBuilder.CreateBox(phName, { width: 1.8, height: 0.4, depth: 0.7 }, this.scene)
        mat.diffuseColor  = new BABYLON.Color3(0.45, 0.20, 0.65)
        mat.emissiveColor = new BABYLON.Color3(0.18, 0.06, 0.28)
        break
      case 'item':
        mesh = BABYLON.MeshBuilder.CreatePolyhedron(phName, { type: 1, size: 0.28 }, this.scene)
        mat.diffuseColor  = new BABYLON.Color3(0.95, 0.80, 0.25)
        mat.emissiveColor = new BABYLON.Color3(0.45, 0.35, 0.05)
        mesh.position.y = 0.5
        break
      case 'hint':
        mesh = BABYLON.MeshBuilder.CreatePolyhedron(phName, { type: 1, size: 0.32 }, this.scene)
        mat.diffuseColor  = new BABYLON.Color3(0.98, 0.85, 0.20)
        mat.emissiveColor = new BABYLON.Color3(0.55, 0.45, 0.05)
        mesh.position.y = 1.4
        break
      case 'wifi': {   // solider Mittelpunkt; Farbe = Verschlüsselung, schwebt ~5 m
        const ws = ENC_STYLE[this._wifiCat] || ENC_STYLE.other
        mesh = BABYLON.MeshBuilder.CreateSphere(phName, { diameter: 0.5, segments: 12 }, this.scene)
        mat.diffuseColor  = new BABYLON.Color3(ws.rgb[0], ws.rgb[1], ws.rgb[2])
        mat.emissiveColor = new BABYLON.Color3(ws.rgb[0] * 0.4, ws.rgb[1] * 0.4, ws.rgb[2] * 0.4)
        mesh.position.y = 5   // ~5 m über dem Boden
        break
      }
      default:
        mesh = BABYLON.MeshBuilder.CreateBox(phName, { size: 1 }, this.scene)
        mat.diffuseColor = new BABYLON.Color3(0.8, 0.2, 0.2)
    }

    // Agent-definierte Farbe (appearance.color, Hex) übersteuert den Typ-
    // Default — so steuert der Agent auch den Fallback-Look ohne Client-Wissen.
    const apColor = this._appearance && typeof this._appearance.color === 'string'
      ? this._appearance.color : null
    if (apColor) {
      try {
        const c = BABYLON.Color3.FromHexString(apColor)
        mat.diffuseColor = c
        mat.emissiveColor = c.scale(0.4)
      } catch { /* ungültiger Hex → Typ-Default behalten */ }
    }

    mesh.material = mat
    mesh.parent = this.root
    this.meshes = [mesh]
  }

  // Baut ein Mesh aus einer agent-definierten Shape (appearance). Maße kommen
  // aus appearance (diameter/size/height/thickness), sonst sinnvolle Defaults.
  // Liefert null für unbekannte/2D-Shapes ("circle"/"emoji"/…) → Legacy-Fallback.
  #primitiveFromShape(shape, ar, phName) {
    const s = this.scene
    switch (shape) {
      case 'sphere':
        return BABYLON.MeshBuilder.CreateSphere(phName, { diameter: Number(ar.diameter) || 0.5, segments: 12 }, s)
      case 'box':
        return BABYLON.MeshBuilder.CreateBox(phName, { size: Number(ar.size) || 1 }, s)
      case 'capsule':
        return BABYLON.MeshBuilder.CreateCapsule(phName, { height: Number(ar.height) || 1.7, radius: Number(ar.thickness) || 0.3 }, s)
      case 'cylinder':
        return BABYLON.MeshBuilder.CreateCylinder(phName, { height: Number(ar.height) || 1.5, diameter: Number(ar.diameter) || 0.4, tessellation: 12 }, s)
      case 'octahedron':
        return BABYLON.MeshBuilder.CreatePolyhedron(phName, { type: 1, size: Number(ar.size) || 0.3 }, s)
      default:
        return null
    }
  }

  #disposePlaceholder() {
    const remaining = []
    for (const mesh of this.meshes) {
      if (mesh.name?.startsWith("placeholder_")) {
        mesh.dispose()
      } else {
        remaining.push(mesh)
      }
    }
    this.meshes = remaining
  }

  #tagMeshes() {
    // Reverse-Lookup für Pointer-Picking / Hover-Tooltips (siehe
    // setupHoverSystem in main.js).
    for (const mesh of this.meshes) {
      if (!mesh.metadata) mesh.metadata = {}
      mesh.metadata.gameObject = this
    }
  }

  // Wendet einen frischen PB-Record auf ein bereits existierendes GameObject
  // an — wird vom syncSceneObjects-Reconcile-Pfad bei Realtime-Updates
  // gerufen. Modell-Reload (model_url-Change) ist hier bewusst nicht
  // enthalten: das ist ein seltener Boot-Schritt, nicht der Live-Pfad.
  applyData(data, geo) {
    this.name = data.name || data.id

    // Position und Rotation gehen via PositionSmoother — das tatsächliche
    // Schreiben auf root.position / root.rotation passiert pro Frame in
    // update() aus dem gesampelten Snap. Damit ist die Bewegung zwischen
    // Realtime-Updates flüssig statt sprunghaft.
    this._smoother.feed(data)

    // Höhen-Referenz (AGL/MSL) live nachziehen — sie ist nicht Teil des
    // Smoothers, geoComp.update() liest sie pro Frame.
    const geoComp = this.getComponent(GeospatialComponent)
    if (geoComp) geoComp.altitudeRef = data.state?.altitude_ref === 'msl' ? 'msl' : 'ground'

    // Scaling ist (noch) nicht Teil des Smoothers — selten geändert,
    // direkter Setter reicht.
    this.root.scaling = new BABYLON.Vector3(
      data.scale?.x ?? 1,
      data.scale?.y ?? 1,
      data.scale?.z ?? 1
    )

    // Animations-State live ziehen (Realtime-Update vom Agent landet hier).
    // Wenn das Modell noch nicht geladen ist (animationGroups leer),
    // wird der Wert in _initialAnimationState gemerkt und greift dann beim
    // Load-Abschluss in #loadModel.
    if (data.animation_state !== undefined) {
      this._initialAnimationState = data.animation_state
      if (this.animationGroups && this.animationGroups.length > 0) {
        this._applyAnimationState(data.animation_state)
      }
    }
  }

  setPosition(vec3) {
    this.root.position = vec3
  }

  setRotation(vec3) {
    this.root.rotation = vec3
  }

  setScaling(vec3) {
    this.root.scaling = vec3
  }

  playAllAnimations(loop = true) {
    this.animationGroups.forEach(anim => anim.start(loop))
  }

  addComponent(component) {
    component.init(this)
    this.components.push(component)
    return component
  }

  getComponent(type) {
    return this.components.find(c => c instanceof type)
  }

  update(delta) {

    // Smoother VOR den Components abtasten, damit GeospatialComponent.update
    // im selben Frame mit den frisch interpolierten lat/lon arbeitet.
    this._applySmoothedTransform()

    // Components zuerst und unabhängig vom Network-Sync-Pfad aktualisieren —
    // sonst bekommen Objekte ohne NetworkSyncComponent (z. B. der Player)
    // nie ein update() ihrer Components.
    this.components.forEach(c => c.update(delta))

    const net = this.getComponent(NetworkSyncComponent)
    const transform = this.getComponent(TransformComponent)

    if (!net || !transform || !net.targetPosition) return

    const now = performance.now()
    const timeSinceUpdate = (now - net.lastUpdateTime) / 1000

    // Extrapolation mit Velocity
    const predictedPosition = net.targetPosition.add(
      net.velocity.scale(timeSinceUpdate)
    )

    transform.position = BABYLON.Vector3.Lerp(
      transform.position,
      predictedPosition,
      0.1
    )

    // Rotation
    const predictedRotation = net.targetRotation.add(
      net.angularVelocity.scale(timeSinceUpdate)
    )

    transform.rotation = BABYLON.Vector3.Lerp(
      transform.rotation,
      predictedRotation,
      0.1
    )
  }

  // Liest den aktuellen Smoother-Snap und schreibt ihn auf GeospatialComponent
  // (lat/lon → root.position via Component.update) sowie root.rotation direkt.
  _applySmoothedTransform() {
    const snap = this._smoother.sample()
    if (!snap) return
    const geoComp = this.getComponent(GeospatialComponent)
    if (geoComp) {
      geoComp.lat      = snap.lat
      geoComp.lon      = snap.lon
      geoComp.altitude = snap.altitude
    }
    // Rotation direkt — kein Component übernimmt das pro Frame.
    this.root.rotation.x = snap.rotation.x
    this.root.rotation.y = snap.rotation.y
    this.root.rotation.z = snap.rotation.z
  }

  dispose() {
    this.components.forEach(c => c.dispose())
    this.root.dispose()
  }

}