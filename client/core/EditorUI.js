import { injectServerBadgeStyles, renderServerBadge } from './ServerBadge.js'
import { LOCAL_MODELS } from './localModels.js'
import { randomHexColor } from './randomColor.js'

const EXT_MODELS_KEY = 'ajna_allow_ext_models'

export class EditorUI {
  constructor({ ajna, container, mode = 'map', onObjectSelected = null, onObjectsUpdated = null, onFocusPlayer = null, onObjectHover = null, onManageGroups = null, onManageServers = null, onManageProfile = null, onManageFilters = null, onEditorActivate = null, objectFilter = null, onToggleArMode = null, getArMode = null }) {
    this.ajna = ajna
    this.container = container
    this.mode = mode
    // Optional: Prädikat (obj) => boolean. Wenn gesetzt, zeigt die Objektliste
    // nur passende Objekte — konsistent mit den Agent-Filtern (Layer-Sicht).
    // Host ruft renderObjectList() bei Filter-Änderung erneut auf.
    this.objectFilter = objectFilter
    this.onObjectSelected = onObjectSelected
    this.onObjectsUpdated = onObjectsUpdated
    // Optional: fired when the editor form is engaged (edit existing or start a
    // new object). The AR host uses it to pop the (possibly minimized) panel.
    this.onEditorActivate = onEditorActivate
    // Optional: Callback aus der jeweiligen Host-Anwendung (z. B. AR-
    // Client), der die aktive Kamera zur Spieler-Position bewegt.
    // Wenn nicht gesetzt, wird die zugehörige Schaltfläche nicht gerendert.
    this.onFocusPlayer = onFocusPlayer
    // Optional (nur AR): Umschalter echtes AR (Kamera-Passthrough) ↔ XR
    // (Skybox). onToggleArMode(on:boolean) führt den Wechsel aus, getArMode()
    // liefert den initialen Zustand für die Toggle-Stellung. Ohne Callback wird
    // der Schalter nicht gerendert (z. B. im Map-Editor).
    this.onToggleArMode = onToggleArMode
    this.getArMode = getArMode
    // Optional: Hover-Callback (record, hovering: boolean) — wird vom AR-
    // Client zum Hervorheben im 3D-Raum, vom Map-Client zum Markieren
    // auf der Karte genutzt.
    this.onObjectHover = onObjectHover
    // Optional: öffnet den Gruppen-Verwaltungs-Dialog. Nur wenn gesetzt
    // wird der entsprechende Button gerendert.
    this.onManageGroups = onManageGroups
    // Optional: öffnet den Server-Verwaltungs-Dialog (Multi-Server).
    this.onManageServers = onManageServers
    // Optional: öffnet den User-Profil-Dialog (u. a. Default-Permissions).
    this.onManageProfile = onManageProfile
    // Optional: öffnet den Agent-Filter-Dialog (per-Layer-Sichtbarkeit).
    this.onManageFilters = onManageFilters
    this.objectLayer = new Map()
  }

  async init() {
    this.initUI()
    // Wichtig: connect() statt loadObjects() — connect() macht intern
    // refreshObjects(), startet aber zusätzlich den Boot-authRefresh,
    // den 1h-Token-Heartbeat, den PB_CONNECT-Listener und den 30s-
    // Catch-up-Poll. loadObjects() würde nur die Liste laden, die
    // Resilience-Layer (Phase 5) bliebe schlafend.
    this.bindEvents()
    // Eine bereits vorhandene Session (z. B. per URL-Fragment-Handoff oder aus
    // localStorage) sofort im Formular spiegeln — nicht erst auf ein
    // Auth-Change-Event warten, das beim Vorab-Laden nicht feuert.
    this.updateAuthUI()
    // connect()-Fehler (z. B. Realtime/PB_CONNECT) dürfen die Auth-UI nicht in
    // den Logout-Zustand zwingen und auch den restlichen Init nicht abbrechen.
    try {
      await this.ajna.connect()
    } catch (err) {
      console.warn('[editor] connect failed:', err?.message || err)
    }
    this.updateAuthUI()
  }

  initUI() {
    if (!this.container) {
      throw new Error('EditorUI: container is required')
    }

    this.container.classList.add('editor-panel')
    this._injectStyles()
    injectServerBadgeStyles()

    this.container.innerHTML = `
      <header class="ed-header">
        <h3>Editor</h3>
      </header>

      ${(this.onFocusPlayer || this.onToggleArMode) ? `
        <section class="ed-section" id="editorPlayerSection">
          ${this.onFocusPlayer ? `
            <button id="editorFocusPlayerBtn" type="button" class="ed-btn ed-btn-primary">Kamera auf Spieler</button>
          ` : ''}
          ${this.onToggleArMode ? `
            <label class="ed-toggle" style="display:flex;align-items:center;gap:8px;margin-top:8px;cursor:pointer;">
              <input type="checkbox" id="editorArModeToggle" style="width:auto;display:inline-block;margin:0;">
              <span>Echtes AR (Kamera-Durchsicht)</span>
            </label>
          ` : ''}
        </section>
      ` : ''}

      <section class="ed-section" id="editorAuth">
        <h4>Login</h4>
        <div id="editorUserDisplay" class="ed-user-display" style="display:none"></div>
        <input id="editorEmail" type="email" placeholder="Email">
        <input id="editorPassword" type="password" placeholder="Passwort">
        <div class="ed-buttons">
          <button id="editorLoginBtn" class="ed-btn ed-btn-primary">Login</button>
          <button id="editorLogoutBtn" class="ed-btn" style="display:none">Logout</button>
        </div>
        <div id="editorStatus" class="ed-status"></div>
      </section>

      ${(this.onManageGroups || this.onManageServers || this.onManageProfile || this.onManageFilters) ? `
        <section class="ed-section" id="editorAdminSection">
          <div class="ed-buttons">
            ${this.onManageServers ? `<button id="editorManageServersBtn" type="button" class="ed-btn">Server</button>` : ''}
            ${this.onManageGroups  ? `<button id="editorManageGroupsBtn"  type="button" class="ed-btn">Gruppen</button>` : ''}
            ${this.onManageProfile ? `<button id="editorManageProfileBtn" type="button" class="ed-btn">Profil</button>` : ''}
            ${this.onManageFilters ? `<button id="editorManageFiltersBtn" type="button" class="ed-btn">Filter</button>` : ''}
          </div>
        </section>
      ` : ''}

      <div id="objectEditorOverlay" class="ed-modal-overlay" hidden>
        <div class="ed-modal">
          <div class="ed-modal-head">
            <h4 id="objectEditorTitle">Objekt-Editor</h4>
            <button type="button" id="editorCloseBtn" class="ed-modal-close" title="Schließen">✕</button>
          </div>
          <form id="sharedEditorForm">
            <input type="hidden" name="objectId">
            <div class="ed-grid">
              <label for="name">Name</label><input id="name" name="name" type="text" required>
              <label for="lat">Lat</label><input id="lat" name="lat" type="number" step="0.000001" required>
              <label for="lon">Lon</label><input id="lon" name="lon" type="number" step="0.000001" required>
              <label for="altitude">Alt</label><input id="altitude" name="altitude" type="number" step="0.1" value="0">
              <label for="altitude_ref">Höhe</label>
              <select id="altitude_ref" name="altitude_ref">
                <option value="ground">über Boden (AGL)</option>
                <option value="msl">über Normalnull (AMSL)</option>
              </select>
              <label for="emoji">Symbol</label>
              <input id="emoji" name="emoji" type="text" maxlength="8" placeholder="z. B. 💡" style="justify-self:start;width:90px">
              <label for="color">Farbe</label>
              <span class="ed-color-cell">
                <input id="colorOn" name="colorOn" type="checkbox" style="width:auto;margin:0">
                <input id="color" name="color" type="color" value="#888888">
              </span>
              <label for="gltfSelect">3D-Modell</label>
              <select id="gltfSelect" name="gltfSelect"></select>
              <label for="gltfUrl" id="gltfUrlLabel">Modell-URL</label>
              <input id="gltfUrl" name="gltfUrl" type="text" placeholder="https://…/modell.glb">
              <label for="portable">Aufnehmbar</label>
              <input id="portable" name="portable" type="checkbox" style="width:auto;justify-self:start;">
              <label for="allowExtModels" title="Sicherheit: erlaubt das Verlinken externer Modell-URLs">Externe URLs</label>
              <input id="allowExtModels" name="allowExtModels" type="checkbox" style="width:auto;justify-self:start;">
            </div>
            <label for="stateJson" class="ed-full-label">State (JSON)</label>
            <textarea id="stateJson" name="stateJson" rows="4" class="ed-json" spellcheck="false"></textarea>
            <div class="ed-buttons">
              <button type="submit" class="ed-btn ed-btn-primary">Speichern</button>
              <button id="editorDeleteBtn" type="button" class="ed-btn">Löschen</button>
            </div>
          </form>
        </div>
      </div>

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
    this.userDisplay = this.container.querySelector('#editorUserDisplay')
    this.statusEl = this.container.querySelector('#editorStatus')
    this.editorForm = this.container.querySelector('#sharedEditorForm')
    this.editorDeleteBtn = this.container.querySelector('#editorDeleteBtn')
    this.editorOverlay = this.container.querySelector('#objectEditorOverlay')
    this.editorTitle = this.container.querySelector('#objectEditorTitle')
    this._populateModelSelect()
    this._wireEditorModal()
    this.refreshBtn = this.container.querySelector('#editorRefreshBtn')
    this.objectListEl = this.container.querySelector('#editorObjectList')
    this.focusPlayerBtn = this.container.querySelector('#editorFocusPlayerBtn')
    this.arModeToggle = this.container.querySelector('#editorArModeToggle')
    this.manageGroupsBtn = this.container.querySelector('#editorManageGroupsBtn')
    this.manageServersBtn = this.container.querySelector('#editorManageServersBtn')
    this.manageProfileBtn = this.container.querySelector('#editorManageProfileBtn')
    this.manageFiltersBtn = this.container.querySelector('#editorManageFiltersBtn')
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
      .editor-panel .ed-user-display {
        background: #15151a;
        border: 1px solid #2a2a32; border-radius: 4px;
        padding: 4px 8px; margin: 2px 0;
        color: #f1c40f;
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
      /* ── Objekt-Editor als Modal-Overlay (statt Seitenleiste) ── */
      .editor-panel .ed-modal-overlay {
        position: fixed; inset: 0; z-index: 5200; display: flex;
        align-items: center; justify-content: center;
        background: rgba(0,0,0,0.5); padding: 16px;
        padding-bottom: calc(16px + var(--safe-bottom, env(safe-area-inset-bottom, 0px)));
      }
      /* höhere Spezifität als display:flex, sonst wäre das Modal immer offen */
      .editor-panel .ed-modal-overlay[hidden] { display: none; }
      .editor-panel .ed-modal {
        width: min(460px, 96vw); max-height: 86vh; overflow-y: auto;
        background: #1b1c22; border: 1px solid #3a3a44; border-radius: 12px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.6); padding: 14px 16px;
        text-align: left;
      }
      .editor-panel .ed-modal-head {
        display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;
      }
      .editor-panel .ed-modal-head h4 { margin: 0; }
      .editor-panel .ed-modal-close {
        background: none; border: none; color: #bbb; font-size: 18px; cursor: pointer;
      }
      .editor-panel .ed-modal .ed-grid { grid-template-columns: 96px 1fr; }
      .editor-panel .ed-color-cell { display: flex; align-items: center; gap: 8px; justify-self: start; }
      .editor-panel .ed-color-cell input[type=color] { width: 44px; height: 26px; padding: 0; }
      .editor-panel .ed-full-label { display: block; color: #aab; margin: 6px 0 2px; }
      .editor-panel .ed-json {
        width: 100%; box-sizing: border-box; background: #15151a; color: #cfe;
        border: 1px solid #2a2a32; border-radius: 4px; padding: 6px;
        font: 12px ui-monospace, Menlo, Consolas, monospace; resize: vertical; margin-bottom: 6px;
      }
      .editor-panel #gltfUrl[hidden], .editor-panel #gltfUrlLabel[hidden] { display: none; }
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
      // State kommt aus dem JSON-Feld (frei editierbar); Höhe/Aufnehmbar bleiben
      // eigene Felder und überschreiben die entsprechenden Keys.
      let state
      try {
        state = this.editorForm.stateJson.value.trim() ? JSON.parse(this.editorForm.stateJson.value) : {}
      } catch (err) {
        this.setStatus('State-JSON ungültig: ' + err.message)
        return
      }
      if (typeof state !== 'object' || Array.isArray(state) || state === null) {
        this.setStatus('State muss ein JSON-Objekt sein')
        return
      }
      state.altitude_ref = this.editorForm.altitude_ref?.value === 'msl' ? 'msl' : 'ground'
      state.portable = !!this.editorForm.portable?.checked

      const data = {
        name: this.editorForm.name.value || `obj-${Date.now()}`,
        lat: parseFloat(this.editorForm.lat.value),
        lon: parseFloat(this.editorForm.lon.value),
        altitude: parseFloat(this.editorForm.altitude.value),
        appearance: this._appearanceFromForm(),
        state
      }
      const id = this.editorForm.objectId.value
      let obj
      try {
        obj = !id ? await this.ajna.createObject(data) : await this.ajna.updateObject(id, data)
      } catch (err) {
        this.setStatus('Speichern fehlgeschlagen: ' + (err?.response?.error || err?.message || err))
        return
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
      this._closeEditor()
      this.renderObjectList()
      this.setStatus('Objekt gelöscht')
    })

    this.ajna.onObjectsChanged(() => {
      this.renderObjectList()
    })

    // Auth-State auch dann nachziehen, wenn der Wechsel nicht via diese
    // Buttons passierte (z. B. ServerDialog → loginToServer).
    this.ajna.onAuthChanged(() => this.updateAuthUI())

    // Server-Liste-Änderungen (Add/Remove über ServerDialog) → Badges in
    // der Objekt-Liste auffrischen, damit Mehr-Server-Status sichtbar ist.
    if (typeof this.ajna.onServersChanged === 'function') {
      this.ajna.onServersChanged(() => this.renderObjectList())
    }

    if (this.manageServersBtn && this.onManageServers) {
      this.manageServersBtn.addEventListener('click', () => this.onManageServers())
    }

    if (this.manageGroupsBtn && this.onManageGroups) {
      this.manageGroupsBtn.addEventListener('click', () => this.onManageGroups())
    }

    if (this.manageProfileBtn && this.onManageProfile) {
      this.manageProfileBtn.addEventListener('click', () => this.onManageProfile())
    }

    if (this.manageFiltersBtn && this.onManageFilters) {
      this.manageFiltersBtn.addEventListener('click', () => this.onManageFilters())
    }

    if (this.focusPlayerBtn && this.onFocusPlayer) {
      this.focusPlayerBtn.addEventListener('click', () => this.onFocusPlayer())
    }

    if (this.arModeToggle && this.onToggleArMode) {
      // Initiale Stellung aus dem Host-Zustand (persistierter Wunsch).
      try { this.arModeToggle.checked = !!this.getArMode?.() } catch {}
      this.arModeToggle.addEventListener('change', async () => {
        const want = this.arModeToggle.checked
        try {
          await this.onToggleArMode(want)
        } catch (err) {
          this.arModeToggle.checked = !want   // Wechsel fehlgeschlagen → zurück
          this.setStatus(err?.message || 'AR-Moduswechsel fehlgeschlagen')
        }
      })
    }
  }

  updateAuthUI() {
    const loggedIn = this.ajna.isLoggedIn()
    const me = loggedIn ? this.ajna.currentUser() : null

    if (loggedIn) {
      this.loginBtn.style.display = 'none'
      this.logoutBtn.style.display = 'inline-block'
      // Email-Eingabe ausblenden, Benutzername anzeigen.
      this.emailInput.style.display = 'none'
      this.passwordInput.style.display = 'none'
      if (this.userDisplay) {
        this.userDisplay.style.display = ''
        this.userDisplay.textContent = me?.name || me?.username || me?.email || '(eingeloggt)'
      }
      // Editor ist jetzt ein Modal (öffnet on demand via fillEditor/startNewObjectAt).
    } else {
      this.loginBtn.style.display = 'inline-block'
      this.logoutBtn.style.display = 'none'
      this.emailInput.style.display = ''
      this.emailInput.disabled = false
      this.passwordInput.style.display = ''
      this.passwordInput.value = ''
      if (this.userDisplay) {
        this.userDisplay.style.display = 'none'
        this.userDisplay.textContent = ''
      }
      this._closeEditor?.()   // beim Logout ein offenes Editor-Modal schließen
    }
  }

  setStatus(text) {
    this.statusEl.innerText = text
  }

  /** Checkbox-Stellung des AR-Modus von außen setzen (Sync mit "Switch Camera"). */
  setArModeToggle(on) {
    if (this.arModeToggle) this.arModeToggle.checked = !!on
  }

  renderObjectList() {
    // Liste nach demselben Agent-Filter einschränken wie die Karten-/Szene-
    // Sicht — sonst zeigt der Editor Objekte, die ausgeblendet sind.
    const all = this.ajna.getObjectList()
    const objects = this.objectFilter ? all.filter(o => this.objectFilter(o)) : all
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
        // Badge-HTML wird selbst escaped (siehe ServerBadge.renderServerBadge);
        // der Name landet weiterhin via textContent, um Backend-Injection zu
        // vermeiden.
        row.innerHTML = `
          <div class="ed-object-info">
            <strong></strong>${renderServerBadge(this.ajna, obj._origin)}
            <span class="ed-object-meta"></span>
          </div>
          <button type="button" class="ed-btn ed-btn-sm">Laden</button>
        `
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

  // ── Objekt-Editor-Modal: Helfer ──────────────────────────────────────
  _allowExt() { try { return localStorage.getItem(EXT_MODELS_KEY) === '1' } catch { return false } }

  _populateModelSelect() {
    const sel = this.editorForm?.gltfSelect
    if (!sel) return
    sel.innerHTML = ''
    sel.appendChild(new Option('(kein Modell)', ''))
    for (const m of LOCAL_MODELS) sel.appendChild(new Option(m.replace(/\.glb$/i, ''), m))
    sel.appendChild(new Option('Externe URL…', '__url__'))
    if (this.editorForm.allowExtModels) this.editorForm.allowExtModels.checked = this._allowExt()
  }

  // Modell-Feld aus einem gltf-Wert füllen: lokales Modell → Dropdown, sonst
  // (externe URL / nicht-Standard-Pfad) → „Externe URL…" + URL-Feld.
  _setModelField(gltf) {
    const f = this.editorForm
    const file = gltf ? gltf.split(/[?#]/)[0].split('/').pop() : ''
    if (!gltf) { f.gltfSelect.value = ''; f.gltfUrl.value = '' }
    else if (LOCAL_MODELS.includes(file) && gltf === '/models/' + file) { f.gltfSelect.value = file; f.gltfUrl.value = '' }
    else { f.gltfSelect.value = '__url__'; f.gltfUrl.value = gltf }
    this._updateModelUrlVisibility()
  }

  // URL-Feld nur bei „Externe URL…" zeigen; Eingabe nur bei aktivem Toggle.
  _updateModelUrlVisibility() {
    const f = this.editorForm
    const isUrl = f.gltfSelect.value === '__url__'
    const allow = this._allowExt()
    const label = this.container.querySelector('#gltfUrlLabel')
    f.gltfUrl.hidden = !isUrl
    if (label) label.hidden = !isUrl
    f.gltfUrl.disabled = isUrl && !allow
    f.gltfUrl.placeholder = (isUrl && !allow)
      ? 'Externe URLs deaktiviert (Checkbox oben)'
      : 'https://…/modell.glb'
  }

  _wireEditorModal() {
    this.container.querySelector('#editorCloseBtn')?.addEventListener('click', () => this._closeEditor())
    this.editorOverlay?.addEventListener('click', (e) => { if (e.target === this.editorOverlay) this._closeEditor() })
    this.editorForm?.gltfSelect?.addEventListener('change', () => this._updateModelUrlVisibility())
    this.editorForm?.allowExtModels?.addEventListener('change', (e) => {
      try { localStorage.setItem(EXT_MODELS_KEY, e.target.checked ? '1' : '0') } catch {}
      this._updateModelUrlVisibility()
    })
  }

  _openEditor()  { if (this.editorOverlay) this.editorOverlay.hidden = false }
  _closeEditor() { if (this.editorOverlay) this.editorOverlay.hidden = true }

  // Baut das appearance-Objekt aus den Editor-Feldern (Merge mit dem Bestand,
  // damit shape/ar/… erhalten bleiben). Leere Felder entfernen den Schlüssel.
  _appearanceFromForm() {
    const f = this.editorForm
    const ap = { ...(this._editingAppearance || {}) }
    // 3D-Modell
    const sv = f.gltfSelect.value
    let gltf = ''
    if (sv === '__url__') gltf = this._allowExt() ? f.gltfUrl.value.trim() : ''
    else if (sv) gltf = '/models/' + sv
    if (gltf) ap.gltf = gltf; else delete ap.gltf
    // Symbol
    const emoji = (f.emoji.value || '').trim()
    if (emoji) ap.emoji = emoji; else delete ap.emoji
    // Farbe (nur wenn aktiviert)
    if (f.colorOn.checked) ap.color = f.color.value
    else delete ap.color
    return ap
  }

  fillEditor(obj) {
    this.onEditorActivate?.()
    const f = this.editorForm
    f.objectId.value = obj.id
    f.name.value = obj.name || ''
    f.lat.value = (obj.lat ?? 0).toFixed(6)
    f.lon.value = (obj.lon ?? 0).toFixed(6)
    f.altitude.value = (obj.altitude ?? 0).toFixed(2)
    f.altitude_ref.value = obj.state?.altitude_ref === 'msl' ? 'msl' : 'ground'
    if (f.portable) f.portable.checked = !!obj.state?.portable
    const ap = obj.appearance || {}
    f.emoji.value = typeof ap.emoji === 'string' ? ap.emoji : ''
    const hasColor = typeof ap.color === 'string' && ap.color
    f.colorOn.checked = !!hasColor
    f.color.value = hasColor ? ap.color : '#888888'
    this._setModelField(typeof ap.gltf === 'string' ? ap.gltf : '')
    f.stateJson.value = JSON.stringify(obj.state || {}, null, 2)   // voller State, editierbar
    this._editingAppearance = { ...ap }
    if (this.editorTitle) this.editorTitle.textContent = 'Objekt bearbeiten'
    this._openEditor()
  }

  /**
   * Bereitet den Editor für ein NEUES Objekt an gegebenen Koordinaten vor und
   * öffnet das Modal. objectId leer (Submit → createObject). Owner setzt der
   * Server. Neue Objekte bekommen eine Zufallsfarbe (untexturierte Modelle).
   */
  startNewObjectAt(lat, lon, altitude = 0) {
    this.onEditorActivate?.()
    if (!this.ajna.isLoggedIn()) { this.setStatus('Zum Anlegen bitte einloggen.'); return }
    const f = this.editorForm
    f.objectId.value = ''
    f.name.value = ''
    f.lat.value = lat.toFixed(6)
    f.lon.value = lon.toFixed(6)
    f.altitude.value = (altitude ?? 0).toFixed(2)
    f.altitude_ref.value = 'ground'
    if (f.portable) f.portable.checked = false
    f.emoji.value = ''
    f.colorOn.checked = true
    f.color.value = randomHexColor()
    this._setModelField('')
    f.stateJson.value = '{}'
    this._editingAppearance = {}
    if (this.editorTitle) this.editorTitle.textContent = 'Neues Objekt'
    this._openEditor()
    f.name.focus()
    this.setStatus(`Neues Objekt @ ${lat.toFixed(5)}, ${lon.toFixed(5)}`)
  }
}
