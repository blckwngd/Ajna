import { TransformComponent } from "../components/TransformComponent.js"

export class DebugUIManager {

  constructor({ geo, gps, player, objectMap }) {

    this.geo = geo
    this.gps = gps
    this.player = player
    this.objectMap = objectMap

    console.log(player)

    this.buildUI()
    this.startUpdateLoop()
  }

  buildUI() {

    this.container = document.createElement("div")
    this.container.style.position = "absolute"
    this.container.style.top = "10px"
    this.container.style.right = "10px"
    this.container.style.width = "320px"
    this.container.style.background = "rgba(0,0,0,0.8)"
    this.container.style.color = "white"
    this.container.style.padding = "10px"
    this.container.style.fontFamily = "monospace"
    this.container.style.zIndex = 2000

    this.container.innerHTML = `
      <h3>DEBUG PANEL</h3>

      <label>
        <input type="checkbox" id="dummyToggle">
        Dummy GPS Mode
      </label>

      <hr>

      <div>
        <strong>Set GPS Position</strong><br>
        Lat: <input id="latInput" type="number" step="0.000001" value="50.45131870958352"><br>
        Lon: <input id="lonInput" type="number" step="0.000001" value="7.536272555643111"><br>
        Alt: <input id="altInput" type="number" step="0.1"><br>
        <button id="setGpsBtn">Apply</button>
      </div>

      <hr>

      <div>
        <strong>Current GPS</strong><br>
        <div id="gpsInfo"></div>
      </div>

      <hr>

      <div>
        <strong>Scene Position</strong><br>
        <div id="sceneInfo"></div>
      </div>

      <hr>

      <div>
        <strong>Loaded Objects</strong><br>
        <div id="objectCount"></div>
      </div>
    `

    document.body.appendChild(this.container)

    this.attachEvents()
  }

  attachEvents() {

    document.getElementById("dummyToggle").addEventListener("change", e => {
      console.log("enabling dummy position")
      this.gps.enableDummyMode(e.target.checked)
    })

    document.getElementById("setGpsBtn").addEventListener("click", () => {
      console.log("setting dummy position")

      const lat = parseFloat(document.getElementById("latInput").value)
      const lon = parseFloat(document.getElementById("lonInput").value)
      const alt = parseFloat(document.getElementById("altInput").value) || 0

      this.gps.setDummyPosition(lat, lon, alt)
    })
  }

  startUpdateLoop() {

    setInterval(() => {

      const gpsInfo = document.getElementById("gpsInfo")
      const sceneInfo = document.getElementById("sceneInfo")
      const objectCount = document.getElementById("objectCount")

      const playerTransform = this.player.getComponent(TransformComponent)

      if (!playerTransform) return

      const worldPos = this.gps.getWorldPosition()
      if (!worldPos)
        return
      // TODO: evtl Kamera-Position statt GPS-Position
      /*
      this.geo.toWorld(
        playerTransform.position.x,
        playerTransform.position.z,
        playerTransform.position.y
      )*/

      gpsInfo.innerText =
        `Lat: ${worldPos.lat.toFixed(6)}
Lon: ${worldPos.lon.toFixed(6)}
Alt: ${worldPos.altitude.toFixed(2)}`

/*
      sceneInfo.innerText =
        `X: ${playerTransform.position.x.toFixed(2)}
Y: ${playerTransform.position.y.toFixed(2)}
Z: ${playerTransform.position.z.toFixed(2)}`
*/
      objectCount.innerText = this.objectMap.size

    }, 500)
  }

}