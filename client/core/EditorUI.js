export class EditorUI {
  constructor({ ajna, container, mode = 'map', onObjectSelected = null, onObjectsUpdated = null, onFocusPlayer = null, onObjectHover = null, onManageGroups = null, onManageServers = null }) {
    this.ajna = ajna
    this.container = container
    this.mode = mode
    this.onObjectSelected = onObjectSelected
    this.onObjectsUpdated = onObjectsUpdated
    // Optional: Callback aus der jeweiligen Host-Anwendung (z. B. AR-
    // Client), der die aktive Kamera zur Spieler-Position bewegt.
    // Wenn nicht gesetzt, wird die zugehörige Schaltfläche nicht gerendert.
    this.onFocusPlayer = onFocusPlayer
    // Optional: Hover-Callback (record, hovering: boolean) — wird vom AR-
    // Client zum Hervorheben im 3D-Raum, vom Map-Client zum Markieren
    // auf der Karte genutzt.
    this.onObjectHover = onObjectHover
    // Optional: öffnet den Gruppen-Verwaltungs-Dialog. Nur wenn gesetzt
    // wird der entsprechende Button gerendert.
    this.onManageGroups = onManageGroups
    // Optional: öffnet den Server-Verwaltungs-Dialog (Multi-Server).
    this.onManageServers = onManageServers
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

    this.container.classList.add('editor-panel')
    this._injectStyles()

    this.container.innerHTML = `
      <header class="ed-header">
        <h3>Editor</h3>
      </header>

      ${this.onFocusPlayer ? `
        <section class="ed-section" id="editorPlayerSection">
          <button id="editorFocusPlayerBtn" type="button" class="ed-btn ed-btn-primary">Kamera auf Spieler</button>
        </section>
      ` : ''}

      <section class="ed-section" id="editorAuth">
        <h4>Login</h4>
        <input id="editorEmail" type="email" placeholder="Email">
        <input id="editorPassword" type="password" placeholder="Passwort">
        <div class="ed-buttons">
          <button id="editorLoginBtn" class="ed-btn ed-btn-primary">Login</button>
          <button id="editorLogoutBtn" class="ed-btn" style="display:none">Logout</button>
        </div>
        <div id="editorStatus" class="ed-status"></div>
      </section>

      ${(this.onManageGroups || this.onManageServers) ? `
        <section class="ed-section" id="editorAdminSection">
          <div class="ed-buttons">
            ${this.onManageServers ? `<button id="editorManageServersBtn" type="button" class="ed-btn">Server</button>` : ''}
            ${this.onManageGroups  ? `<button id="editorManageGroupsBtn"  type="button" class="ed-btn">Gruppen</button>` : ''}
          </div>
        </section>
      ` : ''}

      <section class="ed-section" id="sharedEditorSection">
        <h4>Objekt-Editor</h4>
        <form id="sharedEditorForm">
          <input type="hidden" name="objectId">
          <div class="ed-grid">
            <label for="name">Name</label><input id="name" name="name" type="text" required>
            <label for="lat">Lat</label><input id="lat" name="lat" type="number" step="0.000001" required>
            <label for="lon">Lon</label><input id="lon" name="lon" type="number" step="0.000001" required>
            <label for="altitude">Alt</label><input id="altitude" name="altitude" type="number" step="0.1" value="0">
          </div>
          <div class="ed-buttons">
            <button type="submit" class="ed-btn ed-btn-primary">Speichern</button>
            <button id="editorDeleteBtn" type="button" class="ed-btn">Löschen</button>
          </div>
        </form>
      </section>

      <section class="ed-section">
        <div class="ed-row ed-list-header">
          <h4>Objekte</h4>
          <button id="editorRefreshBtn" class="ed-btn ed-btn-icon" title="Aktualisieren">↻</button>
        </div>
        <div id="editorObjectList" class="ed-object-list"></div>
      </section>
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
    this.focusPlayerBtn = this.container.querySelector('#editorFocusPlayerBtn')
    this.manageGroupsBtn = this.container.querySelector('#editorManageGroupsBtn')
    this.manageServersBtn = this.container.querySelector('#editorManageServersBtn')
  }

  _injectStyles() {
    if (document.getElementById('editorPanelStyles')) return

    const style = document.createElement('style')
    style.id = 'editorPanelStyles'
    // Selektoren mit ID + Klasse → Spezifität 0,1,1,0 = 110, schlägt
    // damit das page-eigene "#ui { background:rgba(0,0,0,0.6); ... }"
    // aus index-ar.html (Spezifität 100) ohne !important.
    style.textContent = `
      #ui.editor-panel, #editorSection.editor-panel {
        background: rgba(18,18,22,0.92);
        color: #eaeaea;
        font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace;
        padding: 10px 12px;
        border-radius: 8px;
        box-shadow: 0 6px 24px rgba(0,0,0,0.4);
        max-height: calc(100vh - 20px);
        overflow-y: auto;
      }
      .editor-panel .ed-header h3 {
        margin: 0 0 8px;
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #f1c40f;
      }
      .editor-panel h4 {
        margin: 0 0 6px;
        font-size: 11px;
        color: #aab;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .editor-panel .ed-section {
        padding: 8px 0;
        border-top: 1px solid rgba(255,255,255,0.08);
      }
      .editor-panel .ed-section:first-of-type { border-top: none; }
      .editor-panel .ed-row {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px;
      }
      .editor-panel .ed-list-header h4 { margin: 0; }
      .editor-panel input[type=email],
      .editor-panel input[type=password],
      .editor-panel input[type=text],
      .editor-panel input[type=number] {
        display: block;
        width: 100%; box-sizing: border-box;
        background: #15151a; color: #eaeaea;
        border: 1px solid #2a2a32; border-radius: 4px;
        padding: 3px 6px; font: inherit;
        margin: 2px 0;
      }
      .editor-panel .ed-grid {
        display: grid; grid-template-columns: 40px 1fr;
        gap: 4px 8px; align-items: center;
        margin-bottom: 6px;
      }
      .editor-panel .ed-grid label { color: #aab; }
      .editor-panel .ed-buttons {
        display: flex; gap: 6px; margin-top: 4px;
      }
      .editor-panel .ed-btn {
        flex: 1; padding: 5px 8px; cursor: pointer;
        background: #2a2a32; color: #eaeaea;
        border: 1px solid #3a3a44; border-radius: 4px;
        font: inherit;
      }
      .editor-panel .ed-btn:hover { background: #34343d; }
      .editor-panel .ed-btn:disabled { opacity: 0.5; cursor: default; }
      .editor-panel .ed-btn-primary {
        background: #2c5d8f; border-color: #3a78b6;
      }
      .editor-panel .ed-btn-primary:hover { background: #356da6; }
      .editor-panel .ed-btn-icon {
        flex: 0 0 auto; padding: 2px 8px;
      }
      .editor-panel .ed-btn-sm {
        flex: 0 0 auto; padding: 2px 8px; font-size: 11px;
      }
      .editor-panel .ed-status {
        margin-top: 5px; font-size: 11px; color: #aab;
        min-height: 1em;
      }
      .editor-panel .ed-object-list {
        max-height: 220px; overflow-y: auto;
        margin-top: 4px;
        background: #15151a; border-radius: 4px;
      }
      .editor-panel .ed-object-row {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px; padding: 4px 6px;
        cursor: pointer;
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      .editor-panel .ed-object-row:last-child { border-bottom: none; }
      .editor-panel .ed-object-row:hover { background: #2a2a32; }
      .editor-panel .ed-object-info {
        flex: 1; min-width: 0; line-height: 1.2;
      }
      .editor-panel .ed-object-info strong {
        display: block;
        color: #f1c40f;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .editor-panel .ed-object-meta {
        font-size: 10px; color: #888;
      }
      .editor-panel .ed-object-empty {
        padding: 6px; color: #777; font-style: italic; text-align: center;
      }
    `
    document.head.appendChild(style)
  }

  bindEvents() {
    this.loginBtn.addEventListener('click', async () => {
      try {
        await this.ajna.login(this.emailInput.value, this.passwordInput.value)
        this.setStatus('Login erfolgreich')
        // Auth-Stand hat sich geändert → neu sichtbare Objekte mit aufnehmen.
        // emitObjectsChanged triggert Listenrefresh und (im AR) syncSceneObjects.
        await this.ajna.loadObjects()
      } catch (err) {
        this.setStatus('Login fehlgeschlagen: ' + err.message)
      }
      this.updateAuthUI()
    })

    this.logoutBtn.addEventListener('click', async () => {
      this.ajna.logout()
      this.setStatus('Abgemeldet')
      // Nach Logout: nicht-public Objekte fallen aus der Sichtbarkeit raus.
      await this.ajna.loadObjects()
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

    if (this.manageServersBtn && this.onManageServers) {
      this.manageServersBtn.addEventListener('click', () => this.onManageServers())
    }

    if (this.manageGroupsBtn && this.onManageGroups) {
      this.manageGroupsBtn.addEventListener('click', () => this.onManageGroups())
    }

    if (this.focusPlayerBtn && this.onFocusPlayer) {
      this.focusPlayerBtn.addEventListener('click', () => this.onFocusPlayer())
    }
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

    if (objects.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'ed-object-empty'
      empty.textContent = 'keine Objekte'
      this.objectListEl.appendChild(empty)
    } else {
      for (const obj of objects) {
        const row = document.createElement('div')
        row.className = 'ed-object-row'
        row.title = obj.id
        row.innerHTML = `
          <div class="ed-object-info">
            <strong></strong>
            <span class="ed-object-meta"></span>
          </div>
          <button type="button" class="ed-btn ed-btn-sm">Laden</button>
        `
        // textContent statt innerHTML — verhindert HTML-Injection aus Backend-Daten
        row.querySelector('strong').textContent = obj.name || 'unnamed'
        row.querySelector('.ed-object-meta').textContent =
          `${(obj.lat ?? 0).toFixed(5)}, ${(obj.lon ?? 0).toFixed(5)}`

        // Klick auf die Zeile → Kamera zum Objekt schwenken
        // (im AR-Modus über main.js verdrahtet, im Map-Modus zentriert die Karte).
        row.addEventListener('click', () => {
          if (typeof this.onObjectSelected === 'function') {
            this.onObjectSelected(obj)
          }
        })

        if (typeof this.onObjectHover === 'function') {
          row.addEventListener('mouseenter', () => this.onObjectHover(obj, true))
          row.addEventListener('mouseleave', () => this.onObjectHover(obj, false))
        }

        // "Laden" lädt den Objekt-Editor — bewusst getrennt vom Zeilen-Klick,
        // damit Bearbeiten und Anspringen separate Aktionen sind.
        row.querySelector('button').addEventListener('click', ev => {
          ev.stopPropagation()
          this.fillEditor(obj)
        })

        this.objectListEl.appendChild(row)
      }
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
