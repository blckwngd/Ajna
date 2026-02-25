import { mapPocketBaseRecord } from "../engine/components/NetworkSyncComponent.js"

export class NetworkSystem {

  constructor(pb, geo, objectMap) {
    this.pb = pb
    this.geo = geo
    this.objectMap = objectMap
  }

  start() {

    this.pb.collection("objects").subscribe("*", e => {
      this.handleEvent(e)
    })

    console.log("NetworkSystem: realtime subscription active")
  }

  handleEvent(e) {

    console.log(e)
    const go = this.objectMap.get(e.record.id)
    if (!go) return

    const net = go.getComponent("NetworkSyncComponent")
    if (!net) return

    const state = mapPocketBaseRecord(e.record, this.geo)
    console.log(state)
    net.applyState(state)
  }
}