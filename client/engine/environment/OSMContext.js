// OSMContext — Geo-Kontext („Kulisse") in der AR-/3D-Szene.
//
// QUELLE: OSM-VEKTORKACHELN (client/core/vectorTiles.js) — eine Anfrage,
// ~0,5 s, liefert Gebäude (inkl. fertiger `render_height`), Wasserflächen,
// Flüsse, Straßen und Schienen. Fällt das aus, greift der alte Weg über die
// Overpass-gestützte Geo-API (`/ajnaapi/geo/{ways,buildings}`), der aber
// spürbar langsamer und rate-limitiert ist.
//
// DARSTELLUNG (auf Orientierung optimiert, nicht auf Realismus):
//   • Straßen/Bäche → flache BÄNDER auf dem Boden, Breite + Farbe nach Klasse
//     (Autobahn breit/orange … Trampelpfad schmal/grün). Pro Kategorie EIN
//     gemergtes Mesh = ein Draw Call; unbeleuchtet, damit sie auch nachts und
//     gegen das AR-Kamerabild lesbar bleiben.
//   • Wasserflächen → gefüllte Polygone (earcut-trianguliert) — der Fluss ist
//     der stärkste Orientierungsanker in der 3D-Ansicht.
//   • Gebäude → weiterhin Wireframe (Footprint + Dach + Vertikalen). Höhe aus
//     der Kachel, sonst client/core/buildingHeight.js. Dieselbe Höhenquelle
//     nutzt die Drachen-Landung, damit er auf dem Dach aufsetzt, das man sieht.
//
// Aufruf: `new OSMContext(...).load(lat, lon)` nach Geo-Origin-Fix.
// Bei Fehlern wird ge-warned, kein Reload-Loop. `dispose()` räumt auf.

import { buildingHeightM, heightSource } from '../../core/buildingHeight.js'
import { applyLayer } from '../../core/debugLayers.js'
import { sceneryNear, tilesFor } from '../../core/vectorTiles.js'
import earcut from 'earcut'

const DEFAULT_RADIUS_M = 300
const STREET_Y = 0.05          // leicht über Ground, gegen Z-Fighting
const BUILDING_Y_OFFSET = 0.0

// Abstand der Höhen-Stützpunkte entlang eines Linienzugs (Meter). Kleiner =
// treuer am Relief, mehr Geometrie. 12 m liegt unter der Auflösung der
// Höhendaten und ist damit fein genug, ohne Punkte zu verschwenden.
const STUETZ_ABSTAND_M = 12
const MAX_STUETZ_JE_KANTE = 200

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
const WATER_AREA_Y = 0.015     // Flächen noch eine Spur tiefer als die Linien
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
    /** Mittelpunkt des letzten Ladelaufs — {lat, lon} oder null. */
    this.center  = null
    this._loaded = false
    this._tileKey = null      // Kachelsatz des letzten Laufs (s. load)
  }

  /** True, wenn der letzte load() ohne Fehler durchgelaufen ist. */
  get isLoaded() { return this._loaded }

  /**
   * Lädt + zeichnet die Kulisse. Primärquelle sind OSM-VEKTORKACHELN
   * (client/core/vectorTiles.js): eine Anfrage, ~0,5 s, mit Gebäudehöhen —
   * gegenüber Overpass (4 Abfragen, im Test 40 s bis Timeout) ein anderer
   * Planet. Overpass bleibt als Fallback verdrahtet, falls die Kacheln mal
   * nicht erreichbar sind.
   */
  async load(lat, lon, { force = false } = {}) {
    // Die Kachelquelle liefert GANZE Kacheln (z14 ≈ 2,4 km bei uns), der Radius
    // wählt aus, WELCHE geholt werden — und beschneidet danach zusätzlich die
    // Features (`_clipToRadius`), sonst wäre die gezeichnete Kulisse auf
    // Kachelgrenzen gerastert. Zieht die Kulisse mit der Kamera mit, wäre ein
    // Neuzeichnen bei jedem Schritt also meist dieselbe Arbeit mit demselben
    // Ergebnis — teuer (gemessen ~230 ms für eine Kachel) und sichtbar als
    // Ruckler. Deshalb: nur neu zeichnen, wenn sich der Kachelsatz ändert.
    // `force` überstimmt das, wenn sich die HÖHENREFERENZ geändert hat (das
    // Relief ist umgezogen) — die Drapierung steckt fest in den Vertices.
    // Radius gehört MIT in den Schlüssel: seit `_clipToRadius` bestimmt er das
    // gezeichnete Ergebnis, nicht nur den Kachelsatz. Ohne ihn bliebe eine
    // Änderung am Reichweiten-Regler innerhalb derselben Kacheln wirkungslos.
    const key = `${this.radius}|`
      + tilesFor(lat, lon, this.radius).map(t => `${t.x}/${t.y}`).sort().join(',')
    if (!force && this._loaded && key === this._tileKey) { this.center = { lat, lon }; return }

    this.dispose()
    this._tileKey = key
    this.center = { lat, lon }
    try {
      const n = await this._loadFromTiles(lat, lon)
      if (n) { this._finish(n); return }
      console.warn('[osm] Vektorkacheln leer — weiche auf Overpass aus')
    } catch (err) {
      console.warn('[osm] Vektorkacheln fehlgeschlagen:', err?.message || err, '— weiche auf Overpass aus')
    }
    // Overpass ist radius-, nicht kachelbasiert → Kachelschlüssel verwerfen,
    // sonst würde ein späterer Lauf am selben Kachelsatz fälschlich übersprungen.
    this._tileKey = null
    await this._loadFromOverpass(lat, lon)
  }

  _finish(counts) {
    // Frisch gezeichnete Meshes an die gespeicherte Debug-Sichtbarkeit angleichen
    // — sonst käme ein ausgeblendetes Overlay nach jedem Reload zurück.
    applyLayer(this.scene, 'ways')
    applyLayer(this.scene, 'water')
    applyLayer(this.scene, 'buildings')
    this._loaded = Object.values(counts).some(v => v > 0)
    console.log('[osm] gezeichnet: ' + Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')
      + ` · Radius ${this.radius} m · Quelle ${counts._src || 'Vektorkacheln'}`)
  }

  /** Kulisse aus Vektorkacheln. @returns {object|null} Zählwerte */
  async _loadFromTiles(lat, lon) {
    const s = await sceneryNear(lat, lon, this.radius)
    const roads = [], rails = []
    for (const f of (s.transportation || [])) {
      // OpenMapTiles: `class` grob (motorway…path, rail), `subclass` = der
      // ursprüngliche OSM-Wert (footway, cycleway …). Schienen getrennt.
      if (f.tags?.class === 'rail' || f.tags?.class === 'transit') rails.push(f)
      else roads.push(f)
    }
    const nah = (f) => this._clipToRadius(f, lat, lon)
    const counts = {
      Straßen:  this._drawWays(nah(roads)),
      Gleise:   this._drawRails(nah(rails)),
      Bäche:    this._drawWater(nah(s.waterway || [])),
      'Wasserflächen': this._drawWaterAreas(nah(s.water || [])),
      Gebäude:  this._drawBuildings(nah(s.building || [])),
    }
    return Object.values(counts).some(v => v > 0) ? counts : null
  }

  /** Alter Pfad: Kulisse über die Overpass-gestützte Geo-API. */
  async _loadFromOverpass(lat, lon) {
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

    this._finish({ Straßen: wayCount, Gleise: railCount, Bäche: waterCount, Gebäude: bldgCount, _src: 'Overpass' })
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
      // Stil-Schlüssel: OSM-Wert (Overpass: `highway`, Kacheln: `subclass`),
      // sonst die gröbere Kachel-Klasse.
      const t = f.tags || {}
      const st = CLASS_STYLE[t.subclass] || CLASS_STYLE[t.highway] || CLASS_STYLE[t.class] || STREET_FALLBACK
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

  // Wasserflächen (Kachel-Layer `water`: Flussbett, Seen, Teiche) als GEFÜLLTE
  // Flächen — der Rhein wird damit zur erkennbaren Wasserfläche statt zu einer
  // Linie, was in der 3D-Ansicht der stärkste Orientierungsanker ist.
  // Triangulierung per earcut (Löcher = Inseln werden mitgeführt).
  //
  // HÖHE: zwei Fälle, weil Wasser eben ist, ein Fluss aber Gefälle hat.
  //  • Kleine Gewässer (Bounding-Box unter LEVEL_MAX_M): EIN gemeinsamer
  //    Pegel für die ganze Fläche, sonst kippte ein Weiher am Hang mit dem
  //    Gelände mit. Als Pegel das untere Quantil der Uferhöhen — die Kachel
  //    tastet am Ufer schon die Böschung mit ab, der Median läge zu hoch.
  //  • Große/langgestreckte Flächen (Rhein): pro Stützpunkt drapiert, sonst
  //    läge das eine Ende vergraben und das andere in der Luft.
  _drawWaterAreas(features) {
    const positions = [], indices = [], colors = []
    const col = BABYLON.Color3.FromHexString('#1e88e5')
    const LEVEL_MAX_M = 300
    let n = 0
    for (const f of features) {
      const rings = f.rings || (f.coordinates ? [f.coordinates] : null)
      if (!rings?.length || rings[0].length < 3) continue
      // Alle Ringe in eine flache XZ-Liste; holeIndices markieren die Inseln.
      // Die Geländehöhe je Stützpunkt wird gleich mitgeführt (Index /2).
      const flat = [], holes = [], hs = []
      let vi = 0
      let xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity
      rings.forEach((ring, ri) => {
        if (ri > 0) holes.push(vi)
        for (const [rlat, rlon] of ring) {
          const v = this.geo.toLocal(rlat, rlon, 0)
          flat.push(v.x, v.z)
          hs.push(this.geo.terrainHeightAt(rlat, rlon))
          if (ri === 0) {
            if (v.x < xMin) xMin = v.x
            if (v.x > xMax) xMax = v.x
            if (v.z < zMin) zMin = v.z
            if (v.z > zMax) zMax = v.z
          }
          vi++
        }
      })
      let tris
      try { tris = earcut(flat, holes.length ? holes : null, 2) } catch { continue }
      if (!tris?.length) continue
      const extent = Math.max(xMax - xMin, zMax - zMin)
      let level = null
      if (extent <= LEVEL_MAX_M) {
        const sorted = hs.slice().sort((a, b) => a - b)
        level = sorted[Math.floor(sorted.length * 0.3)]
      }
      const base = positions.length / 3
      for (let i = 0, k = 0; i < flat.length; i += 2, k++) {
        positions.push(flat[i], (level ?? hs[k]) + WATER_AREA_Y, flat[i + 1])
        colors.push(col.r, col.g, col.b, 1)
      }
      for (const t of tris) indices.push(base + t)
      n++
    }
    const mesh = this._buildRibbonMesh('osm_water_area', { positions, indices, colors })
    if (mesh) mesh.material.alpha = 0.45
    return n
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

      // Vektorkacheln liefern `render_height` bereits fertig berechnet (aus
      // height bzw. Geschossen) — besser als unsere Tag-Heuristik. Ohne das
      // Feld (Overpass-Fallback) greift buildingHeightM wie bisher.
      const tileH = Number(f.tags?.render_height)
      const height = Number.isFinite(tileH) && tileH > 0 ? tileH : buildingHeightM(f.tags)
      const src = Number.isFinite(tileH) && tileH > 0 ? 'tile' : heightSource(f.tags)
      srcCount[src] = (srcCount[src] || 0) + 1
      const ground = this._toLocalPoints(coords, BUILDING_Y_OFFSET)
      // Dach = Gebäudehöhe ÜBER dem jeweiligen Geländepunkt. Der Grundriss
      // folgt bereits dem Relief (siehe _toLocalPoints); ein flaches Dach auf
      // absoluter Höhe würde am Hang schief in den Boden laufen. Als
      // Dachniveau nimmt der höchste Grundrisspunkt — so steht das Gebäude
      // wie gebaut (waagerechte Traufe), statt sich zu verwinden.
      const baseY = Math.max(...ground.map(p => p.y))
      const roof   = ground.map(p => new BABYLON.Vector3(p.x, baseY + height, p.z))

      lines.push(ground)
      lines.push(roof)
      // Vertikale Kanten: letzten Punkt überspringen (ist Duplikat von [0])
      for (let i = 0; i < ground.length - 1; i++) {
        lines.push([ground[i], roof[i]])
      }
    }
    if (Object.keys(srcCount).length) {
      const legend = { tile: 'aus Kachel', height: 'getaggt', levels: 'Geschosse', type: 'aus Gebäudeart', default: 'Default' }
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

  // ── Radius-Beschneidung ────────────────────────────────────────────────
  // Die Kachelquelle liefert GANZE Kacheln (z14 ≈ 2,4 km) — `this.radius` wählt
  // nur aus, welche geholt werden. Ohne diesen Schritt wäre die gezeichnete
  // Kulisse also auf Kachelgrenzen gerastert und ein Reichweiten-Regler ohne
  // spürbare Wirkung: von 300 auf 900 m ändert sich der Kachelsatz oft gar
  // nicht. Hier fällt alles weg, was echt weiter als `radius` entfernt liegt.
  // (Der Overpass-Fallback fragt bereits radiusbasiert ab und braucht das nicht.)
  _clipToRadius(features, lat, lon) {
    const r = this.radius
    if (!Number.isFinite(r) || r <= 0) return features
    const mPerLat = 111320
    const mPerLon = 111320 * Math.cos(lat * Math.PI / 180) || 1
    // Punkt→Strecke statt Punkt→Stützpunkt: eine lange gerade Autobahn kann
    // mitten durch den Kreis laufen, ohne dass ein einziger Stützpunkt drin liegt.
    const nahGenug = (coords) => {
      if (!Array.isArray(coords) || !coords.length) return false
      let px = null, pz = null
      for (const c of coords) {
        const x = (c[1] - lon) * mPerLon, z = (c[0] - lat) * mPerLat
        if (Math.hypot(x, z) <= r) return true
        if (px !== null) {
          const dx = x - px, dz = z - pz
          const len2 = dx * dx + dz * dz
          if (len2 > 0) {
            const t = Math.max(0, Math.min(1, -(px * dx + pz * dz) / len2))
            if (Math.hypot(px + t * dx, pz + t * dz) <= r) return true
          }
        }
        px = x; pz = z
      }
      return false
    }
    return features.filter(f => nahGenug(f.coordinates))
  }

  // Lokale Punkte MIT Geländehöhe: Straßenbänder und Gebäudegrundrisse folgen
  // damit dem Relief, statt in Hänge einzuschneiden oder darüber zu schweben.
  // `y` bleibt der kleine Stapel-Offset gegen Z-Fighting (Wasser < Straße).
  // Ohne geladenes Relief liefert terrainHeightAt 0 → altes, ebenes Verhalten.
  _toLocalPoints(coords, y) {
    return this._nachtasten(coords).map(([lat, lon]) => {
      const v = this.geo.toLocal(lat, lon, 0)
      return new BABYLON.Vector3(v.x, this.geo.terrainHeightAt(lat, lon) + y, v.z)
    })
  }

  /**
   * Linienzug feiner abtasten, BEVOR die Geländehöhe gesetzt wird.
   *
   * OSM setzt Stützpunkte dort, wo die Straße die RICHTUNG ändert — auf einer
   * schnurgeraden Landstraße liegen sie hundert Meter auseinander. Die Höhe nur
   * dort zu nehmen heißt, das Band als GERADE über eine gekrümmte Landschaft zu
   * spannen: Über einer Kuppe schneidet es ins Gelände, über einer Senke
   * schwebt es. Und weil Figuren dem Relief exakt folgen, standen sie dann
   * sichtbar bis zu den Knöcheln im Asphalt.
   *
   * Die Zwischenpunkte kosten Geometrie, aber nur linear in der Streckenlänge —
   * und ohne sie hilft die beste Höhenabfrage nichts, weil sie nie gestellt wird.
   */
  _nachtasten(coords, schrittM = STUETZ_ABSTAND_M) {
    if (!Array.isArray(coords) || coords.length < 2) return coords || []
    const raus = [coords[0]]
    for (let i = 1; i < coords.length; i++) {
      const [aLat, aLon] = coords[i - 1]
      const [bLat, bLon] = coords[i]
      const dLat = (bLat - aLat) * 111320
      const dLon = (bLon - aLon) * 111320 * Math.cos(aLat * Math.PI / 180)
      const laenge = Math.sqrt(dLat * dLat + dLon * dLon)
      // Deckel gegen Ausreißer: eine einzelne, fehlerhaft lange Kante soll
      // nicht Tausende Punkte erzeugen.
      const teile = Math.min(MAX_STUETZ_JE_KANTE, Math.floor(laenge / schrittM))
      for (let k = 1; k <= teile; k++) {
        const t = k / (teile + 1)
        raus.push([aLat + (bLat - aLat) * t, aLon + (bLon - aLon) * t])
      }
      raus.push(coords[i])
    }
    return raus
  }

  dispose() {
    for (const m of this.meshes) {
      try { m.dispose() } catch {}
    }
    this.meshes = []
    this._loaded = false
    this._tileKey = null
  }
}

