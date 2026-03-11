/**
 * Tiles3DUI - UI Component for 3D Tiles Control using BabylonJS GUI
 *
 * Can be used in both debug and standard mode
 */

export class Tiles3DUI {
  constructor(tiles3DManager, engine, scene, options = {}) {
    this.tiles3DManager = tiles3DManager
    this.engine = engine
    this.scene = scene
    this.options = {
      position: 'bottom-right', // 'top-left', 'top-right', 'bottom-left', 'bottom-right'
      compact: false,
      ...options
    }

    this.guiTexture = null
    this.rootPanel = null
    this.visible = true
    this.buildUI()
  }

  buildUI() {
    // Create the GUI texture
    this.guiTexture = GUI.AdvancedDynamicTexture.CreateFullscreenUI("TilesUI", true, this.scene)

    // Create root panel for the UI
    this.rootPanel = new GUI.StackPanel()
    this.rootPanel.width = "250px"
    this.rootPanel.verticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_BOTTOM
    this.rootPanel.horizontalAlignment = this.getHorizontalAlignment()
    this.rootPanel.paddingLeftInPixels = 10
    this.rootPanel.paddingRightInPixels = 10
    this.rootPanel.paddingTopInPixels = 10
    this.rootPanel.paddingBottomInPixels = 10
    this.rootPanel.spacing = 8

    this.guiTexture.addControl(this.rootPanel)

    if (this.options.compact) {
      this.buildCompactUI()
    } else {
      this.buildFullUI()
    }
  }

  getHorizontalAlignment() {
    if (this.options.position.includes('left')) {
      return GUI.Control.HORIZONTAL_ALIGNMENT_LEFT
    }
    return GUI.Control.HORIZONTAL_ALIGNMENT_RIGHT
  }

  buildCompactUI() {
    // Title
    const titleBlock = new GUI.TextBlock()
    titleBlock.text = "3D Tiles"
    titleBlock.height = "30px"
    titleBlock.fontSize = 14
    titleBlock.fontWeight = "bold"
    titleBlock.color = "white"
    this.rootPanel.addControl(titleBlock)

    // Enable toggle - horizontal panel for checkbox and label
    const togglePanel = new GUI.StackPanel()
    togglePanel.isVertical = false
    togglePanel.spacing = 8
    togglePanel.height = "30px"
    this.rootPanel.addControl(togglePanel)

    const toggleCheckbox = new GUI.Checkbox()
    toggleCheckbox.width = "20px"
    toggleCheckbox.height = "20px"
    toggleCheckbox.isChecked = false
    toggleCheckbox.onIsCheckedChangedObservable.add((value) => {
      if (this.tiles3DManager) {
        this.tiles3DManager.setEnabled(value)
      }
    })
    togglePanel.addControl(toggleCheckbox)

    const toggleLabel = new GUI.TextBlock()
    toggleLabel.text = "Enable"
    toggleLabel.fontSize = 12
    toggleLabel.color = "white"
    toggleLabel.verticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_CENTER
    togglePanel.addControl(toggleLabel)

    // Tileset selector
    const selectPanel = new GUI.StackPanel()
    selectPanel.isVertical = true
    selectPanel.spacing = 6
    selectPanel.width = "100%"
    this.rootPanel.addControl(selectPanel)

    const sampleBtn = GUI.Button.CreateSimpleButton("sample", "Sample Tiles")
    sampleBtn.width = "100%"
    sampleBtn.height = "25px"
    sampleBtn.fontSize = 11
    sampleBtn.background = "rgba(100,150,200,0.5)"
    sampleBtn.color = "white"
    sampleBtn.cornerRadius = 4
    sampleBtn.onPointerClickObservable.add(() => {
      this.handleCompactSelection("sample", sampleBtn)
    })
    selectPanel.addControl(sampleBtn)
    this.sampleBtn = sampleBtn

    const osmBtn = GUI.Button.CreateSimpleButton("osm", "OSM Buildings")
    osmBtn.width = "100%"
    osmBtn.height = "25px"
    osmBtn.fontSize = 11
    osmBtn.background = "rgba(100,150,200,0.5)"
    osmBtn.color = "white"
    osmBtn.cornerRadius = 4
    osmBtn.onPointerClickObservable.add(() => {
      this.handleCompactSelection("osm-buildings", osmBtn)
    })
    selectPanel.addControl(osmBtn)
    this.osmBtn = osmBtn

    // Info display
    this.infoBlock = new GUI.TextBlock()
    this.infoBlock.text = "Ready"
    this.infoBlock.height = "40px"
    this.infoBlock.fontSize = 10
    this.infoBlock.color = "#ccc"
    this.infoBlock.textWrapping = true
    this.rootPanel.addControl(this.infoBlock)
  }

  handleCompactSelection(tilesetType, button) {
    this.loadTileset(tilesetType, button)
  }

  buildFullUI() {
    // Title
    const titleBlock = new GUI.TextBlock()
    titleBlock.text = "3D Tiles Control"
    titleBlock.height = "30px"
    titleBlock.fontSize = 14
    titleBlock.fontWeight = "bold"
    titleBlock.color = "white"
    this.rootPanel.addControl(titleBlock)

    // Enable toggle
    const togglePanel = new GUI.StackPanel()
    togglePanel.isVertical = false
    togglePanel.spacing = 8
    togglePanel.height = "30px"
    this.rootPanel.addControl(togglePanel)

    const toggleCheckbox = new GUI.Checkbox()
    toggleCheckbox.width = "20px"
    toggleCheckbox.height = "20px"
    toggleCheckbox.isChecked = false
    toggleCheckbox.onIsCheckedChangedObservable.add((value) => {
      if (this.tiles3DManager) {
        this.tiles3DManager.setEnabled(value)
      }
    })
    togglePanel.addControl(toggleCheckbox)

    const toggleLabel = new GUI.TextBlock()
    toggleLabel.text = "Enable 3D Tiles"
    toggleLabel.fontSize = 12
    toggleLabel.color = "white"
    toggleLabel.verticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_CENTER
    togglePanel.addControl(toggleLabel)

    // Tileset selection buttons
    const tilesetLabel = new GUI.TextBlock()
    tilesetLabel.text = "Select Tileset:"
    tilesetLabel.height = "20px"
    tilesetLabel.fontSize = 11
    tilesetLabel.color = "white"
    this.rootPanel.addControl(tilesetLabel)

    const selectPanel = new GUI.StackPanel()
    selectPanel.isVertical = true
    selectPanel.spacing = 6
    selectPanel.width = "100%"
    this.rootPanel.addControl(selectPanel)

    // Sample button
    const sampleBtn = GUI.Button.CreateSimpleButton("sample", "Sample Dataset")
    sampleBtn.width = "100%"
    sampleBtn.height = "30px"
    sampleBtn.fontSize = 12
    sampleBtn.background = "rgba(100,150,200,0.5)"
    sampleBtn.color = "white"
    sampleBtn.cornerRadius = 4
    sampleBtn.onPointerClickObservable.add(() => {
      this.loadTileset("sample", sampleBtn)
    })
    selectPanel.addControl(sampleBtn)
    this.sampleBtn = sampleBtn

    // OSM Buildings button
    const osmBtn = GUI.Button.CreateSimpleButton("osm", "OSM Buildings")
    osmBtn.width = "100%"
    osmBtn.height = "30px"
    osmBtn.fontSize = 12
    osmBtn.background = "rgba(100,150,200,0.5)"
    osmBtn.color = "white"
    osmBtn.cornerRadius = 4
    osmBtn.onPointerClickObservable.add(() => {
      this.loadTileset("osm-buildings", osmBtn)
    })
    selectPanel.addControl(osmBtn)
    this.osmBtn = osmBtn

    // Photorealistic button
    const photoBtn = GUI.Button.CreateSimpleButton("photo", "Photorealistic")
    photoBtn.width = "100%"
    photoBtn.height = "30px"
    photoBtn.fontSize = 12
    photoBtn.background = "rgba(100,150,200,0.5)"
    photoBtn.color = "white"
    photoBtn.cornerRadius = 4
    photoBtn.onPointerClickObservable.add(() => {
      this.loadTileset("photorealistic", photoBtn)
    })
    selectPanel.addControl(photoBtn)
    this.photoBtn = photoBtn

    // Info display
    this.infoBlock = new GUI.TextBlock()
    this.infoBlock.text = "Select a tileset to load"
    this.infoBlock.height = "50px"
    this.infoBlock.fontSize = 10
    this.infoBlock.color = "#ccc"
    this.infoBlock.textWrapping = true
    this.rootPanel.addControl(this.infoBlock)
  }

  async loadTileset(tilesetType, button) {
    if (!tilesetType || !this.tiles3DManager) return

    const originalText = button.text
    button.text = "Loading..."
    button.isEnabled = false

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
          this.updateInfo("Google Photorealistic requires an API key")
          return
      }

      if (tilesetUrl) {
        success = await this.tiles3DManager.loadTileset(tilesetType, tilesetUrl, options)
      }

      if (success) {
        console.log(`Loaded 3D tileset: ${tilesetType}`)
        this.updateInfo(`Loaded: ${tilesetType}`)
      } else {
        console.error(`Failed to load 3D tileset: ${tilesetType}`)
        this.updateInfo(`Failed to load: ${tilesetType}`)
      }

    } catch (error) {
      console.error("Error loading tileset:", error)
      this.updateInfo(`Error: ${error.message}`)
    } finally {
      button.text = originalText
      button.isEnabled = true
    }
  }

  updateInfo(message) {
    if (this.infoBlock) {
      this.infoBlock.text = message
    }
  }

  setPosition(position) {
    // Position is handled by the rootPanel configuration
    if (position.includes('top')) {
      this.rootPanel.verticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_TOP
    } else {
      this.rootPanel.verticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_BOTTOM
    }
  }

  setVisible(visible) {
    this.visible = visible
    this.rootPanel.isVisible = visible
  }
}