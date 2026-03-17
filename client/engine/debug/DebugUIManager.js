import { TransformComponent } from "../components/TransformComponent.js"

export class DebugUIManager {

  constructor({ geo, gps, player, objectMap, tiles3DManager }) {

    this.geo = geo
    this.gps = gps
    this.player = player
    this.objectMap = objectMap
    this.tiles3DManager = tiles3DManager

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

      <hr>

      <div id="tiles3DSection">
        <strong>3D Tiles</strong><br>
        <label>
          <input type="checkbox" id="tiles3DToggle">
          Enable 3D Tiles
        </label><br>
        <select id="tilesetSelect" style="width: 100%; margin: 4px 0;">
          <option value="">Select Tileset...</option>
          <option value="sample">Sample Dataset (NASA)</option>
          <option value="osm-buildings">OSM Buildings (Cesium)</option>
          <option value="photorealistic">Photorealistic (Google)</option>
        </select><br>
        <button id="loadTilesetBtn" style="width: 100%;">Load Tileset</button>
        <div id="tiles3DInfo" style="margin-top: 4px; font-size: 12px;"></div>
      </div>`

    document.body.appendChild(this.container)

    if (!this.tiles3DManager) {
      const tiles3DSection = document.getElementById('tiles3DSection')
      if (tiles3DSection) {
        tiles3DSection.style.display = 'none'
      }
    }

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

    // 3D Tiles controls
    document.getElementById("tiles3DToggle").addEventListener("change", (e) => {
      if (this.tiles3DManager) {
        this.tiles3DManager.setEnabled(e.target.checked)
      }
    })

    document.getElementById("loadTilesetBtn").addEventListener("click", async () => {
      const select = document.getElementById("tilesetSelect")
      const tilesetType = select.value

      if (!tilesetType || !this.tiles3DManager) return

      const btn = document.getElementById("loadTilesetBtn")
      const originalText = btn.textContent
      btn.textContent = "Loading..."
      btn.disabled = true

      try {
        let success = false

        switch (tilesetType) {
          case "sample":
            success = await this.tiles3DManager.loadTileset("sample", "https://nasa-ammos.github.io/3DTilesRendererJS/example/tileset.json")
            break

          case "osm-buildings":
            // Get current GPS position for centering
            const worldPos = this.gps.getWorldPosition()
            if (worldPos) {
              success = await this.tiles3DManager.loadTileset("osm-buildings", "https://assets.cesium.com/96188/tileset.json", {
                position: { lat: worldPos.lat, lon: worldPos.lon, alt: 0 }
              })
            } else {
              success = await this.tiles3DManager.loadTileset("osm-buildings", "https://assets.cesium.com/96188/tileset.json")
            }
            break

          case "photorealistic":
            // Note: Requires Google Maps API key
            alert("Google Photorealistic 3D Tiles requires an API key. Please configure it in your tileset URL.")
            break
        }

        if (success) {
          console.log(`Loaded 3D tileset: ${tilesetType}`)
          // Auto-enable if loaded successfully
          document.getElementById("tiles3DToggle").checked = true
          this.tiles3DManager.setEnabled(true)
        } else {
          console.error(`Failed to load 3D tileset: ${tilesetType}`)
        }

      } catch (error) {
        console.error("Error loading tileset:", error)
        alert(`Error loading tileset: ${error.message}`)
      } finally {
        btn.textContent = originalText
        btn.disabled = false
      }
    })
  }

  startUpdateLoop() {

    setInterval(() => {

      const gpsInfo = document.getElementById("gpsInfo")
      const sceneInfo = document.getElementById("sceneInfo")
      const objectCount = document.getElementById("objectCount")
      const tiles3DInfo = document.getElementById("tiles3DInfo")

      const playerTransform = this.player.getComponent(TransformComponent)

      if (!playerTransform) return


      sceneInfo.innerText =
        `X: ${scene.activeCamera.position.x.toFixed(2)}
        Y: ${scene.activeCamera.position.y.toFixed(2)}
        Z: ${scene.activeCamera.position.z.toFixed(2)}`

      objectCount.innerText = this.objectMap.size

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

      // Update 3D Tiles info
      if (this.tiles3DManager) {
        const info = this.tiles3DManager.getInfo()
        const tilesetNames = Object.keys(info.tilesets)
        tiles3DInfo.innerText = `Enabled: ${info.enabled}\nTilesets: ${tilesetNames.length}`
      }


    }, 500)
  }

}