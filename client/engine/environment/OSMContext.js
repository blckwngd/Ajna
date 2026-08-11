// OSMContext — minimale Geo-Kontext-Darstellung in der AR-Szene.
//
// Holt sich Straßen-Polylines und Gebäude-Footprints aus der Ajna-Geo-API
// (`/ajnaapi/geo/{ways,buildings}`) und zeichnet sie als Wireframe in
// die Babylon-Szene:
//
//   • Straßen   → CreateLineSystem (eine Mesh-Instanz, viele Polylines)
//   • Gebäude   → CreateLineSystem mit Footprint + Dach + Vertikalen-Kanten;
//                 Höhe über client/core/buildingHeight.js — explizite OSM-Höhe,
//                 sonst Geschosse, sonst geschätzt aus der Gebäudeart
//                 (`building=church|garage|…`), sonst Default. Dieselbe Quelle
//                 nutzt die Drachen-Landung, damit er auf dem Dach aufsetzt,
//                 das man auch sieht.
//
// "Simpelstmögliche Darstellung": kein Material-Setup, keine Polygon-
// Extrusion (das braucht earcut als Dependency), keine Tile-Pyramide.
// Funktioniert direkt mit @babylonjs/core ohne Zusatzpaket.
//
// Aufruf: `new OSMContext(...).load(lat, lon)` nach Geo-Origin-Fix.
// Bei Fehlern (Auth-401 etc.) wird einmal still ge-warned, kein Reload-
// Loop. `dispose()` räumt die Meshes auf.

import { buildingHeightM, heightSource } from '../../core/buildingHeight.js'
import { applyLayer } from '../../core/debugLayers.js'

const DEFAULT_RADIUS_M = 300
const STREET_Y = 0.05          // leicht über Ground, gegen Z-Fighting
const BUILDING_Y_OFFSET = 0.0

const STREET_COLOR   = new BABYLON.Color4(1.0, 0.85, 0.3, 0.9)
const BUILDING_COLOR = new BABYLON.Color4(0.55, 0.7, 1.0, 0.85)

// ── Bänder statt Haarlinien ────────────────────────────────────────────────
// Straßen/Gewässer werden als flache, gemergte Bänder auf dem Boden gezeichnet:
// deutlich besser lesbar als 1-px-Linien (die in AR gegen das Kamerabild fast
// verschwinden) und trotzdem EIN Draw Call pro Kategorie. Breiten sind
// Darstellungs-, keine Katasterwerte — sie sollen die Hierarchie zeigen
// (Autobahn breit, Feldweg schmal).
const CLASS_STYLE = {
  motorway:      { w: 14, c: '#ff8a3d', y: 0.06 },
  trunk:         { w: 12, c: '#ff8a3d', y: 0.06 },
  primary:       { w: 10, c: '#ffb300', y: 0.055 },
  secondary:     { w: 8,  c: '#ffc94a', y: 0.05 },
  tertiary:      { w: 7,  c: '#ffd54a', y: 0.05 },
  residential:   { w: 6,  c: '#ffd54a', y: 0.045 },
  unclassified:  { w: 5,  c: '#ffd54a', y: 0.045 },
  living_street: { w: 5,  c: '#ffdf7a', y: 0.045 },
  service:       { w: 3.5, c: '#e0c98a', y: 0.04 },
  pedestrian:    { w: 4,  c: '#c8e6a0', y: 0.04 },
  footway:       { w: 1.8, c: '#8bc34a', y: 0.035 },
  path:          { w: 1.6, c: '#8bc34a', y: 0.035 },
  cycleway:      { w: 2,  c: '#7cc4e0', y: 0.035 },
  track:         { w: 2.5, c: '#b3a06a', y: 0.035 },
  steps:         { w: 1.5, c: '#9ccc65', y: 0.035 },
}
const STREET_FALLBACK = { w: 4, c: '#ffd54a', y: 0.045 }

// Gewässer: Fluss-Mittellinien werden breit gezeichnet (der Rhein ist der
// stärkste Orientierungsanker), Bäche schmal. `width`/`waterway` aus OSM.
const WATER_STYLE = {
  river:  { w: 40, c: '#2196f3' },
  canal:  { w: 16, c: '#29b6f6' },
  stream: { w: 4,  c: '#4fc3f7' },
  drain:  { w: 2,  c: '#4dd0e1' },
  ditch:  { w: 1.5, c: '#4dd0e1' },
}
const WATER_Y = 0.02           // unter den Straßen (Brücken bleiben lesbar)
const RAIL_STYLE = { w: 3, c: '#b0bec5', y: 0.048 }

export class OSMContext {
  /**
   * @param {BABYLON.Scene} scene
   * @param {object} geo       GeoTransformer mit `toLocal(lat, lon, alt)`
   * @param {object} ajnaGeo   AjnaGeo-Instanz
   * @param {{radius?: number}} [opts]
   */
  constructor(scene, geo, ajnaGeo, opts = {}) {
    this.scene   = scene
    this.geo     = geo
    this.ajnaGeo = ajnaGeo
    this.radius  = opts.radius ?? DEFAULT_RADIUS_M
    /** @type {BABYLON.Mesh[]} */
    this.meshes  = []
    this._loaded = false
  }

  /** True, wenn der letzte load() ohne Fehler durchgelaufen ist. */
  get isLoaded() { return this._loaded }

  /**
   * Lädt + zeichnet Straßen und Gebäude im Radius um (lat, lon).
   * Bereits gerenderte Geometrie wird vorher entsorgt.
   */
  async load(lat, lon) {
    this.dispose()

    // Gewässer + Schienen sind eigene Filter derselben ways-Route. Alle vier
    // Abrufe parallel; jeder darf einzeln fehlschlagen (Overpass-Aussetzer
    // sollen nicht die ganze Kulisse kosten).
    const [waysRes, waterRes, railRes, buildingsRes] = await Promise.allSettled([
      this.ajnaGeo.waysNear(lat, lon, this.radius, 'all'),
      this.ajnaGeo.waysNear(lat, lon, this.radius, 'water'),
      this.ajnaGeo.waysNear(lat, lon, this.radius, 'rail'),
      this.ajnaGeo.buildingsNear(lat, lon, this.radius)
    ])

    let wayCount = 0, waterCount = 0, railCount = 0, bldgCount = 0

    // Reihenfolge = Zeichenreihenfolge: Wasser zuunterst, dann Schiene, Straße.
    if (waterRes.status === 'fulfilled') {
      waterCount = this._drawWater(waterRes.value.features || [])
    } else {
      console.warn('[osm] water fetch failed:', waterRes.reason?.message || waterRes.reason)
    }

    if (railRes.status === 'fulfilled') {
      railCount = this._drawRails(railRes.value.features || [])
    } else {
      console.warn('[osm] rail fetch failed:', railRes.reason?.message || railRes.reason)
    }

    if (waysRes.status === 'fulfilled') {
      wayCount = this._drawWays(waysRes.value.features || [])
    } else {
      console.warn('[osm] ways fetch failed:', waysRes.reason?.message || waysRes.reason)
    }

    if (buildingsRes.status === 'fulfilled') {
      bldgCount = this._drawBuildings(buildingsRes.value.features || [])
    } else {
      console.warn('[osm] buildings fetch failed:', buildingsRes.reason?.message || buildingsRes.reason)
    }

    // Frisch gezeichnete Meshes an die gespeicherte Debug-Sichtbarkeit angleichen
    // — sonst käme ein ausgeblendetes Overlay nach jedem Reload zurück.
    applyLayer(this.scene, 'ways')
    applyLayer(this.scene, 'water')
    applyLayer(this.scene, 'buildings')

    this._loaded = wayCount > 0 || bldgCount > 0 || waterCount > 0
    console.log(`[osm] drawn: ${wayCount} ways, ${waterCount} Gewässer, ${railCount} Gleise, ${bldgCount} buildings, radius ${this.radius} m`)
  }

  // ───────────────────────────────────────────────────────────────────
  //  Band-Geometrie: Polylinie → flaches Band auf dem Boden
  //
  //  Pro Stützpunkt zwei Eckpunkte senkrecht zur (gemittelten) Laufrichtung —
  //  ergibt ein durchgehendes Band ohne Lücken in Kurven. Alle Bänder einer
  //  Kategorie landen in EINER VertexData → ein Draw Call.
  // ───────────────────────────────────────────────────────────────────

  /**
   * Hängt ein Band an die Puffer an.
   * @param {{positions:number[], indices:number[], colors:number[]}} buf
   * @param {BABYLON.Vector3[]} pts  Stützpunkte (bereits lokal, y gesetzt)
   * @param {number} width           Bandbreite in Metern
   * @param {BABYLON.Color3} col
   */
  _appendRibbon(buf, pts, width, col) {
    if (pts.length < 2) return
    const half = Math.max(0.2, width / 2)
    const base = buf.positions.length / 3

    for (let i = 0; i < pts.length; i++) {
      // Laufrichtung: Mittel aus ein- und auslaufendem Segment (Kurven-Glättung).
      const prev = pts[Math.max(0, i - 1)]
      const next = pts[Math.min(pts.length - 1, i + 1)]
      let dx = next.x - prev.x, dz = next.z - prev.z
      const len = Math.hypot(dx, dz) || 1
      dx /= len; dz /= len
      // Senkrechte in der XZ-Ebene
      const nx = -dz * half, nz = dx * half
      const p = pts[i]
      buf.positions.push(p.x + nx, p.y, p.z + nz)
      buf.positions.push(p.x - nx, p.y, p.z - nz)
      for (let k = 0; k < 2; k++) buf.colors.push(col.r, col.g, col.b, 1)
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = base + i * 2
      buf.indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }

  /** Baut aus den Puffern ein unbeleuchtetes, gemergtes Mesh. */
  _buildRibbonMesh(name, buf) {
    if (!buf.indices.length) return null
    const mesh = new BABYLON.Mesh(name, this.scene)
    const vd = new BABYLON.VertexData()
    vd.positions = buf.positions
    vd.indices = buf.indices
    vd.colors = buf.colors
    // Normalen zeigen alle nach oben — die Bänder liegen flach.
    vd.normals = new Array(buf.positions.length).fill(0)
    for (let i = 1; i < vd.normals.length; i += 3) vd.normals[i] = 1
    vd.applyToMesh(mesh)

    const mat = new BABYLON.StandardMaterial(`${name}_mat`, this.scene)
    mat.disableLighting = true          // gleichmäßig hell — auch nachts/in AR lesbar
    mat.emissiveColor = new BABYLON.Color3(1, 1, 1)   // Farbe kommt aus den Vertex-Farben
    mat.diffuseColor = new BABYLON.Color3(0, 0, 0)
    mat.specularColor = new BABYLON.Color3(0, 0, 0)
    mat.backFaceCulling = false
    mat.alpha = 0.75
    mesh.material = mat
    mesh.isPickable = false
    mesh.useVertexColors = true
    this.meshes.push(mesh)
    return mesh
  }

  // ───────────────────────────────────────────────────────────────────

  // Straßen als Bänder, Breite + Farbe nach OSM-Klasse (highway=*). So ist auf
  // einen Blick erkennbar, was Hauptstraße und was Trampelpfad ist.
  _drawWays(features) {
    const buf = { positions: [], indices: [], colors: [] }
    let n = 0
    for (const f of features) {
      if (!Array.isArray(f.coordinates) || f.coordinates.length < 2) continue
      const st = CLASS_STYLE[f.tags?.highway] || STREET_FALLBACK
      // Explizite Fahrbahnbreite aus OSM schlägt die Klassen-Schätzung.
      const tagged = parseFloat(f.tags?.width)
      const w = Number.isFinite(tagged) && tagged > 0 ? tagged : st.w
      this._appendRibbon(buf, this._toLocalPoints(f.coordinates, st.y), w,
        BABYLON.Color3.FromHexString(st.c))
      n++
    }
    return this._buildRibbonMesh('osm_ways', buf) ? n : 0
  }

  // Gewässer: breite blaue Bänder. Der Fluss ist in der 3D-Ansicht der
  // verlässlichste Orientierungsanker — deshalb bewusst großzügig breit.
  _drawWater(features) {
    const buf = { positions: [], indices: [], colors: [] }
    let n = 0
    for (const f of features) {
      if (!Array.isArray(f.coordinates) || f.coordinates.length < 2) continue
      const st = WATER_STYLE[f.tags?.waterway] || WATER_STYLE.stream
      const tagged = parseFloat(f.tags?.width)
      const w = Number.isFinite(tagged) && tagged > 0 ? tagged : st.w
      this._appendRibbon(buf, this._toLocalPoints(f.coordinates, WATER_Y), w,
        BABYLON.Color3.FromHexString(st.c))
      n++
    }
    const mesh = this._buildRibbonMesh('osm_water', buf)
    if (mesh) mesh.material.alpha = 0.55   // Wasser etwas transparenter
    return mesh ? n : 0
  }

  _drawRails(features) {
    const buf = { positions: [], indices: [], colors: [] }
    let n = 0
    for (const f of features) {
      if (!Array.isArray(f.coordinates) || f.coordinates.length < 2) continue
      this._appendRibbon(buf, this._toLocalPoints(f.coordinates, RAIL_STYLE.y),
        RAIL_STYLE.w, BABYLON.Color3.FromHexString(RAIL_STYLE.c))
      n++
    }
    return this._buildRibbonMesh('osm_rails', buf) ? n : 0
  }

  _drawBuildings(features) {
    const lines = []
    // Woher stammen die Höhen? OSM ist je nach Gegend sehr unterschiedlich
    // getaggt — diese Zeile zeigt beim Laden, ob echte Angaben ankommen oder
    // fast alles geschätzt wird. Spart die Rätselei „warum sieht das so aus".
    const srcCount = {}
    for (const f of features) {
      if (!Array.isArray(f.coordinates) || f.coordinates.length < 3) continue

      // Footprint immer geschlossen — Overpass liefert das normalerweise,
      // aber wir machen sicher.
      let coords = f.coordinates
      const first = coords[0], last = coords[coords.length - 1]
      if (first[0] !== last[0] || first[1] !== last[1]) {
        coords = [...coords, first]
      }

      const height = buildingHeightM(f.tags)
      const src = heightSource(f.tags); srcCount[src] = (srcCount[src] || 0) + 1
      const ground = this._toLocalPoints(coords, BUILDING_Y_OFFSET)
      const roof   = ground.map(p => new BABYLON.Vector3(p.x, height, p.z))

      lines.push(ground)
      lines.push(roof)
      // Vertikale Kanten: letzten Punkt überspringen (ist Duplikat von [0])
      for (let i = 0; i < ground.length - 1; i++) {
        lines.push([ground[i], roof[i]])
      }
    }
    if (Object.keys(srcCount).length) {
      const legend = { height: 'getaggt', levels: 'Geschosse', type: 'aus Gebäudeart', default: 'Default' }
      console.log('[osm] Gebäudehöhen: ' +
        Object.entries(srcCount).sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${n}× ${legend[k] || k}`).join(', '))
    }
    if (lines.length === 0) return 0

    const mesh = BABYLON.MeshBuilder.CreateLineSystem(
      'osm_buildings', { lines, useVertexAlpha: false }, this.scene
    )
    mesh.color = BUILDING_COLOR
    mesh.isPickable = false
    this.meshes.push(mesh)

    // Die Anzahl der Gebäude approximieren wir aus der Anzahl an
    // "Footprint+Dach"-Paaren — die Vertikalen-Kanten gehören dazu.
    return features.filter(f => Array.isArray(f.coordinates) && f.coordinates.length >= 3).length
  }

  _toLocalPoints(coords, y) {
    return coords.map(([lat, lon]) => {
      const v = this.geo.toLocal(lat, lon, 0)
      return new BABYLON.Vector3(v.x, y, v.z)
    })
  }

  dispose() {
    for (const m of this.meshes) {
      try { m.dispose() } catch {}
    }
    this.meshes = []
    this._loaded = false
  }
}

