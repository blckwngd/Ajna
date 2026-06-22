// Bottom-Tab-Bar + Tab-Views fuer die Mobile-/Capacitor-Variante.
//
// Strategie: keine Duplikation von map.js' Logik. Diese Shell setzt nur die
// Container-DOM-Struktur (drei Tabs: Karte, AR, Einstellungen) und delegiert:
//   • Map-Tab: enthaelt das #map-Element. map.bundle.js initialisiert Leaflet
//     dort wie immer; die Shell ruft beim Tab-Wechsel `invalidateSize()` auf,
//     damit Leaflet nach Sichtbarwerden korrekt nachrechnet.
//   • AR-Tab: Stub fuer Phase B (Capacitor-Background-Geolocation/BLE).
//   • Einstellungen-Tab: Login-Form + Buttons fuer die in map.js angelegten
//     Dialog-Instanzen (window.ajnaUI). Damit lebt der bestehende EditorUI-
//     Sidebar nur noch versteckt im DOM, seine Funktionen sind im Tab erreichbar.

import { getAccessoryHub } from './AccessoryHub.js'
import { WandManager } from './WandManager.js'
import { UwbManager } from './UwbManager.js'
import { WandAudioFeedback } from './WandAudioFeedback.js'
import { PermissionDialog } from './PermissionDialog.js'
import { InterestArea } from './InterestArea.js'

// Eingeblendete Agent-Quellen (für den Interest-Area-Publish): alles, was im
// Agent-Filter nicht explizit deaktiviert ist.
function enabledSourcesFrom(filters) {
  if (!filters?.getSources) return []
  return filters.getSources().map(s => s.source).filter(src => {
    const sel = filters.getSelection(src)
    return sel === undefined || (Array.isArray(sel) && sel.length > 0)
  })
}

const ALIGN_KEY = 'ajna_wand_alignment'  // persisted manual north-alignment offset (deg)
const UWB_NET_KEY = 'ajna_uwb_network'   // persisted active PANS network id

const TAB_DEFS = [
  { id: 'map',      icon: '🗺️', label: 'Karte' },
  { id: 'ar',       icon: '🥽', label: 'AR' },
  { id: 'settings', icon: '⚙️', label: 'Einstellungen' }
]

export class MobileShell {
  /**
   * @param {object} opts
   * @param {import('./AjnaManager.js').AjnaManager} opts.ajna
   * @param {() => object | null} opts.getUI  Liefert die in map.js angelegten Dialoge.
   */
  constructor({ ajna, getUI } = {}) {
    this.ajna = ajna
    this.getUI = getUI
    this.activeTab = 'map'
    this._unsubs = []
    this._debugTimer = null
    this.wand = null          // shared WandManager (from AccessoryHub)
    this.wandConnected = false
    this.uwb = null           // shared UwbManager (from AccessoryHub)
    this.uwbConnected = false
    this._arLoaded = false    // AR (Babylon) bundle injected lazily on first open
    this._xrSupported = undefined  // immersive WebXR available in THIS context?
    this._arPreview = false    // user chose the in-app 3D preview despite no XR
  }

  init() {
    this._wireTabs()
    this._wireAccessories()
    this._wireArHint()
    this._renderSettings()
    this._unsubs.push(
      this.ajna.onAuthChanged(() => this._renderSettings())
    )
    // Wenn die Filter-Manifeste sich aendern (z. B. neuer Agent), kann der
    // Settings-Tab das spaeter anzeigen — heute noch nicht ausgewertet.
    this._debugTimer = setInterval(() => this._updateDebugInfo(), 2000)
  }

  // Shared wand/UWB/audio live in the AccessoryHub (one instance per page, even
  // across bundles). We grab the refs once and attach our UI listeners here.
  _wireAccessories() {
    const hub = getAccessoryHub({ ajna: this.ajna })
    this.wand = hub.wand
    this.uwb = hub.uwb
    this.wandAudio = hub.audio
    this.positionSource = hub.positionSource
    hub.setPositionFallback(() => window.ajnaGeo?.position || null)

    // Interest-Area-Publisher (Opt-in, Default AUS): teilt einen UNSCHARFEN
    // Bereich, damit Agents Daten in der Nähe liefern. Schalter siehe Settings.
    this.interestArea = new InterestArea({
      ajna: this.ajna,
      getPosition: () => this.positionSource?.getWorldPosition?.() || window.ajnaGeo?.position || null,
      getSources: () => enabledSourcesFrom(window.agentFilters)
    })
    this.interestArea.start()
    this._unsubs.push(() => this.interestArea?.stop())

    // Apply a persisted manual north-alignment offset (optional calibration).
    const align = parseFloat(localStorage.getItem(ALIGN_KEY) || '0')
    if (Number.isFinite(align)) this.wand.setAlignmentDeg(align)

    this._unsubs.push(
      this.wand.onStatusChange((connected) => { this.wandConnected = connected; this._renderSettings() }),
      this.wand.onPointingModeChange(() => this._renderSettings()),
      this.wand.onOrientation((o) => {
        const el = document.querySelector('[data-role="wand-orientation"]')
        if (el) el.textContent =
          `Heading ${o.headingDeg.toFixed(0)}° · ${o.eff || o.mode || ''} · Genauigkeit ${o.acc ?? '?'}/3`
      }),
      this.uwb.onStatusChange((connected) => { this.uwbConnected = connected; this._renderSettings() })
    )
  }

  destroy() {
    this._unsubs.forEach(fn => { try { fn() } catch {} })
    this._unsubs = []
    if (this._debugTimer) clearInterval(this._debugTimer)
    this._debugTimer = null
  }

  // ───────────────────────────────────────────────────────────────────

  _wireTabs() {
    const tabs = document.querySelectorAll('.shell-tabbar button[data-tab]')
    const views = document.querySelectorAll('.shell-view[data-view]')
    tabs.forEach(btn => {
      btn.addEventListener('click', () => this.switchTo(btn.dataset.tab))
    })
    // Initial-Sichtbarkeit konsolidieren (HTML hatte die map-Tab schon aktiv,
    // aber bei Hot-Reload-Stand koennte das verschoben sein).
    tabs.forEach(b => b.classList.toggle('active', b.dataset.tab === this.activeTab))
    views.forEach(v => v.classList.toggle('active', v.dataset.view === this.activeTab))
  }

  switchTo(tabId) {
    if (!TAB_DEFS.find(t => t.id === tabId)) return
    this.activeTab = tabId
    document.querySelectorAll('.shell-tabbar button[data-tab]').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tabId)
    )
    document.querySelectorAll('.shell-view[data-view]').forEach(v =>
      v.classList.toggle('active', v.dataset.view === tabId)
    )
    // Leaflet zeichnet falsche Tiles, wenn die Map waehrend Display:none
    // initialisiert wurde oder die Groesse sich geaendert hat. invalidateSize
    // ist der dokumentierte Fix.
    if (tabId === 'map' && window.map?.invalidateSize) {
      requestAnimationFrame(() => window.map.invalidateSize())
    }

    // AR-View: nur wenn immersives WebXR hier unterstützt wird (Headset/Quest-
    // Browser/Android XR), die Babylon-Szene direkt im Tab laden. Sonst Hinweis
    // „in Chrome öffnen". Render-Loop nur aktiv, solange der AR-Tab offen ist.
    if (tabId === 'ar') {
      this._onArTab()
    } else {
      window.arPause?.()
    }
  }

  async _onArTab() {
    const root = document.querySelector('.shell-view[data-view="ar"]')
    const hint = root?.querySelector('[data-role="ar-hint"]')
    if (this._xrSupported === undefined) this._xrSupported = await xrSupported()

    if (this._xrSupported || this._arPreview) {
      if (hint) hint.hidden = true
      this._ensureAr()
      requestAnimationFrame(() => window.arResume?.())
    } else {
      // No immersive XR in this WebView → offer to continue in Chrome.
      if (hint) hint.hidden = false
    }
  }

  _wireArHint() {
    const root = document.querySelector('.shell-view[data-view="ar"]')
    if (!root) return
    root.querySelector('[data-action="ar-open-chrome"]')
      ?.addEventListener('click', () => this._openXrInChrome())
    root.querySelector('[data-action="ar-preview"]')
      ?.addEventListener('click', () => {
        this._arPreview = true
        const hint = root.querySelector('[data-role="ar-hint"]')
        if (hint) hint.hidden = true
        this._ensureAr()
        requestAnimationFrame(() => window.arResume?.())
      })
  }

  // Open the AR page in the external browser (Chrome, where WebXR + ARCore
  // work), carrying the login token + filter config so work continues
  // seamlessly there (same-origin with the backend via Caddy).
  _openXrInChrome() {
    const url = this._buildArDeepLink()
    const meta = document.querySelector('[data-role="ar-hint"] .meta')
    if (!url) {
      if (meta) meta.textContent =
        'Kein erreichbarer Server konfiguriert — bitte zuerst unter Einstellungen → Verwaltung → Server eintragen.'
      return
    }
    window.open(url, '_blank')
  }

  _arWebBase() {
    // The Chrome page must be served by the backend (same-origin → API + WebXR).
    const isLocal = (u) => !u || /localhost|127\.0\.0\.1|capacitor/i.test(u)
    const servers = this.ajna?.getServers?.() || []
    const real = servers.map(s => s.url).find(u => !isLocal(u))
    if (real) return real
    const def = this.ajna?.defaultClient?.url
    return isLocal(def) ? null : def
  }

  _buildArDeepLink() {
    const base = this._arWebBase()  // which backend serves index-ar.html (same-origin)
    if (!base) return null
    // Carry the ENTIRE multi-server setup verbatim so EVERY connected server
    // stays logged in in Chrome: the server registry + each server's PocketBase
    // auth blob (`ajna_auth_<id>`). Copying the raw localStorage strings avoids
    // any coupling to PB's auth format.
    const auth = {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('ajna_auth_')) auth[k] = localStorage.getItem(k)
    }
    const payload = {
      v: 2,
      base,
      registry: localStorage.getItem('ajna.servers.v1') || '',
      auth,
      filters: localStorage.getItem('ajna.layer_filters') || '',
      align: localStorage.getItem(ALIGN_KEY) || ''
    }
    return `${base.replace(/\/+$/, '')}/index-ar.html#ajna=${b64url(JSON.stringify(payload))}`
  }

  // Inject the AR (Babylon) bundle once, the first time it is needed. It renders
  // into #renderCanvas / #ui already present in the shell HTML and reuses the
  // shared window.ajna / hub (see main.js).
  _ensureAr() {
    if (this._arLoaded) return
    this._arLoaded = true
    const loading = document.querySelector('[data-role="ar-loading"]')
    if (loading) loading.hidden = false
    const s = document.createElement('script')
    s.src = '/dist/ar.bundle.js'
    s.onload = () => { if (loading) loading.remove() }
    s.onerror = () => {
      this._arLoaded = false
      if (loading) loading.textContent = 'AR-Bundle konnte nicht geladen werden'
    }
    document.body.appendChild(s)
  }

  // ───────────────────────────────────────────────────────────────────

  _renderSettings() {
    const root = document.getElementById('mobileSettings')
    if (!root) return
    const user = this.ajna.currentUser()
    const loggedIn = !!user
    const displayName = user?.username || user?.email || user?.id || ''

    root.innerHTML = `
      <section class="settings-section">
        <h3>Zugang</h3>
        ${loggedIn ? `
          <div class="settings-row">
            <div class="label">
              <div>${escapeHtml(displayName)}</div>
              <div class="meta">eingeloggt</div>
            </div>
            <button class="settings-btn-inline" data-action="logout">Logout</button>
          </div>
        ` : `
          <input class="settings-input" data-field="email"
                 type="email" inputmode="email" autocapitalize="off"
                 autocomplete="email" placeholder="E-Mail">
          <input class="settings-input" data-field="password"
                 type="password" autocomplete="current-password" placeholder="Passwort">
          <button class="settings-btn" data-action="login">Login</button>
          <div class="meta" data-role="login-status" style="margin-top:6px"></div>
        `}
      </section>

      <section class="settings-section">
        <h3>Verwaltung</h3>
        <button class="settings-btn secondary" data-action="server">Server</button>
        <button class="settings-btn secondary" data-action="profile" ${loggedIn ? '' : 'disabled'}>Profil</button>
        <button class="settings-btn secondary" data-action="filter" ${loggedIn ? '' : 'disabled'}>Inhaltsfilter</button>
      </section>

      <section class="settings-section">
        <h3>Privatsphäre</h3>
        <label class="meta" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" data-field="share-location" ${InterestArea.isEnabled() ? 'checked' : ''}>
          Ungefähren Standort für Inhalte in der Nähe teilen
        </label>
        <div class="meta" style="margin-top:6px">
          Sendet nur einen unscharfen Bereich (~500 m). Aus = es wird nichts übermittelt.
        </div>
      </section>

      <section class="settings-section">
        <h3>Geräte</h3>
        <button class="settings-btn secondary" data-action="wand">
          ${this.wandConnected ? 'Zauberstab trennen' : 'Zauberstab verbinden'}
        </button>
        <div class="meta" data-role="wand-status" style="margin-top:6px">
          ${this.wandConnected ? 'verbunden' : 'nicht verbunden'}
        </div>

        <!-- Stab-Konfiguration: immer sichtbar. Verbindungsabhängige Aktionen
             (Modus an den Stab senden, kalibrieren) sind getrennt deaktiviert. -->
        <label class="meta" style="display:block;margin-top:10px">Zeige-Modus
          <select class="settings-input" data-field="pointing-mode" style="margin-top:4px" ${this.wandConnected ? '' : 'disabled'}>
            <option value="auto">Automatisch</option>
            <option value="pointer">Zeigestock</option>
            <option value="walkingstick">Wanderstab</option>
            <option value="disabled">Deaktiviert (Stromsparen)</option>
          </select>
        </label>
        <button class="settings-btn secondary" data-action="wand-calibrate" style="margin-top:8px" ${this.wandConnected ? '' : 'disabled'}>
          Stab kalibrieren (senkrecht halten)
        </button>
        <label class="meta" style="display:flex;align-items:center;gap:8px;margin-top:8px">
          <input type="checkbox" data-field="wand-audio" ${WandAudioFeedback.isEnabled() ? 'checked' : ''}>
          Audio-Hinweise (Name/Aktion vorlesen)
        </label>
        <label class="meta" style="display:flex;align-items:center;gap:8px;margin-top:6px">
          <input type="checkbox" data-field="wand-audio-debug" ${WandAudioFeedback.isDebugEnabled() ? 'checked' : ''}>
          Debug-Ansagen (Zustände &amp; Events vorlesen)
        </label>
        <label class="meta" style="display:block;margin-top:8px">Nord-Ausrichtung (°)
          <input class="settings-input" data-field="wand-align" type="number" step="1"
                 value="${parseFloat(localStorage.getItem(ALIGN_KEY) || '0')}" style="margin-top:4px">
          <span class="meta">Feinkorrektur zusätzlich zur Auto-Deklination</span>
        </label>
        <div class="meta" data-role="wand-orientation" style="margin-top:6px">
          ${this.wandConnected ? 'Orientierung: —' : 'Orientierung: (Stab nicht verbunden)'}
        </div>
        <button class="settings-btn secondary" data-action="uwb" style="margin-top:10px">
          ${this.uwbConnected ? 'UWB trennen' : 'UWB verbinden'}
        </button>
        <div class="meta" data-role="uwb-status" style="margin-top:6px">
          ${this.uwbConnected ? 'verbunden' : 'nicht verbunden'}
        </div>
        <label class="meta" style="display:block;margin-top:8px">UWB-Modell
          <select class="settings-input" data-field="uwb-model" style="margin-top:4px">
            <option value="onboard">A – Onboard-Engine</option>
            <option value="ranging">B – Eigene Multilateration</option>
          </select>
        </label>

        <label class="meta" style="display:block;margin-top:10px">UWB-Netz
          <select class="settings-input" data-field="uwb-network" style="margin-top:4px">
            <option value="">Alle Anker</option>
          </select>
        </label>
        <div class="meta" data-role="uwb-network-pan" style="margin-top:4px"></div>
        <div style="display:flex;gap:6px;align-items:center;margin-top:6px">
          <input class="settings-input" data-field="uwb-anchor-node" type="text" inputmode="numeric" placeholder="Node-ID" style="width:96px">
          <button class="settings-btn secondary" data-action="uwb-anchor-add" style="flex:1">Anker hier anlegen</button>
        </div>
        <button class="settings-btn secondary" data-action="uwb-net-share" style="width:100%;margin-top:6px">Netz teilen (Rechte)</button>
        <details style="margin-top:8px">
          <summary class="meta">Neues UWB-Netz veröffentlichen</summary>
          <input class="settings-input" data-field="uwb-net-name" placeholder="Name (z. B. Wohnzimmer)" style="margin-top:6px">
          <input class="settings-input" data-field="uwb-net-pan" placeholder="PANS-Netz-ID (aus DRTLS, z. B. 0x89AB)" style="margin-top:6px">
          <button class="settings-btn secondary" data-action="uwb-net-create" style="margin-top:6px;width:100%">Netz anlegen &amp; teilen</button>
        </details>
        <div class="meta" data-role="uwb-net-status" style="margin-top:6px"></div>
      </section>

      <section class="settings-section">
        <h3>Debug</h3>
        <div class="settings-row">
          <div class="label">GPS</div>
          <div class="meta" data-role="debug-gps">—</div>
        </div>
        <div class="settings-row">
          <div class="label">Server</div>
          <div class="meta" data-role="debug-backend">—</div>
        </div>
        <div class="settings-row">
          <div class="label">Objekte</div>
          <div class="meta" data-role="debug-objects">—</div>
        </div>
        <div class="settings-row">
          <div class="label">UWB</div>
          <div class="meta" data-role="debug-uwb">—</div>
        </div>
      </section>
    `

    this._wireSettingsEvents(root)
    this._updateDebugInfo()
  }

  _wireSettingsEvents(root) {
    const action = sel => root.querySelector(`[data-action="${sel}"]`)

    action('login')?.addEventListener('click', async () => {
      const email = root.querySelector('[data-field="email"]')?.value?.trim() || ''
      const pwd = root.querySelector('[data-field="password"]')?.value || ''
      const status = root.querySelector('[data-role="login-status"]')
      if (!email || !pwd) {
        if (status) status.textContent = 'E-Mail und Passwort erforderlich'
        return
      }
      if (status) status.textContent = 'Login läuft…'
      try {
        await this.ajna.login(email, pwd)
        // _renderSettings wird ueber onAuthChanged neu gerendert.
      } catch (err) {
        if (status) status.textContent = err?.message || 'Login fehlgeschlagen'
      }
    })

    action('logout')?.addEventListener('click', () => {
      try { this.ajna.logout() } catch {}
    })

    const openDialog = (key) => {
      const ui = this.getUI?.() || {}
      const dlg = ui[key]
      if (!dlg?.open) {
        console.warn(`[mobile] Dialog "${key}" nicht verfuegbar`)
        return
      }
      dlg.open()
    }
    action('server') ?.addEventListener('click', () => openDialog('serverDialog'))
    action('profile')?.addEventListener('click', () => openDialog('profileDialog'))
    action('filter') ?.addEventListener('click', () => openDialog('filterDialog'))

    action('wand')?.addEventListener('click', () => this._toggleWand(root))
    action('uwb')?.addEventListener('click', () => this._toggleUwb(root))

    // Wand config (only present while connected).
    const modeSel = root.querySelector('[data-field="pointing-mode"]')
    if (modeSel) {
      if (this.wand?.pointingMode) modeSel.value = this.wand.pointingMode
      modeSel.addEventListener('change', () => this.wand?.setPointingMode(modeSel.value))
    }
    action('wand-calibrate')?.addEventListener('click', () => {
      this.wand?.calibrate('staff')
      const el = root.querySelector('[data-role="wand-orientation"]')
      if (el) el.textContent = 'Kalibriere … Stab senkrecht halten'
    })
    const audioToggle = root.querySelector('[data-field="wand-audio"]')
    audioToggle?.addEventListener('change', () => WandAudioFeedback.setEnabled(audioToggle.checked))

    const shareToggle = root.querySelector('[data-field="share-location"]')
    shareToggle?.addEventListener('change', () => this.interestArea?.onToggle(shareToggle.checked))

    const uwbModelSel = root.querySelector('[data-field="uwb-model"]')
    if (uwbModelSel) {
      uwbModelSel.value = this.uwb?.model || (localStorage.getItem('ajna_uwb_model') === 'ranging' ? 'ranging' : 'onboard')
      uwbModelSel.addEventListener('change', () => {
        const m = uwbModelSel.value
        try { localStorage.setItem('ajna_uwb_model', m) } catch {}
        this.uwb?.setMode(m)
      })
    }

    this._wireUwbNetwork(root)

    const audioDebugToggle = root.querySelector('[data-field="wand-audio-debug"]')
    audioDebugToggle?.addEventListener('change', () => {
      const on = audioDebugToggle.checked
      WandAudioFeedback.setDebugEnabled(on)
      const statusEl = root.querySelector('[data-role="wand-orientation"]')
      if (!on) return
      // Audible smoke test (runs on this user gesture, regardless of the other
      // gates) so it's obvious whether TTS works in this WebView at all.
      if (!WandAudioFeedback.ttsAvailable()) {
        console.warn('[mobile] Web Speech TTS not available in this WebView')
        if (statusEl) statusEl.textContent = 'TTS in dieser WebView nicht verfügbar (natives TTS nötig)'
        return
      }
      this.wandAudio?.speak('Audio-Debugging aktiviert')
      if (statusEl) statusEl.textContent = 'Audio-Test gesendet — hörst du „Audio-Debugging aktiviert"?'
    })

    const alignInput = root.querySelector('[data-field="wand-align"]')
    alignInput?.addEventListener('change', () => {
      const v = parseFloat(alignInput.value)
      if (!Number.isFinite(v)) return
      this.wand?.setAlignmentDeg(v)
      try { localStorage.setItem(ALIGN_KEY, String(v)) } catch {}
    })
  }

  // ── UWB network (shared PANS network published as an Ajna object) ──────

  _wireUwbNetwork(root) {
    const sel = root.querySelector('[data-field="uwb-network"]')
    const statusEl = root.querySelector('[data-role="uwb-net-status"]')
    const setStatus = (t) => { if (statusEl) statusEl.textContent = t || '' }
    if (!sel) return

    this._populateUwbNetworkSelect(root)   // options + active value + PAN display

    // The change listener is on the <select> element, so repopulating its
    // <option>s later (after create) does NOT drop it — no rebind needed.
    sel.addEventListener('change', () => {
      const id = sel.value || null
      this.uwb?.setNetwork(id)
      try { id ? localStorage.setItem(UWB_NET_KEY, id) : localStorage.removeItem(UWB_NET_KEY) } catch {}
      this._populateUwbNetworkSelect(root)
      setStatus('')
    })

    root.querySelector('[data-action="uwb-net-share"]')?.addEventListener('click', () => this._shareUwbNetwork(setStatus))
    root.querySelector('[data-action="uwb-anchor-add"]')?.addEventListener('click', () => this._addUwbAnchor(root, setStatus))
    root.querySelector('[data-action="uwb-net-create"]')?.addEventListener('click', () => this._createUwbNetwork(root, setStatus))
  }

  // Refresh only the network <select> + PAN display in place (keeps the status
  // line and the <select>'s change listener — used after create/select so a
  // full _renderSettings() doesn't wipe the message the user just got).
  _populateUwbNetworkSelect(root) {
    const sel = root.querySelector('[data-field="uwb-network"]')
    const panEl = root.querySelector('[data-role="uwb-network-pan"]')
    if (!sel) return
    const active = this.uwb?.network || ''
    const nets = this.uwb?.getNetworks?.() || []
    sel.innerHTML = '<option value="">Alle Anker</option>' +
      nets.map(n => `<option value="${escapeHtml(n.networkId)}">${escapeHtml(n.name)}</option>`).join('')
    sel.value = active
    const n = nets.find(x => x.networkId === (this.uwb?.network || null))
    if (panEl) panEl.textContent = n ? `PANS-Netz-ID: ${n.networkId} — diese ID in DRTLS für weitere Anker verwenden` : ''
  }

  _activeNetworkObj() {
    const id = this.uwb?.network
    if (!id) return null
    return (this.uwb?.getNetworks?.() || []).find(n => n.networkId === id)?.obj || null
  }

  async _shareUwbNetwork(setStatus) {
    const obj = this._activeNetworkObj()
    if (!obj) { setStatus('Erst ein Netz auswählen (nicht „Alle Anker")'); return }
    // Reuse the standard object permission dialog → grant others view (use) /
    // edit (add nodes) on this network object.
    try {
      this._permDialog = this._permDialog || new PermissionDialog({ ajna: this.ajna })
      await this._permDialog.open(obj)
    } catch (e) { setStatus(e?.message || 'Teilen fehlgeschlagen') }
  }

  async _createUwbNetwork(root, setStatus) {
    if (!this.ajna?.currentUser?.()) { setStatus('Zum Anlegen bitte einloggen'); return }
    const name = root.querySelector('[data-field="uwb-net-name"]')?.value?.trim()
    const pan = root.querySelector('[data-field="uwb-net-pan"]')?.value?.trim()
    if (!pan) { setStatus('PANS-Netz-ID erforderlich (aus der DRTLS-App)'); return }
    const pos = this.positionSource?.getWorldPosition?.() || window.ajnaGeo?.position || null
    try {
      setStatus('Lege Netz an …')
      const obj = await this.ajna.createObject({
        name: name || `UWB-Netz ${pan}`,
        type: 'uwb_network',
        lat: pos?.lat ?? 0, lon: pos?.lon ?? 0, altitude: pos?.altitude ?? 0,
        state: { uwb_network: { networkId: pan } }
      })
      // Publish: every logged-in user may SEE it; the owner grants edit via "Netz teilen".
      let shareWarn = ''
      try { await this.ajna.addPermission(obj.id, { subject_type: 'authenticated', rights: ['view'], interact_actions: [] }) }
      catch (e) { console.warn('[mobile] Netz-Freigabe fehlgeschlagen', e?.message || e); shareWarn = ' (Freigabe fehlgeschlagen)' }
      this.uwb?.refreshNetworks()
      this.uwb?.setNetwork(pan)
      try { localStorage.setItem(UWB_NET_KEY, pan) } catch {}
      // Refresh the select in place (NOT a full _renderSettings, which would wipe this status).
      this._populateUwbNetworkSelect(root)
      setStatus(`Netz angelegt${shareWarn}. „Netz teilen" öffnet die Rechte (edit = Anker beitragen).`)
    } catch (e) { setStatus(e?.message || 'Anlegen fehlgeschlagen') }
  }

  async _addUwbAnchor(root, setStatus) {
    if (!this.ajna?.currentUser?.()) { setStatus('Zum Anlegen bitte einloggen'); return }
    const netId = this.uwb?.network
    if (!netId) { setStatus('Erst ein Netz auswählen, dann den Anker beitragen'); return }
    const pos = this.positionSource?.getWorldPosition?.() || window.ajnaGeo?.position || null
    if (!pos || !Number.isFinite(pos.lat)) { setStatus('Keine Position — Anker braucht seinen genauen Standort'); return }
    // Node-ID may be entered decimal or hex (0x…, as DRTLS shows it). Reject
    // empty/NaN explicitly — Number('') is 0 and would silently create "Anker 0".
    const raw = root.querySelector('[data-field="uwb-anchor-node"]')?.value?.trim()
    if (!raw) { setStatus('Node-ID erforderlich (uint16, aus DRTLS)'); return }
    const nodeId = /^0x[0-9a-f]+$/i.test(raw) ? parseInt(raw, 16) : parseInt(raw, 10)
    if (!Number.isInteger(nodeId) || nodeId < 0 || nodeId > 0xFFFF) { setStatus('Ungültige Node-ID (0…65535)'); return }
    try {
      setStatus('Lege Anker an …')
      const obj = await this.ajna.createObject({
        name: `UWB-Anker ${nodeId}`,
        type: 'uwb_anchor',
        lat: pos.lat, lon: pos.lon, altitude: pos.altitude || 0,
        state: { uwb: { nodeId, network: netId } }
      })
      let shareWarn = ''
      try { await this.ajna.addPermission(obj.id, { subject_type: 'authenticated', rights: ['view'], interact_actions: [] }) }
      catch (e) { console.warn('[mobile] Anker-Freigabe fehlgeschlagen', e?.message || e); shareWarn = ' (Freigabe fehlgeschlagen)' }
      this.uwb?.refreshAnchors()
      setStatus(`Anker ${nodeId} an aktueller Position angelegt (Netz ${netId})${shareWarn}.`)
    } catch (e) { setStatus(e?.message || 'Anker anlegen fehlgeschlagen') }
  }

  async _toggleUwb(root) {
    const statusEl = root.querySelector('[data-role="uwb-status"]')
    const setStatus = (t) => { if (statusEl) statusEl.textContent = t }
    if (!(await UwbManager.isAvailable())) { setStatus('Nur in der App (Capacitor) verfügbar'); return }
    if (this.uwbConnected) { await this.uwb.disconnect('viewer'); this.uwbConnected = false; this._renderSettings(); return }
    try {
      setStatus('Verbinde …')
      await this.uwb.connect({ role: 'viewer', name: 'DW' })
    } catch (err) {
      setStatus(err?.message || 'Verbindung fehlgeschlagen')
    }
  }

  async _toggleWand(root) {
    const statusEl = root.querySelector('[data-role="wand-status"]')
    const setStatus = (t) => { if (statusEl) statusEl.textContent = t }
    if (!(await WandManager.isAvailable())) { setStatus('Nur in der App (Capacitor) verfügbar'); return }
    if (this.wandConnected) { await this.wand.stop(); this.wandConnected = false; this._renderSettings(); return }
    try {
      setStatus('Verbinde …')
      await this.wand.start({ name: 'WizardStaff' })
    } catch (err) {
      setStatus(err?.message || 'Verbindung fehlgeschlagen')
    }
  }

  _updateDebugInfo() {
    const root = document.getElementById('mobileSettings')
    if (!root) return

    const gpsEl = root.querySelector('[data-role="debug-gps"]')
    if (gpsEl) {
      // Shared fused position (UWB-or-GPS); shows the live source.
      const p = this.positionSource?.getWorldPosition?.()
      if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
        const src = this.positionSource?.activeSource ? ` (${this.positionSource.activeSource})` : ''
        gpsEl.textContent = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}${src}`
      } else {
        gpsEl.textContent = '—'
      }
    }

    const beEl = root.querySelector('[data-role="debug-backend"]')
    if (beEl) {
      const servers = this.ajna.getServers?.() ?? []
      const connected = servers.filter(s => s.isConnected).length
      beEl.textContent = `${connected}/${servers.length} verbunden`
    }

    const objEl = root.querySelector('[data-role="debug-objects"]')
    if (objEl) {
      const count = this.ajna.getObjects?.()?.length ?? 0
      objEl.textContent = String(count)
    }

    const uwbEl = root.querySelector('[data-role="debug-uwb"]')
    if (uwbEl) {
      const p = this.uwb?.position
      if (p && Number.isFinite(p.lat)) {
        const q = Number.isFinite(p.quality) ? ` · q${p.quality}` : ''
        uwbEl.textContent = `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}${q}`
      } else {
        uwbEl.textContent = this.uwbConnected ? 'verbunden (kein Fix)' : '—'
      }
    }
  }
}

// Is an immersive WebXR session available in THIS context? True on headsets /
// the Quest browser / Android XR / desktop Chrome with a headset; false in the
// Android System WebView (no WebXR).
async function xrSupported() {
  try {
    if (!navigator.xr?.isSessionSupported) return false
    if (await navigator.xr.isSessionSupported('immersive-ar')) return true
    if (await navigator.xr.isSessionSupported('immersive-vr')) return true
    return false
  } catch { return false }
}

// URL-safe base64 of a UTF-8 string (for the handoff fragment).
function b64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
