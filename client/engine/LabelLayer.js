// LabelLayer — Beschriftungen für Objekte im 3D-/AR-Blick.
//
// Zeigt zu jedem Objekt mit `appearance.label` eine Tafel, die mitwandert und
// die Entfernung nennt. Was draufsteht, bestimmt die Vorlage im Objekt
// (siehe core/Appearance.js) — der Client liefert nur Werte ein. Kein Agent
// bringt Code in den Client.
//
// WARUM EINE ZENTRALE EBENE UND NICHT JE KOMPONENTE
// Drei Dinge lassen sich pro Objekt gar nicht entscheiden:
//   • WELCHE Tafel angeschaut wird — das ist ein Vergleich ALLER Winkel,
//   • welche 25 die nächsten sind (Deckel gegen Textwüste),
//   • und die gemeinsame Zeichenfläche, denn eine eigene Textur pro Objekt
//     wären bei 30 Ständen 30 Canvas.
// Deshalb: EIN AdvancedDynamicTexture im Vollbild, ein TextBlock je Objekt
// (`linkWithMesh`), und EIN Durchlauf, der alles zusammen entscheidet.
//
// WARUM BABYLON-GUI UND KEIN HTML-OVERLAY
// In einer immersiven WebXR-Sitzung ist DOM schlicht nicht sichtbar. Die
// Vollbildtextur wird in die Szene gerendert und funktioniert dort — das ist
// der Grund, nicht Bequemlichkeit.
//
// WARUM GETAKTET
// Die Entfernung ändert sich mit jedem Schritt. Alle Tafeln pro Frame neu zu
// setzen ist genau die Hauptthread-Arbeit, die Ajna schon einmal die Bildrate
// gekostet hat (Hover-Pick pro pointermove). Der schwere Durchlauf läuft
// deshalb 4×/s; pro Frame wird nur die Fokus-Größe weich nachgezogen, und das
// betrifft höchstens zwei Tafeln.

import * as GUI from 'babylonjs-gui'
import { resolveLabel, labelScaleForDistance } from '../core/Appearance.js'

const UPDATE_MS = 250          // schwerer Durchlauf: 4×/s reicht fürs Auge
const MAX_VISIBLE = 25         // mehr Tafeln liest ohnehin niemand
const MAX_DISTANCE_M = 1500    // darüber: ausblenden
const BASE_FONT_PX = 18        // × Entfernungsfaktor 0.7…1.4 ⇒ 13…25 px
const FOCUS_ANGLE_DEG = 12     // Sichtkegel, in dem eine Tafel „angeschaut" ist
const FOCUS_SCALE = 1.3
const EASE = 0.18              // Annäherung pro Frame an die Zielgröße

// Säule vom Boden zur Tafel. Ohne sie schwebt die Beschriftung im Bild und man
// sieht nicht, WO sie hingehört — mit ihr liest das Auge die Entfernung schon
// aus der Perspektive, bevor es die Zahl liest.
const POLE_MIN_M = 2.0         // steht ein Objekt AUF dem Boden, bekommt es
                               // trotzdem einen Mast — sonst klebte die Tafel
                               // ohne Bezugspunkt am Untergrund
const POLE_MAX_M = 40          // darüber: kein Mast. Ein Flugzeug in 10 km
                               // Höhe bekommt keine Säule bis zum Erdboden.
// 10 cm auf 2 m Höhe: schlank wie ein Schildpfosten, aber auf mittlerer
// Distanz noch als Strich erkennbar. Echte Perspektive ist hier Absicht — die
// Verjüngung IST die Tiefeninformation; in der Ferne verschwindet sie, dort
// trägt die Zahl auf der Tafel.
const POLE_DIAMETER_M = 0.1

/** @type {WeakMap<object, LabelLayer>} eine Ebene pro Szene */
const layers = new WeakMap()

export function labelLayerFor(scene) {
  let l = layers.get(scene)
  if (!l) { l = new LabelLayer(scene); layers.set(scene, l) }
  return l
}

class LabelLayer {

  constructor(scene) {
    this.scene = scene
    this.entries = new Map()      // GameObject → { text, record, scale, target, dist }
    this.texture = null
    this._lastPass = 0
    this._focus = null

    this._onFrame = () => this._frame()
    scene.onBeforeRenderObservable.add(this._onFrame)
  }

  /** Zeichenfläche erst anlegen, wenn wirklich eine Tafel gebraucht wird. */
  _ensureTexture() {
    if (!this.texture) {
      this.texture = GUI.AdvancedDynamicTexture.CreateFullscreenUI('ajna-labels', true, this.scene)
      // Nicht anklickbar: die Tafeln sollen Klicks auf Objekte NICHT abfangen.
      this.texture.isForeground = true
      this.texture.rootContainer.isPointerBlocker = false
    }
    return this.texture
  }

  register(gameObject, record) {
    if (this.entries.has(gameObject)) { this.entries.get(gameObject).record = record; return }
    const t = new GUI.TextBlock(`label_${gameObject.id}`)
    t.text = ''
    t.color = '#ffffff'
    t.fontSize = BASE_FONT_PX
    t.fontWeight = '600'
    // Kontur statt Hintergrundkasten: liest sich über Himmel, Hauswand und
    // Wiese gleichermaßen und kostet keine zweite Fläche.
    t.outlineWidth = 4
    t.outlineColor = 'rgba(0,0,0,0.85)'
    t.resizeToFit = true
    t.isPointerBlocker = false
    t.isVisible = false
    t.transformCenterX = 0.5
    t.transformCenterY = 1
    this._ensureTexture().addControl(t)

    // Mast bauen und die Tafel an SEINE SPITZE hängen, nicht an das Objekt:
    // So sitzt die Beschriftung wie ein Schild auf einem Pfahl, und die Säule
    // führt das Auge zum Boden hinunter.
    const pole = this._buildPole(gameObject)
    t.linkWithMesh(pole ? pole.tip : gameObject.root)
    t.linkOffsetY = -14

    this.entries.set(gameObject, { text: t, record, pole, scale: 1, target: 1, dist: Infinity })
  }

  /**
   * Schmale Säule vom Boden bis zur Tafel, plus ein unsichtbarer Knoten an der
   * Spitze als Aufhängepunkt.
   *
   * Die Höhe ist die Höhe des Objekts ÜBER GRUND — bei Objekten, die auf dem
   * Boden stehen (Stände, POIs), also 0; deshalb die Untergrenze. Die
   * Bodenhöhe kommt aus dem GeoTransformer und folgt damit dem Relief.
   *
   * @returns {{mesh: object, tip: object}|null}
   */
  _buildPole(gameObject) {
    const geoComp = gameObject.components?.find(c => c.geo && Number.isFinite(c.lat))
    if (!geoComp) return null
    const rootY = gameObject.root?.position?.y
    if (!Number.isFinite(rootY)) return null

    // Höhe über Grund: Wurzel minus Geländehöhe an dieser Stelle. Deckt beide
    // Höhenbezüge ab ('ground' wie 'msl'), ohne sie unterscheiden zu müssen.
    const groundY = geoComp.geo.terrainHeightAt?.(geoComp.lat, geoComp.lon) ?? 0
    const drop = rootY - groundY
    if (!Number.isFinite(drop) || drop > POLE_MAX_M) return null

    const height = Math.max(POLE_MIN_M, drop)
    const mesh = BABYLON.MeshBuilder.CreateCylinder(`pole_${gameObject.id}`,
      { height, diameter: POLE_DIAMETER_M, tessellation: 6 }, this.scene)
    const mat = new BABYLON.StandardMaterial(`pole_mat_${gameObject.id}`, this.scene)
    const hex = typeof gameObject._appearance?.color === 'string' ? gameObject._appearance.color : '#dddddd'
    try { mat.emissiveColor = BABYLON.Color3.FromHexString(hex).scale(0.8) } catch { mat.emissiveColor = new BABYLON.Color3(0.85, 0.85, 0.85) }
    mat.disableLighting = true      // gleichmäßig sichtbar, auch im Schatten
    mat.alpha = 0.75
    mesh.material = mat
    mesh.isPickable = false         // fängt keine Klicks auf das Objekt ab
    mesh.parent = gameObject.root
    // Mitte des Zylinders liegt auf halber Höhe; das Objekt sitzt oben.
    mesh.position.y = -drop + height / 2

    const tip = new BABYLON.TransformNode(`poletip_${gameObject.id}`, this.scene)
    tip.parent = gameObject.root
    tip.position.y = -drop + height
    return { mesh, tip }
  }

  unregister(gameObject) {
    const e = this.entries.get(gameObject)
    if (!e) return
    try { e.text.linkWithMesh(null); this.texture?.removeControl(e.text); e.text.dispose() } catch { /* Szene evtl. weg */ }
    try { e.pole?.mesh.dispose(false, true); e.pole?.tip.dispose() } catch {}
    this.entries.delete(gameObject)
    if (this._focus === gameObject) this._focus = null
  }

  dispose() {
    this.scene.onBeforeRenderObservable.removeCallback(this._onFrame)
    for (const go of [...this.entries.keys()]) this.unregister(go)
    try { this.texture?.dispose() } catch {}
    this.texture = null
    layers.delete(this.scene)
  }

  // ── pro Frame: nur die Fokus-Größe weich nachziehen ────────────────────
  _frame() {
    const now = performance.now()
    if (now - this._lastPass >= UPDATE_MS) { this._lastPass = now; this._pass() }

    for (const e of this.entries.values()) {
      if (!e.text.isVisible) continue
      const d = e.target - e.scale
      if (Math.abs(d) < 0.005) continue        // fertig — Control nicht anfassen
      e.scale += d * EASE
      e.text.scaleX = e.scale
      e.text.scaleY = e.scale
    }
  }

  /** Tafel und Säule gemeinsam schalten — eine Säule ohne Schild verwirrt nur. */
  _show(e, on) {
    e.text.isVisible = on
    if (e.pole) e.pole.mesh.setEnabled(on)
  }

  // ── getaktet: Text, Entfernung, Sichtbarkeit, Fokus ────────────────────
  _pass() {
    const cam = this.scene.activeCamera
    if (!cam || !this.entries.size) return
    const eye = cam.globalPosition
    // Blickrichtung der Kamera — in XR die Blickrichtung des Kopfes.
    const fwd = cam.getForwardRay ? cam.getForwardRay(1).direction : cam.getTarget().subtract(eye).normalize()

    const candidates = []
    for (const [go, e] of this.entries) {
      const p = go.root?.absolutePosition
      if (!p) { this._show(e, false); continue }
      const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      // Keine belastbare Position (z. B. Objekt ohne gültige Koordinaten oder
      // Origin noch nicht gesetzt) → gar keine Tafel. Sonst klebte sie an einer
      // zufälligen Bildschirmstelle und behauptete eine Entfernung, die es
      // nicht gibt. Real erlebt: eine kaputte Dummy-Position machte JEDE
      // Objektposition zu NaN, und die Tafeln standen trotzdem da.
      if (!Number.isFinite(dist)) { this._show(e, false); continue }
      e.dist = dist
      // Winkel zur Blickachse. `dot` < 0 heißt hinter der Kamera — dann ist
      // die projizierte Position bedeutungslos.
      const inv = dist > 1e-6 ? 1 / dist : 0
      const dot = (dx * fwd.x + dy * fwd.y + dz * fwd.z) * inv
      if (dist > MAX_DISTANCE_M || dot <= 0) { this._show(e, false); continue }
      candidates.push({ go, e, dist, dot })
    }

    // Deckel: die nächsten MAX_VISIBLE gewinnen.
    candidates.sort((a, b) => a.dist - b.dist)
    const shown = candidates.slice(0, MAX_VISIBLE)
    for (const c of candidates.slice(MAX_VISIBLE)) this._show(c.e, false)

    // Angeschaut = kleinster Winkel im Sichtkegel; bei Gleichstand die nähere.
    const cosLimit = Math.cos(FOCUS_ANGLE_DEG * Math.PI / 180)
    let best = null
    for (const c of shown) {
      if (c.dot < cosLimit) continue
      if (!best || c.dot > best.dot + 1e-4 || (Math.abs(c.dot - best.dot) <= 1e-4 && c.dist < best.dist)) best = c
    }
    this._focus = best ? best.go : null

    for (const c of shown) {
      const { e, go, dist } = c
      const txt = resolveLabel(e.record?.appearance?.label || '', e.record, { distanceM: dist })
      if (txt !== e.text.text) e.text.text = txt
      this._show(e, !!txt)
      if (!txt) continue

      // Schriftgröße auf GANZE Pixel: sie neu zu setzen rastert den Text neu,
      // das soll nur passieren, wenn sich wirklich etwas ändert. Der weiche
      // Fokus läuft darüber als Transform (scaleX/Y) — billig und flüssig.
      const px = Math.round(BASE_FONT_PX * labelScaleForDistance(dist))
      if (px !== e.text.fontSize) e.text.fontSize = px

      const focused = go === this._focus
      e.target = focused ? FOCUS_SCALE : 1
      e.text.zIndex = focused ? 10 : 0
      e.text.alpha = focused ? 1 : 0.9
    }
  }
}
