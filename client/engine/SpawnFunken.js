// SpawnFunken — kurzlebiger Hinweis an der Stelle, an der gleich ein Objekt
// erscheint.
//
// WARUM ES DAS BRAUCHT
// Zwischen „hier erzeugen" und der fertigen Figur liegt eine kleine, aber
// spürbare Lücke: Der Reconcile der Szene ist auf 1 s gedrosselt (sonst
// ruckelt jeder Director-Tick), und danach lädt noch das Modell. Ohne
// Rückmeldung wirkt der Klick verschluckt — und wer nichts sieht, klickt
// nochmal.
//
// Der Funke ist bewusst NUR Anzeige: kein GameObject, kein Datensatz, nichts,
// was jemand anderes sieht. Er verschwindet, sobald das echte Objekt eintrifft
// (`quittiere`) oder nach einer Frist — sonst bliebe eine Wolke stehen, wenn
// der Spawn scheitert.

const DAUER_MS = 8000       // Frist, falls nie ein Objekt eintrifft
const NAH_M = 12            // wie nah ein neues Objekt sein muss, damit es „der" ist
const MAX_OFFEN = 8         // mehr gleichzeitige Wolken sind nur noch Unruhe
const AUSKLANG_MS = 1600    // Restlebenszeit der Partikel nach dem Stopp

export class SpawnFunken {
  /**
   * @param {BABYLON.Scene} scene
   * @param {object} geo   GeoManager — liefert toLocalRef (Boden-bezogen)
   */
  constructor(scene, geo) {
    this.scene = scene
    this.geo = geo
    this._offen = []
    this._textur = null
    this._nr = 0
  }

  // Eigene Partikel-Textur statt einer Bilddatei: ein weicher Punkt ist mit
  // wenigen Zeilen Canvas gezeichnet, kostet keinen Netzzugriff und geht auch
  // in der nativen App ohne Bundle-Eintrag.
  #textur() {
    if (this._textur) return this._textur
    const n = 64
    const t = new BABYLON.DynamicTexture(`funke_tex`, n, this.scene, false)
    const ctx = t.getContext()
    const g = ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.35, 'rgba(190,230,255,0.75)')
    g.addColorStop(1, 'rgba(140,200,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, n, n)
    t.update()
    t.hasAlpha = true
    this._textur = t
    return t
  }

  /**
   * Wolke an einer Weltposition zeigen.
   * @param {{lat:number, lon:number}} stelle
   * @returns {object|null} Eintrag (für gezieltes Beenden) oder null
   */
  zeige({ lat, lon }, { dauerMs = DAUER_MS } = {}) {
    if (!this.scene || !this.geo?.origin) return null
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
    if (this._offen.length >= MAX_OFFEN) this.#beende(this._offen[0])

    const id = `funke${++this._nr}`
    // Wie ein Objekt mit altitude 0: auf dem Boden, nicht auf Origin-Höhe.
    const pos = this.geo.toLocalRef(lat, lon, 0, 'ground')

    const wurzel = new BABYLON.TransformNode(id, this.scene)
    wurzel.position.copyFrom(pos)

    const ps = new BABYLON.ParticleSystem(`${id}_ps`, 200, this.scene)
    ps.particleTexture = this.#textur()
    ps.emitter = wurzel
    ps.minEmitBox = new BABYLON.Vector3(-0.35, 0, -0.35)
    ps.maxEmitBox = new BABYLON.Vector3(0.35, 0.15, 0.35)
    ps.color1 = new BABYLON.Color4(0.55, 0.85, 1.0, 0.9)
    ps.color2 = new BABYLON.Color4(0.85, 0.95, 1.0, 0.7)
    ps.colorDead = new BABYLON.Color4(0.4, 0.7, 1.0, 0)
    ps.minSize = 0.08
    ps.maxSize = 0.22
    ps.minLifeTime = 0.6
    ps.maxLifeTime = 1.3
    ps.emitRate = 90
    ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD
    ps.gravity = new BABYLON.Vector3(0, 0.5, 0)
    ps.direction1 = new BABYLON.Vector3(-0.35, 1.2, -0.35)
    ps.direction2 = new BABYLON.Vector3(0.35, 2.0, 0.35)
    ps.minEmitPower = 0.4
    ps.maxEmitPower = 1.1
    ps.updateSpeed = 0.012
    ps.start()

    // Bodenscheibe: Die Wolke allein sagt „irgendwo hier oben", die Scheibe
    // sagt „genau da". Leicht über Grund, damit sie nicht im Relief z-kämpft.
    const ring = BABYLON.MeshBuilder.CreateDisc(`${id}_ring`, { radius: 0.85, tessellation: 40 }, this.scene)
    ring.rotation.x = Math.PI / 2
    ring.position.y = 0.05
    ring.parent = wurzel
    ring.isPickable = false
    const mat = new BABYLON.StandardMaterial(`${id}_mat`, this.scene)
    mat.emissiveColor = new BABYLON.Color3(0.45, 0.75, 1.0)
    mat.disableLighting = true
    mat.alpha = 0.28
    mat.backFaceCulling = false
    ring.material = mat

    const eintrag = { id, lat, lon, wurzel, ps, ring, mat, frist: null }
    eintrag.frist = setTimeout(() => this.#beende(eintrag), dauerMs)
    this._offen.push(eintrag)
    return eintrag
  }

  /**
   * Ein Objekt ist eingetroffen — passende Wolken ausklingen lassen.
   * Ohne Positionsangabe bleibt alles stehen: Lieber eine Wolke zu lang als
   * die falsche gelöscht.
   */
  quittiere(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 0
    let n = 0
    for (const e of [...this._offen]) {
      if (abstandM(e.lat, e.lon, lat, lon) > NAH_M) continue
      this.#beende(e)
      n++
    }
    return n
  }

  /** Alles abräumen (Szenenwechsel). */
  dispose() {
    for (const e of [...this._offen]) this.#beende(e, true)
    try { this._textur?.dispose() } catch {}
    this._textur = null
  }

  #beende(eintrag, sofort = false) {
    const i = this._offen.indexOf(eintrag)
    if (i < 0) return
    this._offen.splice(i, 1)
    if (eintrag.frist) clearTimeout(eintrag.frist)

    // Erst aufhören zu senden, dann abräumen: Ein hartes dispose ließe die
    // Wolke mitten im Bild verschwinden statt auszuklingen.
    try { eintrag.ps.stop() } catch {}
    try { eintrag.mat.alpha = 0 } catch {}
    const weg = () => {
      try { eintrag.ps.dispose() } catch {}
      try { eintrag.ring.dispose() } catch {}
      try { eintrag.mat.dispose() } catch {}
      try { eintrag.wurzel.dispose() } catch {}
    }
    if (sofort) weg()
    else setTimeout(weg, AUSKLANG_MS)
  }
}

// Grobe Meter-Distanz — für einen Umkreis von wenigen Metern genügt die
// flache Näherung bei Weitem.
function abstandM(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * 111320
  const dLon = (bLon - aLon) * 111320 * Math.cos(aLat * Math.PI / 180)
  return Math.hypot(dLat, dLon)
}
