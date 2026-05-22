import { GeospatialComponent } from "./components/GeospatialComponent.js"
import { TransformComponent } from "./components/TransformComponent.js"
import { NetworkSyncComponent } from "./components/NetworkSyncComponent.js"

export class GameObject {

  constructor(scene, id) {
    this.scene = scene
    this.id = id

    // Neutraler Transform-Node als Wrapper
    this.root = new BABYLON.TransformNode(`go_${id}`, scene)

    this.meshes = []
    this.animationGroups = []
    this.components = []
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

    // Geospatial Component
    go.addComponent(
      new GeospatialComponent(
        geo,
        data.lat,
        data.lon,
        data.altitude ?? 0
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

    const position = geo.toLocal(
      data.lat,
      data.lon,
      data.altitude ?? 0
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

    // Immer einen Platzhalter — das Modell-Loading ist ein nice-to-have,
    // das Verhalten der Szene darf davon nicht abhängen.
    this.#createPlaceholder()

    if (data.model_url) {
      // Fire-and-forget. Bei Erfolg ersetzt #loadModel den Platzhalter,
      // bei Fehler bleibt er stehen — kein Abbruch des syncSceneObjects-Loops.
      this.#loadModel(data.model_url).catch(err => {
        console.warn(
          `GameObject ${this.id}: Modell konnte nicht geladen werden (${data.model_url})`,
          err
        )
      })
    }
  }

  async #loadModel(url) {
    const result = await BABYLON.SceneLoader.ImportMeshAsync(
      "",
      "",
      url,
      this.scene
    )

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
    if (importRoot) importRoot.parent = this.root

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

  // Wechselt zur AnimationGroup mit dem passenden Namen (case-insensitive).
  // No-op wenn schon aktiv. Bei unbekanntem Namen: erste Group als Fallback.
  _applyAnimationState(state) {
    if (!this.animationGroups || this.animationGroups.length === 0) return

    let target = null
    if (state) {
      const lower = String(state).toLowerCase()
      target = this.animationGroups.find(g => (g.name || "").toLowerCase() === lower)
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
    const box = BABYLON.MeshBuilder.CreateBox(
      `placeholder_${this.id}`,
      { size: 1 },
      this.scene
    )

    const mat = new BABYLON.StandardMaterial(
      `mat_${this.id}`,
      this.scene
    )
    mat.diffuseColor = new BABYLON.Color3(0.8, 0.2, 0.2)

    box.material = mat
    box.parent = this.root

    this.meshes = [box]
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

    // GeospatialComponent ist Single Source of Truth für die Welt-Position:
    // ihr update() schreibt jede Frame in root.position. Würden wir nur
    // root.position direkt setzen, läge der nächste Frame die alte Position
    // (aus den internen lat/lon-Feldern der Component) wieder ein —
    // Effekt: Objekt springt nach jedem Realtime-Update sofort zurück.
    const geoComp = this.getComponent(GeospatialComponent)
    if (geoComp) {
      geoComp.setCoordinates(data.lat, data.lon, data.altitude ?? 0)
    } else {
      // Fallback, falls das GameObject ohne GeospatialComponent gebaut wurde
      this.root.position = geo.toLocal(
        data.lat,
        data.lon,
        data.altitude ?? 0
      )
    }

    // Rotation/Scaling werden nur einmalig per TransformComponent.init()
    // gesetzt, danach gibt es keinen kontinuierlichen Override — direkter
    // Setter auf root reicht.
    this.root.rotation = new BABYLON.Vector3(
      data.rotation?.x ?? 0,
      data.rotation?.y ?? 0,
      data.rotation?.z ?? 0
    )

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

  dispose() {
    this.components.forEach(c => c.dispose())
    this.root.dispose()
  }

}