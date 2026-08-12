// Terrain — echtes Geländerelief unter der Szene.
//
// Bis hierher war die Welt eine Ebene: Der Boden lag flach auf y=0, egal ob
// Rheintal oder Hang. Diese Klasse legt ein Höhengitter darunter, gespeist aus
// den offenen Terrarium-Kacheln (client/core/terrainTiles.js).
//
// BEZUGSPUNKT: die Geländehöhe AM ORIGIN, nicht die GPS-Höhe. Der Spieler
// steht in Ajna auf y=0; das Relief ringsum ist die Differenz dazu. (Die
// GPS-Höhe schwankt um ±10–20 m — als Referenz wäre sie unbrauchbar und
// würde die Landschaft vertikal springen lassen.)
//
// DARSTELLUNG: eine beleuchtete, halbtransparente Fläche in gedecktem Grün —
// die Beleuchtung macht Hänge über Schattierung lesbar, was für die
// Orientierung mehr bringt als jede Linie. Darüber liegt das Bodengitter,
// drapiert auf derselben Geometrie: die flache Ersatzebene des
// DebugSceneBuilders hängt starr bei y=0 und schnitte durch jeden Hang, also
// übernimmt hier ein zweites Mesh mit demselben GridMaterial. Zwei Draw Calls.
//
// GRENZEN: Kachelauflösung ~9,5 m/Pixel (z14) — Geländekanten wie Böschungen
// oder Hohlwege verschwimmen. Objekte werden NICHT auf das Relief gesetzt;
// sie behalten ihre eigene Höhe (das bliebe eine bewusste Design-Entscheidung
// mit Folgen fürs Gameplay).

import { GridMaterial } from '@babylonjs/materials'
import { elevationSampler, despike, TERRAIN_Z, metersPerPixel } from '../../core/terrainTiles.js'
import { applyLayer } from '../../core/debugLayers.js'

const DEFAULT_RADIUS_M = 1200      // Sichtweite des Reliefs (Hänge ringsum)
const DEFAULT_SEGMENTS = 96        // 96² Felder ≈ 25 m Raster bei 1200 m Radius
const TERRAIN_Y = -0.15            // knapp unter Straßenbänder/Bodengitter
const GRID_LIFT = 0.05             // Gitter minimal über der Fläche (Z-Fighting)

export class Terrain {
  /**
   * @param {BABYLON.Scene} scene
   * @param {object} geo   GeoTransformer (toLocal)
   * @param {{radius?: number, segments?: number}} [opts]
   */
  constructor(scene, geo, opts = {}) {
    this.scene = scene
    this.geo = geo
    this.radius = opts.radius ?? DEFAULT_RADIUS_M
    this.segments = Math.max(8, Math.min(200, opts.segments ?? DEFAULT_SEGMENTS))
    this.mesh = null
    this.gridMesh = null
    this._loaded = false
  }

  get isLoaded() { return this._loaded }

  /** Höhe (relativ zum Origin) an einer Weltkoordinate — null vor dem Laden. */
  elevationAt(lat, lon) {
    if (!this._sampler) return null
    const e = this._sampler.elevationAt(lat, lon)
    return e == null ? null : e - this._originEle
  }

  async load(lat, lon) {
    this.dispose()
    let sampler
    try {
      sampler = await elevationSampler(lat, lon, this.radius, TERRAIN_Z)
    } catch (err) {
      console.warn('[terrain] Höhenkacheln nicht ladbar:', err?.message || err)
      return
    }
    const originEle = sampler.elevationAt(lat, lon)
    if (originEle == null) { console.warn('[terrain] keine Höhe am Origin'); return }
    this._sampler = sampler
    this._originEle = originEle

    // Gitter in LOKALEN Metern aufspannen und je Knoten die Höhe abtasten.
    // Schrittweite in Grad, damit die Abtastung dem Mercator-Raster folgt.
    const n = this.segments
    const step = (this.radius * 2) / n
    const dLatPerM = 1 / 111320
    const dLonPerM = 1 / (111320 * Math.cos(lat * Math.PI / 180) || 1)

    // 1) Höhen abtasten (Gitter im Speicher, damit danach gefiltert werden kann)
    const W = n + 1
    const grid = new Float32Array(W * W)
    const coords = new Array(W * W)
    for (let iz = 0; iz <= n; iz++) {
      for (let ix = 0; ix <= n; ix++) {
        const offX = -this.radius + ix * step      // Meter Ost(+)
        const offZ = -this.radius + iz * step      // Meter Nord(+)
        const pLat = lat + offZ * dLatPerM
        const pLon = lon + offX * dLonPerM
        const e = sampler.elevationAt(pLat, pLon)
        const i = iz * W + ix
        grid[i] = (e == null ? originEle : e) - originEle
        coords[i] = [pLat, pLon]
      }
    }
    // 2) Letztes Sicherheitsnetz gegen Nadeln: greift unabhängig davon, WO der
    //    Fehler entstand (Quelldaten, Kachelnaht, Farbkanal-Verschiebung beim
    //    Canvas-Lesen). Schwelle relativ zur Rasterweite: eine Zelle darf gegen
    //    ihre Nachbarn höchstens ~60° Steigung ausreißen, alles darüber ist
    //    Datenmüll. Wird geloggt, damit so etwas sichtbar bleibt.
    const spikeLimit = Math.max(40, step * 1.7)
    const fixed = despike(grid, W, W, spikeLimit)

    const positions = [], indices = [], colors = []
    let min = Infinity, max = -Infinity
    for (let i = 0; i < grid.length; i++) {
      const [pLat, pLon] = coords[i]
      const h = grid[i]
      // Über toLocal, damit invertNorthSouth/EastWest der Szene gelten.
      const v = this.geo.toLocal(pLat, pLon, 0)
      positions.push(v.x, TERRAIN_Y + h, v.z)
      if (h < min) min = h
      if (h > max) max = h
      // Sanfte Höhenschichtung: Talsohlen kühler, Kuppen wärmer — hilft der
      // Orientierung zusätzlich zur Schattierung.
      colors.push(0, 0, 0, 1)   // wird unten gefüllt, sobald min/max bekannt
    }
    // Farben nachtragen (min/max stehen erst jetzt fest).
    const span = Math.max(1, max - min)
    for (let i = 0, c = 0; i < positions.length; i += 3, c += 4) {
      const t = ((positions[i + 1] - TERRAIN_Y) - min) / span
      colors[c]     = 0.30 + 0.28 * t          // R
      colors[c + 1] = 0.42 + 0.20 * t          // G
      colors[c + 2] = 0.33 + 0.10 * (1 - t)    // B
      colors[c + 3] = 1
    }
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const a = iz * (n + 1) + ix
        const b = a + 1, c = a + (n + 1), d = c + 1
        indices.push(a, c, b, b, c, d)
      }
    }

    const mesh = new BABYLON.Mesh('terrain', this.scene)
    const vd = new BABYLON.VertexData()
    vd.positions = positions
    vd.indices = indices
    vd.colors = colors
    const normals = []
    BABYLON.VertexData.ComputeNormals(positions, indices, normals)
    vd.normals = normals
    vd.applyToMesh(mesh)

    const mat = new BABYLON.StandardMaterial('terrain_mat', this.scene)
    mat.useVertexColor = true
    mat.specularColor = new BABYLON.Color3(0, 0, 0)   // Gelände glänzt nicht
    mat.alpha = 0.55                                   // Kulisse, kein Belag
    mat.backFaceCulling = false
    mesh.material = mat
    mesh.useVertexColors = true
    // PICKBAR: „Rechtsklick → hier etwas erzeugen" trifft damit das echte
    // Gelände statt der gedachten Ebene — der Spawnpunkt bekommt die reale Höhe.
    mesh.isPickable = true
    mesh.receiveShadows = false
    mesh.alphaIndex = 0          // Fläche zuerst, Gitter darüber (s. u.)
    this.mesh = mesh

    // ── Bodengitter AUF dem Relief ──────────────────────────────────────
    // Die flache 5000-m-Gitterebene aus dem DebugSceneBuilder liegt starr bei
    // y=0 und schneidet damit durch jeden Hang. Solange ein Relief da ist,
    // legen wir dieselbe Rasterdarstellung stattdessen über die
    // Geländegeometrie — gleiche Vertices, nur minimal angehoben. Das Raster
    // rechnet das GridMaterial aus der lokalen Vertex-Position, die hier
    // Metern ab Origin entspricht → die Linien sitzen weltfest.
    const gridMesh = new BABYLON.Mesh('terrainGrid', this.scene)
    const gvd = new BABYLON.VertexData()
    gvd.positions = positions.map((v, i) => (i % 3 === 1 ? v + GRID_LIFT : v))
    gvd.indices = indices
    gvd.normals = normals
    gvd.applyToMesh(gridMesh)
    const gmat = new GridMaterial('terrainGrid_mat', this.scene)
    gmat.gridRatio = 1                 // 1-m-Feinraster …
    gmat.majorUnitFrequency = 10       // … kräftige Linie alle 10 m
    gmat.minorUnitVisibility = 0.3
    gmat.mainColor = new BABYLON.Color3(0.04, 0.05, 0.08)
    gmat.lineColor = new BABYLON.Color3(0.5, 0.7, 1.0)
    // opacity < 1 schaltet im GridMaterial den transparenten Modus: zwischen
    // den Linien bleibt es fast durchsichtig, das Relief scheint durch.
    gmat.opacity = 0.6
    gmat.backFaceCulling = false
    gridMesh.material = gmat
    gridMesh.isPickable = false
    gridMesh.receiveShadows = false
    gridMesh.alphaIndex = 1      // nach der Relieffläche zeichnen
    this.gridMesh = gridMesh
    // Flache Ersatz-Ebene stilllegen, solange das Relief steht.
    this.scene.getMeshByName('debugGround')?.setEnabled(false)

    this._loaded = true
    applyLayer(this.scene, 'terrain')
    applyLayer(this.scene, 'grid')

    // Ab jetzt ist das Relief die Höhenreferenz der ganzen Szene: AGL-Objekte
    // (Figuren, Items, Marker) setzen darauf auf, und 'msl'-Objekte (Flugzeuge)
    // bekommen mit originEle endlich die echte Bodenhöhe ü. NN als Bezug.
    this.geo.setTerrain?.(this, originEle)

    console.log(`[terrain] Relief geladen: ${sampler.tiles} Kachel(n), ${n}×${n} Felder,`
      + ` Höhen ${min.toFixed(0)}…${max.toFixed(0)} m relativ (Origin ${originEle.toFixed(0)} m ü. NN),`
      + ` Raster ${step.toFixed(0)} m, Quelle ${metersPerPixel(lat).toFixed(1)} m/Pixel`
      + (fixed ? ` · ${fixed} Nadel(n) geglättet (>${spikeLimit.toFixed(0)} m)` : ''))
  }

  dispose() {
    try { this.mesh?.dispose() } catch {}
    try { this.gridMesh?.dispose() } catch {}
    this.mesh = null
    this.gridMesh = null
    this._sampler = null
    this._loaded = false
    // Ohne Relief übernimmt wieder die flache Ersatzebene — mit der zuletzt
    // gewählten Sichtbarkeit der Ebene „Bodengitter".
    try { applyLayer(this.scene, 'grid') } catch {}
  }
}
