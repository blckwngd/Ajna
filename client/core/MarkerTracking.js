// MarkerTracking — Bild-Marker-Integration für die AR-Ansicht (SLAM/WorldTracker).
//
// Drei Aufgaben (Spike in client/poc/slam/markertest.html bestanden):
//  1. REGISTRIERUNG: Objekte mit state.marker werden als 8th-Wall-Bild-Targets
//     registriert — aber NUR im Umkreis von RADIUS_M um den Spieler (Hysterese
//     beim Verlassen, Obergrenze MAX_TARGETS). Groß gewählt (~25 m), damit auch
//     Graffitis/Plakate als große Marker taugen. Inkrementelles Umregistrieren
//     ist billig (die Engine difft die Liste und lädt/entlädt nur Änderungen).
//  2. OVERLAY: erkannte Marker bekommen Umriss + Objektname + Distanz ins
//     Kamerabild gezeichnet (eigene 2D-Canvas über der App-Canvas).
//  3. SNAP: frame-lokale Metrik-Referenz — aus der RELATIVEN Pose Marker↔Kamera
//     (gleicher Frame!) + gemessenem Einheiten/Meter-Faktor wird die exakte
//     Kamera-Geo-Pose berechnet. NIE auf Welt-Posen über Zeit bauen (der
//     responsive-SLAM-Weltframe springt/reskaliert — am Gerät gemessen).
//
// Verifizierte Engine-Konventionen (siehe Memory ajna-realworld-remote):
//  • configure({ imageTargetData: [{ name, imagePath, type:'PLANAR',
//    physicalWidthInMeters, moveable, properties:{originalWidth,…} }] })
//  • Pose+scale in SLAM-EINHEITEN; scale = längste Kante in Einheiten.
//  • Lokale Achsen des Markers: +X = physisch OBEN, +Y = physisch LINKS
//    (Target intern 90° gedreht) — bei LH gemessen; RH ggf. nachjustieren.
//
// Nutzt das globale window.BABYLON (App-Konvention).

const RADIUS_M = 25          // Aktivierungs-Umkreis (Code-Konstante, s. Anforderung)
const LEAVE_FACTOR = 1.3     // Hysterese: aktiv bleiben bis RADIUS_M × 1.3
const MAX_TARGETS = 8        // Engine nicht fluten; nächste zuerst
const TICK_MS = 3000         // Auswahl-/Registrierungs-Rhythmus

export class MarkerTracking {
  /**
   * @param {{worldTracker:object, geo:object, appCanvas:HTMLCanvasElement,
   *          getPlayerLocal:()=>({x:number,z:number}|null),
   *          getRecordName?:(id:string)=>string}} opts
   */
  constructor({ worldTracker, geo, appCanvas, getPlayerLocal, getRecordName }) {
    this.tracker = worldTracker
    this.geo = geo
    this.appCanvas = appCanvas
    this.getPlayerLocal = getPlayerLocal
    this.getRecordName = getRecordName || (id => id)
    // Laufzeit-Tuning ohne Rebuild (Konsole): ajnaMarkerCfg.radiusM = 50 …
    this.cfg = { radiusM: RADIUS_M, snap: true, headingSign: 1, thetaOffsetDeg: 0 }
    try { window.ajnaMarkerCfg = this.cfg } catch {}

    this._candidates = []        // [{id, lat, lon, alt, headingDeg, image, widthM}]
    this._activeIds = new Set()  // aktuell registrierte Objekt-IDs
    this._registry = new Map()   // id → {aspect, widthM, lat, lon, alt, headingDeg}
    this._dims = new Map()       // imageUrl → {w,h} (Preload-Cache)
    this._applying = false
    this._trackerGen = -1        // Neu-Registrierung nach Tracker-Restart
    this._canvas = null
    this._raf = 0
    this._timer = setInterval(() => this._tick(), TICK_MS)
  }

  /** Objektliste einspeisen (bei onObjectsChanged aufrufen). BEWUSST O(1):
   *  onObjectsChanged feuert bei Realtime-Traffic (Director) zig-mal pro
   *  Sekunde — die eigentliche Kandidaten-Auswahl läuft nur im 3-s-Tick. */
  refresh(objects) {
    this._objects = objects || []
  }

  // ── Auswahl im Umkreis + Registrierung (läuft nur alle TICK_MS) ──────────
  _tick() {
    if (!this.tracker?.active || !this.geo?.origin) return
    const p = this.getPlayerLocal?.()
    if (!p) return
    this._candidates = (this._objects || [])
      .map(o => ({ o, mk: o && ((o.state && o.state.marker) || o.marker) }))
      .filter(({ o, mk }) => mk && mk.image && Number(mk.widthM) > 0 &&
        Number.isFinite(o.lat) && Number.isFinite(o.lon))
      .map(({ o, mk }) => ({
        id: o.id, lat: o.lat, lon: o.lon,
        alt: mk.alt != null ? +mk.alt : (Number.isFinite(o.altitude) ? o.altitude : 1.2),
        headingDeg: mk.headingDeg != null ? +mk.headingDeg : (+o.heading || 0),
        image: mk.image, widthM: +mk.widthM,
      }))
    const withDist = this._candidates.map(c => {
      const l = this.geo.toLocal(c.lat, c.lon, 0)
      const d = Math.hypot(l.x - p.x, l.z - p.z)
      return { c, d }
    })
    const keepR = this.cfg.radiusM * LEAVE_FACTOR
    const chosen = withDist
      .filter(({ c, d }) => d <= (this._activeIds.has(c.id) ? keepR : this.cfg.radiusM))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_TARGETS)
      .map(({ c }) => c)
    const ids = new Set(chosen.map(c => c.id))
    const gen = this.tracker.generation ?? 0
    const unchanged = gen === this._trackerGen && ids.size === this._activeIds.size &&
      [...ids].every(id => this._activeIds.has(id))
    if (unchanged) return
    this._trackerGen = gen
    this._apply(chosen, ids)
  }

  async _apply(list, ids) {
    if (this._applying) return
    this._applying = true
    try {
      const targets = []
      for (const c of list) {
        let dims = this._dims.get(c.image)
        if (!dims) {
          try { dims = await this._loadDims(c.image); this._dims.set(c.image, dims) }
          catch (e) { console.warn('[marker] Bild nicht ladbar:', c.image, e?.message); continue }
        }
        this._registry.set(c.id, { aspect: dims.h / dims.w, widthM: c.widthM,
          lat: c.lat, lon: c.lon, alt: c.alt, headingDeg: c.headingDeg })
        targets.push({ name: c.id, imagePath: c.image, type: 'PLANAR',
          physicalWidthInMeters: c.widthM, moveable: false,
          properties: { originalWidth: dims.w, originalHeight: dims.h, left: 0, top: 0,
            width: dims.w, height: dims.h, isRotated: false } })
      }
      this.tracker.configureImageTargets(targets)
      this._activeIds = ids
      console.log(`[marker] ${targets.length} Target(s) registriert:`, targets.map(t => t.name).join(', ') || '—')
    } finally {
      this._applying = false
    }
  }

  _loadDims(src) {
    return new Promise((res, rej) => {
      const im = new Image(); im.crossOrigin = 'anonymous'
      im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight })
      im.onerror = () => rej(new Error('load failed'))
      im.src = src
    })
  }

  // ── Snap: frame-lokale Kamera-Geo-Pose aus einem erkannten Marker ────────
  /**
   * @param {object} r  worldTracker.reality des AKTUELLEN Frames
   * @returns {{theta:number, camLocal:object, upm:number, markerId:string}|null}
   */
  computeSnap(r) {
    if (!this.cfg.snap || !r || !r.detectedImages || !r.detectedImages.length) return null
    const B = window.BABYLON
    for (const d of r.detectedImages) {
      const reg = this._registry.get(d.name)
      if (!reg || !d.position || !d.rotation || !Number.isFinite(d.scale)) continue
      // Einheiten/Meter aus DIESEM Frame (Marker misst die SLAM-Skala).
      const widthU = reg.aspect <= 1 ? d.scale : d.scale / reg.aspect
      const upm = widthU / reg.widthM
      if (!Number.isFinite(upm) || upm <= 0) continue
      // Relativvektor Kamera→Marker in Metern (SLAM-Frame, gleicher Frame).
      const rel = new B.Vector3((d.position.x - r.position.x) / upm,
        (d.position.y - r.position.y) / upm, (d.position.z - r.position.z) / upm)
      // Marker-Yaw im SLAM-Frame: physische Front ≈ lokale Z-Normale der Pose
      // (die interne 90°-Drehung liegt um Z und ändert die Z-Normale nicht).
      const q = new B.Quaternion(d.rotation.x, d.rotation.y, d.rotation.z, d.rotation.w)
      const m = new B.Matrix(); B.Matrix.FromQuaternionToRef(q, m)
      const n = B.Vector3.TransformNormal(new B.Vector3(0, 0, 1), m)
      const yawS = Math.atan2(n.x, n.z)
      // Marker-Yaw im Geo-Frame aus headingDeg (Vorzeichen per cfg justierbar,
      // Konvention wie MarkerPreview: rotation.y = -headingDeg).
      const yawG = -reg.headingDeg * Math.PI / 180 * this.cfg.headingSign
        + this.cfg.thetaOffsetDeg * Math.PI / 180
      const theta = yawG - yawS
      // Kamera-Geo-Position = Marker-Geo-Pos − Ry(θ)·rel
      const markerLocal = this.geo.toLocalRef(reg.lat, reg.lon, reg.alt, 'ground')
      const rot = new B.Matrix(); B.Matrix.RotationYToRef(theta, rot)
      const relG = B.Vector3.TransformCoordinates(rel, rot)
      const camLocal = markerLocal.subtract(relG)
      return { theta, camLocal, upm, markerId: d.name }
    }
    return null
  }

  // ── Overlay: Umriss + Name + Distanz am erkannten Marker ─────────────────
  startOverlay() {
    if (this._raf) return
    const loop = () => { this._raf = requestAnimationFrame(loop); this._draw() }
    this._raf = requestAnimationFrame(loop)
  }
  stopOverlay() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0 }
    if (this._canvas) this._canvas.getContext('2d').clearRect(0, 0, this._canvas.width, this._canvas.height)
  }

  _ensureCanvas() {
    if (this._canvas) return this._canvas
    const c = document.createElement('canvas')
    c.id = 'marker-overlay'
    Object.assign(c.style, { position: 'absolute', top: '0', left: '0', width: '100%',
      height: '100%', zIndex: '2', pointerEvents: 'none' })
    const parent = this.appCanvas?.parentElement || document.body
    parent.appendChild(c)
    this._canvas = c
    return c
  }

  _draw() {
    const r = this.tracker?.reality
    const hasDet = this.tracker?.active && r && r.detectedImages?.length > 0 && r.intrinsics
    // Leerlauf: Canvas NICHT pro Frame anfassen (Fullscreen-Ebene = Fill-Rate!)
    // — einmal leeren nach der letzten Erkennung, sonst gar nicht existieren lassen.
    if (!hasDet) {
      if (this._drawn && this._canvas) {
        this._canvas.getContext('2d').clearRect(0, 0, this._canvas.width, this._canvas.height)
        this._drawn = false
      }
      return
    }
    const c = this._ensureCanvas(), ctx = c.getContext('2d')
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const W = Math.round(window.innerWidth * dpr), H = Math.round(window.innerHeight * dpr)
    if (c.width !== W) { c.width = W; c.height = H }
    ctx.clearRect(0, 0, W, H)
    this._drawn = true
    const B = window.BABYLON
    // Projektion im SLAM-Frame (RH wie die App): view aus der Kamera-Pose,
    // Projektion aus den ROHEN Intrinsics (matcht das Kamerabild der Engine).
    const rot = new B.Quaternion(r.rotation.x, r.rotation.y, r.rotation.z, r.rotation.w)
    const pos = new B.Vector3(r.position.x, r.position.y, r.position.z)
    const view = B.Matrix.Invert(B.Matrix.Compose(B.Vector3.One(), rot, pos))
    const vp = view.multiply(B.Matrix.FromArray(r.intrinsics))
    const viewport = new B.Viewport(0, 0, W, H)
    const ID = B.Matrix.Identity()
    const project = (p) => {
      const z = B.Vector3.TransformCoordinates(p, view).z
      if (Math.abs(z) <= 0.05) return null
      const s = B.Vector3.Project(p, ID, vp, viewport)
      return (s.x >= -W && s.x <= 2 * W) ? { x: s.x, y: s.y } : null
    }
    ctx.font = `${Math.round(18 * (W / 720))}px ui-monospace, monospace`
    ctx.textAlign = 'center'
    for (const d of r.detectedImages) {
      const reg = this._registry.get(d.name)
      if (!reg || !d.position || !d.rotation) continue
      const asp = reg.aspect || 1
      const s = d.scale || 1
      const widthU = asp <= 1 ? s : s / asp
      const halfX = (widthU * asp) / 2, halfY = widthU / 2   // Höhe→X, Breite→Y (Konvention)
      const q = new B.Quaternion(d.rotation.x, d.rotation.y, d.rotation.z, d.rotation.w)
      const m = new B.Matrix(); B.Matrix.FromQuaternionToRef(q, m)
      const ctr = new B.Vector3(d.position.x, d.position.y, d.position.z)
      const P = [[-halfX, halfY, 0], [halfX, halfY, 0], [halfX, -halfY, 0], [-halfX, -halfY, 0]]
        .map(a => project(ctr.add(B.Vector3.TransformCoordinates(new B.Vector3(a[0], a[1], a[2]), m))))
      ctx.strokeStyle = '#5ef27a'; ctx.lineWidth = 3; ctx.beginPath()
      let st = false
      for (const p of P) { if (!p) continue; st ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); st = true }
      if (st) { ctx.closePath(); ctx.stroke() }
      const upm = widthU / reg.widthM
      const distM = B.Vector3.Distance(ctr, pos) / (upm || 1)
      const top = P[0] || P[1]
      if (top) { ctx.fillStyle = '#5ef27a'; ctx.fillText(`${this.getRecordName(d.name)} · ${distM.toFixed(1)} m`, top.x, top.y - 8) }
    }
  }

  dispose() {
    clearInterval(this._timer)
    this.stopOverlay()
    this._canvas?.remove(); this._canvas = null
  }
}
