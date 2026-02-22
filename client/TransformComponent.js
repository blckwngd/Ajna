import { BaseComponent } from "./BaseComponent.js"

export class TransformComponent extends BaseComponent {

  constructor(rotation = null, scaling = null) {
    super()
    this.rotation = rotation
    this.scaling = scaling
  }

  init(gameObject) {
    super.init(gameObject)

    if (this.rotation) {
      this.gameObject.root.rotation = this.rotation
    }

    if (this.scaling) {
      this.gameObject.root.scaling = this.scaling
    }
  }
}