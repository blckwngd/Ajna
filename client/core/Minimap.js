// Minimap — kompakte 2D-Karte als HUD über der 3D-/AR-Ansicht.
//
// Zeigt IMMER den Kartenausschnitt der aktuellen KAMERAPOSITION (nicht der
// GPS-Position): in XR ist die Kamera der Spieler, im Desktop-3D fliegt man frei
// durch die Welt und will wissen, wo man gerade steckt. Die Kamera sitzt daher
// fest in der Panelmitte, dort zeichnet ein Pfeil mit Sichtkegel die
// Blickrichtung. Die Karte selbst bleibt nordorientiert (oben = Nord) — eine
// mitdrehende Leaflet-Karte ginge in 1.x nur über CSS-Transforms auf dem
// Map-Pane und bricht dort Kacheln und Eingaben.
//
// Ansichts-Bindung: die Instanz hängt im View-Container der 3D-Ansicht (in der
// Mobile-Shell `.shell-view[data-view="ar"]`, standalone `<body>`). Damit ist
// sie automatisch nur im 3D-/AR-Tab sichtbar und verschwindet in der
// Kartenansicht mit — dort wäre eine Minikarte über der Karte sinnlos.
//
// Leaflet wird WIEDERVERWENDET: liegt `window.L` schon vor (Mobile-Shell und
// index-map.html laden es per <script>), nutzt die Minimap genau diese Instanz;
// auf der reinen 3D-Seite (index-ar.html) wird es beim ersten Öffnen von
// derselben CDN-URL mit denselben SRI-Hashes nachgeladen. Solange niemand die
// Minimap öffnet, kostet sie den 3D-Client also nichts.
//
// Objekte werden bewusst NICHT gezeichnet (die Marker-Logik der großen Karte
// hängt an map.js). Wenn das später kommt: ein `L.layerGroup()` auf `this._map`
// und ein `setObjects(list)`, das aus `emojiOf()` schlanke DivIcons baut.

import { makeDraggable } from './draggable.js'

const STYLE_ID   = 'ajna-minimap-style'
const KEY_POS    = 'ajna.minimap.pos'
const KEY_ZOOM   = 'ajna.minimap.zoom'
const KEY_OPEN   = 'ajna.minimap.open'
// Bewusst DERSELBE Schlüssel wie in map.js: wer die große Karte auf dunkel
// stellt, findet die Minimap ebenso vor (und umgekehrt).
const KEY_THEME  = 'ajna_map_theme'

// Nachführung läuft im Bildtakt (requestAnimationFrame), nicht auf einem
// Intervall: mit 4 Hz sprang die Karte beim Gehen sichtbar in Stufen. Die
// Schwellen sind so klein, dass Bewegung flüssig wirkt, aber ein ruhender
// Betrachter keine Arbeit auslöst.
const MOVE_EPS_M  = 0.05   // darunter kein setView (Karte steht ohnehin still)
const HEADING_EPS = 0.25   // Grad, darunter kein Neu-Rotieren des Pfeils
const ZOOM_MIN    = 12
const ZOOM_MAX    = 21

// Gleiche Version + Hashes wie in index.html / index-map.html — beim Aktualisieren
// alle drei Stellen mitziehen, sonst lädt die Seite zwei Leaflet-Versionen.
const LEAFLET = {
  css: { href: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
         integrity: 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=' },
  js:  { src: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
         integrity: 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=' },
}

let _leafletPromise = null

/**
 * Leaflet bereitstellen — sofort, wenn die Seite es schon geladen hat, sonst
 * einmalig per CDN nachziehen. Bei Fehlschlag (offline) wird der Cache
 * zurückgesetzt, damit ein späterer Versuch es erneut probiert.
 * @returns {Promise<object>} window.L
 */
export function ensureLeaflet() {
  if (window.L) return Promise.resolve(window.L)
  if (_leafletPromise) return _leafletPromise
  _leafletPromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET.css.href}"]`)) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = LEAFLET.css.href
      link.integrity = LEAFLET.css.integrity
      link.crossOrigin = ''
      document.head.appendChild(link)
    }
    const s = document.createElement('script')
    s.src = LEAFLET.js.src
    s.integrity = LEAFLET.js.integrity
    s.crossOrigin = ''
    s.onload = () => window.L ? resolve(window.L) : reject(new Error('Leaflet geladen, aber window.L fehlt'))
    s.onerror = () => reject(new Error('Leaflet nicht erreichbar'))
    document.head.appendChild(s)
  }).catch(err => { _leafletPromise = null; throw err })
  return _leafletPromise
}

// Basemaps wie in map.js, aber als FABRIKEN: eine Leaflet-Layer-Instanz kann
// immer nur auf genau einer Karte liegen, geteilte Objekte würden die große
// Karte leerräumen, sobald die Minimap denselben Stil wählt.
//
// Die Quellenangaben stehen kurz: in der runden Scheibe ist unten nur eine
// schmale Sehne Platz. Der volle Text hängt als `title` daran (siehe CSS-Block
// und `_applyBase`), die Nennung bleibt also erhalten.
const BASEMAPS = {
  light: {
    label: 'Karte hell', icon: '🗺️',
    make: L => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxNativeZoom: 19, maxZoom: ZOOM_MAX, attribution: '&copy; OSM',
    }),
    voll: '© OpenStreetMap contributors',
  },
  dark: {
    label: 'Karte dunkel', icon: '🌑',
    make: L => L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxNativeZoom: 20, maxZoom: ZOOM_MAX, subdomains: 'abcd',
      attribution: '&copy; OSM, CARTO',
    }),
    voll: '© OpenStreetMap contributors, © CARTO',
  },
  satellite: {
    label: 'Satellit', icon: '🛰️',
    // Achtung: Esri-Kachel-URL in der Reihenfolge {z}/{y}/{x}.
    make: L => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 19, maxZoom: ZOOM_MAX, attribution: '&copy; Esri',
    }),
    voll: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
}
const BASE_ORDER = ['light', 'dark', 'satellite']

const read = (key, fallback = null) => { try { return localStorage.getItem(key) ?? fallback } catch { return fallback } }
const write = (key, value) => { try { localStorage.setItem(key, value) } catch {} }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** Grobe Meter-Distanz (equirektangulär) — für die Bewegungsschwelle völlig ausreichend. */
const distM = (a, b) => Math.hypot(
  (b.lat - a.lat) * 111320,
  (b.lon - a.lon) * 111320 * Math.cos(a.lat * Math.PI / 180))

/** Kleinste Winkeldifferenz in Grad (−180…180). */
const angleDelta = (a, b) => ((a - b + 540) % 360) - 180

export class Minimap {
  /**
   * @param {{
   *   container?: HTMLElement,
   *   getView: () => ({lat:number, lon:number, heading?:number}|null),
   *   zoom?: number,
   * }} opts  getView liefert die aktuelle Kameraposition in WGS84 plus
   *          Blickrichtung als Kompasskurs (0 = Nord, im Uhrzeigersinn).
   */
  constructor({ container = document.body, getView, zoom = 17 } = {}) {
    this.container = container
    this.getView = getView
    this._zoom = clamp(Number(read(KEY_ZOOM, zoom)) || zoom, ZOOM_MIN, ZOOM_MAX)
    this._base = BASEMAPS[read(KEY_THEME, 'light')] ? read(KEY_THEME, 'light') : 'light'
    this._open = false
    this._map = null
    this._tiles = null
    this._mapPending = null
    this._raf = 0
    this._last = null
    this._injectStyles()
    this._buildDom()
    // Zustand über Sitzungen halten: wer die Minimap offen gelassen hat, will
    // sie beim nächsten Start nicht erneut aufklappen müssen.
    if (read(KEY_OPEN) === '1') this.open()
  }

  toggle() { this._open ? this.close() : this.open() }

  /**
   * Die ganze Minimap ein-/ausblenden — Knopf UND Fenster. Getrennt von
   * open()/close(): DAS ist die Entscheidung des Nutzers und bleibt gemerkt,
   * während setVisible() nur sagt, ob die Ansicht sie überhaupt anbietet.
   *
   * Gebraucht, seit die Minimap nicht mehr in einem einzelnen View-Container
   * hängt: sie soll in der 3D- UND der Objekte-Ansicht erscheinen, aber nicht
   * über der Karte — dort wäre eine Minikarte sinnlos.
   */
  setVisible(on) {
    this._hidden = !on
    if (this.fab) this.fab.style.display = on ? '' : 'none'
    // Das Fenster folgt der Nutzer-Entscheidung, aber nur solange sichtbar.
    if (this._panel) this._panel.hidden = !on || !this._open
    if (on) { if (this._open) { this._startLoop(); this._map?.invalidateSize(); this._tick(true) } }
    else this._stopLoop()
  }

  open() {
    if (this._open) return
    this._open = true
    if (!this._hidden) this._panel.hidden = false
    this.fab.classList.add('active')
    write(KEY_OPEN, '1')
    this._ensureMap().then(() => { this._map?.invalidateSize(); this._syncRadius(); this._tick(true) })
    this._startLoop()
  }

  close() {
    this._open = false
    this._panel.hidden = true
    this.fab.classList.remove('active')
    write(KEY_OPEN, '0')
    // Karte bewusst NICHT zerstören: das erneute Öffnen soll sofort stehen,
    // Kacheln sind ohnehin im Browser-Cache. Nur die Nachführung pausiert.
    this._stopLoop()
  }

  // Bildtakt statt Intervall: die Karte soll mit der Kamera mitfließen, nicht
  // in Stufen springen. rAF pausiert von selbst, sobald der Tab im Hintergrund
  // liegt — und die Schwellen in _tick sorgen dafür, dass ein stillstehender
  // Betrachter keine Leaflet-Arbeit auslöst.
  _startLoop() {
    if (this._raf) return
    const step = () => {
      this._raf = requestAnimationFrame(step)
      this._tick()
    }
    this._raf = requestAnimationFrame(step)
  }

  _stopLoop() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0 }
  }

  dispose() {
    this._stopLoop()
    try { this._resizeObserver?.disconnect() } catch {}
    try { this._dragCleanup?.() } catch {}
    try { this._map?.remove() } catch {}
    this._map = null
    this._panel?.remove()
    this.fab?.remove()
  }

  // ── DOM ────────────────────────────────────────────────────────────────
  _buildDom() {
    this.fab = document.createElement('button')
    this.fab.type = 'button'
    this.fab.className = 'ajna-mm-fab'
    this.fab.title = 'Minimap'
    this.fab.textContent = '🧭'
    this.container.appendChild(this.fab)
    this._fabDrag = makeDraggable(this.fab, { key: 'ajna.minimap.fab', onClick: () => this.toggle() })

    const panel = document.createElement('div')
    panel.className = 'ajna-mm-panel'
    panel.hidden = true
    // Runde Scheibe mit vier Bedienknöpfen in den Ecken des umschließenden
    // Quadrats: die Ecken liegen AUSSERHALB des Kreises und sind sonst leer,
    // die Knöpfe kosten also keine Kartenfläche.
    panel.innerHTML = `
      <div class="ajna-mm-disc">
        <div class="ajna-mm-canvas" data-role="map"></div>
        <div class="ajna-mm-north">N</div>
        <div class="ajna-mm-radius" data-role="radius"></div>
        <div class="ajna-mm-self" data-role="self">
          <svg viewBox="-34 -34 68 68" width="68" height="68" aria-hidden="true">
            <path d="M0 0 L-13.5 -29 A32 32 0 0 1 13.5 -29 Z" class="ajna-mm-cone"/>
            <circle r="4.5" class="ajna-mm-dot"/>
          </svg>
        </div>
        <div class="ajna-mm-status" data-role="status" hidden></div>
      </div>
      <button type="button" class="ajna-mm-chip mm-tl" data-role="base" title="Kartenstil"></button>
      <button type="button" class="ajna-mm-chip mm-tr" data-role="close" title="Schließen">✕</button>
      <button type="button" class="ajna-mm-chip mm-bl" data-role="zoomout" title="Weiter weg">−</button>
      <button type="button" class="ajna-mm-chip mm-br" data-role="zoomin" title="Näher heran">+</button>`
    this.container.appendChild(panel)
    this._panel = panel
    this._selfEl = panel.querySelector('[data-role="self"]')
    this._statusEl = panel.querySelector('[data-role="status"]')
    this._radiusEl = panel.querySelector('[data-role="radius"]')
    this._baseBtn = panel.querySelector('[data-role="base"]')
    this._syncBaseBtn()

    panel.querySelector('[data-role="close"]').addEventListener('click', () => this.close())
    this._baseBtn.addEventListener('click', () => this._cycleBase())
    panel.querySelector('[data-role="zoomin"]').addEventListener('click', () => this._zoomBy(+1))
    panel.querySelector('[data-role="zoomout"]').addEventListener('click', () => this._zoomBy(-1))
    // Die ganze Scheibe ist der Anfasser (Kartenschwenk ist ohnehin aus, die
    // Mitte IST die Kamera). Die Eckknöpfe dürfen dabei keinen Zug auslösen.
    for (const chip of panel.querySelectorAll('.ajna-mm-chip')) {
      chip.addEventListener('pointerdown', e => e.stopPropagation())
    }
    this._dragCleanup = makeDraggable(panel, { key: KEY_POS })

    // Leaflet muss von jeder Größenänderung erfahren — auch von der, die beim
    // Tab-Wechsel entsteht: in der Shell ist die AR-View `display:none`, die
    // Karte misst dann 0×0 und bliebe nach dem Einblenden grau.
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => {
        if (!this._map) return
        this._map.invalidateSize()
        this._syncRadius()
      })
      this._resizeObserver.observe(panel)
    }
  }

  _zoomBy(delta) {
    if (!this._map) return
    this._map.setZoom(clamp(this._map.getZoom() + delta, ZOOM_MIN, ZOOM_MAX))
  }

  /** Sichtbarer Radius als Text — bei einer runden Karte die natürliche Maßangabe. */
  _syncRadius() {
    if (!this._map || !this._radiusEl) return
    const size = this._map.getSize()
    if (!size.x || !size.y) return
    const m = this._map.distance(this._map.getCenter(), this._map.containerPointToLatLng([0, size.y / 2]))
    if (!Number.isFinite(m) || m <= 0) return
    this._radiusEl.textContent = m < 950 ? `${Math.round(m / 5) * 5} m` : `${(m / 1000).toFixed(1)} km`
  }

  _status(text) {
    if (!this._statusEl) return
    this._statusEl.textContent = text || ''
    this._statusEl.hidden = !text
  }

  _syncBaseBtn() {
    const b = BASEMAPS[this._base]
    this._baseBtn.textContent = b.icon
    this._baseBtn.title = `Kartenstil: ${b.label}`
  }

  _cycleBase() {
    const next = BASE_ORDER[(BASE_ORDER.indexOf(this._base) + 1) % BASE_ORDER.length]
    this._base = next
    write(KEY_THEME, next)
    this._syncBaseBtn()
    this._applyBase()
  }

  _applyBase() {
    if (!this._map || !window.L) return
    if (this._tiles) { this._map.removeLayer(this._tiles); this._tiles = null }
    this._tiles = BASEMAPS[this._base].make(window.L)
    this._tiles.addTo(this._map)
    // Kurztext in der Scheibe, vollständige Nennung als Tooltip.
    const attr = this._panel.querySelector('.leaflet-control-attribution')
    if (attr) attr.title = BASEMAPS[this._base].voll
  }

  // ── Karte ──────────────────────────────────────────────────────────────
  async _ensureMap() {
    if (this._map) return this._map
    if (this._mapPending) return this._mapPending
    this._status('Karte wird geladen …')
    this._mapPending = (async () => {
      const L = await ensureLeaflet()
      const start = this.getView?.()
      const center = (start && Number.isFinite(start.lat)) ? [start.lat, start.lon] : [0, 0]
      const map = L.map(this._panel.querySelector('[data-role="map"]'), {
        // Pannen aus: die Mitte IST die Kamera, ein verschobener Ausschnitt
        // würde im nächsten Bild sofort zurückspringen. Auch Pinch ist aus —
        // auf der runden Scheibe gehört die Berührung dem Verschieben des HUDs;
        // gezoomt wird über die beiden Eckknöpfe (am Schreibtisch zusätzlich
        // per Mausrad).
        dragging: false, doubleClickZoom: false, boxZoom: false, keyboard: false,
        touchZoom: false, tap: false, scrollWheelZoom: true,
        // Eigene Eckknöpfe statt Leaflets Zoom-Leiste: die säße im Kreis in
        // einer abgeschnittenen Ecke.
        zoomControl: false, attributionControl: true,
        minZoom: ZOOM_MIN, maxZoom: ZOOM_MAX,
      }).setView(center, this._zoom)
      map.attributionControl.setPrefix('')
      map.on('zoomend', () => {
        this._zoom = map.getZoom()
        write(KEY_ZOOM, String(this._zoom))
        this._syncRadius()
      })
      this._map = map
      this._applyBase()
      this._syncRadius()
      this._status(null)
      return map
    })().catch(err => {
      this._mapPending = null
      this._status('Karte nicht verfügbar')
      console.warn('[minimap] Leaflet konnte nicht bereitgestellt werden:', err?.message || err)
      return null
    })
    return this._mapPending
  }

  // ── Nachführung ────────────────────────────────────────────────────────
  _tick(force = false) {
    if (!this._open || !this._map || document.hidden) return
    const v = this.getView?.()
    // Vor dem ersten GPS-Fix steht kein Geo-Origin — ohne Hinweis stünde die
    // Karte stumm auf 0°/0° (Atlantik) und sähe nach einem Fehler aus.
    if (!v || !Number.isFinite(v.lat) || !Number.isFinite(v.lon)) {
      if (!this._last) this._status('Warte auf Position …')
      return
    }
    this._status(null)

    if (force || !this._last || distM(this._last, v) > MOVE_EPS_M) {
      this._map.setView([v.lat, v.lon], this._zoom, { animate: false })
    }
    // Ohne belastbare Blickrichtung (Kamera schaut senkrecht nach oben/unten)
    // die letzte behalten statt auf 0 zu springen.
    const heading = Number.isFinite(v.heading) ? v.heading : (this._last?.heading ?? 0)
    if (force || !this._last || Math.abs(angleDelta(heading, this._last.heading)) > HEADING_EPS) {
      this._selfEl.style.transform = `translate(-50%, -50%) rotate(${heading.toFixed(1)}deg)`
    }
    this._last = { lat: v.lat, lon: v.lon, heading }
  }

  // ── CSS ────────────────────────────────────────────────────────────────
  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const bottom = 'calc(var(--tabbar-height, 0px) + var(--safe-bottom, env(safe-area-inset-bottom, 0px)) + 144px)'
    const s = document.createElement('style')
    s.id = STYLE_ID
    s.textContent = `
    /* Auslöser — Reihe der schwebenden Knöpfe: 🎒 +16, 💬 +80, 🧭 +144 */
    .ajna-mm-fab{position:fixed;right:16px;bottom:${bottom};z-index:5500;
      width:48px;height:48px;border-radius:50%;border:1px solid #3a3a44;
      background:rgba(24,24,30,.92);color:#eaeaea;font-size:22px;line-height:1;cursor:pointer;
      display:flex;align-items:center;justify-content:center;box-shadow:0 6px 22px rgba(0,0,0,.45)}
    .ajna-mm-fab.active{background:#2c5d8f;border-color:#3a78b6;color:#fff}
    .ajna-mm-fab:active{transform:scale(.96)}

    /* Quadratischer Rahmen, runde Scheibe darin. Die vier Ecken des Quadrats
       liegen ausserhalb des Kreises und sind sonst ungenutzt — genau dort
       sitzen die Bedienknöpfe, sie kosten also keine Kartenfläche. */
    .ajna-mm-panel{position:fixed;right:16px;bottom:calc(${bottom} + 60px);z-index:5400;
      width:var(--mm-size);height:var(--mm-size);--mm-size:clamp(168px,44vw,248px);
      background:transparent;cursor:move;touch-action:none}
    .ajna-mm-panel[hidden]{display:none}

    .ajna-mm-disc{position:absolute;inset:0;border-radius:50%;overflow:hidden;
      background:#12141a;border:2px solid rgba(255,255,255,.20);
      box-shadow:0 8px 30px rgba(0,0,0,.55), inset 0 0 24px rgba(0,0,0,.45)}
    .ajna-mm-canvas{position:absolute;inset:0;background:#12141a}

    /* Quellenangabe mittig unten — die Ecken schneidet der Kreis ab. */
    .ajna-mm-canvas .leaflet-bottom.leaflet-right{left:0;right:0;
      display:flex;justify-content:center;pointer-events:none}
    /* 11 px vom Rand: ganz unten ist die Kreissehne zu kurz, der Text würde
       an den Seiten abgeschnitten. */
    .ajna-mm-canvas .leaflet-control-attribution{margin:0 0 11px;padding:0 5px;pointer-events:auto;
      font:8px system-ui,sans-serif;line-height:12px;border-radius:6px;
      background:rgba(0,0,0,.45);color:#d6d9e0;white-space:nowrap}
    .ajna-mm-canvas .leaflet-control-attribution a{color:#9dc4ee}

    /* Eckknöpfe */
    .ajna-mm-chip{position:absolute;width:26px;height:26px;border-radius:50%;cursor:pointer;
      border:1px solid #3a3a44;background:rgba(24,24,30,.94);color:#d6d9e0;
      font:14px/1 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
      padding:0;box-shadow:0 3px 10px rgba(0,0,0,.5);z-index:10}
    .ajna-mm-chip:hover{color:#fff;background:rgba(44,93,143,.95);border-color:#3a78b6}
    .ajna-mm-chip:active{transform:scale(.92)}
    .ajna-mm-chip.mm-tl{left:-4px;top:-4px}
    .ajna-mm-chip.mm-tr{right:-4px;top:-4px}
    .ajna-mm-chip.mm-bl{left:-4px;bottom:-4px;font-size:18px}
    .ajna-mm-chip.mm-br{right:-4px;bottom:-4px;font-size:17px}

    /* Kamera-Marke: sitzt fest in der Mitte, nur die Rotation ändert sich.
       Keine CSS-Transition — die Nachführung läuft im Bildtakt, eine
       Überblendung würde der Kamera nur hinterherhinken. */
    .ajna-mm-self{position:absolute;left:50%;top:50%;width:68px;height:68px;
      transform:translate(-50%,-50%);transform-origin:50% 50%;pointer-events:none;z-index:500}
    .ajna-mm-cone{fill:rgba(80,160,255,.30);stroke:rgba(120,190,255,.65);stroke-width:1}
    .ajna-mm-dot{fill:#4da3ff;stroke:#fff;stroke-width:1.5}

    .ajna-mm-north,.ajna-mm-radius{position:absolute;left:50%;transform:translateX(-50%);z-index:500;
      font:600 10px system-ui,sans-serif;color:#eaeaea;pointer-events:none;
      background:rgba(0,0,0,.45);border-radius:5px;padding:0 5px;white-space:nowrap}
    .ajna-mm-north{top:5px}
    .ajna-mm-radius{bottom:27px;font-weight:500;color:#c9cdd6}

    .ajna-mm-status{position:absolute;inset:0;z-index:600;display:flex;align-items:center;
      justify-content:center;text-align:center;padding:10px;
      font:12px system-ui,sans-serif;color:#8a8f99;background:rgba(18,18,22,.9)}
    .ajna-mm-status[hidden]{display:none}`
    document.head.appendChild(s)
  }
}
