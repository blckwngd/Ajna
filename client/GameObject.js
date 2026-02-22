export class GameObject {

  constructor(scene, id) {
    this.scene = scene
    this.id = id

    // Neutraler Transform-Node als Wrapper
    this.root = new BABYLON.TransformNode(`go_${id}`, scene)

    this.meshes = []
    this.animationGroups = []
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

  dispose() {
    this.root.dispose()
  }
}