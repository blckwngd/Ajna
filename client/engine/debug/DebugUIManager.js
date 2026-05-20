import { TransformComponent } from "../components/TransformComponent.js"

export class DebugUIManager {

  constructor({ scene, geo, gps, player, objectMap, tiles3DManager, onObjectHover = null }) {

    this.scene = scene
    this.geo = geo
    this.gps = gps
    this.player = player
    this.objectMap = objectMap
    this.tiles3DManager = tiles3DManager
    // Hover-Callback (gameObject, hovering) — Highlight im 3D-Raum
    // wird vom Host (main.js) bereitgestellt, nicht hier.
    this.onObjectHover = onObjectHover

    // Cache, um die Object-Liste nur neu zu rendern, wenn sich das
    // Objekt-Set wirklich geändert hat — sonst flackern Klick-Handler.
    this._renderedObjectKeys = ""

    this.buildUI()
    this.startUpdateLoop()
  }

  buildUI() {

    this.container = document.createElement("div")
    this.container.id = "debugPanel"
    this.container.innerHTML = this._html()
    document.body.appendChild(this.container)

    this._injectStyles()
    this._restoreInputs()
    this._syncDummyToggle()

    if (!this.tiles3DManager) {
      this.container.querySelector("#tiles3DSection").style.display = "none"
    }

    this.attachEvents()
  }

  _html() {
    return `
      <header class="dbg-header">
        <h3>Debug Panel</h3>
      </header>

      <section class="dbg-section">
        <div class="dbg-row dbg-toggle">
          <label class="dbg-switch">
            <input type="checkbox" id="dummyToggle">
            <span>Dummy GPS</span>
          </label>
          <span class="dbg-badge" id="gpsSourceBadge">—</span>
        </div>
        <p class="dbg-hint" id="dummyHint"></p>
      </section>

      <section class="dbg-section">
        <h4>Dummy Position</h4>
        <div class="dbg-grid">
          <label>Lat</label><input id="latInput" type="number" step="0.000001">
          <label>Lon</label><input id="lonInput" type="number" step="0.000001">
          <label>Alt</label><input id="altInput" type="number" step="0.1">
        </div>
        <div class="dbg-buttons">
          <button id="setGpsBtn" class="dbg-btn dbg-btn-primary">Apply</button>
          <button id="clearGpsBtn" class="dbg-btn">Clear</button>
        </div>
      </section>

      <section class="dbg-section">
        <h4>Current GPS</h4>
        <pre id="gpsInfo" class="dbg-readout">–</pre>
      </section>

      <section class="dbg-section">
        <h4>Scene Position</h4>
        <pre id="sceneInfo" class="dbg-readout">–</pre>
      </section>

      <section class="dbg-section">
        <div class="dbg-row dbg-list-header">
          <h4>Loaded Objects</h4>
          <span id="objectCount" class="dbg-counter">0</span>
        </div>
        <div id="objectList" class="dbg-object-list"></div>
      </section>

      <section class="dbg-section" id="tiles3DSection">
        <h4>3D Tiles</h4>
        <div class="dbg-row dbg-toggle">
          <label class="dbg-switch">
            <input type="checkbox" id="tiles3DToggle">
            <span>Enable</span>
          </label>
        </div>
        <select id="tilesetSelect" class="dbg-select">
          <option value="">Select Tileset…</option>
          <option value="sample">Sample Dataset (NASA)</option>
          <option value="osm-buildings">OSM Buildings (Cesium)</option>
          <option value="photorealistic">Photorealistic (Google)</option>
        </select>
        <div class="dbg-buttons">
          <button id="loadTilesetBtn" class="dbg-btn dbg-btn-primary">Load</button>
        </div>
        <pre id="tiles3DInfo" class="dbg-readout">–</pre>
      </section>
    `
  }

  _injectStyles() {
    if (document.getElementById("debugPanelStyles")) return

    const style = document.createElement("style")
    style.id = "debugPanelStyles"
    style.textContent = `
      #debugPanel {
        position: absolute; top: 10px; right: 10px;
        width: 300px; max-height: calc(100vh - 20px);
        overflow-y: auto;
        background: rgba(18,18,22,0.92);
        color: #eaeaea;
        font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace;
        padding: 10px 12px;
        border-radius: 8px;
        box-shadow: 0 6px 24px rgba(0,0,0,0.4);
        z-index: 2000;
      }
      #debugPanel .dbg-header h3 {
        margin: 0 0 8px;
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #f1c40f;
      }
      #debugPanel h4 {
        margin: 0 0 6px;
        font-size: 11px;
        color: #aab;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      #debugPanel .dbg-section {
        padding: 8px 0;
        border-top: 1px solid rgba(255,255,255,0.08);
      }
      #debugPanel .dbg-section:first-of-type { border-top: none; }
      #debugPanel .dbg-inline {
        display: flex; align-items: center; justify-content: space-between;
      }
      #debugPanel .dbg-row {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px;
      }
      #debugPanel .dbg-switch {
        display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
      }
      #debugPanel .dbg-switch input { margin: 0; }
      #debugPanel .dbg-grid {
        display: grid; grid-template-columns: 36px 1fr;
        gap: 4px 8px; align-items: center;
        margin-bottom: 6px;
      }
      #debugPanel .dbg-grid label { color: #aab; }
      #debugPanel input[type=number],
      #debugPanel .dbg-select {
        width: 100%; box-sizing: border-box;
        background: #15151a; color: #eaeaea;
        border: 1px solid #2a2a32; border-radius: 4px;
        padding: 3px 6px; font: inherit;
      }
      #debugPanel .dbg-buttons {
        display: flex; gap: 6px; margin-top: 4px;
      }
      #debugPanel .dbg-btn {
        flex: 1; padding: 5px 8px; cursor: pointer;
        background: #2a2a32; color: #eaeaea;
        border: 1px solid #3a3a44; border-radius: 4px;
        font: inherit;
      }
      #debugPanel .dbg-btn:hover { background: #34343d; }
      #debugPanel .dbg-btn:disabled { opacity: 0.5; cursor: default; }
      #debugPanel .dbg-btn-primary {
        background: #2c5d8f; border-color: #3a78b6;
      }
      #debugPanel .dbg-btn-primary:hover { background: #356da6; }
      #debugPanel .dbg-readout {
        margin: 0; padding: 4px 6px;
        background: #15151a; border-radius: 4px;
        white-space: pre-wrap;
        color: #cde;
      }
      #debugPanel .dbg-counter {
        font-weight: bold; color: #f1c40f;
      }
      #debugPanel .dbg-badge {
        font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase;
        padding: 2px 8px; border-radius: 10px;
        background: #444;
      }
      #debugPanel .dbg-badge.real  { background: #2a7a2a; color: #fff; }
      #debugPanel .dbg-badge.dummy { background: #a67014; color: #fff; }
      #debugPanel .dbg-hint {
        margin: 4px 0 0; font-size: 11px; color: #888;
      }
      #debugPanel .dbg-list-header h4 { margin: 0; }
      #debugPanel .dbg-object-list {
        max-height: 140px; overflow-y: auto;
        margin-top: 4px;
        background: #15151a; border-radius: 4px;
      }
      #debugPanel .dbg-object-row {
        padding: 3px 6px; cursor: pointer;
        border-bottom: 1px solid rgba(255,255,255,0.05);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      #debugPanel .dbg-object-row:last-child { border-bottom: none; }
      #debugPanel .dbg-object-row:hover {
        background: #2a2a32; color: #f1c40f;
      }
      #debugPanel .dbg-object-empty {
        padding: 6px; color: #777; font-style: italic; text-align: center;
      }
    `
    document.head.appendChild(style)
  }

  _restoreInputs() {
    // Vorhandene Dummy-Position aus GPSProvider (= localStorage) vorbefüllen,
    // sonst sinnvolle Defaults.
    const dummy = this.gps.getDummyPosition?.() || null

    const latInput = this.container.querySelector("#latInput")
    const lonInput = this.container.querySelector("#lonInput")
    const altInput = this.container.querySelector("#altInput")

    latInput.value = dummy?.lat ?? 50.45131870958352
    lonInput.value = dummy?.lon ?? 7.536272555643111
    altInput.value = dummy?.altitude ?? 0
  }

  _syncDummyToggle() {
    const toggle = this.container.querySelector("#dummyToggle")
    toggle.checked = this.gps.isDummyMode?.() ?? false
    this._updateDummyHint()
  }

  _updateDummyHint() {
    const hint = this.container.querySelector("#dummyHint")
    if (this.gps.isDummyMode?.()) {
      hint.textContent = "Real GPS updates are ignored."
    } else if (this.gps.getDummyPosition?.()) {
      hint.textContent = "Dummy used as boot fallback; real fix takes over."
    } else {
      hint.textContent = "Real GPS active. No dummy set."
    }
  }

  attachEvents() {

    this.container.querySelector("#dummyToggle").addEventListener("change", e => {
      this.gps.enableDummyMode(e.target.checked)
      this._updateDummyHint()
    })

    this.container.querySelector("#setGpsBtn").addEventListener("click", () => {
      const lat = parseFloat(this.container.querySelector("#latInput").value)
      const lon = parseFloat(this.container.querySelector("#lonInput").value)
      const alt = parseFloat(this.container.querySelector("#altInput").value) || 0

      if (Number.isNaN(lat) || Number.isNaN(lon)) return

      this.gps.setDummyPosition(lat, lon, alt)
      this._updateDummyHint()
    })

    this.container.querySelector("#clearGpsBtn").addEventListener("click", () => {
      this.gps.clearDummyPosition()
      this.container.querySelector("#latInput").value = ""
      this.container.querySelector("#lonInput").value = ""
      this.container.querySelector("#altInput").value = ""
      this._updateDummyHint()
    })

    // 3D Tiles
    const tilesToggle = this.container.querySelector("#tiles3DToggle")
    if (tilesToggle) {
      tilesToggle.addEventListener("change", e => {
        if (this.tiles3DManager) this.tiles3DManager.setEnabled(e.target.checked)
      })
    }

    const loadBtn = this.container.querySelector("#loadTilesetBtn")
    if (loadBtn) loadBtn.addEventListener("click", () => this._loadTileset())
  }

  async _loadTileset() {
    const select = this.container.querySelector("#tilesetSelect")
    const tilesetType = select.value
    if (!tilesetType || !this.tiles3DManager) return

    const btn = this.container.querySelector("#loadTilesetBtn")
    const original = btn.textContent
    btn.textContent = "Loading…"
    btn.disabled = true

    try {
      let success = false

      switch (tilesetType) {
        case "sample":
          success = await this.tiles3DManager.loadTileset(
            "sample",
            "https://nasa-ammos.github.io/3DTilesRendererJS/example/tileset.json"
          )
          break

        case "osm-buildings": {
          const worldPos = this.gps.getWorldPosition()
          const opts = worldPos
            ? { position: { lat: worldPos.lat, lon: worldPos.lon, alt: 0 } }
            : undefined
          success = await this.tiles3DManager.loadTileset(
            "osm-buildings",
            "https://assets.cesium.com/96188/tileset.json",
            opts
          )
          break
        }

        case "photorealistic":
          alert("Google Photorealistic 3D Tiles requires an API key. Please configure it in your tileset URL.")
          break
      }

      if (success) {
        this.container.querySelector("#tiles3DToggle").checked = true
        this.tiles3DManager.setEnabled(true)
      }
    } catch (error) {
      console.error("Error loading tileset:", error)
      alert(`Error loading tileset: ${error.message}`)
    } finally {
      btn.textContent = original
      btn.disabled = false
    }
  }

  _renderObjectList() {

    const list = this.container.querySelector("#objectList")
    list.innerHTML = ""

    if (this.objectMap.size === 0) {
      const empty = document.createElement("div")
      empty.className = "dbg-object-empty"
      empty.textContent = "no objects loaded"
      list.appendChild(empty)
      return
    }

    for (const [id, go] of this.objectMap) {
      if (!go) continue

      const row = document.createElement("div")
      row.className = "dbg-object-row"
      row.textContent = go.name || id
      row.title = id
      row.addEventListener("click", () => this._focusOn(go))
      if (typeof this.onObjectHover === "function") {
        row.addEventListener("mouseenter", () => this.onObjectHover(go, true))
        row.addEventListener("mouseleave", () => this.onObjectHover(go, false))
      }
      list.appendChild(row)
    }
  }

  _focusOn(gameObject) {

    const cam = this.scene?.activeCamera
    if (!cam || !gameObject?.root) return

    // Welt-Position des Ziels berechnen — auch wenn das Objekt unter
    // verschachtelten Parents hängt, gibt absolutePosition den Welt-Punkt.
    gameObject.root.computeWorldMatrix(true)
    const target = gameObject.root.absolutePosition.clone()

    // Player-Kamera ist Child des Player-Roots — wir können sie nicht
    // einfach im Welt-Raum repositionieren, ohne den Player mitzuziehen.
    // Daher in dem Fall nur die Blickrichtung anpassen.
    if (cam.parent) {
      cam.setTarget?.(target)
      return
    }

    // Freie Kamera (Debug-FreeCam): hinflieg-Position + Blick auf Ziel.
    // Offset: 5 m südlich (-Z), 3 m über dem Objekt — schaut nach Nord.
    const offset = new BABYLON.Vector3(0, 3, -5)
    cam.position.copyFrom(target.add(offset))
    cam.setTarget?.(target)
  }

  startUpdateLoop() {

    setInterval(() => {

      const gpsInfo = this.container.querySelector("#gpsInfo")
      const sceneInfo = this.container.querySelector("#sceneInfo")
      const objectCount = this.container.querySelector("#objectCount")
      const tiles3DInfo = this.container.querySelector("#tiles3DInfo")
      const badge = this.container.querySelector("#gpsSourceBadge")

      const playerTransform = this.player.getComponent(TransformComponent)
      if (!playerTransform) return

      if (scene?.activeCamera) {
        const p = scene.activeCamera.position
        sceneInfo.textContent =
          `X: ${p.x.toFixed(2)}  Y: ${p.y.toFixed(2)}  Z: ${p.z.toFixed(2)}`
      }

      objectCount.textContent = this.objectMap.size

      // Liste nur rerendern, wenn sich das Objekt-Set tatsächlich
      // geändert hat — sonst zerstören wir bei jedem Tick die Klick-Handler.
      const currentKeys = Array.from(this.objectMap.keys()).sort().join("|")
      if (currentKeys !== this._renderedObjectKeys) {
        this._renderObjectList()
        this._renderedObjectKeys = currentKeys
      }

      const worldPos = this.gps.getWorldPosition()
      if (worldPos) {
        gpsInfo.textContent =
          `Lat: ${worldPos.lat.toFixed(6)}\n` +
          `Lon: ${worldPos.lon.toFixed(6)}\n` +
          `Alt: ${worldPos.altitude.toFixed(2)}`

        const source = worldPos.source || (this.gps.isDummyMode?.() ? "dummy" : "real")
        badge.textContent = source
        badge.className = `dbg-badge ${source}`
      } else {
        gpsInfo.textContent = "no fix yet"
        badge.textContent = "—"
        badge.className = "dbg-badge"
      }

      if (this.tiles3DManager && tiles3DInfo) {
        const info = this.tiles3DManager.getInfo()
        const tilesetNames = Object.keys(info.tilesets)
        tiles3DInfo.textContent =
          `Enabled: ${info.enabled}\nTilesets: ${tilesetNames.length}`
      }

    }, 500)
  }
}
