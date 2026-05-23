import { AjnaManager } from "./core/AjnaManager.js"
import { EditorUI } from "./core/EditorUI.js"
import { GPSProvider } from "./core/GPSProvider.js"
import { ContextMenu } from "./core/ContextMenu.js"
import { PermissionDialog } from "./core/PermissionDialog.js"
import { GroupDialog } from "./core/GroupDialog.js"
import { ObjectActions } from "./core/ObjectActions.js"
import { Toast } from "./core/Toast.js"
import "leaflet-gps"
import "leaflet/dist/leaflet.css"
import "leaflet-gps/dist/leaflet-gps.min.css"

const ajna = new AjnaManager("http://" + window.location.hostname + ":8090")
window.ajna = ajna
const markerLayer = new Map()
const interactSubs = new Map()
const contextMenu = new ContextMenu()
const permissionDialog = new PermissionDialog({ ajna })
const groupDialog = new GroupDialog({ ajna })
const toast = new Toast()
let objectActions = null  // wird in init() verdrahtet, sobald editorUI da ist

function subscribeMarkerInteract(objectId) {
  if (interactSubs.has(objectId)) return
  interactSubs.set(objectId, null)
  ajna.subscribeInteract(objectId, data => handleMarkerInteract(objectId, data))
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
  toast.show(`${data.action} → ${label}`, { title: "INTERACT" })

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

function mapUpdateMarkers(objects) {
  if (!window.map) return

  for (const obj of objects) {
    if (markerLayer.has(obj.id)) {
      const marker = markerLayer.get(obj.id)
      marker.setLatLng([obj.lat, obj.lon])
      marker.bindPopup(`<strong>${obj.name || 'unnamed'}</strong><br>${obj.lat.toFixed(5)}, ${obj.lon.toFixed(5)}`)
    } else {
      addMarker(obj)
    }
  }

  for (const id of Array.from(markerLayer.keys())) {
    if (!objects.find(o => o.id === id)) {
      removeMarker(id)
    }
  }
}

function addMarker(obj) {
  if (!window.L || markerLayer.has(obj.id)) return

  const icon = window.L.divIcon({
    className: 'map-marker',
    iconSize: [28, 28],
    html: `❌ ${obj.name}`
  })

  const marker = window.L.marker([obj.lat, obj.lon], { icon, draggable: true }).addTo(window.map)
  // Hover-Tooltip mit dem Objekt-Namen (Leaflet zeigt/blendet ihn automatisch
  // bei mouseover / mouseout)
  marker.bindTooltip(obj.name || 'unnamed', { direction: 'top', offset: [0, -8] })

  marker.on('dragend', async event => {
    const { lat, lng } = event.target.getLatLng()
    const updated = await ajna.updateObject(obj.id, { lat, lon: lng })
    marker.setLatLng([lat, lng])
    marker.bindPopup(`<strong>${updated.name || 'unnamed'}</strong><br>${lat.toFixed(5)}, ${lng.toFixed(5)}`)
    await ajna.loadObjects()
    mapUpdateMarkers(ajna.getObjectList())
  })

  marker.on('click', e => {
    // Aktuelle Position des Records aus dem AjnaManager-Cache holen
    // (kann sich durch Realtime-Updates seit addMarker geändert haben).
    const fresh = ajna.getObjectById(obj.id) || obj
    if (!objectActions) return
    const origEvt = e.originalEvent
    objectActions.showFor(fresh, origEvt.clientX, origEvt.clientY)
  })

  markerLayer.set(obj.id, marker)
  subscribeMarkerInteract(obj.id)
}

function removeMarker(id) {
  const marker = markerLayer.get(id)
  if (marker) {
    window.map.removeLayer(marker)
    markerLayer.delete(id)
  }
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
    @keyframes ajna-marker-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(241, 196, 15, 0.7); }
      70%  { box-shadow: 0 0 0 16px rgba(241, 196, 15, 0); }
      100% { box-shadow: 0 0 0 0 rgba(241, 196, 15, 0); }
    }
    .map-marker.marker-pulse {
      animation: ajna-marker-pulse 700ms ease-out;
      border-radius: 4px;
    }
  `
  document.head.appendChild(style)
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

  const map = window.L.map('map').setView(center, zoom)
  map.addControl(new L.Control.Gps({
    autoActive: !dummyMode,
    position: 'topleft',
    setView: !dummyMode,
    autoCenter: !dummyMode
  }))
  window.map = map

  // Karte verschiebt sich → Off-Screen-Linie zum hervorgehobenen Marker neu zeichnen
  map.on('move', updateHighlightLine)
  map.on('zoom', updateHighlightLine)

  injectHighlightStyles()

  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map)

  const editorSection = document.getElementById('editorSection')
  editorUI = new EditorUI({
    ajna,
    container: editorSection,
    mode: 'map',
    onObjectSelected: obj => map.setView([obj.lat, obj.lon], 16),
    onObjectsUpdated: objects => mapUpdateMarkers(objects),
    onObjectHover: (obj, hovering) => setMarkerHighlight(obj.id, hovering),
    onManageGroups: () => groupDialog.open()
  })

  // Marker-Klick-Aktionen verdrahten, sobald die EditorUI als Sink für
  // "Bearbeiten" zur Verfügung steht.
  objectActions = new ObjectActions({
    ajna,
    editorUI,
    contextMenu,
    permissionDialog
  })

  await editorUI.init()
  mapUpdateMarkers(ajna.getObjectList())

  ajna.onObjectsChanged(objects => {
    mapUpdateMarkers(objects)
  })
}

window.addEventListener('DOMContentLoaded', init)
