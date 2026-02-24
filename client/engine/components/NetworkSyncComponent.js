import { BaseComponent } from "../BaseComponent.js"

export class NetworkSyncComponent extends BaseComponent {

  constructor(objectId, geo) {
    super()
    this.objectId = objectId
    this.geo = geo
    this.subscription = null
  }

  init(gameObject) {
    super.init(gameObject)
    this.startListening()
  }

  startListening() {
    // Wird von außen gesetzt, um auf globale PocketBase Instanz zuzugreifen
    // Idealerweise durch dependency injection oder globals
  }

  // Diese Methode wird von außen aufgerufen um die PocketBase subscription zu setzen
  subscribeToUpdates(pb) {
    if (!pb) return

    pb.collection("objects").subscribe(this.objectId, (e) => {
      if (e.action === "update") {
        this.applyUpdate(e.record)
      } else if (e.action === "delete") {
        this.gameObject.dispose()
      }
    })
  }

  applyUpdate(data) {
    // Position
    const position = this.geo.toLocal(
      data.lat,
      data.lon,
      data.altitude ?? 0
    )
    this.gameObject.root.position = position

    // Rotation
    const rotation = new BABYLON.Vector3(
      data.rotation?.x ?? 0,
      data.rotation?.y ?? 0,
      data.rotation?.z ?? 0
    )
    this.gameObject.root.rotation = rotation

    // Skalierung
    const scaling = new BABYLON.Vector3(
      data.scale?.x ?? 1,
      data.scale?.y ?? 1,
      data.scale?.z ?? 1
    )
    this.gameObject.root.scaling = scaling
  }

  dispose() {
    if (this.subscription) {
      // Subscription wird von PocketBase verwaltet
      // Die unsubscribe-Logik wird von außen behandelt
    }
  }
}
