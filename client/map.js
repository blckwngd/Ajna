import { AjnaManager } from "./core/AjnaManager.js"
import { EditorUI } from "./core/EditorUI.js"
import "leaflet-gps"
import "leaflet/dist/leaflet.css"
import "leaflet-gps/dist/leaflet-gps.min.css"

const ajna = new AjnaManager("http://localhost:8090")
const markerLayer = new Map()

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
  marker.bindPopup(`<strong>${obj.name || 'unnamed'}</strong><br>id: ${obj.id}`)

  marker.on('dragend', async event => {
    const { lat, lng } = event.target.getLatLng()
    const updated = await ajna.updateObject(obj.id, { lat, lon: lng })
    marker.setLatLng([lat, lng])
    marker.bindPopup(`<strong>${updated.name || 'unnamed'}</strong><br>${lat.toFixed(5)}, ${lng.toFixed(5)}`)
    await ajna.loadObjects()
    mapUpdateMarkers(ajna.getObjectList())
  })

  marker.on('click', () => {
    if (editorUI && typeof editorUI.fillEditor === 'function') {
      editorUI.fillEditor(obj)
    }
  })

  markerLayer.set(obj.id, marker)
}

function removeMarker(id) {
  const marker = markerLayer.get(id)
  if (marker) {
    window.map.removeLayer(marker)
    markerLayer.delete(id)
  }
}

async function init() {
  if (!window.L) {
    throw new Error('Leaflet ist nicht geladen')
  }

  if (!document.getElementById('map')) {
    throw new Error('DOM-Element #map nicht gefunden')
  }

  const map = window.L.map('map').setView([51.1657, 10.4515], 14)
  map.addControl(new L.Control.Gps({ autoActive: true, position: 'topleft', setView: true, autoCenter: true }))
  window.map = map

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
    onObjectsUpdated: objects => mapUpdateMarkers(objects)
  })

  await editorUI.init()
  mapUpdateMarkers(ajna.getObjectList())

  ajna.onObjectsChanged(objects => {
    mapUpdateMarkers(objects)
  })
}

window.addEventListener('DOMContentLoaded', init)
