export class EditorUI {
  constructor({ ajna, container, mode = 'map', onObjectSelected = null, onObjectsUpdated = null }) {
    this.ajna = ajna
    this.container = container
    this.mode = mode
    this.onObjectSelected = onObjectSelected
    this.onObjectsUpdated = onObjectsUpdated
    this.objectLayer = new Map()
  }

  async init() {
    this.initUI()
    this.bindEvents()
    await this.ajna.loadObjects()
    this.updateAuthUI()
  }

  initUI() {
    if (!this.container) {
      throw new Error('EditorUI: container is required')
    }

    // Für mobile/kleine Bildschirme: Toggle anzeigbar machen
    this.container.innerHTML = `
      <div id="editorAuth" style="margin-bottom:8px">
        <h3>Login</h3>
        <input id="editorEmail" type="email" placeholder="Email" style="width:100%" />
        <input id="editorPassword" type="password" placeholder="Passwort" style="width:100%" />
        <button id="editorLoginBtn">Login</button>
        <button id="editorLogoutBtn" style="display:none">Logout</button>
        <div id="editorStatus" style="margin-top:5px"></div>
      </div>

      <div id="sharedEditorSection">
        <h3>Objekt-Editor</h3>
        <style>
          .editor-row { display: flex; align-items: center; margin-bottom: 8px; }
          .editor-row label { width: 60px; font-weight: 600; }
          .editor-row input { flex: 1; margin-left: 8px; }
        </style>
        <form id="sharedEditorForm">
          <input type="hidden" name="objectId" />
          <div class="editor-row"><label for="name">Name</label><input id="name" name="name" type="text" required /></div>
          <div class="editor-row"><label for="lat">Lat</label><input id="lat" name="lat" type="number" step="0.000001" required /></div>
          <div class="editor-row"><label for="lon">Lon</label><input id="lon" name="lon" type="number" step="0.000001" required /></div>
          <div class="editor-row"><label for="altitude">Alt</label><input id="altitude" name="altitude" type="number" step="0.1" value="0" /></div>
          <button type="submit">Speichern</button>
          <button id="editorDeleteBtn" type="button">Löschen</button>
        </form>

        <h3>Objekte</h3>
        <button id="editorRefreshBtn">Aktualisieren</button>
        <div id="editorObjectList" style="max-height:220px;overflow:auto; border:1px solid #ccc; background:#fff"></div>
      </div>
    `

    this.loginBtn = this.container.querySelector('#editorLoginBtn')
    this.logoutBtn = this.container.querySelector('#editorLogoutBtn')
    this.emailInput = this.container.querySelector('#editorEmail')
    this.passwordInput = this.container.querySelector('#editorPassword')
    this.statusEl = this.container.querySelector('#editorStatus')
    this.editorForm = this.container.querySelector('#sharedEditorForm')
    this.editorDeleteBtn = this.container.querySelector('#editorDeleteBtn')
    this.refreshBtn = this.container.querySelector('#editorRefreshBtn')
    this.objectListEl = this.container.querySelector('#editorObjectList')
  }

  bindEvents() {
    this.loginBtn.addEventListener('click', async () => {
      try {
        await this.ajna.login(this.emailInput.value, this.passwordInput.value)
        this.setStatus('Login erfolgreich')
      } catch (err) {
        this.setStatus('Login fehlgeschlagen: ' + err.message)
      }
      this.updateAuthUI()
    })

    this.logoutBtn.addEventListener('click', () => {
      this.ajna.logout()
      this.setStatus('Abgemeldet')
      this.updateAuthUI()
    })

    this.refreshBtn.addEventListener('click', async () => {
      await this.ajna.loadObjects()
      this.renderObjectList()
      this.setStatus('Objekte geladen')
    })

    this.editorForm.addEventListener('submit', async (ev) => {
      ev.preventDefault()
      const data = {
        name: this.editorForm.name.value || `obj-${Date.now()}`,
        lat: parseFloat(this.editorForm.lat.value),
        lon: parseFloat(this.editorForm.lon.value),
        altitude: parseFloat(this.editorForm.altitude.value)
      }
      const id = this.editorForm.objectId.value
      let obj
      if (!id) {
        obj = await this.ajna.createObject(data)
      } else {
        obj = await this.ajna.updateObject(id, data)
      }
      this.fillEditor(obj)
      this.renderObjectList()
      this.setStatus('Objekt gespeichert')
    })

    this.editorDeleteBtn.addEventListener('click', async () => {
      const id = this.editorForm.objectId.value
      if (!id) return
      await this.ajna.deleteObject(id)
      this.editorForm.reset()
      this.renderObjectList()
      this.setStatus('Objekt gelöscht')
    })

    this.ajna.onObjectsChanged(() => {
      this.renderObjectList()
    })
  }

  updateAuthUI() {
    const loggedIn = this.ajna.isLoggedIn()

    if (loggedIn) {
      this.loginBtn.style.display = 'none'
      this.logoutBtn.style.display = 'inline-block'
      this.emailInput.disabled = true
      this.passwordInput.style.display = 'none'
      this.container.querySelector('#sharedEditorSection').style.display = ''
    } else {
      this.loginBtn.style.display = 'inline-block'
      this.logoutBtn.style.display = 'none'
      this.emailInput.disabled = false
      this.passwordInput.style.display = ''
      this.container.querySelector('#sharedEditorSection').style.display = 'none'
    }
  }

  setStatus(text) {
    this.statusEl.innerText = text
  }

  renderObjectList() {
    const objects = this.ajna.getObjectList()
    this.objectListEl.innerHTML = ''
    for (const obj of objects) {
      const row = document.createElement('div')
      row.className = 'object-row'
      row.innerHTML = `<strong>${obj.name || 'unnamed'}</strong> <small>${obj.lat.toFixed(5)}, ${obj.lon.toFixed(5)}</small>`
      row.onclick = () => {
        this.fillEditor(obj)
        if (typeof this.onObjectSelected === 'function') {
          this.onObjectSelected(obj)
        }
      }
      this.objectListEl.appendChild(row)
    }
    if (typeof this.onObjectsUpdated === 'function') {
      this.onObjectsUpdated(this.ajna.getObjectList())
    }
  }

  fillEditor(obj) {
    this.editorForm.objectId.value = obj.id
    this.editorForm.name.value = obj.name || ''
    this.editorForm.lat.value = (obj.lat ?? 0).toFixed(6)
    this.editorForm.lon.value = (obj.lon ?? 0).toFixed(6)
    this.editorForm.altitude.value = (obj.altitude ?? 0).toFixed(2)
  }
}
