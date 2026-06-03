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
  }

  init() {
    this._wireTabs()
    this._renderSettings()
    this._unsubs.push(
      this.ajna.onAuthChanged(() => this._renderSettings())
    )
    // Wenn die Filter-Manifeste sich aendern (z. B. neuer Agent), kann der
    // Settings-Tab das spaeter anzeigen — heute noch nicht ausgewertet.
    this._debugTimer = setInterval(() => this._updateDebugInfo(), 2000)
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
        <h3>Geräte</h3>
        <button class="settings-btn secondary" data-action="ble-stub">Bluetooth-Geräte</button>
        <div class="meta" style="margin-top:6px">Kopplung &amp; Verwaltung kommen in Phase C.</div>
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

    action('ble-stub')?.addEventListener('click', () => {
      alert('Bluetooth-Geräte-Verwaltung: kommt in Phase C (BLE-Plugin).')
    })
  }

  _updateDebugInfo() {
    const root = document.getElementById('mobileSettings')
    if (!root) return

    const gpsEl = root.querySelector('[data-role="debug-gps"]')
    if (gpsEl) {
      const p = window.ajnaGeo?.position || window.ajnaGeo?.getPosition?.()
      if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
        gpsEl.textContent = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`
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
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
