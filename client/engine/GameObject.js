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

  // Factory-Methode zum Erstellen eines GameObjects mit Standard-Komponenten
  static async createFromPBData(scene, data, geo, includeNetworkSync = false) {
    const go = new GameObject(scene, data.id)
    await go.loadFromData(data, geo)

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

    return go
  }

  async loadFromData(data, geo) {

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

    if (data.model_url) {
      await this.#loadModel(data.model_url)
    } else {
      this.#createPlaceholder()
    }
  }

  async #loadModel(url) {
    const result = await BABYLON.SceneLoader.ImportMeshAsync(
      "",
      "",
      url,
      this.scene
    )

    result.meshes.forEach(mesh => {
      if (mesh !== result.meshes[0]) {
        mesh.parent = this.root
      }
    })

    // Falls erstes Mesh selbst transformiert ist
    if (result.meshes.length > 0) {
      result.meshes[0].parent = this.root
    }

    this.meshes = result.meshes
    this.animationGroups = result.animationGroups || []
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
    console.log(type)
    console.log(this)
    return this.components.find(c => c instanceof type)
  }

  update(delta) {

    const net = this.getComponent("NetworkSyncComponent")
    const transform = this.getComponent("TransformComponent")

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
    
    this.components.forEach(c => c.update(deltaTime))
  }

  dispose() {
    this.components.forEach(c => c.dispose())
    this.root.dispose()
  }

}