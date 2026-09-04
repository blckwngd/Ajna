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
// Objekte erscheinen als reine Symbole (kein Name daneben — auf einer
// handtellergroßen Scheibe wäre Text sofort Brei). Der Name steht im Tooltip
// beim Überfahren bzw. Antippen. Bewusst OHNE Kontextmenü und ohne
// Interaktionen: die Minimap ist zum Orientieren da, gehandelt wird in der
// AR-Ansicht oder auf der großen Karte.
//
// Damit ein wlan-reicher Server nicht die Bildrate frisst: nur was im
// gezeichneten Kreis liegt, höchstens OBJ_MAX Stück (die nächsten zuerst),
// abgeglichen mit OBJ_SYNC_MS statt in jedem Bild.

import { makeDraggable } from './draggable.js'
import { iconOf } from './Appearance.js'

const STYLE_ID   = 'ajna-minimap-style'
const KEY_POS    = 'ajna.minimap.pos'
const KEY_ZOOM   = 'ajna.minimap.zoom'
// Nicht die Zoomstufe selbst wird gemerkt, sondern der ABSTAND zu der Stufe,
// die zur aktuellen Flughöhe gehört. Wer einmal eine Stufe näher heranzieht,
// bleibt beim Steigen und Sinken eine Stufe näher.
const KEY_OFFSET = 'ajna.minimap.zoomoffset'
const KEY_OPEN   = 'ajna.minimap.open'
// Ausrichtung: 'blick' (oben ist die Blickrichtung) oder 'nord'.
const KEY_NORDEN = 'ajna.minimap.norden'
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

// Objekt-Marker: Abgleich mit 5 Hz statt im Bildtakt. Die Karte ist wenige
// Zentimeter groß — schneller wäre nicht sichtbar, aber bei einigen tausend
// Objekten teuer. Bewegte Objekte (Schiffe, Flugzeuge, Figuren) wirken damit
// weiterhin flüssig.
// Zoom nach Flughöhe: der abgedeckte Radius soll ungefähr dem entsprechen,
// was die Kamera von dort oben überblickt. Am Boden bleibt es beim bisherigen
// Ausschnitt (BODEN_RADIUS_M), darüber wächst er mit der Höhe.
const HOEHE_FAKTOR   = 1.5   // sichtbarer Radius ≈ Faktor × Höhe über Grund
const BODEN_RADIUS_M = 55    // Untergrenze — entspricht der bisherigen Vorgabe
const HOEHE_EPS_M    = 3     // darunter nicht neu zoomen (Zappeln vermeiden)

const OBJ_SYNC_MS   = 200
const OBJ_MAX       = 250    // Obergrenze gezeichneter Marker, nächste zuerst
const OBJ_MOVE_EPS_M = 0.5   // darunter kein setLatLng (spart Layout-Arbeit)

// Zusatzangaben im Tooltip. Beide standardmäßig AUS: im Alltag will man den
// Namen lesen, nicht eine ID entziffern. Für die Fehlersuche jederzeit
// einschaltbar, ohne Neubau:
//   localStorage.setItem('ajna.minimap.tooltipId', '1')       Objekt-ID
//   localStorage.setItem('ajna.minimap.tooltipServer', '1')   Herkunfts-Server
const TOOLTIP_SERVER_DEFAULT = false
const TOOLTIP_ID_DEFAULT     = false
const KEY_TIP_SERVER = 'ajna.minimap.tooltipServer'
const KEY_TIP_ID     = 'ajna.minimap.tooltipId'

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
    kurz: '© OSM', voll: '© OpenStreetMap contributors',
  },
  dark: {
    label: 'Karte dunkel', icon: '🌑',
    make: L => L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxNativeZoom: 20, maxZoom: ZOOM_MAX, subdomains: 'abcd',
      attribution: '&copy; OSM, CARTO',
    }),
    kurz: '© OSM, CARTO', voll: '© OpenStreetMap contributors, © CARTO',
  },
  satellite: {
    label: 'Satellit', icon: '🛰️',
    // Achtung: Esri-Kachel-URL in der Reihenfolge {z}/{y}/{x}.
    make: L => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 19, maxZoom: ZOOM_MAX, attribution: '&copy; Esri',
    }),
    kurz: '© Esri', voll: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
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
   *   getObjects?: () => object[],
   *   serverNameFor?: (record: object) => (string|null),
   *   filters?: {matches: (o:object) => boolean, onChange?: (fn:Function) => Function},
   *   zoom?: number,
   * }} opts  getView liefert die aktuelle Kameraposition in WGS84 plus
   *          Blickrichtung als Kompasskurs (0 = Nord, im Uhrzeigersinn).
   *          getObjects liefert die bekannten Objekte (Records mit lat/lon);
   *          fehlt es, bleibt die Karte leer wie bisher. filters ist der
   *          Inhaltsfilter — was der Spieler ausgeblendet hat, gehört auch
   *          hier nicht hin.
   */
  constructor({ container = document.body, getView, getObjects = null, filters = null,
                serverNameFor = null, zoom = 17 } = {}) {
    this.container = container
    this.getView = getView
    this.getObjects = getObjects
    // Bei mehreren verbundenen Servern gehört der Servername in den Tooltip:
    // zwei Instanzen mit je einem World-Director erzeugen Figuren aus denselben
    // Namenspools. Ohne die Herkunft sehen zwei verschiedene „Mara Roth" wie
    // ein kaputter Datensatz aus.
    this.serverNameFor = serverNameFor
    this.filters = filters || null
    this._objLayer = null
    this._markers = new Map()   // Objekt-ID → L.Marker
    this._objSyncAt = 0
    this._zoomOffset = Number(read(KEY_OFFSET, '0')) || 0
    this._autoZooming = false   // unterscheidet eigenes Zoomen von dem des Nutzers
    this._lastHoehe = null
    this._zoom = clamp(Number(read(KEY_ZOOM, zoom)) || zoom, ZOOM_MIN, ZOOM_MAX)
    this._base = BASEMAPS[read(KEY_THEME, 'light')] ? read(KEY_THEME, 'light') : 'light'
    this._open = false
    // Ausdrücklich gesetzt: `setDocked` vergleicht dagegen, und ein
    // undefinierter Startwert ließe den ersten Aufruf anders laufen als jeden
    // weiteren.
    this._docked = false
    this._freiePos = null
    this._map = null
    this._tiles = null
    this._mapPending = null
    this._raf = 0
    this._last = null
    this._injectStyles()
    this._buildDom()
    // Blendet der Spieler eine Quelle aus, sollen ihre Symbole sofort weg sein
    // — nicht erst beim nächsten Abgleich.
    if (this.filters?.onChange) {
      this._filterOff = this.filters.onChange(() => this._syncObjects(this._last, true))
    }
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
  /**
   * Oben andocken statt frei schweben.
   *
   * WOFÜR: In der Objektliste soll die Karte die Liste nicht verdecken,
   * sondern über ihr stehen — Karte oben, Liste darunter. Das ist nah an
   * „ich zeige auf etwas und greife es direkt an".
   *
   * Die frei gezogene Position wird dabei nur AUSGEBLENDET, nicht vergessen:
   * Beim Abdocken steht das HUD wieder da, wo der Mensch es hingelegt hat.
   * Eine Position, die man selbst gewählt hat, darf ein Reiterwechsel nicht
   * stillschweigend verwerfen.
   *
   * Die tatsächliche Höhe geht als `--mm-hoehe` ans Dokument — wer darunter
   * Platz lassen will, rechnet die Größe nicht nach, sondern liest sie ab.
   */
  setDocked(on) {
    const an = !!on
    if (this._docked === an) return
    this._docked = an
    const p = this._panel
    if (!p) return
    if (an) {
      // ALLE VIER Kanten merken, nicht nur zwei.
      //
      // Der Fehler, den das behebt: `makeDraggable` setzt beim Anwenden einer
      // gemerkten Position `right`/`bottom` auf `auto` — dort steht die
      // Position dann in `left`/`top`. Gemerkt wurden aber nur diese beiden.
      // Beim Abdocken kamen sie leer zurück, während `right:auto` und
      // `bottom:auto` INLINE stehen blieben und die Regel aus dem Stylesheet
      // (`right:16px`) überstimmten. Ergebnis: ein `position:fixed`-Element
      // ohne einen einzigen Anker — es rutschte an seinen statischen Platz
      // unter das Fenster und war in der 3D-Ansicht schlicht weg.
      this._freiePos = {
        left: p.style.left, top: p.style.top,
        right: p.style.right, bottom: p.style.bottom,
      }
      p.style.left = ''
      p.style.top = ''
      p.style.right = ''
      p.style.bottom = ''
      p.classList.add('mm-oben')
    } else {
      p.classList.remove('mm-oben')
      // Ohne gemerkte Position bleibt alles leer — dann greift wieder das
      // Stylesheet. Genau das ist der Normalfall für jeden, der die Karte nie
      // verschoben hat.
      const f = this._freiePos || { left: '', top: '', right: '', bottom: '' }
      p.style.left = f.left
      p.style.top = f.top
      p.style.right = f.right
      p.style.bottom = f.bottom
    }
    this._meldeHoehe()
  }

  /** Höhe der Scheibe ans Dokument geben (0, wenn nicht angedockt/sichtbar). */
  _meldeHoehe() {
    const sichtbar = this._docked && this._open
    const h = sichtbar ? (this._panel?.offsetHeight || 0) : 0
    try { document.documentElement.style.setProperty('--mm-hoehe', `${h}px`) } catch {}
  }

  setVisible(on) {
    this._hidden = !on
    if (this.fab) this.fab.style.display = on ? '' : 'none'
    // Das Fenster folgt der Nutzer-Entscheidung, aber nur solange sichtbar.
    if (this._panel) this._panel.hidden = !on || !this._open
    if (on) { if (this._open) { this._startLoop(); this._map?.invalidateSize(); this._tick(true) } }
    else this._stopLoop()
    this._meldeHoehe()
  }

  open() {
    if (this._open) return
    this._open = true
    if (!this._hidden) this._panel.hidden = false
    this.fab.classList.add('active')
    write(KEY_OPEN, '1')
    this._ensureMap().then(() => { this._map?.invalidateSize(); this._syncRadius(); this._tick(true) })
    this._startLoop()
    this._meldeHoehe()
  }

  close() {
    this._open = false
    this._panel.hidden = true
    this.fab.classList.remove('active')
    write(KEY_OPEN, '0')
    this._meldeHoehe()
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
    try { this._filterOff?.() } catch {}
    this._lastHoehe = null
    this._markers.clear()
    this._objLayer = null
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
        <!-- Die Nadel zeigt, wo Norden liegt, und wandert mit der Karte.
             Der Schalter steht FEST oben: Ein Knopf, der sich beim Drehen
             mitbewegt, ist auf einem Telefon nicht zu treffen. -->
        <div class="ajna-mm-nordring"><div class="ajna-mm-nordmarke">N</div></div>
        <button type="button" class="ajna-mm-north" data-role="norden"></button>
        <div class="ajna-mm-radius" data-role="radius"></div>
        <div class="ajna-mm-self" data-role="self">
          <svg viewBox="-34 -34 68 68" width="68" height="68" aria-hidden="true">
            <path d="M0 0 L-13.5 -29 A32 32 0 0 1 13.5 -29 Z" class="ajna-mm-cone"/>
            <circle r="4.5" class="ajna-mm-dot"/>
          </svg>
        </div>
        <div class="ajna-mm-attr" data-role="attr"></div>
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
    this._attrEl = panel.querySelector('[data-role="attr"]')
    this._discEl = panel.querySelector('.ajna-mm-disc')
    this._nordBtn = panel.querySelector('[data-role="norden"]')
    this._radiusEl = panel.querySelector('[data-role="radius"]')
    this._baseBtn = panel.querySelector('[data-role="base"]')
    this._syncBaseBtn()

    panel.querySelector('[data-role="close"]').addEventListener('click', () => this.close())
    this._baseBtn.addEventListener('click', () => this._cycleBase())
    panel.querySelector('[data-role="zoomin"]').addEventListener('click', () => this._zoomBy(+1))
    panel.querySelector('[data-role="zoomout"]').addEventListener('click', () => this._zoomBy(-1))
    this._nordBtn.addEventListener('click', () => this._toggleNorden())
    // Der Knopf sitzt auf der Scheibe, und die ist der Zieh-Anfasser.
    this._nordBtn.addEventListener('pointerdown', e => e.stopPropagation())
    this._syncNordBtn()
    // Die ganze Scheibe ist der Anfasser (Kartenschwenk ist ohnehin aus, die
    // Mitte IST die Kamera). Die Eckknöpfe dürfen dabei keinen Zug auslösen.
    for (const chip of panel.querySelectorAll('.ajna-mm-chip')) {
      chip.addEventListener('pointerdown', e => e.stopPropagation())
    }
    // Angedockt sitzt das Fenster fest: Dann darf weder gezogen noch die
    // gemerkte Freiposition angewandt werden — sonst schöbe der nächste
    // Fenstergrößenwechsel die oben angedockte Karte wieder zur Seite.
    this._dragCleanup = makeDraggable(panel, { key: KEY_POS, aktiv: () => !this._docked })

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

  /** Sichtbarer Radius in Metern (Mitte bis Rand der Scheibe) oder 0. */
  _radiusM() {
    if (!this._map) return 0
    const size = this._map.getSize()
    if (!size.x || !size.y) return 0
    const m = this._map.distance(this._map.getCenter(), this._map.containerPointToLatLng([0, size.y / 2]))
    return Number.isFinite(m) && m > 0 ? m : 0
  }

  /** Sichtbarer Radius als Text — bei einer runden Karte die natürliche Maßangabe. */
  _syncRadius() {
    if (!this._radiusEl) return
    const m = this._radiusM()
    if (!m) return
    this._radiusEl.textContent = m < 950 ? `${Math.round(m / 5) * 5} m` : `${(m / 1000).toFixed(1)} km`
  }

  // ── Objekt-Symbole ─────────────────────────────────────────────────────

  /** DivIcon aus dem Symbol des Objekts. */
  _iconFor(record) {
    return window.L.divIcon({
      className: 'ajna-mm-marker',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
      // iconOf kürzt und maskiert — der Wert kommt aus agent-gelieferten Daten.
      html: `<span class="ajna-mm-glyph">${iconOf(record)}</span>`,
    })
  }

  /**
   * Tooltip-Inhalt als DOM statt HTML-String: Name und ID sind Fremddaten und
   * dürfen kein Markup werden.
   *
   * Zeile 1: Name, dahinter optional der Server.
   * Zeile 2: optional die Objekt-ID — für die Fehlersuche, wenn Namen nicht
   *          eindeutig sind (der World-Director vergibt sie aus Pools).
   * Beide Zusätze hängen an Schaltern, siehe TOOLTIP_*_DEFAULT oben.
   */
  _tipFor(record) {
    const el = document.createElement('span')
    const kopf = document.createElement('span')
    kopf.textContent = record?.name || record?.type || 'Objekt'
    el.appendChild(kopf)

    if (this._tooltipServer()) {
      let server = null
      try { server = this.serverNameFor?.(record) || null } catch { server = null }
      if (server) {
        const s = document.createElement('span')
        s.className = 'mm-tip-nb'
        s.textContent = ' · ' + server
        el.appendChild(s)
      }
    }

    if (record?.id && this._tooltipId()) {
      const id = document.createElement('span')
      id.className = 'mm-tip-id'
      id.textContent = String(record.id)
      el.appendChild(id)
    }
    return el
  }

  /** Servername im Tooltip zeigen? Vorgabe aus dem Code, umschaltbar zur Laufzeit. */
  _tooltipServer() {
    const v = read(KEY_TIP_SERVER, null)
    return v === null ? TOOLTIP_SERVER_DEFAULT : v === '1'
  }

  /** Objekt-ID im Tooltip zeigen? Gleiche Mechanik, eigener Schalter. */
  _tooltipId() {
    const v = read(KEY_TIP_ID, null)
    return v === null ? TOOLTIP_ID_DEFAULT : v === '1'
  }

  /**
   * Marker mit dem aktuellen Objektbestand abgleichen.
   *
   * Bewusst ein Abgleich statt Neuaufbau: ein weggeworfener und neu gesetzter
   * Marker verliert seinen offenen Tooltip und flackert bei jedem Durchlauf.
   *
   * @param {{lat:number, lon:number}|null} view  Kartenmitte
   * @param {boolean} [force]  Taktbremse überspringen (Filterwechsel, Öffnen)
   */
  _syncObjects(view, force = false) {
    if (!this._objLayer || !this.getObjects || !view) return
    const jetzt = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    if (!force && jetzt - this._objSyncAt < OBJ_SYNC_MS) return
    this._objSyncAt = jetzt

    let liste
    try { liste = this.getObjects() || [] } catch { return }

    // Nur, was im gezeichneten Kreis liegt. Etwas Zuschlag, damit ein Objekt
    // am Rand nicht bei jedem Schritt auf- und zuklappt.
    const radius = this._radiusM() * 1.2
    if (!radius) return
    const nah = []
    for (const o of liste) {
      if (!Number.isFinite(o?.lat) || !Number.isFinite(o?.lon)) continue
      if (o.carried_by) continue                      // im Inventar, nicht in der Welt
      if (this.filters?.matches && !this.filters.matches(o)) continue
      const d = distM(view, o)
      if (d > radius) continue
      nah.push({ o, d })
    }
    if (nah.length > OBJ_MAX) {
      nah.sort((a, b) => a.d - b.d)
      nah.length = OBJ_MAX
    }

    const behalten = new Set()
    for (const { o } of nah) {
      behalten.add(o.id)
      let m = this._markers.get(o.id)
      if (!m) {
        m = window.L.marker([o.lat, o.lon], {
          icon: this._iconFor(o),
          // interactive bleibt an — ohne Zeigerereignisse gäbe es keinen
          // Tooltip. Angehängt wird trotzdem KEIN Klick- oder Kontextmenü:
          // gehandelt wird in der AR-Ansicht oder auf der großen Karte.
          interactive: true, keyboard: false, riseOnHover: true,
        })
        m.bindTooltip(this._tipFor(o), {
          direction: 'top', offset: [0, -8], opacity: 0.95, className: 'ajna-mm-tip',
        })
        m._sym = iconOf(o)
        m._nam = `${o.name || ''}|${o._origin || ''}`
        this._objLayer.addLayer(m)
        this._markers.set(o.id, m)
        continue
      }
      const ll = m.getLatLng()
      if (distM({ lat: ll.lat, lon: ll.lng }, o) > OBJ_MOVE_EPS_M) m.setLatLng([o.lat, o.lon])
      const sym = iconOf(o)
      if (sym !== m._sym) { m.setIcon(this._iconFor(o)); m._sym = sym }
      const beschriftung = `${o.name || ''}|${o._origin || ''}`
      if (beschriftung !== m._nam) { m.setTooltipContent(this._tipFor(o)); m._nam = beschriftung }
    }

    for (const [id, m] of this._markers) {
      if (behalten.has(id)) continue
      this._objLayer.removeLayer(m)
      this._markers.delete(id)
    }
  }

  _status(text) {
    if (!this._statusEl) return
    this._statusEl.textContent = text || ''
    this._statusEl.hidden = !text
  }

  /** Zeigt die Karte nach Norden statt in Blickrichtung? */
  _nordenOben() { return read(KEY_NORDEN, '0') === '1' }

  _toggleNorden() {
    write(KEY_NORDEN, this._nordenOben() ? '0' : '1')
    this._syncNordBtn()
    this._tick(true)
  }

  /**
   * Beschriftung und Erklärung des Schalters.
   *
   * Der Knopf zeigt den ZUSTAND, nicht die Aktion — „N" heißt: Norden ist
   * oben. Was ein Tippen bewirkt, steht im Tooltip. Andersherum (Knopf zeigt
   * die Aktion) rät man bei jedem Blick neu, was gerade gilt.
   */
  _syncNordBtn() {
    if (!this._nordBtn) return
    const nord = this._nordenOben()
    // Was auf dem Knopf steht, ist das, was gerade oben IST: „N" für Norden,
    // der Pfeil für die Blickrichtung. Kein Zustand, den man erraten muss.
    this._nordBtn.textContent = nord ? 'N' : '▲'
    this._nordBtn.classList.toggle('mm-nord-fest', nord)
    // Die Nadel ist nur nötig, solange Norden NICHT oben ist.
    this._discEl?.classList.toggle('mm-nadel-aus', nord)
    this._nordBtn.title = nord
      ? 'Norden ist oben — tippen für „Blickrichtung oben"'
      : 'Blickrichtung ist oben — tippen für „Norden oben"'
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
    if (this._attrEl) {
      this._attrEl.textContent = BASEMAPS[this._base].kurz || ''
      this._attrEl.title = BASEMAPS[this._base].voll
    }
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
        // Leaflets Quellenangabe säße IN der Karte und würde mitdrehen —
        // kopfüber ist eine Nennung keine Nennung. Wir zeichnen sie selbst,
        // ausserhalb der Drehung (siehe .ajna-mm-attr).
        zoomControl: false, attributionControl: false,
        minZoom: ZOOM_MIN, maxZoom: ZOOM_MAX,
      }).setView(center, this._zoom)
      map.on('zoomend', () => {
        this._zoom = map.getZoom()
        write(KEY_ZOOM, String(this._zoom))
        // Hat der NUTZER gezoomt, ist das ab jetzt seine Vorgabe für diese
        // Flughöhe: wir merken uns den Abstand zur automatischen Stufe und
        // halten ihn beim Steigen und Sinken.
        if (!this._autoZooming && Number.isFinite(this._lastHoehe)) {
          const auto = this._autoZoomFor(this._lastHoehe, map.getCenter().lat)
          if (auto !== null) {
            this._zoomOffset = clamp(this._zoom - auto, -6, 6)
            write(KEY_OFFSET, String(this._zoomOffset))
          }
        }
        this._syncRadius()
      })
      this._map = map
      this._objLayer = L.layerGroup().addTo(map)
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
      // ZWEI ANSICHTEN, EIN WINKEL.
      //
      // „Blickrichtung oben": Gedreht wird die KARTE um −heading; der eigene
      // Pfeil steht fest und zeigt nach oben. Das ist die Ansicht, die man beim
      // Gehen lesen kann, ohne sie im Kopf zu drehen — dafür muss Norden
      // sichtbar bleiben (Nordring).
      //
      // „Norden oben": Die Karte bleibt stehen (Winkel 0), stattdessen dreht
      // sich der Pfeil — das alte Verhalten. Beides hängt an derselben
      // CSS-Variablen, es gibt also keinen zweiten Rechenweg.
      const nord = this._nordenOben()
      this._discEl?.style.setProperty('--mm-drehung', nord ? '0deg' : `${(-heading).toFixed(1)}deg`)
      this._selfEl.style.transform = nord
        ? `translate(-50%, -50%) rotate(${heading.toFixed(1)}deg)`
        : 'translate(-50%, -50%)'
    }
    this._last = { lat: v.lat, lon: v.lon, heading }
    this._folgeHoehe(v, force)
    this._syncObjects(v, force)
  }

  /**
   * Zoomstufe der Flughöhe nachführen. Ohne Höhenangabe (Objekte-Tab, reine
   * GPS-Position) bleibt die vom Nutzer gewählte Stufe unangetastet.
   * @param {{lat:number, hoehe?:number}} v
   * @param {boolean} force
   */
  _folgeHoehe(v, force) {
    const h = Number(v.hoehe)
    if (!this._map || !Number.isFinite(h)) return
    if (!force && this._lastHoehe !== null && Math.abs(h - this._lastHoehe) < HOEHE_EPS_M) return
    this._lastHoehe = h

    const auto = this._autoZoomFor(h, v.lat)
    if (auto === null) return
    const ziel = clamp(auto + this._zoomOffset, ZOOM_MIN, ZOOM_MAX)
    if (ziel === this._map.getZoom()) return
    // Flagge, damit der eigene setZoom nicht als Nutzer-Eingriff zählt und
    // den gemerkten Abstand überschreibt.
    this._autoZooming = true
    try { this._map.setZoom(ziel, { animate: false }) }
    finally { this._autoZooming = false }
  }

  /**
   * Welche Zoomstufe deckt aus dieser Höhe ungefähr den überblickten Bereich ab?
   *
   * Gerechnet wird über die Leaflet-Beziehung Meter-je-Pixel:
   *   m/px = 156543.034 · cos(Breite) / 2^z
   * Gesucht ist das z, bei dem der halbe Scheibendurchmesser dem gewünschten
   * Radius entspricht. Dadurch stimmt die Angabe im Radius-Chip automatisch mit.
   *
   * @returns {number|null} ganzzahlige Stufe oder null, wenn die Karte noch keine Größe hat
   */
  _autoZoomFor(hoehe, lat) {
    if (!this._map) return null
    const size = this._map.getSize()
    if (!size.y) return null
    const radius = Math.max(BODEN_RADIUS_M, HOEHE_FAKTOR * Math.max(0, hoehe))
    const mProPixel = radius / (size.y / 2)
    const z = Math.log2(156543.03392 * Math.cos((lat || 0) * Math.PI / 180) / mProPixel)
    return Number.isFinite(z) ? clamp(Math.round(z), ZOOM_MIN, ZOOM_MAX) : null
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
      width:var(--mm-size);height:var(--mm-size);--mm-size:clamp(124px,30vw,236px);
      background:transparent;cursor:move;touch-action:none}
    .ajna-mm-panel[hidden]{display:none}
    /* Angedockt: oben mittig, außerhalb der Sicherheitsabstände. Nicht mehr
       ziehbar — im angedockten Modus IST die Position die Aussage. */
    .ajna-mm-panel.mm-oben{top:calc(env(safe-area-inset-top, 0px) + 10px);
      bottom:auto;right:auto;left:50%;transform:translateX(-50%);cursor:default}

    .ajna-mm-disc{position:absolute;inset:0;border-radius:50%;overflow:hidden;
      background:#12141a;border:2px solid rgba(255,255,255,.20);
      box-shadow:0 8px 30px rgba(0,0,0,.55), inset 0 0 24px rgba(0,0,0,.45)}
    /* Die Scheibe hält den Drehwinkel; alles darin bezieht sich darauf. */
    .ajna-mm-disc{--mm-drehung:0deg}
    /* Die Karte dreht sich, der Ausschnitt bleibt. Ein Quadrat, um seinen
       Mittelpunkt gedreht, deckt den einbeschriebenen Kreis in JEDER Lage —
       die 2 % Vergrößerung sind nur gegen Kantenglättung an den vier
       Berührpunkten. */
    .ajna-mm-canvas{position:absolute;inset:0;background:#12141a;
      transform:rotate(var(--mm-drehung)) scale(1.02);transform-origin:50% 50%}
    /* Marker und Beschriftungen drehen gegen — die Karte darf sich drehen,
       Schrift nicht.

       Gedreht wird das INNERE Element, nie das von Leaflet positionierte:
       Die Eigenschaft rotate wirkt NACH transform, und Leaflet setzt die
       Marker-Position ueber transform. Eine Drehung danach schwenkt den
       Marker um die Scheibenmitte, statt ihn aufzurichten — er wuerde
       kreisen statt stillzustehen. */
    .ajna-mm-glyph,
    .ajna-mm-tip > span{rotate:calc(-1 * var(--mm-drehung));transform-origin:50% 50%}
    .ajna-mm-tip > span{display:inline-block}

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
    .ajna-mm-chip{position:absolute;width:var(--mm-chip);height:var(--mm-chip);
      --mm-chip:clamp(22px,calc(var(--mm-size) * .15),28px);border-radius:50%;cursor:pointer;
      border:1px solid #3a3a44;background:rgba(24,24,30,.94);color:#d6d9e0;
      font:calc(var(--mm-chip) * .54)/1 system-ui,sans-serif;
      display:flex;align-items:center;justify-content:center;
      padding:0;box-shadow:0 3px 10px rgba(0,0,0,.5);z-index:10}
    .ajna-mm-chip:hover{color:#fff;background:rgba(44,93,143,.95);border-color:#3a78b6}
    .ajna-mm-chip:active{transform:scale(.92)}
    .ajna-mm-chip.mm-tl{left:-4px;top:-4px}
    .ajna-mm-chip.mm-tr{right:-4px;top:-4px}
    /* − und + brauchen mehr Punktgröße als die Symbole, um gleich groß zu wirken. */
    .ajna-mm-chip.mm-bl{left:-4px;bottom:-4px;font-size:calc(var(--mm-chip) * .70)}
    .ajna-mm-chip.mm-br{right:-4px;bottom:-4px;font-size:calc(var(--mm-chip) * .66)}

    /* Kamera-Marke: sitzt fest in der Mitte, nur die Rotation ändert sich.
       Keine CSS-Transition — die Nachführung läuft im Bildtakt, eine
       Überblendung würde der Kamera nur hinterherhinken. */
    /* Steht fest und zeigt nach oben: In dieser Ansicht IST oben die
       Blickrichtung. Gedreht wird die Karte darunter. */
    .ajna-mm-self{position:absolute;left:50%;top:50%;
      width:calc(var(--mm-size) * .4);height:calc(var(--mm-size) * .4);
      transform:translate(-50%,-50%);transform-origin:50% 50%;pointer-events:none;z-index:500}
    /* Das SVG trägt feste Maße im Markup — hier auf die Containergröße ziehen,
       sonst schrumpft nur der Rahmen und der Blickkegel bliebe groß. */
    .ajna-mm-self svg{width:100%;height:100%;display:block}
    .ajna-mm-cone{fill:rgba(80,160,255,.30);stroke:rgba(120,190,255,.65);stroke-width:1}
    .ajna-mm-dot{fill:#4da3ff;stroke:#fff;stroke-width:1.5}

    /* Nur noch die Maßstabs-Angabe: Der Nordschalter ist ein Knopf und bringt
       seine eigene Optik mit (siehe unten). */
    .ajna-mm-radius{position:absolute;left:50%;transform:translateX(-50%);z-index:500;
      font:600 10px system-ui,sans-serif;color:#eaeaea;pointer-events:none;
      background:rgba(0,0,0,.45);border-radius:5px;padding:0 5px;white-space:nowrap}
    .ajna-mm-north{position:absolute;z-index:501}
    /* Der Nordring dreht mit der Karte und trägt die Nadel an den Rand, an dem
       Norden wirklich liegt. Ohne ihn wüsste in einer gedrehten Karte niemand
       mehr, wo Norden ist. */
    .ajna-mm-nordring{position:absolute;inset:0;pointer-events:none;z-index:500;
      transform:rotate(var(--mm-drehung));transform-origin:50% 50%}
    /* Der Schalter: fest oben, gross genug für einen Finger. Die sichtbare
       Marke bleibt klein — die Trefferfläche wächst über das Polster, nicht
       über die Schrift. 34 px ist die Grenze, unter der Tippen zum Glücksspiel
       wird. */
    .ajna-mm-north{top:0;left:50%;transform:translateX(-50%);
      min-width:34px;min-height:34px;padding:0;border:0;background:none;
      display:flex;align-items:center;justify-content:center;
      pointer-events:auto;cursor:pointer;-webkit-tap-highlight-color:transparent;
      font:600 11px system-ui,sans-serif;color:#eaeaea}
    /* Die Marke im Knopf — nur sie ist zu sehen. */
    .ajna-mm-north::before{content:'';position:absolute;left:50%;top:50%;
      width:22px;height:17px;margin:-8.5px 0 0 -11px;
      border-radius:5px;background:rgba(0,0,0,.45);z-index:-1}
    .ajna-mm-north.mm-nord-fest::before{background:rgba(80,160,255,.55);
      box-shadow:0 0 0 1px rgba(160,205,255,.75)}
    .ajna-mm-north:active{opacity:.7}

    /* Nordmarke: das „N" wandert am Rand mit und steht dort, wo Norden
       wirklich liegt. Sie ist Anzeige, kein Bedienelement — angefasst wird der
       Schalter oben.
       Eine erste Fassung war ein 2 px schmaler Strich: auf einem Telefon nicht
       zu sehen, und selbst wenn, sagt ein Strich nicht „Norden". Ein
       Buchstabe braucht keine Legende. */
    .ajna-mm-nordmarke{position:absolute;left:50%;top:2px;
      width:16px;height:16px;margin-left:-8px;border-radius:50%;
      display:flex;align-items:center;justify-content:center;
      font:700 10px system-ui,sans-serif;color:#ffd9d2;
      background:rgba(190,60,45,.85);box-shadow:0 0 0 1px rgba(0,0,0,.45);
      /* Gegendrehung, damit der Buchstabe aufrecht bleibt, während der Ring
         dreht — ein kopfstehendes N liest niemand. */
      rotate:calc(-1 * var(--mm-drehung))}
    /* Bei „Norden oben" sagt der Schalter es schon; zwei Zeichen für dieselbe
       Aussage sind eines zu viel. */
    .ajna-mm-disc.mm-nadel-aus .ajna-mm-nordmarke{display:none}
    /* Quellenangabe: ausserhalb der Drehung, damit sie waagerecht bleibt. */
    .ajna-mm-attr{position:absolute;left:0;right:0;bottom:11px;z-index:500;
      text-align:center;pointer-events:auto;
      font:8px system-ui,sans-serif;line-height:12px;color:#d6d9e0;white-space:nowrap}
    .ajna-mm-attr:empty{display:none}
    .ajna-mm-radius{bottom:27px;font-weight:500;color:#c9cdd6}

    .ajna-mm-status{position:absolute;inset:0;z-index:600;display:flex;align-items:center;
      justify-content:center;text-align:center;padding:10px;
      font:12px system-ui,sans-serif;color:#8a8f99;background:rgba(18,18,22,.9)}
    .ajna-mm-status[hidden]{display:none}

    /* Objekt-Symbole: nur der Glyph, kein Kästchen und kein Name. Ein Schatten
       darunter, damit ein dunkles Emoji auf der Satellitenkachel nicht
       verschwindet. */
    .ajna-mm-marker{background:none;border:none}
    .ajna-mm-glyph{display:block;width:var(--mm-ico);height:var(--mm-ico);line-height:var(--mm-ico);
      --mm-ico:clamp(15px,calc(var(--mm-size) * .115),22px);text-align:center;
      font-size:calc(var(--mm-ico) * .78);filter:drop-shadow(0 0 2px rgba(0,0,0,.85)) drop-shadow(0 0 1px rgba(0,0,0,.9));
      cursor:default;user-select:none}
    /* Name erst beim Überfahren (am Telefon: beim Antippen). */
    .ajna-mm-canvas .leaflet-tooltip.ajna-mm-tip{background:rgba(18,18,22,.94);color:#eaeaea;
      border:1px solid #3a3a44;border-radius:6px;padding:2px 6px;
      font:11px system-ui,sans-serif;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,.5)}
    .ajna-mm-canvas .leaflet-tooltip.ajna-mm-tip::before{border-top-color:#3a3a44}
    .ajna-mm-canvas .leaflet-tooltip.ajna-mm-tip .mm-tip-nb{opacity:.6}
    .ajna-mm-canvas .leaflet-tooltip.ajna-mm-tip .mm-tip-id{display:block;opacity:.5;
      font:10px ui-monospace,Menlo,Consolas,monospace;user-select:all}`
    document.head.appendChild(s)
  }
}
