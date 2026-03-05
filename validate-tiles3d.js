#!/usr/bin/env node

/**
 * 3D Tiles Integration Validator
 *
 * Überprüft die korrekte Installation und Konfiguration der 3D Tiles Integration
 */

const fs = require('fs')
const path = require('path')

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
}

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`)
}

function checkFile(filePath, description) {
  if (fs.existsSync(filePath)) {
    log(`✓ ${description}`, 'green')
    return true
  } else {
    log(`✗ ${description} - NOT FOUND: ${filePath}`, 'red')
    return false
  }
}

function checkContent(filePath, searchString, description) {
  if (!fs.existsSync(filePath)) {
    log(`✗ ${description} - File not found`, 'red')
    return false
  }

  const content = fs.readFileSync(filePath, 'utf8')
  if (content.includes(searchString)) {
    log(`✓ ${description}`, 'green')
    return true
  } else {
    log(`✗ ${description} - Content not found`, 'red')
    return false
  }
}

function checkDependency(packageJson, depName, description) {
  if (packageJson.dependencies && packageJson.dependencies[depName]) {
    log(`✓ ${description}: ${packageJson.dependencies[depName]}`, 'green')
    return true
  } else {
    log(`✗ ${description} - NOT FOUND in dependencies`, 'red')
    return false
  }
}

function main() {
  log('\n=== 3D Tiles Integration Validator ===\n', 'cyan')

  let allGood = true

  // Check Dependencies
  log('1. Checking Dependencies...', 'blue')
  allGood = checkFile('package.json', 'package.json exists') && allGood

  if (fs.existsSync('package.json')) {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    allGood = checkDependency(packageJson, '@nasa/3d-tiles-renderer', '3D Tiles Renderer dependency') && allGood
  }

  log('')

  // Check Core Files
  log('2. Checking Core Files...', 'blue')
  allGood = checkFile('client/engine/debug/Tiles3DManager.js', 'Tiles3DManager.js exists') && allGood
  allGood = checkFile('client/engine/debug/Tiles3DUI.js', 'Tiles3DUI.js exists') && allGood
  allGood = checkFile('client/main.js', 'main.js exists') && allGood
  allGood = checkFile('client/index.html', 'index.html exists') && allGood

  log('')

  // Check Configuration
  log('3. Checking Configuration...', 'blue')

  const indexHtmlPath = 'client/index.html'
  allGood = checkContent(indexHtmlPath, 'type="importmap"', 'Import Map defined in index.html') && allGood
  allGood = checkContent(indexHtmlPath, '@nasa/3d-tiles-renderer', '3D Tiles Renderer in Import Map') && allGood

  const mainJsPath = 'client/main.js'
  allGood = checkContent(mainJsPath, 'Tiles3DManager', 'Tiles3DManager imported in main.js') && allGood
  allGood = checkContent(mainJsPath, 'Tiles3DUI', 'Tiles3DUI imported in main.js') && allGood
  allGood = checkContent(mainJsPath, 'tiles3DManager = new Tiles3DManager', 'Tiles3DManager instantiated') && allGood
  allGood = checkContent(mainJsPath, 'tiles3DUI = new Tiles3DUI', 'Tiles3DUI instantiated') && allGood
  allGood = checkContent(mainJsPath, 'tiles3DManager.update()', 'Tiles3DManager updated in render loop') && allGood
  allGood = checkContent(mainJsPath, 'tiles3DUI.updateInfo()', 'Tiles3DUI updated in render loop') && allGood

  log('')

  // Check Exports
  log('4. Checking Exports...', 'blue')
  const debugSceneBuilderPath = 'client/engine/debug/DebugSceneBuilder.js'
  allGood = checkContent(debugSceneBuilderPath, 'Tiles3DManager', 'Tiles3DManager exported from DebugSceneBuilder') && allGood
  allGood = checkContent(debugSceneBuilderPath, 'Tiles3DUI', 'Tiles3DUI exported from DebugSceneBuilder') && allGood

  log('')

  // Check Debug UI Integration
  log('5. Checking Debug UI Integration...', 'blue')
  const debugUIManagerPath = 'client/engine/debug/DebugUIManager.js'
  allGood = checkContent(debugUIManagerPath, 'tiles3DManager', 'Tiles3DManager parameter in DebugUIManager') && allGood
  allGood = checkContent(debugUIManagerPath, 'tiles3DToggle', '3D Tiles toggle in Debug UI') && allGood
  allGood = checkContent(debugUIManagerPath, 'loadTilesetBtn', 'Load tileset button in Debug UI') && allGood

  log('')

  // Summary
  log('=================================', 'cyan')
  if (allGood) {
    log('✓ All 3D Tiles integration checks passed!', 'green')
    log('\nNext steps:', 'yellow')
    log('1. Run: npm install')
    log('2. Start server: npm run dev-server')
    log('3. Open browser: http://localhost:8080')
    log('4. Look for 3D Tiles UI in bottom-right corner')
    log('5. Try loading a sample tileset!')
  } else {
    log('✗ Some checks failed. Please review the errors above.', 'red')
    log('\nCommon fixes:', 'yellow')
    log('• Run: npm install @nasa/3d-tiles-renderer')
    log('• Check that all files were created correctly')
    log('• Verify import statements in main.js')
    log('• Check Import Map in index.html')
  }

  log('\nFor detailed documentation, see: TILES3D_INTEGRATION.md', 'blue')
  log('')

  // Additional info
  log('Available Tilesets:', 'blue')
  log('• Sample Dataset (NASA) - No API key required')
  log('• OSM Buildings (Cesium) - May require Cesium Ion token')
  log('• Photorealistic (Google) - Requires Google Maps API key')
  log('')
}

if (require.main === module) {
  main()
}

module.exports = { checkFile, checkContent, checkDependency }