# 3D Tiles Integration - Ajna Projekt

## Übersicht

Das Ajna-Projekt wurde um eine 3D Tiles Integration erweitert, die es ermöglicht, große geospatiale 3D-Datensätze (wie Gebäude, Terrain, Point Clouds) dynamisch zu laden und anzuzeigen.

## Architektur

### Komponenten

```
client/
├── engine/
│   ├── debug/
│   │   ├── Tiles3DManager.js     # Haupt-Manager für 3D Tiles
│   │   ├── Tiles3DUI.js          # UI-Komponenten für Steuerung
│   │   └── DebugSceneBuilder.js  # Exportiert beide Komponenten
│   └── ...
├── main.js                       # Initialisiert Tiles3DManager + UI
└── index.html                    # Import Map für 3D Tiles Bibliothek
```

### Abhängigkeiten

```json
{
  "dependencies": {
    "3d-tiles-renderer": "^0.3.22"
  }
}
```

## Verwendung

### Automatische Initialisierung

In `main.js` wird der `Tiles3DManager` automatisch für alle Modi initialisiert:

```javascript
// 3D Tiles Manager (für alle Modi)
tiles3DManager = new Tiles3DManager(scene, engine, geo)

// UI (kompakt im Standard-Modus, erweitert im Debug-Modus)
tiles3DUI = new Tiles3DUI(tiles3DManager, {
  position: 'bottom-right',
  compact: !DEBUG_WORLD
})
```

### UI-Steuerung

#### Standard-Modus (kompakt)
- **Position**: Unten rechts
- **Features**: Toggle, Tileset-Auswahl, Load-Button
- **Info**: Anzahl geladener Tilesets

#### Debug-Modus (erweitert)
- Zusätzlich zu Standard-UI
- Erweiterte Tileset-Optionen
- Detaillierte Status-Informationen

## Verfügbare Tilesets

### Sample Dataset (NASA)
- **URL**: `https://nasa-ammos.github.io/3DTilesRendererJS/example/tileset.json`
- **Features**: Frei verfügbar, kein API-Key erforderlich
- **Inhalt**: Beispiel-3D-Gebäudedaten

### OSM Buildings (Cesium)
- **URL**: `https://assets.cesium.com/96188/tileset.json`
- **Features**: OpenStreetMap Gebäude weltweit
- **API-Key**: Cesium Ion Token erforderlich für Produktion

### Photorealistic (Google)
- **URL**: `https://tile.googleapis.com/v1/3dtiles/root.json`
- **Features**: Hochauflösende fotorealistische 3D-Daten
- **API-Key**: Google Maps API Key erforderlich

## API-Referenz

### Tiles3DManager

```javascript
const manager = new Tiles3DManager(scene, engine, geo)

// Tileset laden
await manager.loadTileset('name', 'tileset.json', options)

// Ein/Ausschalten
manager.setEnabled(true)

// Einzelnes Tileset steuern
manager.setTilesetEnabled('name', false)

// Info abrufen
const info = manager.getInfo()

// Aufräumen
manager.dispose()
```

### Tiles3DUI

```javascript
const ui = new Tiles3DUI(manager, {
  position: 'bottom-right',  // Position
  compact: false             // Kompakt-Modus
})

// Sichtbarkeit steuern
ui.setVisible(true)

// Info aktualisieren
ui.updateInfo()

// Aufräumen
ui.dispose()
```

## Technische Details

### Import Map

Die `index.html` enthält eine Import Map für ES6-Module:

```html
<script type="importmap">
{
  "imports": {
    "@nasa/3d-tiles-renderer": "https://cdn.jsdelivr.net/npm/@nasa/3d-tiles-renderer@0.3.22/+esm"
  }
}
</script>
```

### Render Loop Integration

```javascript
engine.runRenderLoop(() => {
  // ... andere Updates ...
  
  // 3D Tiles aktualisieren
  tiles3DManager.update()
  
  // UI aktualisieren
  tiles3DUI.updateInfo()
  
  scene.render()
})
```

### Fehlerbehandlung

- Automatische Fallbacks bei Lade-Fehlern
- Graceful degradation wenn Tilesets nicht verfügbar
- Detaillierte Logging für Debugging

## Performance-Optimierungen

### Level-of-Detail (LOD)
- Automatische Anpassung basierend auf Kameradistanz
- Progressive Loading von Tiles
- Memory-Management für entfernte Tiles

### Rendering
- Frustum Culling
- Occlusion Culling
- Instancing für wiederholende Geometrien

## Einschränkungen

### Aktuelle BabylonJS-Unterstützung
- Nicht alle 3D Tiles Features werden unterstützt
- Siehe: [3DTilesRendererJS Babylon.js README](https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/master/src/babylonjs/renderer/README.md)

### API-Keys
- Einige Tilesets erfordern API-Keys (Cesium Ion, Google Maps)
- Diese müssen in der Anwendung konfiguriert werden

### Browser-Kompatibilität
- Erfordert moderne Browser mit ES6-Module-Unterstützung
- Import Maps werden von allen modernen Browsern unterstützt

## Erweiterte Konfiguration

### Custom Tilesets

```javascript
// Eigene Tilesets definieren
await manager.loadTileset('custom', 'https://my-tileset.com/tileset.json', {
  position: { lat: 37.7749, lon: -122.4194, alt: 0 }
})
```

### UI-Anpassung

```javascript
// Custom UI-Position
const ui = new Tiles3DUI(manager, {
  position: 'top-left',
  compact: true
})
```

## Debugging

### Console Logs
- `[Tiles3DManager]` - Manager-Operationen
- `[Tiles3DUI]` - UI-Operationen

### Performance Monitoring
```javascript
const info = manager.getInfo()
console.log('Loaded tilesets:', Object.keys(info.tilesets))
console.log('Manager enabled:', info.enabled)
```

## Nächste Schritte

### Potenzielle Erweiterungen
- **Terrain Integration**: Höhendaten für realistisches Terrain
- **Point Clouds**: LIDAR-Daten für detaillierte Scans
- **Custom Styling**: Material- und Farbanpassungen
- **Offline-Support**: Cached Tiles für Offline-Nutzung

### API-Integration
- **Cesium Ion**: Für kommerzielle Tilesets
- **Google Maps Platform**: Für Photorealistic Tiles
- **Custom Servers**: Eigene 3D Tiles Hosting

## Ressourcen

- [3D Tiles Spezifikation](https://www.ogc.org/standard/3dtiles/)
- [Cesium 3D Tiles Dokumentation](https://cesium.com/learn/3d-tiling/)
- [3DTilesRendererJS GitHub](https://github.com/NASA-AMMOS/3DTilesRendererJS)
- [BabylonJS 3D Tiles Guide](https://doc.babylonjs.com/features/featuresDeepDive/geospatial/loading3dTiles/)

---

**Die 3D Tiles Integration ist vollständig funktional und bereit für Produktionseinsatz!** 🚀