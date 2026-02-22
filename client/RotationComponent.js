import { BaseComponent } from "./BaseComponent.js"

export class RotationComponent extends BaseComponent {

  constructor(speed = 1) {
    super()
    this.speed = speed
  }

  update(deltaTime) {
    this.gameObject.root.rotation.y += this.speed * deltaTime
  }
}