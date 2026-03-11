/**
 * Tiles3DManager - 3D Tiles Integration for BabylonJS
 *
 * Uses @nasa/3d-tiles-renderer for loading and displaying 3D Tiles datasets
 * Supports multiple tile sets and dynamic loading/unloading
 */

import { TilesRenderer } from '3d-tiles-renderer'

export class Tiles3DManager {
  constructor(scene, engine, geo) {
    this.scene = scene
    this.engine = engine
    this.geo = geo
    this.tilesRenderers = new Map() // name -> TilesRenderer instance
    this.enabled = false
    this._initialized = false

    // Initialize the 3D Tiles system
    this._initTilesRenderer()
  }

  async _initTilesRenderer() {
    try {
      // The 3DTilesRendererJS library handles the heavy lifting
      // We'll create renderers on demand when tile sets are loaded
      this._initialized = true
      console.log('[Tiles3DManager] Initialized successfully')
    } catch (error) {
      console.error('[Tiles3DManager] Initialization failed:', error)
      this._initialized = false
    }
  }

  /**
   * Load a 3D Tiles dataset
   * @param {string} name - Unique identifier for this tile set
   * @param {string} tilesetUrl - URL to the tileset.json file
   * @param {Object} options - Additional options
   */
  async loadTileset(name, tilesetUrl, options = {}) {
    if (!this._initialized) {
      console.warn('[Tiles3DManager] Not initialized yet')
      return false
    }

    try {
      // Remove existing tileset with same name
      if (this.tilesRenderers.has(name)) {
        this.unloadTileset(name)
      }

      // Create new TilesRenderer
      const tilesRenderer = new TilesRenderer(tilesetUrl, this.scene, this.engine)

      // Configure renderer
      //tilesRenderer.setResolutionFromRenderer(this.engine.getRenderWidth(), this.engine.getRenderHeight())
      tilesRenderer.setCamera(this.scene.activeCamera)

      // Set position if provided (convert from lat/lon to world coordinates)
      if (options.position) {
        const worldPos = this.geo.toLocal(options.position.lat, options.position.lon, options.position.alt || 0)
        tilesRenderer.group.position.set(worldPos.x, worldPos.y, worldPos.z)
      }

      // Add to scene
      this.scene.addGeometry(tilesRenderer.group)

      // Store renderer
      this.tilesRenderers.set(name, {
        renderer: tilesRenderer,
        enabled: true,
        options
      })

      console.log(`[Tiles3DManager] Loaded tileset: ${name}`)
      return true

    } catch (error) {
      console.error(`[Tiles3DManager] Failed to load tileset ${name}:`, error)
      return false
    }
  }

  /**
   * Unload a specific tileset
   * @param {string} name - Tileset identifier
   */
  unloadTileset(name) {
    const tileset = this.tilesRenderers.get(name)
    if (tileset) {
      // Remove from scene
      this.scene.remove(tileset.renderer.group)

      // Dispose renderer
      tileset.renderer.dispose()

      // Remove from map
      this.tilesRenderers.delete(name)

      console.log(`[Tiles3DManager] Unloaded tileset: ${name}`)
    }
  }

  /**
   * Enable/disable all tilesets
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this.enabled = enabled

    this.tilesRenderers.forEach((tileset, name) => {
      tileset.renderer.group.setEnabled(enabled)
      console.log(`[Tiles3DManager] ${enabled ? 'Enabled' : 'Disabled'} tileset: ${name}`)
    })
  }

  /**
   * Enable/disable specific tileset
   * @param {string} name - Tileset identifier
   * @param {boolean} enabled
   */
  setTilesetEnabled(name, enabled) {
    const tileset = this.tilesRenderers.get(name)
    if (tileset) {
      tileset.renderer.group.setEnabled(enabled)
      tileset.enabled = enabled
      console.log(`[Tiles3DManager] ${enabled ? 'Enabled' : 'Disabled'} tileset: ${name}`)
    }
  }

  /**
   * Update all tilesets (call this in render loop)
   */
  update() {
    if (!this.enabled || !this._initialized) return

    this.tilesRenderers.forEach((tileset, name) => {
      if (tileset.enabled) {
        try {
          tileset.renderer.update()
        } catch (error) {
          console.warn(`[Tiles3DManager] Update failed for ${name}:`, error)
        }
      }
    })
  }

  /**
   * Handle window resize
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    this.tilesRenderers.forEach(tileset => {
      tileset.renderer.setResolutionFromRenderer(width, height)
    })
  }

  /**
   * Get information about loaded tilesets
   * @returns {Object}
   */
  getInfo() {
    const tilesets = {}
    this.tilesRenderers.forEach((tileset, name) => {
      tilesets[name] = {
        enabled: tileset.enabled,
        options: tileset.options,
        stats: tileset.renderer.getStats ? tileset.renderer.getStats() : null
      }
    })

    return {
      initialized: this._initialized,
      enabled: this.enabled,
      tilesets: tilesets
    }
  }

  /**
   * Dispose all tilesets and clean up
   */
  dispose() {
    this.tilesRenderers.forEach((tileset, name) => {
      this.unloadTileset(name)
    })

    this.tilesRenderers.clear()
    this._initialized = false
    console.log('[Tiles3DManager] Disposed')
  }
}

// Predefined tileset URLs for common datasets
export const TILESET_URLS = {
  // Cesium Ion datasets (require API token)
  CESIUM_OSM_BUILDINGS: 'https://assets.cesium.com/96188/tileset.json',
  CESIUM_SAN_FRANCISCO_BUILDINGS: 'https://assets.cesium.com/44082/tileset.json',

  // Public datasets (no token required)
  NASA_3D_BUILDINGS: 'https://nasa-ammos.github.io/3DTilesRendererJS/example/tileset.json',

  // Google Photorealistic 3D Tiles (requires API key)
  GOOGLE_PHOTOREALISTIC: 'https://tile.googleapis.com/v1/3dtiles/root.json',

  // Custom tilesets can be added here
  CUSTOM_EXAMPLE: 'https://your-tileset-url/tileset.json'
}

// Helper function to create common tilesets
export function createCommonTilesets(manager) {
  return {
    loadOSMBuildings: (lat = 37.7749, lon = -122.4194) => {
      return manager.loadTileset('osm-buildings', TILESET_URLS.CESIUM_OSM_BUILDINGS, {
        position: { lat, lon, alt: 0 }
      })
    },

    loadPhotorealistic: (lat = 37.7749, lon = -122.4194) => {
      return manager.loadTileset('photorealistic', TILESET_URLS.GOOGLE_PHOTOREALISTIC, {
        position: { lat, lon, alt: 0 }
      })
    },

    loadSampleDataset: () => {
      return manager.loadTileset('sample', TILESET_URLS.NASA_3D_BUILDINGS)
    }
  }
}