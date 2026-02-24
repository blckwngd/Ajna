export class World {

  constructor(scene) {
    this.scene = scene
    this.objects = new Map()
  }

  add(gameObject) {
    this.objects.set(gameObject.id, gameObject)
  }

  get(id) {
    return this.objects.get(id)
  }

  update(delta) {
    this.objects.forEach(o => o.update(delta))
  }
}