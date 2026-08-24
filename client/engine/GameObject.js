import { GeospatialComponent } from "./components/GeospatialComponent.js"
import { TransformComponent } from "./components/TransformComponent.js"
import { NetworkSyncComponent } from "./components/NetworkSyncComponent.js"
import { PositionSmoother } from "../core/PositionSmoother.js"
import { LabelComponent } from "./components/LabelComponent.js"
import { tagMeshOwner } from "./meshOwner.js"
import { ENC_STYLE, encCategory } from "../core/wifiStyle.js"
import { appearanceOf, arViewOf, gltfUrlOf } from "../core/Appearance.js"
import { gangartFuer, tempoAusSpruengen } from "../core/gangart.js"

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
  "Diamond.glb": 0.4,
}

// Per-Modell-Yaw-Korrektur (rad): manche GLBs schauen entlang +Z statt −Z —
// die Figur liefe zur Blickrichtung des Directors „rückwärts". Der Offset wird
// auf einen Wrapper-Node zwischen root und Modell gelegt, damit die geo-Rotation
// (root, vom Agent/Editor) unberührt bleibt.
const MODEL_YAW_RAD = {
  "Soldier.glb": Math.PI,
}

// Aktion → mögliche Namen einer Reaktions-Animation (Teilstring, case-insensitiv).
// Erste passende AnimationGroup des Modells wird EINMAL abgespielt, danach zurück
// zum vorherigen Zustand. Modelle ohne passende Animation reagieren nicht.
const INTERACTION_ANIM = {
  talk:      ["wave", "yes", "thumbsup", "greet", "talk"],
  sprechen:  ["wave", "yes", "thumbsup", "greet", "talk"],
  attack:    ["hit", "punch", "attack", "damage", "death", "die"],
  angreifen: ["hit", "punch", "attack", "damage", "death", "die"],
  feed:      ["eat", "chew"],
  "füttern": ["eat", "chew"],
}

// Logische Animationszustände → Prioritätsliste von Namens-Teilstrings. So mappt
// derselbe Director-State auf modell-spezifische Clip-Namen: ein fliegendes Wesen
// nutzt für „fly" FlapFlight, für „glide" GlideFlight; ein Vogel mit nur einem
// Clip fällt auf dessen erste Group zurück. Deckt Groß-/Kleinschreibung ab.
// Zusätzliche Teilstrings decken abweichende/fehlerbehaftete Clip-Namen ab:
// „idol" (wyvern.glb, Tippfehler für idle), „flying" (wyvern glide-Clip). Der
// Präfix „metarig|" ist egal — gematcht wird per includes(). Reihenfolge =
// Priorität; die spezifischen Namen (glideflight/flapflight) stehen VORNE, damit
// sie beim Dragon.glb weiterhin zuerst greifen.
const ANIM_ALIASES = {
  walk:  ["walk", "move", "trot", "flapflight", "fly", "run"],
  run:   ["run", "gallop", "sprint", "flapflight", "fly", "walk"],
  idle:  ["idle", "idol", "survey", "rest", "stand", "glideflight", "glide", "hover"],
  fly:   ["flapflight", "flap", "fly", "flight", "wing", "walk", "run", "move"],
  glide: ["glideflight", "glide", "flying", "soar", "hover", "idle", "flight", "flapflight"],
  // Abheben: der wyvern hat „metarig|take off"; Modelle ohne eigenen Takeoff-Clip
  // (z. B. Dragon.glb) fallen sauber auf ihre Flap-/Flug-Animation zurück.
  takeoff: ["take off", "takeoff", "take_off", "launch", "flapflight", "flap", "fly", "flight"],
  // Gesten aus Dialogen (Parley). Letzter Eintrag ist immer "idle": Modelle
  // ohne passenden Clip sollen ruhig stehen bleiben statt irgendeine Animation
  // zu erwischen (der Fallback auf groups[0] greift sonst).
  wave:  ["wave", "waving", "greet", "salute", "yes", "idle"],
  dance: ["dance", "dancing", "idle"],
  jump:  ["jump", "hop", "idle"],
}

// Typen, die als „Figur" einen Blob-Schatten bekommen (Objekte mit 3D-Modell
// ebenfalls, siehe loadFromData).
const FIGURE_TYPES = new Set(["npc", "enemy", "animal", "dragon"])

// Zustände, in denen die Gangart (core/gangart.js) das Sagen hat: Fortbewegung
// AUF DEM BODEN. Alles andere — fliegen, gleiten, abheben, Gesten — gehört dem
// Agent bzw. der Interaktion; dort wäre eine tempoabhängige Gehanimation falsch.
const BODEN_ANIM = new Set(["idle", "walk", "run"])

// Ab dieser Höhe über Grund gilt eine Figur als fliegend (Meter). Bewusst über
// Kopfhöhe: Ein Objekt auf einer Treppe oder einem Dach geht weiterhin.
const FLIEGT_AB_M = 3

export class GameObject {

  constructor(scene, id) {
    this.scene = scene
    this.id = id

    // Neutraler Transform-Node als Wrapper
    this.root = new BABYLON.TransformNode(`go_${id}`, scene)

    this.meshes = []
    this.animationGroups = []
    this.components = []

    // BESITZVERHÄLTNISSE beim Aufräumen — seit dem AssetContainer-Cache
    // (siehe _loadContainer) gehören Geometrie, Materialien und Texturen eines
    // GLB NICHT mehr diesem Objekt, sondern allen Objekten desselben Modells.
    // Wer sie beim Löschen mit freigibt, nimmt sie den anderen weg: die werden
    // weiß. Deshalb wird beim Aufräumen NUR freigegeben, was hier steht.
    //
    //   _ownMaterials    selbst gebaute Materialien (Platzhalter, Bildtafel,
    //                    Aura) samt eigener Texturen
    //   _clonedMaterials Klone von Container-Materialien (appearance.color /
    //                    opacity). Der Klon gehört uns, seine TEXTUREN nicht.
    this._ownMaterials = []
    this._clonedMaterials = []

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

    // Beschriftung (appearance.label). Meldet sich selbst wieder ab, wenn das
    // Objekt keine Vorlage trägt — kostet dann nichts.
    go.addComponent(new LabelComponent(data))

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
    this._agentAnim = data.animation_state || null

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
    // Bild-Marker (state.marker = {image, widthM, heightM?, headingDeg?}) → der
    // Platzhalter wird ein flacher texturierter Quader statt des Standard-Würfels.
    this._marker = (data.state && data.state.marker) || data.marker || null
    // Kosmetischer Spin (appearance.spin = Grad/s um die Y-Achse) — rein lokal,
    // nicht synchronisiert.
    this._spinRad = (Number(this._appearance?.spin) || 0) * Math.PI / 180

    // Agent-definierte Animations-/Ausrichtungs-Parameter (appearance-Contract,
    // reine DATEN mit Validierung — Interpretation ausschließlich hier):
    //   yaw (rad, übersteuert MODEL_YAW_RAD), animSpeed (Playback, 0.1–4),
    //   anim (Alias-Map Zustand → Clip-Name, nur gegen eigene Groups gematcht).
    const apYaw = Number(this._appearance?.yaw)
    this._modelYaw = Number.isFinite(apYaw) ? apYaw : null
    const apSpeed = Number(this._appearance?.animSpeed)
    this._animSpeed = Number.isFinite(apSpeed) ? Math.min(4, Math.max(0.1, apSpeed)) : 1
    const aliases = this._appearance?.anim
    this._animAliases = (aliases && typeof aliases === 'object' && !Array.isArray(aliases)) ? aliases : null

    // Immer einen Platzhalter — das Modell-Loading ist ein nice-to-have,
    // das Verhalten der Szene darf davon nicht abhängen.
    this.#createPlaceholder()

    // appearance.glow (Hex): pulsierende Aura — hängt am root, unabhängig vom
    // Platzhalter/Modell-Tausch. Appearance-Änderungen bauen das GameObject
    // ohnehin neu auf (Reconcile-Signatur) → an/aus wirkt live.
    this.#applyGlow()

    // Figuren (und Objekte mit 3D-Modell) werfen echte Schatten (Babylon
    // ShadowGenerator; die Meshes werden in #loadModel als Caster registriert).
    // POI/WLAN/Hints nicht.
    this._castsShadow = FIGURE_TYPES.has(this._objectType) || !!gltfUrlOf(data)

    // appearance.gltf gewinnt vor Legacy model_url (siehe Appearance.gltfUrlOf).
    const modelUrl = gltfUrlOf(data)
    if (modelUrl && this.#externalModelBlocked(modelUrl, data?._serverUrl)) {
      console.warn(`GameObject ${this.id}: externes Modell blockiert (Einstellung „Externe URLs" aus): ${modelUrl}`)
    } else if (modelUrl) {
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

  // Externe (fremd-origin) Modelle nur laden, wenn „Externe URLs" aktiviert ist
  // (localStorage ajna_allow_ext_models) — schützt Betrachter vor untergeschobenen
  // Modell-URLs. Lokale Modelle (App-Bundle/same-origin) und der Herkunfts-Server
  // des Objekts sind immer erlaubt.
  #externalModelBlocked(url, serverUrl) {
    let allowed = false
    try { allowed = localStorage.getItem("ajna_allow_ext_models") === "1" } catch {}
    if (allowed) return false
    try {
      const origin = new URL(url, window.location.href).origin
      if (origin === window.location.origin) return false
      if (serverUrl && new URL(serverUrl).origin === origin) return false
      return true
    } catch { return false }
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

  // Pro Modell-URL EIN Parse: AssetContainer-Cache (URL → Promise<Container>).
  // Vorher parste JEDES Objekt seine GLB komplett neu (ImportMeshAsync) — bei
  // mehreren Wyverns (12 MB) fror der Main-Thread beim Boot sekundenlang ein
  // und jede Kopie hielt eigene Geometrie/Texturen. Jetzt: einmal laden+parsen,
  // dann pro Objekt instanziieren (Geometrie/Texturen geteilt, Skelette/
  // AnimationGroups pro Instanz — Figuren animieren weiterhin unabhängig).
  static _containerCache = new Map()
  static _loadContainer(url, scene) {
    let p = GameObject._containerCache.get(url)
    if (!p) {
      p = BABYLON.SceneLoader.LoadAssetContainerAsync("", url, scene)
      p.catch(() => GameObject._containerCache.delete(url))   // Fehlschlag nicht cachen
      GameObject._containerCache.set(url, p)
    }
    return p
  }

  async #loadModel(url) {
    const candidates = this.#modelCandidates(url)
    let container, lastErr
    for (const candidate of candidates) {
      try {
        container = await GameObject._loadContainer(candidate, this.scene)
        break
      } catch (err) {
        lastErr = err   // z. B. nicht im Bundle → nächster Kandidat (Server)
      }
    }
    if (!container) throw lastErr

    // Instanzieren statt neu parsen. Materialien nur klonen, wenn dieses Objekt
    // sie individuell einfärbt/transparent macht (sonst teilen alle Instanzen).
    const cloneMats = !!(this._appearance?.color || Number.isFinite(Number(this._appearance?.opacity)))
    const inst = container.instantiateModelsToScene(n => n, cloneMats)
    const instRoot = inst.rootNodes[0]
    const result = {
      meshes: instRoot ? [instRoot, ...instRoot.getChildMeshes(false)] : [],
      animationGroups: inst.animationGroups || [],
      skeletons: inst.skeletons || [],
    }

    // Wurden Materialien geklont, gehören DIE KLONE diesem Objekt und müssen
    // beim Aufräumen weg — sonst bleibt pro Spawn eines zurück. Ihre Texturen
    // bleiben die des Containers und dürfen NICHT mitgehen.
    if (cloneMats) {
      for (const m of result.meshes) {
        if (m.material && !this._clonedMaterials.includes(m.material)) this._clonedMaterials.push(m.material)
      }
    }

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
      // Kette root → [yawFix] → [spin] → Modell. Beide Wrapper optional:
      // yawFix korrigiert Modelle, die entlang +Z statt −Z schauen (Soldier
      // liefe sonst rückwärts); spin ist die kosmetische Y-Rotation. Beide
      // getrennt von root, damit die geo-Rotation (Agent/Editor) unberührt bleibt.
      let parent = this.root
      const file = (url.split(/[?#]/)[0].split("/").pop() || "")
      // appearance.yaw (Agent-Daten) übersteuert die Default-Tabelle für
      // mitgelieferte Modelle — auch explizit 0 (= Korrektur abschalten).
      const yaw = this._modelYaw ?? MODEL_YAW_RAD[file]
      if (yaw) {
        const yawNode = new BABYLON.TransformNode(`yawfix_${this.id}`, this.scene)
        yawNode.rotation.y = yaw
        yawNode.parent = parent
        parent = yawNode
      }
      if (this._spinRad) {
        this._spinNode = new BABYLON.TransformNode(`spin_${this.id}`, this.scene)
        this._spinNode.parent = parent
        parent = this._spinNode
      }
      importRoot.parent = parent
      this.#normalizeModelSize(importRoot, url)
      this.#seatModel(importRoot)
    }

    this.meshes = result.meshes

    // Echten Schattenwurf: jedes geladene Mesh (nicht nur __root__) als Caster
    // registrieren. Der ShadowGenerator projiziert auf die Boden-Ebene — bei
    // fliegenden Kreaturen landet der Schatten korrekt am Boden.
    const sg = this.scene?._ajnaShadowGenerator
    if (this._castsShadow && sg) {
      for (const m of this.meshes) { try { sg.addShadowCaster(m) } catch {} }
    }
    this.animationGroups = result.animationGroups || []
    this.skeletons = result.skeletons || []
    this._activeAnim = null
    this.#pruefeGangart()

    this.#applyModelColor()     // untexturierte Materialien mit appearance.color einfärben
    this.#applyModelOpacity()   // appearance.opacity → Material-Transparenz (alle Materialien)

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

  // Färbt untexturierte Materialien des geladenen Modells mit appearance.color
  // (Hex). Texturierte Materialien bleiben unangetastet — so bekommt z. B. der
  // Blob/Slime seine (zufällige) Farbe, während der Fuchs seine Textur behält.
  #applyModelColor() {
    const hex = this._appearance?.color
    if (typeof hex !== "string" || !hex) return
    let c
    try { c = BABYLON.Color3.FromHexString(hex) } catch { return }
    for (const mesh of this.meshes || []) {
      const mat = mesh.material
      if (!mat) continue
      const textures = mat.getActiveTextures ? mat.getActiveTextures() : []
      if (textures.length > 0) continue                     // texturiert → Look behalten
      if ("albedoColor" in mat) mat.albedoColor = c         // PBRMaterial (GLB-Standard)
      else if ("diffuseColor" in mat) mat.diffuseColor = c  // StandardMaterial
    }
  }

  // appearance.opacity (0..1) → Material-Transparenz für ALLE Modell-Materialien
  // (auch texturierte). < 1 aktiviert Alpha-Blending.
  #applyModelOpacity() {
    const op = Number(this._appearance?.opacity)
    if (!Number.isFinite(op) || op >= 1 || op < 0) return
    for (const mesh of this.meshes || []) {
      const mat = mesh.material
      if (!mat) continue
      mat.alpha = op
      if ("transparencyMode" in mat) mat.transparencyMode = 2   // MATERIAL_ALPHABLEND
    }
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

  /**
   * Modell auf seinen Standpunkt setzen.
   *
   * ANLASS: Ein gerufener Drache landete sichtbar UNTER dem Gelände. Die
   * Position stimmte — der Ursprung des Modells liegt nur nicht an den Füßen:
   * Bei `Dragon.glb` sitzt er auf 38 % der Höhe, beim Wyvern auf 48 %. Genau
   * dieser Anteil verschwindet im Boden, und je größer die Figur, desto
   * auffälliger.
   *
   * Deshalb wird der Import-Root so verschoben, dass sein TIEFSTER PUNKT auf
   * der Objektposition liegt. Für Modelle mit Ursprung an den Füßen (Fox,
   * Soldier …) ist die Verschiebung ~0 — die Messung passiert zur Laufzeit über
   * die volle Hierarchie, also nach allen Knoten-Transforms und der
   * Größen-Normierung. Ein Modell, das schon richtig sitzt, bleibt unberührt.
   *
   * Für fliegende Figuren heißt das: Die Höhe bezeichnet den Bauch, nicht die
   * Körpermitte. Das ist die Angabe, die man meint, wenn man „30 m über Grund"
   * sagt.
   */
  #seatModel(importRoot) {
    try {
      this.root.computeWorldMatrix(true)
      importRoot.computeWorldMatrix(true)
      const { min, max } = importRoot.getHierarchyBoundingVectors(true)
      // Höhe gleich mitnehmen: Die Gangart skaliert damit die Schrittlänge
      // (ein Fuchs rennt, wo ein Pferd geht), und der Perf-Pass in main.js
      // streckt daran die Animations-Distanz. Zweimal messen wäre Verschwendung.
      const hoehe = max.y - min.y
      if (Number.isFinite(hoehe) && hoehe > 0) this._hoeheM = hoehe
      const unten = min.y - this.root.getAbsolutePosition().y
      // Nur eingreifen, wenn es sich lohnt: Millimeter-Korrekturen an jedem
      // Modell wären Rauschen, und ein Modell ohne Geometrie liefert Unsinn.
      if (!Number.isFinite(unten) || Math.abs(unten) < 0.01) return
      importRoot.position.y -= unten
    } catch (err) {
      console.warn(`GameObject ${this.id}: Aufsetzen fehlgeschlagen`, err?.message || err)
    }
  }

  // Löst einen logischen Zustand (z. B. "idle", "fly", "glide") auf die passende
  // AnimationGroup auf: 1) exakter Name, 2) Alias-Prioritätsliste (ANIM_ALIASES,
  // deckt modell-spezifische Namen wie "FlapFlight"/"GlideFlight" ab), 3) Fallback
  // auf die erste Group (skinned Modelle brauchen eine laufende Animation, sonst
  // verzerrte Identity-Bones). Kein Warn-Spam mehr — der Fallback ist gewollt.
  _resolveAnimGroup(state) {
    const groups = this.animationGroups
    if (!state) return groups[0]
    const lower = String(state).toLowerCase()
    // Agent-definierte Alias-Map (appearance.anim) hat Vorrang: exakter
    // Clip-Name, gematcht NUR gegen die Groups dieses Modells.
    const mapped = this._animAliases?.[lower] ?? this._animAliases?.[state]
    if (typeof mapped === 'string' && mapped) {
      const g = groups.find(x => (x.name || '').toLowerCase() === mapped.toLowerCase())
      if (g) return g
    }
    const exact = groups.find(g => (g.name || "").toLowerCase() === lower)
    if (exact) return exact
    for (const needle of (ANIM_ALIASES[lower] || [lower])) {
      const g = groups.find(x => (x.name || "").toLowerCase().includes(needle))
      if (g) return g
    }
    return groups[0]
  }

  // Wechselt zur AnimationGroup für den logischen Zustand (siehe _resolveAnimGroup).
  // No-op wenn schon aktiv.
  _applyAnimationState(state) {
    if (!this.animationGroups || this.animationGroups.length === 0) return

    // Läuft gerade eine Reaktions-Animation (wave/hit)? Nicht unterbrechen —
    // den gewünschten Zustand nur merken, damit playInteractionAnimation danach
    // dorthin zurückkehrt.
    if (this._reactionAnim) { this._lastAnimState = state; return }

    // applyData() läuft bei JEDEM Objekt-Update (Realtime) — erneute Anfrage
    // desselben Zustands nichts tun. Verhindert wiederholtes Auflösen UND
    // Warn-Spam (die Warnung feuerte bisher pro syncSceneObjects erneut).
    if (state === this._lastAnimState) return
    this._lastAnimState = state

    const next = this._resolveAnimGroup(state)
    if (this._activeAnim === next) return

    // Distanz-LOD-Pause (main.js ajnaPerf) verwerfen: Der Zustandswechsel macht
    // die gemerkte Pause-Liste ungültig — sonst spielt die LOD beim Wieder-
    // eintritt in den Radius die ALTEN Clips über die neue Animation.
    this._pausedAnims = null

    // Vorherige stoppen — Babylon spielt sonst beide gleichzeitig.
    this.animationGroups.forEach(g => g.stop())
    // Bones auf Ruhelage, BEVOR die neue Group startet: manche Clips animieren
    // nur einen Teil des Skeletts. Das Dragon-"Idle" z. B. bewegt nur Wirbel +
    // Schwanz, NICHT die Flügel (im GLB verifiziert: 13 vs. 57 Knoten). Ohne
    // Reset behielten die nicht animierten Bones die letzte Pose der vorherigen
    // Group — der gelandete Drache bliebe mit den aus GlideFlight/FlapFlight
    // gespreizten Flügeln stehen, während nur Rumpf/Schwanz idle-atmen.
    this.skeletons?.forEach(sk => { try { sk.returnToRest() } catch {} })
    next.start(true, this._animSpeed)   // Playback-Faktor aus appearance.animSpeed
    this._activeAnim = next
  }

  // Spielt EINMAL eine zur Aktion passende Reaktions-Animation (z. B. "wave" auf
  // sprechen, "hit"/"death" auf angreifen) und kehrt danach zum vorherigen
  // Zustand zurück. No-op, wenn das Modell keine passende Animation hat.
  playInteractionAnimation(action) {
    if (!this.animationGroups?.length || this._reactionAnim) return
    const wanted = INTERACTION_ANIM[String(action || "").toLowerCase()]
    if (!wanted) return
    const group = this.animationGroups.find(g => {
      const n = (g.name || "").toLowerCase()
      return wanted.some(w => n.includes(w))
    })
    if (!group) return

    this._reactionAnim = group
    this.animationGroups.forEach(g => g.stop())
    this._activeAnim = group
    try { group.start(false, this._animSpeed) } catch { this._reactionAnim = null; return }   // One-Shot

    const revert = () => {
      if (this._reactionAnim !== group) return
      this._reactionAnim = null
      if (this.root?.isDisposed?.()) return
      this._activeAnim = null
      const back = this._lastAnimState
      this._lastAnimState = undefined     // Dedup umgehen → Revert erzwingen
      this._applyAnimationState(back)
    }
    group.onAnimationGroupEndObservable?.addOnce?.(revert)
    setTimeout(revert, 4000)              // Sicherheitsnetz, falls kein End-Event
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

    // 0) Bild-Marker: flacher texturierter Quader mit dem Marker-Bild statt des
    //    Standard-Würfels. Reale Breite/Höhe (m) + Ausrichtung aus state.marker;
    //    Position/Höhe des Objekts kommen aus lat/lon/altitude (root).
    if (this._marker && this._marker.image) {
      const w = Number(this._marker.widthM) || 0.15
      const h = Number(this._marker.heightM) || w
      const box = BABYLON.MeshBuilder.CreateBox(phName, { width: w, height: h, depth: 0.02 }, this.scene)
      const mMat = new BABYLON.StandardMaterial(`mat_${this.id}`, this.scene)
      this._ownMaterials.push(mMat)
      const mTex = new BABYLON.Texture(this._marker.image, this.scene)
      mMat.diffuseTexture = mTex
      mMat.emissiveTexture = mTex        // selbstleuchtend → im AR-Bild ohne Szenenlicht sichtbar
      mMat.disableLighting = true
      mMat.backFaceCulling = false
      box.material = mMat
      const hd = Number(this._marker.headingDeg)
      if (Number.isFinite(hd)) box.rotation.y = -hd * Math.PI / 180   // Vorderseite in headingDeg
      box.parent = this.root
      this.meshes = [box]
      return
    }

    // 1) Agent-definierte AR-Darstellung zuerst (appearance / appearance.ar) —
    //    type-UNABHÄNGIG. Erkennt der Helfer ein 3D-Primitiv (z. B. WLAN als
    //    "sphere"), rendern wir es direkt mit Farbe, Transparenz (opacity) und
    //    Schwebehöhe (y) aus appearance. So braucht der Viewer kein Typ-Wissen.
    const ar = arViewOf(this._appearance)

    // Bildtafel (shape "image" + https-texture, z. B. Commons-Fotos): Foto als
    // beidseitige, gleichmäßig helle Plane, die sich zum Betrachter dreht.
    if (ar && (ar.shape || '').toLowerCase() === 'image') {
      const texUrl = typeof ar.texture === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(ar.texture.trim())
        ? ar.texture.trim() : null
      if (texUrl) {
        const w = Number(ar.width) || 1.2
        const h = Number(ar.height) || 0.9
        const plane = BABYLON.MeshBuilder.CreatePlane(phName,
          { width: w, height: h, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, this.scene)
        const mat = new BABYLON.StandardMaterial(`mat_${this.id}`, this.scene)
        this._ownMaterials.push(mat)
        mat.emissiveTexture = new BABYLON.Texture(texUrl, this.scene)
        mat.disableLighting = true          // Fotos gleichmäßig hell, licht-unabhängig
        mat.backFaceCulling = false
        plane.material = mat
        plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_Y
        const yy = Number(ar.y)
        plane.position.y = Number.isFinite(yy) ? yy : 1.4
        plane.parent = this.root
        this.meshes = [plane]
        return
      }
    }

    const apMesh = ar ? this.#primitiveFromShape((ar.shape || '').toLowerCase(), ar, phName) : null
    if (apMesh) {
      const apMat = new BABYLON.StandardMaterial(`mat_${this.id}`, this.scene)
      this._ownMaterials.push(apMat)
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
    this._ownMaterials.push(mat)
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

  // Aura für appearance.glow: emissive, halbtransparente Kugel um das Objekt.
  // Bewusst NICHT in this.meshes (kein Picking, überlebt #disposePlaceholder);
  // Puls läuft in update(). Ungültige Farben werden still ignoriert.
  #applyGlow() {
    const g = this._appearance && typeof this._appearance.glow === 'string' ? this._appearance.glow.trim() : ''
    if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(g)) return
    let color
    try { color = BABYLON.Color3.FromHexString(g.length === 9 ? g.slice(0, 7) : g) } catch { return }
    const mesh = BABYLON.MeshBuilder.CreateSphere(`glow_${this.id}`, { diameter: 0.95, segments: 10 }, this.scene)
    const mat = new BABYLON.StandardMaterial(`glowmat_${this.id}`, this.scene)
    this._ownMaterials.push(mat)
    mat.emissiveColor = color
    mat.diffuseColor = BABYLON.Color3.Black()
    mat.specularColor = BABYLON.Color3.Black()
    mat.disableLighting = true
    mat.alpha = 0.28
    mat.backFaceCulling = false
    mesh.material = mat
    mesh.isPickable = false
    // Auf halber Objekthöhe — passt für die Item-/Primitive-Platzhalter; ein
    // appearance.ar.y-Offset (schwebende Objekte) wird übernommen.
    const arY = Number(this._appearance?.ar?.y ?? this._appearance?.y)
    mesh.position.y = Number.isFinite(arY) ? arY : 0.5
    mesh.parent = this.root
    this._glowMesh = mesh
    this._glowMat = mat
    this._glowT = 0
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
    // setupHoverSystem in main.js). tagMeshOwner legt bewusst ein EIGENES
    // metadata-Objekt an — Instanzen desselben Modells teilen sich sonst den
    // Eintrag des Containers (siehe meshOwner.js).
    for (const mesh of this.meshes) tagMeshOwner(mesh, this)
  }

  // Wendet einen frischen PB-Record auf ein bereits existierendes GameObject
  // an — wird vom syncSceneObjects-Reconcile-Pfad bei Realtime-Updates
  // gerufen. Modell-Reload (model_url-Change) ist hier bewusst nicht
  // enthalten: das ist ein seltener Boot-Schritt, nicht der Live-Pfad.
  applyData(data, geo) {
    this.name = data.name || data.id

    // Beschriftung mit dem frischen Datensatz versorgen: Vorlage UND die
    // eingesetzten Werte (state.*) können sich per Realtime ändern.
    this.getComponent(LabelComponent)?.setRecord(data)

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
      // Was der AGENT will — getrennt festhalten. Die Gangart darf nur
      // Bodenzustände verfeinern; sagt der Agent „fliegen", hat sie sich
      // herauszuhalten (siehe #pflegeGangart).
      this._agentAnim = data.animation_state
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
    this.animationGroups.forEach(anim => anim.start(loop, this._animSpeed))
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

    // Kosmetischer Spin um die Y-Achse (rein lokal, unsynchronisiert).
    if (this._spinNode && this._spinRad) this._spinNode.rotation.y += this._spinRad * delta

    // Glow-Puls: sanftes Atmen der Aura (~2,5 s Periode), rein kosmetisch.
    if (this._glowMat) {
      this._glowT += delta
      this._glowMat.alpha = 0.22 + 0.12 * Math.sin(this._glowT * 2.5)
    }

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
    // Pausiert (Editor-Gizmo manipuliert das Objekt): sonst überschreibt der
    // Smoother root.rotation pro Frame und macht den Rotations-Drag unsichtbar.
    if (this.transformPaused) return
    const snap = this._smoother.sample()
    if (!snap) return
    const geoComp = this.getComponent(GeospatialComponent)
    if (geoComp) {
      geoComp.lat      = snap.lat
      geoComp.lon      = snap.lon
      geoComp.altitude = snap.altitude
    }
    // Rotation direkt — kein Component übernimmt das pro Frame.
    //
    // WEICH DREHEN statt springen: Bei vorausgerechneten Objekten liefert der
    // Smoother die Rotation der letzten Meldung unverändert. Seit die Agents
    // ihren Plan statt jeder Position schicken, kommen Meldungen nur noch an
    // Wegknicken — die Figur würde dort ruckartig herumschnappen. Auf der
    // Stelle drehen ist außerdem genau das, was eine Figur lebendig macht.
    this.#dreheZu(snap.rotation)
    this.#pflegeGangart(snap)
  }

  /**
   * Bringt dieses Modell überhaupt Gehen mit?
   *
   * Nur dann lohnt die Gangart-Pflege. Ein Diamant, eine Bildtafel oder ein
   * Flugzeug haben keinen Gehzyklus — dort würde die Rechnung eine Animation
   * verstellen, die etwas ganz anderes zeigt.
   */
  #pruefeGangart() {
    const namen = (this.animationGroups || []).map(g => (g.name || '').toLowerCase())
    const hat = (teile) => namen.some(n => teile.some(x => n.includes(x)))
    this._gangartAn = hat(['walk', 'move', 'trot']) && FIGURE_TYPES.has(this._objectType)
    this._laufAnim = hat(['run', 'gallop', 'sprint'])
    this._gangLetzte = null
    this._gangV = 0
    this._gangT = 0
  }

  /** Auf dem kürzesten Winkelweg zur Zielrotation nachziehen. */
  #dreheZu(ziel) {
    const r = this.root.rotation
    const kurz = (von, nach) => {
      let d = (nach - von) % (Math.PI * 2)
      if (d > Math.PI) d -= Math.PI * 2
      if (d < -Math.PI) d += Math.PI * 2
      return d
    }
    // Fester Anteil je Frame: bildratenunabhängig genug für diesen Zweck und
    // ohne Zustand. Ein volles Umdrehen dauert damit rund eine halbe Sekunde.
    const k = 0.18
    r.x += kurz(r.x, ziel.x) * k
    r.y += kurz(r.y, ziel.y) * k
    r.z += kurz(r.z, ziel.z) * k
  }

  /**
   * Gangart nach TATSÄCHLICHEM Tempo: Zyklus wählen, mischen, Abspieltempo an
   * die Schrittlänge koppeln. Siehe core/gangart.js — dort steht, warum das
   * Gleiten der stärkste Tot-Effekt ist.
   */
  #pflegeGangart(snap) {
    if (!this._gangartAn || !this.animationGroups?.length) return

    // NUR BODENFORTBEWEGUNG. Ein Drache und der Wyvern bringen einen
    // Gehzyklus mit — den gibt es für den Fall, dass sie gelandet sind.
    // Solange der Agent „fliegen" oder „gleiten" meldet, ist jede Gangart-
    // Rechnung falsch: Die Figur zuckte dann im Gehtakt durch die Luft,
    // statt zu fliegen. Fluglage bestimmt der Agent, nicht das Tempo.
    if (this._agentAnim && !BODEN_ANIM.has(String(this._agentAnim).toLowerCase())) return

    // Zweite Sicherung über die HÖHE: Zwischen dem Laden und der ersten
    // Meldung des Agents steht in `_agentAnim` noch der Anlege-Zustand
    // („idle"). Ein Drache, der beim Erscheinen 40 m hoch kreist, bekäme in
    // diesem Fenster kurz einen Gehzyklus verpasst. Wer in der Luft ist, geht
    // nicht — unabhängig davon, was gerade gemeldet wurde.
    if ((snap.altitude ?? 0) > FLIEGT_AB_M) return

    // Tempo bevorzugt aus dem Plan des Agents. Der Rückfall aus zwei Positionen
    // zappelt und hinkt hinterher — er ist für Objekte da, deren Quelle noch
    // keinen Plan schickt.
    let v = this._smoother.curr?.dr?.v
    if (!Number.isFinite(v)) {
      const jetzt = performance.now()
      if (this._gangLetzte) {
        this._gangV = tempoAusSpruengen(this._gangLetzte, snap, jetzt - this._gangT, this._gangV || 0)
      }
      this._gangLetzte = { lat: snap.lat, lon: snap.lon }
      this._gangT = jetzt
      v = this._gangV || 0
    }

    const g = gangartFuer(v, { groesse: this._hoeheM || undefined, hatLauf: !!this._laufAnim })
    const fuehrend = g.misch.anteil > 0.5 ? g.misch.nach : g.misch.von
    if (fuehrend !== this._lastAnimState) this._applyAnimationState(fuehrend)
    // Abspieltempo — die eigentliche Rechnung gegen das Gleiten.
    const tempo = g.tempo * (this._animSpeed || 1)
    if (this._activeAnim && Math.abs((this._activeAnim.speedRatio ?? 1) - tempo) > 0.02) {
      try { this._activeAnim.speedRatio = tempo } catch {}
    }
  }

  dispose() {
    this.components.forEach(c => c.dispose())

    // NICHT `dispose(false, true)`. Der zweite Parameter gibt Materialien UND
    // Texturen mit frei — das war richtig, solange jedes Objekt seine eigene
    // GLB-Kopie parste. Seit dem AssetContainer-Cache teilen sich alle Objekte
    // desselben Modells diese Texturen: Ein Objekt zu löschen machte ALLE
    // anderen weiß. Geometrie und Texturen gehören jetzt dem Container und
    // bleiben, bis der Cache selbst geräumt wird.
    this.root.dispose(false, false)

    // Was wirklich uns gehört, geben wir gezielt frei — sonst bliebe pro
    // Spawn/Despawn ein Material liegen.
    for (const m of this._ownMaterials) {
      // true = eigene Texturen mit weg (Marker-Bild, Foto-Tafel).
      try { m.dispose(false, true) } catch { /* Szene evtl. schon weg */ }
    }
    // Geklonte Modell-Materialien: der Klon ja, seine Texturen NEIN.
    for (const m of this._clonedMaterials) {
      try { m.dispose(false, false) } catch {}
    }
    this._ownMaterials = []
    this._clonedMaterials = []
  }

}