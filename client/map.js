import { AjnaManager } from "./core/AjnaManager.js"
import { EditorUI } from "./core/EditorUI.js"
import { GPSProvider } from "./core/GPSProvider.js"
import { ContextMenu } from "./core/ContextMenu.js"
import { PermissionDialog } from "./core/PermissionDialog.js"
import { GroupDialog } from "./core/GroupDialog.js"
import { ServerDialog } from "./core/ServerDialog.js"
import { ProfileDialog } from "./core/ProfileDialog.js"
import { FilterDialog } from "./core/FilterDialog.js"
import { AgentFilters } from "./core/AgentFilters.js"
import { ObjectActions } from "./core/ObjectActions.js"
import { Toast } from "./core/Toast.js"
import { PositionSmoother } from "./core/PositionSmoother.js"
import { encStyleOf } from "./core/wifiStyle.js"
import { shapeOf, emojiOf, colorOf, radiusOf } from "./core/Appearance.js"
import { interactionReply, describeRequires } from "./core/InteractionReply.js"
import { spawnRandomAndEdit, directorSpawnItems } from "./core/SpawnHere.js"
import { InterestArea } from "./core/InterestArea.js"
import { ProximityReporter } from "./core/ProximityReporter.js"
import { InterestAreaDebug } from "./core/InterestAreaDebug.js"
import { setupMapGps } from "./core/MapGpsControl.js"
import { getAccessoryHub } from "./core/AccessoryHub.js"
import { InventoryUI, DRAG_MIME } from "./core/InventoryUI.js"
import { inventoryDevices } from "./core/inventoryDevices.js"
import { rayEndpointWgs84 } from "./core/PointingResolver.js"
// Hinweis: Leaflet selbst (JS + CSS) wird via CDN-Tag in index*.html
// geladen — kein npm-Bundle-Import noetig.

// Same-Origin via Caddy — siehe main.js für Erklärung.
const ajna = new AjnaManager(window.location.origin)
window.ajna = ajna
const markerLayer = new Map()
// Abdeckungs-Kreise: pro Objekt mit state.coverage_radius (z. B. WLANs aus der
// WiGLE-Bridge) ein L.circle um den Mittelpunkt. Lebenszyklus an den Marker
// gekoppelt (addMarker/removeMarker).
const coverageLayer = new Map()
// Pro Marker ein PositionSmoother — füttert sich aus mapUpdateMarkers,
// wird in tickMarkerSmoothers() pro Frame ausgelesen und auf den Marker
// angewendet. Damit wirken die 5-Hz-Updates eines Agents (Fox-Walk) auf
// der Karte flüssig, statt zwischen Stützpunkten zu springen.
const markerSmoothers = new Map()
// IDs von Markern, die GERADE interpolieren (sich bewegen). Nur diese werden
// pro Frame angefasst — statische Objekte (POIs, WLANs, Items) fallen nach dem
// Settling raus, statt 60×/s dieselbe Position geschrieben zu bekommen.
const movingIds = new Set()
const interactSubs = new Map()
const contextMenu = new ContextMenu()
const permissionDialog = new PermissionDialog({ ajna })
const groupDialog = new GroupDialog({ ajna })
const serverDialog = new ServerDialog({ ajna })
const profileDialog = new ProfileDialog({ ajna })
const agentFilters = new AgentFilters(ajna)
const filterDialog = new FilterDialog({ ajna, filters: agentFilters })
window.agentFilters = agentFilters   // Console-Debugging
const toast = new Toast()

// Mobile-Shell (mobile.bundle.js) braucht Zugriff auf die hier konstruierten
// Dialog-Instanzen, ohne sie selbst nochmal anzulegen. Wir exponieren sie
// gebuendelt unter window.ajnaUI — read-only Konvention, kein Auto-Wiring.
window.ajnaUI = {
  serverDialog, profileDialog, filterDialog, groupDialog,
  permissionDialog, contextMenu, toast, agentFilters
}
let objectActions = null  // wird in init() verdrahtet, sobald editorUI da ist
let _announcer = null      // wird in init() aus dem AccessoryHub gesetzt (TTS)

function subscribeMarkerInteract(objectId) {
  if (interactSubs.has(objectId)) return
  interactSubs.set(objectId, null)
  // Eigene Aktionen kommen als Echo zurück — die zeigt/sagt schon der
  // Auslöse-Pfad (onInteract). Nur fremde Reaktionen hier verarbeiten.
  ajna.subscribeInteract(objectId, data => {
    if (data?.source && data.source === ajna.currentUser()?.id) return
    handleMarkerInteract(objectId, data)
  })
    .then(unsub => { interactSubs.set(objectId, unsub) })
    .catch(err => {
      interactSubs.delete(objectId)
      console.warn("interact subscribe failed", objectId, err?.message || err)
    })
}

function unsubscribeMarkerInteract(objectId) {
  const unsub = interactSubs.get(objectId)
  if (typeof unsub === "function") { try { unsub() } catch {} }
  interactSubs.delete(objectId)
}

function handleMarkerInteract(objectId, data) {
  const marker = markerLayer.get(objectId)
  const obj = ajna.getObjectById(objectId)
  const label = obj?.name || objectId

  // Antwort des Objekts (examine→Beschreibung, talk→Dialog, attack/feed/…→
  // Flavor). Identische Ableitung wie im AR-Client (InteractionReply).
  toast.show(interactionReply(obj, data.action, label), { title: label })
  // Akustische Ansage ("<Aktion> - <Ergebnis>"), gegated über Audio-Schalter.
  _announcer?.interaction(obj || objectId, data.action)

  // Kurzer optischer Pulse am Marker (CSS @keyframes via Klasse).
  const el = marker?.getElement()
  if (el) {
    el.classList.remove("marker-pulse")
    void el.offsetWidth  // Reflow erzwingen → Animation re-startet
    el.classList.add("marker-pulse")
    setTimeout(() => el.classList.remove("marker-pulse"), 700)
  }
}

// Wird nur als Read-Quelle für die persistierte Dummy-Position verwendet.
// Kein start() — Leaflet liefert die laufenden GPS-Updates über sein
// eigenes L.Control.Gps. GPSProvider ist hier nur Single Source of Truth
// für die persistierte Boot-Position aus localStorage.
const gpsConfig = new GPSProvider()

let editorUI = null

// Viewport-Culling: nur Objekte im (um VIEWPORT_PAD gepufferten) Sichtbereich
// bekommen einen DOM-Marker. Der Puffer verhindert sichtbares "Poppen" beim
// Pannen. Re-Evaluierung bei jedem objectsChanged UND bei map moveend/zoomend.
const VIEWPORT_PAD = 0.5

function mapUpdateMarkers(objects) {
  if (!window.map) return

  // Getragene Objekte (im Inventar) gehören nicht in die Welt-Ansicht, dann der
  // Agent-Filter: nur Objekte, die der Spieler sehen will (Default = alle).
  // UWB-Anker (Infrastruktur) nur bei aktivem Debug-Flag zeigen (Einstellungen).
  const showAnchors = (() => { try { return localStorage.getItem('ajna.debug.show_uwb_anchors') === '1' } catch { return false } })()
  const inWorld = objects.filter(o => !o.carried_by &&
    ((o.type || '').toLowerCase() !== 'uwb_anchor' || showAnchors))
  const filtered = agentFilters ? inWorld.filter(o => agentFilters.matches(o)) : inWorld
  const bounds = window.map.getBounds().pad(VIEWPORT_PAD)
  const keep = new Set()   // ids, die einen Marker haben SOLLEN

  for (const obj of filtered) {
    // Defensive: kaputte Koordinaten würden via toFixed() den Loop abreißen.
    if (!Number.isFinite(obj.lat) || !Number.isFinite(obj.lon)) {
      console.warn(`mapUpdateMarkers: skip ${obj.id} (${obj.name || 'unnamed'}) — invalid lat/lon`)
      continue
    }
    if (!bounds.contains([obj.lat, obj.lon])) continue   // außerhalb Viewport → kein Marker
    keep.add(obj.id)
    // Signatur der Darstellung: Name (Label) + appearance (Emoji/Farbe/Modell).
    // Ändert sie sich, muss das Icon neu gebaut werden — sonst zeigt der Marker
    // das alte Bild bis zum Reload.
    const sig = JSON.stringify([obj.name, obj.appearance ?? null])
    try {
      const m = markerLayer.get(obj.id)
      if (m) {
        feedSmoother(obj)
        if (m._ajnaSig !== sig) {   // Darstellung geändert → Marker neu aufbauen
          removeMarker(obj.id)
          addMarker(obj)
          feedSmoother(obj)
          const nm = markerLayer.get(obj.id); if (nm) nm._ajnaSig = sig
        }
        // sonst: Popup-Inhalt ist als Funktion gebunden (siehe addMarker) und
        // beim Öffnen automatisch aktuell — kein bindPopup pro Reconcile.
      } else {
        addMarker(obj)
        feedSmoother(obj)
        const nm = markerLayer.get(obj.id); if (nm) nm._ajnaSig = sig
      }
    } catch (err) {
      console.warn(`mapUpdateMarkers: marker für ${obj.id} fehlgeschlagen`, err)
    }
  }

  // Cleanup: Marker entfernen, die nicht (mehr) gerendert werden sollen —
  // verschwundene Records, Filter-Opfer ODER aus dem Viewport gewandert.
  // (removeMarker räumt Kreis, Smoother, movingIds + interact-Sub mit ab.)
  for (const id of Array.from(markerLayer.keys())) {
    if (!keep.has(id)) removeMarker(id)
  }
}

// Leading+Trailing-Throttle: führt sofort aus, danach höchstens alle `ms` — und
// immer mit den ZULETZT übergebenen Argumenten. Für den Realtime-Reconcile, der
// sonst bei jedem Objekt-Update (Director ~2 Hz × N Figuren) komplett durchläuft.
function throttleLatest(fn, ms) {
  let last = 0, timer = null, lastArgs = null
  return (...args) => {
    lastArgs = args
    const wait = ms - (Date.now() - last)
    if (wait <= 0) {
      if (timer) { clearTimeout(timer); timer = null }
      last = Date.now()
      fn(...lastArgs)
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; last = Date.now(); fn(...lastArgs) }, wait)
    }
  }
}

function feedSmoother(obj) {
  let sm = markerSmoothers.get(obj.id)
  if (!sm) {
    sm = new PositionSmoother()
    markerSmoothers.set(obj.id, sm)
  }
  // Nur wenn sich die Position tatsächlich geändert hat, wird der Marker (bis
  // zum Settling) in den Pro-Frame-Loop aufgenommen.
  if (sm.feed(obj)) movingIds.add(obj.id)
}

// Pro-Frame-Loop: gesampelten Position auf die Marker schreiben. Leaflet
// rerendet bei setLatLng den Marker effizient; CPU-Kosten bei < 100
// Markern vernachlässigbar.
//
// WICHTIG: während eines User-Drags wird der Marker übersprungen — sonst
// kämpft der Smoother-Sample (alte Position) jeden Frame gegen Leaflets
// Maus-getriebene Position, und der Marker bleibt visuell "festgenagelt".
function tickMarkerSmoothers() {
  // Nur GERADE bewegte Marker anfassen — nicht alle. Ein settled-Marker wird
  // einmal final gesetzt und dann aus movingIds entfernt (kein Frame-Spam mehr).
  for (const id of movingIds) {
    const marker = markerLayer.get(id)
    const sm = markerSmoothers.get(id)
    if (!marker || !sm) { movingIds.delete(id); continue }
    if (marker._ajnaDragging) continue
    const snap = sm.sample()
    if (snap) marker.setLatLng([snap.lat, snap.lon])
    if (sm.isSettled()) movingIds.delete(id)
  }
  requestAnimationFrame(tickMarkerSmoothers)
}

// Type-spezifische Darstellung — neue Types hier ergänzen, damit der
// Renderer im 3D-Client (GameObject.#createPlaceholder) und auf der
// Karte konsistent unterschieden werden. Emoji + CSS-Klasse pro Typ;
// die Klasse wird in injectHighlightStyles() eingefärbt.
const MARKER_TYPES = {
  poi:    { emoji: '📍', cls: 'map-marker-poi' },
  npc:    { emoji: '🧑', cls: 'map-marker-npc' },
  enemy:  { emoji: '👹', cls: 'map-marker-enemy' },
  animal: { emoji: '🐾', cls: 'map-marker-animal' },
  dragon: { emoji: '🐉', cls: 'map-marker-dragon' },
  item:   { emoji: '💎', cls: 'map-marker-item' },
  hint:   { emoji: '💡', cls: 'map-marker-hint' },
  wifi:   { emoji: '📶', cls: 'map-marker-wifi' },
  uwb_anchor: { emoji: '⚓', cls: 'map-marker-anchor' },
  call:   { emoji: '📣', cls: 'map-marker-call' }
}

function markerIconFor(obj) {
  const type = (obj.type || '').toLowerCase()
  const def = MARKER_TYPES[type]
  // Agent-definiertes Emoji (appearance.emoji) hat Vorrang; sonst die Legacy-
  // Heuristik: WLAN-Verschlüsselungssymbol bzw. das Typ-Emoji.
  const emoji = emojiOf(obj)
    || (type === 'wifi' ? encStyleOf(obj).symbol : (def ? def.emoji : '❌'))
  // UWB-Anker: Node-ID + Höhe statt Name (3D-Höhe auch auf der 2D-Karte sichtbar).
  const html = type === 'uwb_anchor'
    ? `⚓ #${obj.state?.uwb?.nodeId ?? '?'} · ${(obj.altitude ?? 0).toFixed(1)}m`
    : `${emoji} ${obj.name}`
  return window.L.divIcon({
    className: def ? `map-marker ${def.cls}` : 'map-marker',
    iconSize: [28, 28],
    html
  })
}

// Wählt die Karten-Repräsentation aus dem agent-definierten `shape`:
//   • "circle" → Canvas-circleMarker (günstig bei Masse, NICHT draggable)
//   • sonst    → DOM-divIcon mit Emoji (draggable)
// Fallback ohne appearance: WLANs werden als Canvas-Punkt gezeichnet (dichte
// Masse), alles andere als divIcon — entspricht dem bisherigen Look.
function makeMarker(obj) {
  const type = (obj.type || '').toLowerCase()
  const shape = shapeOf(obj)
  const asCircle = shape === 'circle' || (shape === null && type === 'wifi')

  if (asCircle) {
    const color = colorOf(obj) || (type === 'wifi' ? encStyleOf(obj).hex : '#28a0d7')
    const radius = radiusOf(obj) || 7
    // preferCanvas (Map-Init) rendert Path-Layer wie circleMarker auf Canvas.
    return window.L.circleMarker([obj.lat, obj.lon], {
      radius, color, weight: 1, opacity: 0.9,
      fillColor: color, fillOpacity: 0.4
    })
  }
  return window.L.marker([obj.lat, obj.lon], { icon: markerIconFor(obj), draggable: true })
}

// Popup-Inhalt aus dem AjnaManager-Cache (frische Position). Als Funktion an
// bindPopup übergeben → beim Öffnen ausgewertet, nie pro Reconcile neu gebaut.
// Namen/Beschreibungen sind Nutzertext und landen als HTML im Popup — escapen.
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const CALL_STATUS_TEXT = {
  open: 'offen', claimed: 'angenommen', pending: 'wird geprüft',
  done: 'erledigt', cancelled: 'abgebrochen'
}

/**
 * Inhaltszeile fürs Popup: die BESCHREIBUNG des Objekts bzw. bei Aufträgen die
 * Aufgabe (+ Forderung/Belohnung/Status). Koordinaten sagen dem Spieler nichts —
 * die zeigen wir nur, wenn es sonst nichts zu sagen gibt.
 * @returns {string} HTML oder '' wenn keine Beschreibung vorhanden
 */
function popupDetail(o) {
  if ((o?.type || '').toLowerCase() === 'call') {
    const c = o.state?.call || {}
    const bits = [escHtml(c.task || 'Auftrag ohne Beschreibung')]
    const req = describeRequires(c)
    if (req.length) bits.push('Gefordert: ' + escHtml(req.join(', ')))
    const rw = Array.isArray(c.rewardItems) ? c.rewardItems.length : 0
    if (rw) bits.push(`Belohnung: ${rw} Gegenstand${rw > 1 ? '/Gegenstände' : ''}`)
    bits.push('Status: ' + (CALL_STATUS_TEXT[c.status] || 'offen'))
    return bits.join('<br>')
  }
  const d = o?.description || o?.state?.note || o?.state?.hint
  return d ? escHtml(String(d)) : ''
}

function popupHtml(id) {
  const o = ajna.getObjectById(id)
  const name = o?.name || 'unnamed'
  const lat = Number.isFinite(o?.lat) ? o.lat.toFixed(6) : '?'
  const lon = Number.isFinite(o?.lon) ? o.lon.toFixed(6) : '?'
  if ((o?.type || '').toLowerCase() === 'uwb_anchor') {
    const u = o.state?.uwb || {}, l = u.local || {}
    return `<strong>⚓ UWB-Anker #${u.nodeId ?? '?'}</strong>`
      + `<br>${lat}, ${lon} · ${(o.altitude ?? 0).toFixed(2)} m`
      + `<br>lokal: ${l.x ?? '?'}, ${l.y ?? '?'}, ${l.z ?? '?'} mm`
      + (u.network != null ? `<br>Netz: ${u.network}` : '')
      + `<br><button type="button" onclick="window.__ajnaEditObj&&window.__ajnaEditObj('${id}')" style="margin-top:6px;cursor:pointer">✏️ Bearbeiten</button>`
  }
  const detail = popupDetail(o)
  return `<strong>${escHtml(name)}</strong><br>${detail || `${lat}, ${lon}`}`
}

function addMarker(obj) {
  if (!window.L || markerLayer.has(obj.id)) return

  const marker = makeMarker(obj).addTo(window.map)
  // Hover-Tooltip mit dem Objekt-Namen (Leaflet zeigt/blendet ihn automatisch
  // bei mouseover / mouseout)
  marker.bindTooltip(obj.name || 'unnamed', { direction: 'top', offset: [0, -8] })
  marker.bindPopup(() => popupHtml(obj.id))   // einmalig; Inhalt beim Öffnen aktuell

  // Abdeckungs-Kreis um den Mittelpunkt (z. B. geschätzte WLAN-Reichweite),
  // sofern das Objekt einen state.coverage_radius (in Metern) trägt.
  const coverR = Number(obj.state?.coverage_radius)
  if (Number.isFinite(coverR) && coverR > 0) {
    // Kreisfarbe: agent-definiert (appearance.color) vor Legacy-Heuristik
    // (WLAN-Verschlüsselungsfarbe offen=rot … WPA3=blau, sonst neutrales Blau).
    const cc = colorOf(obj)
      || ((obj.type || '').toLowerCase() === 'wifi' ? encStyleOf(obj).hex : '#28a0d7')
    const circle = window.L.circle([obj.lat, obj.lon], {
      radius: coverR,
      color: cc, weight: 1, opacity: 0.6,
      fillColor: cc, fillOpacity: 0.12,
      interactive: false   // Klicks gehen an den Marker, nicht den Kreis
    }).addTo(window.map)
    coverageLayer.set(obj.id, circle)
  }

  // Drag-to-move nur für draggable Marker (divIcon). Canvas-circleMarker
  // (dichte Masse, z. B. WLANs) ist bewusst nicht verschiebbar — Position
  // dieser Agent-Objekte wird ohnehin vom Agent gepflegt.
  if (marker.dragging) {
    marker.on('dragstart', () => {
      // Während des Drags: Smoother-Sample-Loop überspringt diesen Marker.
      marker._ajnaDragging = true
    })

    marker.on('dragend', async event => {
      marker._ajnaDragging = false
      const { lat, lng } = event.target.getLatLng()
      // Smoother zurücksetzen, sonst lerpt er vom Pre-Drag-Punkt zur neuen
      // Position zurück und der Marker rutscht sichtbar zurück+nach vorn.
      markerSmoothers.get(obj.id)?.reset()
      await ajna.updateObject(obj.id, { lat, lon: lng })
      marker.setLatLng([lat, lng])
      coverageLayer.get(obj.id)?.setLatLng([lat, lng])
      // Popup bleibt die Funktion aus addMarker (liest die frische Position) —
      // kein Neubinden nötig.
      await ajna.loadObjects()
      mapUpdateMarkers(ajna.getObjectList())
    })
  }

  marker.on('click', e => {
    // Aktuelle Position des Records aus dem AjnaManager-Cache holen
    // (kann sich durch Realtime-Updates seit addMarker geändert haben).
    const fresh = ajna.getObjectById(obj.id) || obj
    if (!objectActions) return
    const origEvt = e.originalEvent
    objectActions.showFor(fresh, origEvt.clientX, origEvt.clientY)
  })

  markerLayer.set(obj.id, marker)
  // Realtime-Interact-Subscription nur für Objekte, die der Agent als
  // "realtime-würdig" markiert (state.realtime === true) — z. B. interaktive
  // NPCs. Statische Massendaten (WLANs, POIs) öffnen KEINE Subscription:
  // sonst hunderte PB-Realtime-Abos + Sub/Unsub-Sturm bei jedem Pan (Culling).
  // Objekt-Daten kommen ohnehin über das globale objects:*-Abo + 30s-Poll.
  if (obj.state?.realtime === true) subscribeMarkerInteract(obj.id)
}

function removeMarker(id) {
  const marker = markerLayer.get(id)
  if (marker) {
    window.map.removeLayer(marker)
    markerLayer.delete(id)
  }
  const circle = coverageLayer.get(id)
  if (circle) {
    window.map.removeLayer(circle)
    coverageLayer.delete(id)
  }
  markerSmoothers.delete(id)
  movingIds.delete(id)
  unsubscribeMarkerInteract(id)
}

// Hover-Highlight aus den Editor-Listen: setzt eine Markierungs-Klasse
// auf das Marker-Element und zeichnet, falls das Objekt außerhalb der
// aktuellen Karten-Bounds liegt, eine gestrichelte Linie von der
// Kartenmitte zur Marker-Position.
let highlightedMarker = null
let highlightLine = null

function setMarkerHighlight(id, hovering) {
  if (!window.map) return
  const marker = markerLayer.get(id)

  if (highlightedMarker && (!hovering || highlightedMarker !== marker)) {
    const el = highlightedMarker.getElement()
    if (el) el.classList.remove('marker-highlighted')
    if (highlightLine) {
      window.map.removeLayer(highlightLine)
      highlightLine = null
    }
    highlightedMarker = null
  }

  if (hovering && marker) {
    const el = marker.getElement()
    if (el) el.classList.add('marker-highlighted')
    highlightedMarker = marker
    updateHighlightLine()
  }
}

function updateHighlightLine() {
  if (!highlightedMarker || !window.map) return

  const latlng = highlightedMarker.getLatLng()
  const bounds = window.map.getBounds()

  if (highlightLine) {
    window.map.removeLayer(highlightLine)
    highlightLine = null
  }

  if (!bounds.contains(latlng)) {
    highlightLine = window.L.polyline([window.map.getCenter(), latlng], {
      color: '#f1c40f',
      weight: 2,
      dashArray: '6, 6',
      interactive: false
    }).addTo(window.map)
  }
}

function injectHighlightStyles() {
  if (document.getElementById('mapHighlightStyles')) return
  const style = document.createElement('style')
  style.id = 'mapHighlightStyles'
  style.textContent = `
    .map-marker.marker-highlighted {
      background: rgba(241, 196, 15, 0.35);
      outline: 2px solid #f1c40f;
      border-radius: 4px;
    }
    .map-marker.wand-target {
      background: rgba(55, 214, 122, 0.35);
      outline: 2px solid #37d67a;
      border-radius: 4px;
    }
    @keyframes ajna-marker-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(241, 196, 15, 0.7); }
      70%  { box-shadow: 0 0 0 16px rgba(241, 196, 15, 0); }
      100% { box-shadow: 0 0 0 0 rgba(241, 196, 15, 0); }
    }
    .map-marker.marker-pulse {
      animation: ajna-marker-pulse 700ms ease-out;
      border-radius: 4px;
    }
    /* Marker tragen nur Symbol + Name — keine Box. Lesbarkeit über einen
       weißen Text-Schatten statt Hintergrund/Outline (gilt für alle Typen,
       inkl. POI und Archetypen). Hover-Highlight (marker-highlighted) und
       Interaktions-Pulse bleiben als bewusstes Feedback erhalten. */
    .map-marker {
      white-space: nowrap;
      font-size: 12.5px;
      font-weight: 600;
      /* Textfarbe + Halo kommen aus den Theme-Regeln unten (an Basemap gekoppelt). */
    }
    /* Label-Kontrast an die aktive Basemap koppeln: dunkler Text + heller Halo
       auf heller Karte, heller Text + dunkler Halo auf dunkler Karte. Bisher
       erbte der Text das helle Shell-Weiß und verschwand auf der hellen OSM-Karte. */
    #map.map-theme-light .map-marker {
      color: #16181d;
      text-shadow: 0 0 3px #fff, 0 0 3px #fff, 0 0 2px #fff;
    }
    #map.map-theme-dark .map-marker {
      color: #f2f4f7;
      text-shadow: 0 0 3px #000, 0 0 3px #000, 0 0 2px #000;
    }
  `
  document.head.appendChild(style)
}

// Setzt die Theme-Klasse am Karten-Container (#map) → steuert den Label-Kontrast
// (CSS in injectHighlightStyles) passend zur hellen/dunklen Basemap.
function applyMapTheme(theme) {
  const el = document.getElementById('map')
  if (!el) return
  el.classList.toggle('map-theme-dark', theme === 'dark')
  el.classList.toggle('map-theme-light', theme !== 'dark')
}

// Eingeblendete Agent-Quellen (für den Interest-Area-Publish): alles, was im
// Agent-Filter nicht explizit deaktiviert ist.
function enabledSources() {
  return agentFilters.getSources()
    .map(s => s.source)
    .filter(src => {
      const sel = agentFilters.getSelection(src)
      return sel === undefined || (Array.isArray(sel) && sel.length > 0)
    })
}

async function init() {
  if (!window.L) {
    throw new Error('Leaflet ist nicht geladen')
  }

  if (!document.getElementById('map')) {
    throw new Error('DOM-Element #map nicht gefunden')
  }

  // Falls eine Dummy-Position hinterlegt ist (gemeinsamer Storage mit dem
  // AR-Client), wird die Karte direkt darauf zentriert — sonst Deutschland-
  // Übersicht. Bei aktivem Dummy-Modus wird zusätzlich autoCenter des
  // Leaflet-GPS-Controls abgeschaltet, damit die echte Position die
  // Karte nicht ungewollt verschiebt.
  const dummy = gpsConfig.getDummyPosition()
  const dummyMode = gpsConfig.isDummyMode()

  const center = dummy ? [dummy.lat, dummy.lon] : [51.1657, 10.4515]
  const zoom = dummy ? 16 : 14

  // preferCanvas: Vektor-Layer (v. a. die vielen WLAN-Abdeckungskreise) rendern
  // auf einem Canvas statt als einzelne SVG-Elemente → skaliert auf hunderte.
  const map = window.L.map('map', { preferCanvas: true }).setView(center, zoom)
  // Eigenes GPS-Control: erster Klick aktiviert Watch + Follow + Marker,
  // weitere Klicks toggeln nur Follow. Auf Capacitor-Native triggern wir
  // das per Event-Listener (s. mobile.js) sofort beim App-Start.
  // Shared GPS/UWB position source so the map marker matches the AR camera
  // (UWB-corrected when available). onActivate starts the shared GPS provider.
  const _hub = getAccessoryHub({ ajna })
  _announcer = _hub.announcer   // TTS-Ansagen für Marker-Interaktionen

  const gpsControl = setupMapGps(map, {
    positionSource: _hub.positionSource,
    onActivate: () => _hub.gps.start()
  })
  window.ajnaGpsControl = gpsControl

  // Visual pointing ray on the map (origin → direction), shared wand. 5-m-
  // Zeiger; färbt sich GRÜN und hebt den Marker hervor, sobald ein Objekt
  // anvisiert wird ("getroffen").
  const WAND_RAY_M = 5
  let _rayPoly = null
  let _wandTargetId = null
  const _setWandTarget = (id, on) => {
    const el = id && markerLayer.get(id)?.getElement()
    if (el) el.classList.toggle('wand-target', on)
  }
  _hub.wand.onTarget((target) => {
    if (_wandTargetId && _wandTargetId !== target?.id) _setWandTarget(_wandTargetId, false)
    if (target?.id) _setWandTarget(target.id, true)
    _wandTargetId = target?.id || null
  })
  _hub.wand.onOrientation(() => {
    const dir = _hub.wand.getPointingDirection()
    const origin = _hub.wand.getOrigin?.()
    if (!dir || !origin || !Number.isFinite(origin.lat) || !window.map) {
      if (_rayPoly) { _rayPoly.remove(); _rayPoly = null }
      return
    }
    const end = rayEndpointWgs84(origin, dir, WAND_RAY_M)
    const latlngs = [[origin.lat, origin.lon], [end.lat, end.lon]]
    const color = _wandTargetId ? '#37d67a' : '#4ea1ff'   // Treffer → grün
    if (_rayPoly) { _rayPoly.setLatLngs(latlngs); _rayPoly.setStyle({ color }) }
    else _rayPoly = window.L.polyline(latlngs,
      { color, weight: 3, opacity: 0.85, interactive: false }).addTo(window.map)
  })
  window.map = map
  window.dispatchEvent(new CustomEvent('ajna:map-ready', {
    detail: { map, gpsControl, dummyMode }
  }))

  // Interest-Area-Publisher (Opt-in): teilt einen UNSCHARFEN Bereich, damit
  // Agents Daten in der Nähe liefern. Position aus der geteilten GPS/UWB-Quelle;
  // eingeblendete Quellen aus dem Agent-Filter. NUR im Desktop-Map-Client — in
  // der Mobile-Shell übernimmt MobileShell Publisher + Schalter (sonst doppelt).
  if (!document.querySelector('.shell-tabbar')) {
    const interestArea = new InterestArea({
      ajna,
      positionSource: _hub.positionSource,   // Event-getriebenes Publishing
      getPosition: () => _hub.positionSource?.getWorldPosition?.() || null,
      getSources: () => enabledSources()
    })
    interestArea.start()
    window.ajnaInterestArea = interestArea   // Debug-Zugriff (Konsole + Overlay)
    // Neu publishen, sobald Manifeste geladen/Filter geändert → Quellen aktuell.
    agentFilters.onChange(() => interestArea.publishNow())

    // Stufe „Nähe" — gleiche Eigentümer-Regel wie oben: in der Shell gehört der
    // Reporter der MobileShell, sonst gäbe es ihn doppelt.
    const proximityReporter = new ProximityReporter({
      ajna,
      positionSource: _hub.positionSource,
      getPosition: () => _hub.positionSource?.getWorldPosition?.() || null
    })
    proximityReporter.start()
    window.ajnaProximity = proximityReporter
  }

  // Debug-Overlay „📡 IA" (oben links): zeigt eigenen + Server-Interessensbereiche
  // und den letzten Publish-Grund. Holt die InterestArea-Instanz aus window
  // (Shell oder Desktop). Nur zur Fehlersuche, standardmäßig aus.
  try {
    window.ajnaInterestAreaDebug = new InterestAreaDebug({ map, ajna, getInterestArea: () => window.ajnaInterestArea })
  } catch (err) { console.warn('[map] InterestAreaDebug init:', err?.message || err) }

  // Karte verschiebt sich → Off-Screen-Linie zum hervorgehobenen Marker neu zeichnen
  map.on('move', updateHighlightLine)
  map.on('zoom', updateHighlightLine)
  // Nach Pan/Zoom neu cullen: jetzt sichtbare Objekte einblenden, aus dem
  // Viewport gewanderte ausblenden. moveend deckt Pan UND Zoom ab.
  map.on('moveend', () => mapUpdateMarkers(ajna.getObjectList()))

  injectHighlightStyles()

  // Basemaps (alle frei, ohne API-Key): hell (OSM), dunkel (CARTO dark_all),
  // Satellit (Esri World Imagery). Der Layer-Umschalter (oben rechts) bietet alle
  // an; die Wahl bleibt gemerkt. Der Label-Kontrast (injectHighlightStyles) folgt
  // dem `contrast` der aktiven Basemap — Satellit nutzt den dunklen Kontrast
  // (heller Text + dunkler Halo liest sich auf Luftbildern am besten).
  const lightTiles = window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  })
  const darkTiles = window.L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20, subdomains: 'abcd',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
  })
  // Esri World Imagery — Achtung: Tile-URL in Reihenfolge {z}/{y}/{x}.
  const satTiles = window.L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
  })
  const BASEMAPS = {
    light:     { label: 'Karte hell',   layer: lightTiles, contrast: 'light' },
    dark:      { label: 'Karte dunkel', layer: darkTiles,  contrast: 'dark'  },
    satellite: { label: 'Satellit',     layer: satTiles,   contrast: 'dark'  },
  }
  let mapBase = 'light'
  try { const s = localStorage.getItem('ajna_map_theme'); if (s && BASEMAPS[s]) mapBase = s } catch {}
  BASEMAPS[mapBase].layer.addTo(map)
  applyMapTheme(BASEMAPS[mapBase].contrast)
  const baseLayers = {}
  for (const key of Object.keys(BASEMAPS)) baseLayers[BASEMAPS[key].label] = BASEMAPS[key].layer
  window.L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map)
  map.on('baselayerchange', e => {
    const key = Object.keys(BASEMAPS).find(k => BASEMAPS[k].layer === e.layer) || 'light'
    try { localStorage.setItem('ajna_map_theme', key) } catch {}
    applyMapTheme(BASEMAPS[key].contrast)
  })

  const editorSection = document.getElementById('editorSection')
  editorUI = new EditorUI({
    ajna,
    container: editorSection,
    mode: 'map',
    onObjectSelected: obj => map.setView([obj.lat, obj.lon], 16),
    onObjectsUpdated: objects => mapUpdateMarkers(objects),
    onObjectHover: (obj, hovering) => setMarkerHighlight(obj.id, hovering),
    onManageGroups: () => groupDialog.open(),
    onManageServers: () => serverDialog.open(),
    onManageProfile: () => profileDialog.open(),
    onManageFilters: () => filterDialog.open(),
    objectFilter: obj => agentFilters.matches(obj),
    onSaved: (obj, err) => {
      if (obj) toast.show('Änderungen übernommen', { title: obj.name || 'Objekt' })
      else if (err) toast.show('Speichern fehlgeschlagen', { title: 'Editor' })
    }
  })

  // Editier-Hilfe aus dem Karten-Popup (z. B. „Bearbeiten" bei UWB-Ankern).
  window.__ajnaEditObj = (oid) => { const o = ajna.getObjectById(oid); if (o) editorUI?.fillEditor(o) }

  // Marker-Klick-Aktionen verdrahten, sobald die EditorUI als Sink für
  // "Bearbeiten" zur Verfügung steht.
  objectActions = new ObjectActions({
    ajna,
    editorUI,
    contextMenu,
    permissionDialog,
    // Für Aktionen wie „Rufen": exakte Position, die ObjectActions je nach
    // Privatsphäre-Stufe vergröbert oder gar nicht mitschickt.
    getPosition: () => _hub?.positionSource?.getWorldPosition?.() || window.ajnaGeo?.position || null,
    // Tap-Menü-Interaktion → sofort Reply-Toast + Puls + TTS (wie Echo-Pfad).
    onInteract: (record, key) =>
      handleMarkerInteract(record.id, { action: key, source: ajna.currentUser()?.id }),
    // Server hat die Wirkung abgelehnt → Grund zeigen statt Erfolg vortäuschen.
    onInteractError: (record, key, message) =>
      toast.show(message || 'Aktion nicht möglich', { title: record?.name || 'Aktion' })
  })

  // ── Inventar: Fenster + Platzieren (Tipp-Modus & Drag&Drop) ──
  let _placing = null
  const _placeAt = async (rec, latlng) => {
    try { await ajna.place(rec.id, { lat: latlng.lat, lon: latlng.lng }) }
    catch (err) { toast.show('Platzieren fehlgeschlagen: ' + (err?.response?.error || err?.message || err), { title: 'Platzieren' }) }
  }
  const _endPlacing = () => { _placing = null; if (window.map) window.map.getContainer().style.cursor = '' }
  window.map.on('click', (e) => { if (_placing) { const r = _placing; _endPlacing(); _placeAt(r, e.latlng) } })

  const mapEl = document.getElementById('map')
  mapEl.addEventListener('dragover', (e) => {
    if (Array.from(e.dataTransfer?.types || []).includes(DRAG_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }
  })
  mapEl.addEventListener('drop', (e) => {
    const id = e.dataTransfer?.getData(DRAG_MIME)
    if (!id) return
    e.preventDefault()
    const rec = ajna.getObjectById(id)
    const latlng = window.map.mouseEventToLatLng(e)
    if (rec && latlng) _placeAt(rec, latlng)
  })

  const inventory = new InventoryUI({
    ajna,
    editorUI,
    container: document.querySelector('.shell-view[data-view="map"]') || document.body,
    onExamine: (rec) => {
      toast.show(interactionReply(rec, 'examine', rec.name), { title: rec.name || 'Objekt' })
      _announcer?.interaction(rec, 'examine')
    },
    onPlace: (rec) => {
      _placing = rec
      window.map.getContainer().style.cursor = 'crosshair'
      toast.show(`Tippe auf die Karte, um „${rec.name || 'Objekt'}" zu platzieren`, { title: 'Platzieren' })
    },
    getDevices: () => inventoryDevices(_hub),
  })
  _hub.wand?.onStatusChange?.(() => inventory.refresh())
  _hub.uwb?.onStatusChange?.(() => inventory.refresh())

  await editorUI.init()
  mapUpdateMarkers(ajna.getObjectList())

  // Throttle: Realtime-Updates kommen gebündelt (bewegte Figuren), aber ein
  // voller Marker-Reconcile pro Update ist bei vielen Objekten teuer. Max ~4×/s.
  ajna.onObjectsChanged(throttleLatest(objects => {
    mapUpdateMarkers(objects)
  }, 250))

  // UWB-Anker-Debug-Sichtbarkeit umgeschaltet (Einstellungen) → Marker neu rendern.
  window.addEventListener('ajna:uwb-anchors', () => mapUpdateMarkers(ajna.getObjectList()))

  // Manifeste selbst aktuell halten: Erst-Load (deckt persistierte Session ab, wo
  // onAuthChanged nicht feuert) + Auth-Wechsel + periodisch. window.agentFilters
  // wird auch von der Mobile-Shell (deren Interest-Area-Publisher) gelesen.
  agentFilters.startAutoRefresh()
  agentFilters.onChange(() => {
    mapUpdateMarkers(ajna.getObjectList())
    editorUI?.renderObjectList()   // Editor-Liste mitziehen
  })

  // Rechtsklick auf die Karte → "Neues Objekt…" an den geklickten
  // GPS-Koordinaten. Leaflet liefert e.latlng direkt; der Browser-eigene
  // Kontextmenü wird unterdrückt.
  map.on('contextmenu', e => {
    if (e.originalEvent) e.originalEvent.preventDefault()
    const { lat, lng } = e.latlng
    const loggedIn = ajna.isLoggedIn()
    contextMenu.show({
      x: e.originalEvent?.clientX ?? 0,
      y: e.originalEvent?.clientY ?? 0,
      title: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      items: [
        {
          label: 'Neues Objekt…',
          disabled: !loggedIn,
          onClick: () => editorUI.startNewObjectAt(lat, lng, 0)
        },
        {
          label: 'Zufälliges Objekt (mir gehörend)…',
          disabled: !loggedIn,
          onClick: () => spawnRandomAndEdit({
            ajna, editorUI, announcer: _announcer,
            position: { lat, lon: lng, altitude: 0 }
          }).catch(err => toast.show(err?.message || 'Spawn fehlgeschlagen', { title: 'Spawn' }))
        },
        // Vom World-Director erzeugen lassen → gehört ihm, bewegt sich auch.
        ...directorSpawnItems({
          ajna, position: { lat, lon: lng }, enabled: loggedIn,
          notify: msg => toast.show(msg, { title: 'Spawn' })
        })
      ]
    })
  })

  // Marker-Smoothing-Loop starten (rAF — pausiert wenn Tab im Hintergrund).
  requestAnimationFrame(tickMarkerSmoothers)
}

window.addEventListener('DOMContentLoaded', init)
