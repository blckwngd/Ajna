// Sichtbarkeit der Debug-Overlays: Bodengitter, Koordinatenachsen, Gebäude-
// umrisse, Straßenzüge (OSM/Overpass). Gerätelokal gespeichert, Default = an.
//
// EINE Quelle für drei Leser: der Umschalter (DebugUIManager), der die OSM-
// Overlays zeichnende OSMContext und der die Szene aufbauende DebugSceneBuilder.
// Warum zentral: die OSM-Meshes werden bei jedem Overpass-Load NEU erzeugt —
// ohne diese gemeinsame Präferenz käme ein ausgeblendetes Overlay nach jedem
// Reload/Origin-Wechsel wieder zurück. So wendet der Erzeuger die gespeicherte
// Sichtbarkeit direkt beim (Neu-)Zeichnen an.

export const DEBUG_LAYERS = [
  // Bodengitter hat ZWEI mögliche Träger: die flache 5000-m-Ersatzebene
  // (debugGround) und — sobald ein Relief geladen ist — das darüber drapierte
  // Gitter (terrainGrid). Steht das Relief, gilt nur noch das drapierte; die
  // flache Ebene schnitte sonst quer durch jeden Hang. Terrain schaltet
  // debugGround beim Laden ab und beim Verwerfen wieder ein.
  { key: 'grid',      label: 'Bodengitter',
    meshes: scene => (scene.getMeshByName?.('terrainGrid') ? ['terrainGrid'] : ['debugGround']) },
  { key: 'axes',      label: 'Koordinatenachsen', meshes: ['axisX', 'axisY', 'axisZ'] },
  { key: 'buildings', label: 'Gebäudeumrisse',    meshes: ['osm_buildings'] },
  { key: 'ways',      label: 'Straßenzüge',       meshes: ['osm_ways', 'osm_rails'] },
  { key: 'water',     label: 'Gewässer',          meshes: ['osm_water', 'osm_water_area'] },
  { key: 'terrain',   label: 'Geländerelief',     meshes: ['terrain'] },
]

const skey = k => `ajna.debug.layer.${k}`

/** Sichtbarkeit einer Ebene (Default: an, wenn nie gesetzt). */
export function layerVisible(key) {
  try { const v = localStorage.getItem(skey(key)); return v === null ? true : v === '1' } catch { return true }
}

export function setLayerVisible(key, on) {
  try { localStorage.setItem(skey(key), on ? '1' : '0') } catch {}
}

/** Gespeicherte Sichtbarkeit auf die (evtl. gerade neu erzeugten) Meshes anwenden. */
export function applyLayer(scene, key) {
  const def = DEBUG_LAYERS.find(l => l.key === key)
  if (!def || !scene) return
  const on = layerVisible(key)
  const names = typeof def.meshes === 'function' ? def.meshes(scene) : def.meshes
  for (const name of names) scene.getMeshByName?.(name)?.setEnabled(on)
}

export function applyAllLayers(scene) {
  for (const l of DEBUG_LAYERS) applyLayer(scene, l.key)
}
