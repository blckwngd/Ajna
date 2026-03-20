import { AjnaManager } from "./core/AjnaManager.js"
import "leaflet-gps"

const ajna = new AjnaManager("http://localhost:8090")

const markerLayer = new Map()
let canCreate = false

function updateAuthUI() {
  const loggedIn = ajna.isLoggedIn()
  canCreate = loggedIn

  const loginBtn = document.getElementById('loginBtn')
  const logoutBtn = document.getElementById('logoutBtn')
  const loginStatus = document.getElementById('loginStatus')
  const newSection = document.getElementById('newObjectSection')
  const editSection = document.getElementById('editorSection')

  if (!loginBtn || !logoutBtn || !loginStatus) return

  if (loggedIn) {
    loginBtn.style.display = 'none'
    logoutBtn.style.display = 'block'
    loginStatus.innerText = `Angemeldet als ${ajna.getCurrentUser()?.email || 'Benutzer'}`
    if (newSection) newSection.style.display = ''
    if (editSection) editSection.style.display = ''
  } else {
    loginBtn.style.display = 'block'
    logoutBtn.style.display = 'none'
    loginStatus.innerText = 'Nicht angemeldet'
    if (newSection) newSection.style.display = 'none'
    if (editSection) editSection.style.display = 'none'
  }

  // Tablet/Mobile-Editor-Toggle an/aus
  const editorToggle = document.getElementById('editorToggle')
  if (editorToggle) {
    editorToggle.style.display = window.innerWidth <= 850 ? 'block' : 'none'
    if (!loggedIn) {
      editorToggle.style.display = 'none'
    }
  }
}

async function renderObjectList(objects) {
  const listEl = document.getElementById("objectList")
  listEl.innerHTML = ""

  for (const obj of objects) {
    const row = document.createElement("div")
    row.className = "object-row"
    row.innerHTML = `<strong>${obj.name || "unnamed"}</strong> <small>(${obj.lat.toFixed(5)}, ${obj.lon.toFixed(5)})</small>`
    row.onclick = () => {
      const marker = markerLayer.get(obj.id)
      if (marker) marker.openPopup()
      window.map.setView([obj.lat, obj.lon], 16)
      fillEditor(obj)
    }
    listEl.appendChild(row)
  }
}

function fillEditor(obj){
  const form = document.getElementById("editor")
  form.objectId.value = obj.id
  form.name.value = obj.name || ""
  form.lat.value = obj.lat || 0
  form.lon.value = obj.lon || 0
  form.altitude.value = obj.altitude || 0
}

function updateMarker(obj) {
  const marker = markerLayer.get(obj.id)
  if (marker) {
    marker.setLatLng([obj.lat, obj.lon])
    marker.bindPopup(`<strong>${obj.name || 'unnamed'}</strong><br>${obj.lat.toFixed(5)}, ${obj.lon.toFixed(5)}`)
  }
}

function addMarker(obj) {
  if (!window.L) return
  if (markerLayer.has(obj.id)) return

  const marker = window.L.marker([obj.lat, obj.lon], { draggable: true }).addTo(window.map)
  marker.bindPopup(`<strong>${obj.name || 'unnamed'}</strong><br>id: ${obj.id}`)

  marker.on('dragend', async (event) => {
    const { lat, lng } = event.target.getLatLng()
    const updated = await ajna.updateObject(obj.id, { lat, lon: lng })
    marker.setLatLng([lat, lng])
    marker.bindPopup(`<strong>${updated.name || 'unnamed'}</strong><br>${lat.toFixed(5)}, ${lng.toFixed(5)}`)
    await refreshObjects()
  })

  marker.on('click', () => fillEditor(obj))
  markerLayer.set(obj.id, marker)
}

function removeMarker(id) {
  const marker = markerLayer.get(id)
  if (marker) {
    window.map.removeLayer(marker)
    markerLayer.delete(id)
  }
}

async function refreshObjects() {
  const objects = ajna.getObjectList()
  await renderObjectList(objects)

  for (const obj of objects) {
    if (markerLayer.has(obj.id)) {
      updateMarker(obj)
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

async function init() {
  if (!window.L) {
    throw new Error('Leaflet ist nicht geladen: Bitte überprüfe, ob leaflet.js vor map.bundle.js eingebunden ist (index-map.html).')
  }

  if (!document.getElementById('map')) {
    throw new Error('DOM-Element #map nicht gefunden. Bitte stelle sicher, dass index-map.html ein <div id="map"> hat.')
  }

  const map = window.L.map('map').setView([51.1657, 10.4515], 9)
  map.addControl( new L.Control.Gps({ autoActive: true, position: "topleft", setView: true }) );
  window.map = map

  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map)

  document.getElementById('newObjectBtn').onclick = async () => {
    const lat = parseFloat(document.getElementById('newLat').value)
    const lon = parseFloat(document.getElementById('newLon').value)
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return alert('Bitte gültige Koordinaten eingeben')
    }
    const obj = await ajna.createObject({ name: `obj-${Date.now()}`, lat, lon, altitude: 0 })
    addMarker(obj)
    await refreshObjects()
  }

  const editor = document.getElementById('editor')
  editor.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const id = editor.objectId.value
    if (!id) return

    const updated = await ajna.updateObject(id, {
      name: editor.name.value,
      lat: parseFloat(editor.lat.value),
      lon: parseFloat(editor.lon.value),
      altitude: parseFloat(editor.altitude.value)
    })
    fillEditor(updated)
    updateMarker(updated)
    await refreshObjects()
  })

  document.getElementById('deleteBtn').onclick = async () => {
    const id = editor.objectId.value
    if (!id) return
    await ajna.deleteObject(id)
    removeMarker(id)
    editor.reset()
    await refreshObjects()
  }

  document.getElementById('refreshBtn').onclick = async () => {
    await ajna.loadObjects()
    await refreshObjects()
    document.getElementById('status').innerText = 'Objekte geladen'
  }

  ajna.onObjectsChanged(async () => {
    await refreshObjects()
  })

  document.getElementById('loginBtn').onclick = async () => {
    const email = document.getElementById('email').value
    const password = document.getElementById('password').value
    try {
      await ajna.login(email, password)
      updateAuthUI()
      document.getElementById('status').innerText = 'Login erfolgreich'
      await ajna.loadObjects()
      await refreshObjects()
    } catch (error) {
      document.getElementById('loginStatus').innerText = 'Login fehlgeschlagen'
      console.error('Login error', error)
    }
  }

  document.getElementById('logoutBtn').onclick = async () => {
    ajna.logout()
    updateAuthUI()
    document.getElementById('status').innerText = 'Abgemeldet'
    await ajna.loadObjects()
    await refreshObjects()
  }

  const editorToggle = document.getElementById('editorToggle')
  if (editorToggle) {
    editorToggle.onclick = () => {
      const es = document.getElementById('editorSection')
      if (!es) return
      const isVisible = es.classList.toggle('visible')
      editorToggle.innerText = isVisible ? 'Editor ausblenden' : 'Editor anzeigen'
    }
  }

  await ajna.loadObjects()
  await refreshObjects()

  updateAuthUI()

  map.on('click', (event) => {
    if (!canCreate) {
      document.getElementById('status').innerText = 'Klicken nicht erlaubt: fehlende Berechtigung.'
      return
    }

    const { lat, lng } = event.latlng
    document.getElementById('newLat').value = lat.toFixed(6)
    document.getElementById('newLon').value = lng.toFixed(6)
    fillEditor({ id: '', name: '', lat, lon: lng, altitude: 0 })
    document.getElementById('status').innerText = `Koordinaten gesetzt: ${lat.toFixed(6)}, ${lng.toFixed(6)}. Drücke 'Erstellen'`;
  })
}

init().catch(err => console.error(err))
