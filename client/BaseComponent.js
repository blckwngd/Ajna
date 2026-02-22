export class BaseComponent {

  constructor() {
    this.gameObject = null
    this.scene = null
  }

  init(gameObject) {
    this.gameObject = gameObject
    this.scene = gameObject.scene
  }

  update(deltaTime) {
    // optional override
  }

  dispose() {
    // optional override
  }
}