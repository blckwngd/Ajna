import { BaseComponent } from "../BaseComponent.js"
export class NetworkSyncComponent extends BaseComponent{

  constructor() {
    super()
    
    this.targetPosition = null
    this.targetRotation = null

    this.velocity = null
    this.angularVelocity = null

    this.lastUpdateTime = 0
  }

  applyNetworkState(state) {

    this.targetPosition = new BABYLON.Vector3(
      state.x, state.y, state.z
    )

    this.targetRotation = new BABYLON.Vector3(
      state.rx, state.ry, state.rz
    )

    this.velocity = state.velocity
      ? new BABYLON.Vector3(
          state.velocity.x,
          state.velocity.y,
          state.velocity.z
        )
      : BABYLON.Vector3.Zero()

    this.angularVelocity = state.angularVelocity
      ? new BABYLON.Vector3(
          state.angularVelocity.x,
          state.angularVelocity.y,
          state.angularVelocity.z
        )
      : BABYLON.Vector3.Zero()

    this.lastUpdateTime = performance.now()
  }

  applyState(state) {
    this.targetPosition = state.position
    this.targetRotation = state.rotation
    this.velocity = state.velocity
    this.angularVelocity = state.angularVelocity
    this.lastUpdateTime = state.serverTime
  }
}

export function mapPocketBaseRecord(record, geo) {

  const worldPos = geo.toLocal(
    record.lat,
    record.lon,
    record.altitude
  )

  return {
    position: worldPos,
    rotation: new BABYLON.Vector3(
      record.rotation_x ?? 0,
      record.rotation_y ?? 0,
      record.rotation_z ?? 0
    ),
    velocity: new BABYLON.Vector3(
      record.velocity_x ?? 0,
      record.velocity_y ?? 0,
      record.velocity_z ?? 0
    ),
    angularVelocity: new BABYLON.Vector3(
      record.angular_velocity_x ?? 0,
      record.angular_velocity_y ?? 0,
      record.angular_velocity_z ?? 0
    ),
    serverTime: record.server_timestamp ?? performance.now()
  }
}