/**
 * Tiles3DUI - UI Component for 3D Tiles Control
 *
 * Can be used in both debug and standard mode
 */

export class Tiles3DUI {
  constructor(tiles3DManager, options = {}) {
    this.tiles3DManager = tiles3DManager
    this.options = {
      position: 'bottom-right', // 'top-left', 'top-right', 'bottom-left', 'bottom-right'
      compact: false,
      ...options
    }

    this.container = null
    this.visible = true
    this.buildUI()
  }

  buildUI() {
    this.container = document.createElement("div")
    this.container.style.position = "absolute"
    this.container.style.background = "rgba(0,0,0,0.8)"
    this.container.style.color = "white"
    this.container.style.padding = "8px"
    this.container.style.borderRadius = "4px"
    this.container.style.fontFamily = "Arial, sans-serif"
    this.container.style.fontSize = "12px"
    this.container.style.zIndex = 1000
    this.container.style.minWidth = "200px"

    // Position the container
    this.setPosition(this.options.position)

    if (this.options.compact) {
      this.buildCompactUI()
    } else {
      this.buildFullUI()
    }

    document.body.appendChild(this.container)
  }

  buildCompactUI() {
    this.container.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
          <input type="checkbox" id="tiles3DCompactToggle" style="margin: 0;">
          <span>3D Tiles</span>
        </label>
        <select id="tilesetCompactSelect" style="flex: 1; padding: 2px; font-size: 11px;">
          <option value="sample">Sample</option>
          <option value="osm-buildings">OSM Buildings</option>
        </select>
        <button id="loadCompactBtn" style="padding: 2px 6px; font-size: 11px;">Load</button>
      </div>
      <div id="tiles3DCompactInfo" style="margin-top: 4px; font-size: 10px; color: #ccc;"></div>
    `

    this.attachCompactEvents()
  }

  buildFullUI() {
    this.container.innerHTML = `
      <div style="margin-bottom: 8px; font-weight: bold;">3D Tiles Control</div>

      <div style="margin-bottom: 8px;">
        <label style="display: flex; align-items: center; gap: 4px;">
          <input type="checkbox" id="tiles3DFullToggle">
          <span>Enable 3D Tiles</span>
        </label>
      </div>

      <div style="margin-bottom: 8px;">
        <select id="tilesetFullSelect" style="width: 100%; padding: 4px;">
          <option value="">Select Tileset...</option>
          <option value="sample">Sample Dataset (NASA)</option>
          <option value="osm-buildings">OSM Buildings (Cesium)</option>
          <option value="photorealistic">Photorealistic (Google)</option>
        </select>
      </div>

      <div style="margin-bottom: 8px;">
        <button id="loadFullBtn" style="width: 100%; padding: 6px;">Load Tileset</button>
      </div>

      <div id="tiles3DFullInfo" style="font-size: 11px; color: #ccc;"></div>
    `

    this.attachFullEvents()
  }

  attachCompactEvents() {
    const toggle = document.getElementById("tiles3DCompactToggle")
    const select = document.getElementById("tilesetCompactSelect")
    const loadBtn = document.getElementById("loadCompactBtn")

    toggle.addEventListener("change", (e) => {
      if (this.tiles3DManager) {
        this.tiles3DManager.setEnabled(e.target.checked)
      }
    })

    loadBtn.addEventListener("click", async () => {
      await this.loadTileset(select.value, loadBtn, "Loading...")
    })
  }

  attachFullEvents() {
    const toggle = document.getElementById("tiles3DFullToggle")
    const select = document.getElementById("tilesetFullSelect")
    const loadBtn = document.getElementById("loadFullBtn")

    toggle.addEventListener("change", (e) => {
      if (this.tiles3DManager) {
        this.tiles3DManager.setEnabled(e.target.checked)
      }
    })

    loadBtn.addEventListener("click", async () => {
      await this.loadTileset(select.value, loadBtn, "Loading...")
    })
  }

  async loadTileset(tilesetType, button, loadingText) {
    if (!tilesetType || !this.tiles3DManager) return

    const originalText = button.textContent
    button.textContent = loadingText
    button.disabled = true

    try {
      let success = false
      let tilesetUrl = ""
      let options = {}

      switch (tilesetType) {
        case "sample":
          tilesetUrl = "https://nasa-ammos.github.io/3DTilesRendererJS/example/tileset.json"
          break

        case "osm-buildings":
          tilesetUrl = "https://assets.cesium.com/96188/tileset.json"
          // Note: Cesium Ion datasets may require an API token
          break

        case "photorealistic":
          // Google Photorealistic requires API key
          alert("Google Photorealistic 3D Tiles requires an API key. Please configure it properly.")
          return
      }

      if (tilesetUrl) {
        success = await this.tiles3DManager.loadTileset(tilesetType, tilesetUrl, options)
      }

      if (success) {
        console.log(`Loaded 3D tileset: ${tilesetType}`)
        // Auto-enable if loaded successfully
        const toggle = this.options.compact ?
          document.getElementById("tiles3DCompactToggle") :
          document.getElementById("tiles3DFullToggle")
        if (toggle) {
          toggle.checked = true
          this.tiles3DManager.setEnabled(true)
        }
      } else {
        console.error(`Failed to load 3D tileset: ${tilesetType}`)
        alert(`Failed to load tileset: ${tilesetType}`)
      }

    } catch (error) {
      console.error("Error loading tileset:", error)
      alert(`Error loading tileset: ${error.message}`)
    } finally {
      button.textContent = originalText
      button.disabled = false
    }
  }

  setPosition(position) {
    const margin = "10px"

    switch (position) {
      case 'top-left':
        this.container.style.top = margin
        this.container.style.left = margin
        break
      case 'top-right':
        this.container.style.top = margin
        this.container.style.right = margin
        break
      case 'bottom-left':
        this.container.style.bottom = margin
        this.container.style.left = margin
        break
      case 'bottom-right':
      default:
        this.container.style.bottom = margin
        this.container.style.right = margin
        break
    }
  }

  setVisible(visible) {
    this.visible = visible
    this.container.style.display = visible ? 'block' : 'none'
  }

  updateInfo() {
    if (!this.tiles3DManager) return

    const info = this.tiles3DManager.getInfo()
    const tilesetNames = Object.keys(info.tilesets)

    const infoText = `Enabled: ${info.enabled} | Tilesets: ${tilesetNames.length}`

    if (this.options.compact) {
      const infoEl = document.getElementById("tiles3DCompactInfo")
      if (infoEl) infoEl.textContent = infoText
    } else {
      const infoEl = document.getElementById("tiles3DFullInfo")
      if (infoEl) infoEl.textContent = infoText
    }
  }

  dispose() {
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container)
    }
  }
}