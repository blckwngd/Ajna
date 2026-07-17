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
import { ProximityReporter } from './ProximityReporter.js'
import { privacy } from './PrivacyPolicy.js'
import { messageLog, CATS } from './MessageLog.js'
import { MessageLogPanel } from './MessageLogPanel.js'

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
    this._logPanel = null     // Chat-/Verlaufsfenster (schwebender Auslöser)
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
    // Chat-/Verlaufsfenster: schwebender Auslöser (💬) in jeder View. Der Verlauf
    // selbst ist persistent (MessageLog); hier nur die Ansicht.
    this._logPanel = new MessageLogPanel()
    // Debug-Protokoll in den Einstellungen live aus dem geteilten Store speisen
    // (so tauchen auch UWB-/Auto-Reconnect-Schritte dort auf).
    this._unsubs.push(
      this.ajna.onAuthChanged(() => this._renderSettings()),
      messageLog.onChange(() => this._refreshDebugLog())
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
    this.gps = hub.gps   // für den Echt/Dummy-GPS-Schalter in den Einstellungen
    hub.setPositionFallback(() => window.ajnaGeo?.position || null)

    // Interest-Area-Publisher (Opt-in, Default AUS): teilt einen UNSCHARFEN
    // Bereich, damit Agents Daten in der Nähe liefern. Schalter siehe Settings.
    this.interestArea = new InterestArea({
      ajna: this.ajna,
      positionSource: this.positionSource,   // Event-getriebenes Publishing
      getPosition: () => this.positionSource?.getWorldPosition?.() || window.ajnaGeo?.position || null,
      getSources: () => enabledSourcesFrom(window.agentFilters)
    })
    this.interestArea.start()
    window.ajnaInterestArea = this.interestArea   // Debug-Zugriff (Konsole + Karten-Overlay)
    // Manifeste aktuell halten (map.js setzt window.agentFilters) + neu publishen,
    // sobald die Quellen geladen sind — sonst ginge die Area ohne Quellen raus.
    window.agentFilters?.startAutoRefresh?.()
    window.agentFilters?.onChange?.(() => this.interestArea?.publishNow?.())
    this._unsubs.push(() => this.interestArea?.stop())

    // Stufe „Nähe": Anwesenheit an nahen Objekten melden — per Objekt-ID, nie
    // per Koordinate. Ob und an wen etwas rausgeht, entscheidet der Manager.
    this.proximityReporter = new ProximityReporter({
      ajna: this.ajna,
      positionSource: this.positionSource,
      getPosition: () => this.positionSource?.getWorldPosition?.() || window.ajnaGeo?.position || null
    })
    this.proximityReporter.start()
    window.ajnaProximity = this.proximityReporter   // Debug-Zugriff
    this._unsubs.push(() => this.proximityReporter?.stop())
    // Apply a persisted manual north-alignment offset (optional calibration).
    const align = parseFloat(localStorage.getItem(ALIGN_KEY) || '0')
    if (Number.isFinite(align)) this.wand.setAlignmentDeg(align)

    // Apply the persisted "run in background" preference — starts the foreground
    // service + persistent notification so the app stays usable with the screen off.
    if (MobileShell._bgServiceOn()) this.wand.setBackgroundService(true)

    this._unsubs.push(
      this.wand.onStatusChange((connected) => { this.wandConnected = connected; this._renderSettings(); this._refreshDeviceModal() }),
      this.wand.onPointingModeChange(() => { this._renderSettings(); this._refreshDeviceModal() }),
      this.wand.onOrientation((o) => {
        const el = document.querySelector('[data-role="wand-orientation"]')
        if (el) el.textContent =
          `Heading ${o.headingDeg.toFixed(0)}° · ${o.eff || o.mode || ''} · Genauigkeit ${o.acc ?? '?'}/3`
      }),
      this.uwb.onStatusChange((connected) => { this.uwbConnected = connected; this._renderSettings(); this._refreshDeviceModal() })
    )

    // Debug-Log: capture all wand + connection events for the collapsible viewer
    // (orientation is excluded — it's continuous and would flood the log).
    this._unsubs.push(
      // Skip raw 'gesture' — the wand already sends a readable "Geste: …" log line
      // (covers Button 1 too, which only emits effects). Other events stay raw.
      this.wand.on('*', (e) => { if (e?.type !== 'gesture') this._logEvent(this._fmtWandEvent(e)) }),
      // Readable diagnostic lines: gestures (wand) + voice ptt/STT (app-side).
      this.wand.onLog((line) => this._logEvent(line)),
      this.wand.onState((name) => this._logEvent('state → ' + name)),
      this.wand.onPointingModeChange((m) => this._logEvent('mode → ' + m)),
      this.wand.onInteraction((i) => this._logEvent(`interact ${i.action}${i.name ? ' → ' + i.name : ''}`)),
      this.wand.onStatusChange((c) => this._logEvent('Stab ' + (c ? 'verbunden' : 'getrennt'))),
      this.uwb.onStatusChange((c) => this._logEvent('UWB ' + (c ? 'verbunden' : 'getrennt'))),
      this.ajna.onAuthChanged((u) => this._logEvent(u ? `login ${u.email || ''}` : 'logout')),
      // Selection lock (Button 2): show a small popup with the locked object.
      // Secondary to the screen-off audio path — the wand+TTS flow needs no screen.
      this.wand.onLock((o) => { this._logEvent(o ? `lock → ${o.name || o.id}` : 'lock aufgehoben'); this._showSelectionPopup(o) })
    )
  }

  /** "Run in background" preference (persisted). */
  static _bgServiceOn() { try { return localStorage.getItem('ajna_bg_service') === '1' } catch { return false } }

  // Minimal "selected object" popup (body overlay, visible across tabs). The lock
  // itself + interactions work fully without it (screen-off via wand + TTS).
  _showSelectionPopup(o) {
    if (!o) { this._selPopup?.remove(); this._selPopup = null; return }
    if (!this._selPopup) {
      const el = document.createElement('div')
      el.style.cssText = 'position:fixed;left:50%;bottom:calc(var(--tabbar-height, 0px) + var(--safe-bottom, env(safe-area-inset-bottom, 0px)) + 16px);transform:translateX(-50%);z-index:6000;'
        + 'background:rgba(18,18,22,0.96);color:#eaeaea;border:1px solid #3a3a44;border-radius:10px;'
        + 'padding:8px 12px;font:13px ui-monospace,Menlo,Consolas,monospace;display:flex;gap:12px;'
        + 'align-items:center;box-shadow:0 8px 32px rgba(0,0,0,0.55)'
      const label = document.createElement('span'); label.dataset.role = 'sel-name'
      const x = document.createElement('button')
      x.textContent = '✕'
      x.style.cssText = 'background:none;border:1px solid #555;color:#eaeaea;border-radius:6px;cursor:pointer;padding:2px 9px'
      x.addEventListener('click', () => this.wand?.clearLock())
      el.append(label, x)
      document.body.appendChild(el)
      this._selPopup = el
    }
    this._selPopup.querySelector('[data-role="sel-name"]').textContent = '🔒 ' + (o.name || o.id)
  }

  _fmtWandEvent(e) {
    const d = e?.data || {}
    switch (e?.type) {
      case 'button':  return `button ${d.id}${d.long ? ' (lang)' : ''}`
      case 'tilt':    return `tilt ${d.dir}`
      case 'gesture': return `gesture ${d.name}`
      case 'effect':  return `effect ${d.domain}/${d.id}`
      default:        return `${e?.type} ${JSON.stringify(d)}`
    }
  }

  // Technische Events landen als 'debug' im geteilten Store; die onChange-
  // Subscription (init) frischt den <pre> auf.
  _logEvent(line) { messageLog.push(line, 'debug') }

  // Debug-<pre>: ALLE Kategorien, neueste zuerst (mit Uhrzeit + Icon).
  _debugLogText() {
    return messageLog.entries().slice().reverse()
      .map(e => `${new Date(e.t).toTimeString().slice(0, 8)}  ${CATS[e.cat]?.icon || ''} ${e.text}`)
      .join('\n')
  }
  _refreshDebugLog() {
    const el = document.querySelector('[data-role="debug-log"]')
    if (el) el.textContent = this._debugLogText()
  }

  destroy() {
    this._unsubs.forEach(fn => { try { fn() } catch {} })
    this._unsubs = []
    if (this._debugTimer) clearInterval(this._debugTimer)
    this._debugTimer = null
    this._selPopup?.remove(); this._selPopup = null
    this._logPanel?.destroy(); this._logPanel = null
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
  // work), carrying the login token + filter config so work continues there.
  //
  // Bevorzugt wird die im APK GEBÜNDELTE AR-Seite über einen lokalen Loopback-
  // Server (LocalServer-Plugin) an Chrome gegeben: http://localhost gilt als
  // secure context → WebXR funktioniert, und die aktuelle Web-App muss NICHT
  // erst auf den Server deployt werden. Die API/Auth bleibt der entfernte
  // Server (payload.base). Ohne lokalen Server (z. B. Desktop) Fallback auf den
  // Server-Deep-Link (lädt die Seite vom entfernten Server → Deploy nötig).
  async _openXrInChrome() {
    const meta = document.querySelector('[data-role="ar-hint"] .meta')
    const apiBase = this._arWebBase()   // entfernter Ajna-Server (API + Auth)
    if (!apiBase) {
      if (meta) meta.textContent =
        'Kein erreichbarer Server konfiguriert — bitte zuerst unter Einstellungen → Verwaltung → Server eintragen.'
      return
    }
    let pageBase = apiBase
    try {
      const { Capacitor, registerPlugin } = await import('@capacitor/core')
      if (Capacitor?.isNativePlatform?.()) {
        const LocalServer = registerPlugin('LocalServer')
        const { url } = await LocalServer.start()
        if (url) pageBase = url   // z. B. http://localhost:43219 (gebündelte Assets)
      }
    } catch (err) {
      console.warn('[xr] lokaler Server nicht verfügbar, nutze Server-Deploy:', err?.message || err)
    }
    const url = this._buildArDeepLink(pageBase, apiBase)
    if (!url) return
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

  // pageBase: von wo Chrome die SEITE lädt (lokaler Loopback-Server ODER der
  // entfernte Server). apiBase: das API-/Auth-Backend, das im Payload landet
  // (immer der ENTFERNTE Server — auch wenn die Seite von localhost kommt).
  _buildArDeepLink(pageBase = null, apiBase = null) {
    const base = apiBase || this._arWebBase()  // API-Backend (entfernt)
    if (!base) return null
    const page = pageBase || base               // wo die Seite ausgeliefert wird
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
    return `${page.replace(/\/+$/, '')}/index-ar.html#ajna=${b64url(JSON.stringify(payload))}`
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
    // AR-FOV-Kalibrierfaktor (per Gerät): vom AR-Client, sonst aus localStorage.
    const arFovFactor = window.arFovCalibration?.factor
      ?? (parseFloat(localStorage.getItem('ajna.ar.fov_factor')) || 1)
    const arNorth = (() => { try { return parseFloat(localStorage.getItem('ajna.ar.north_offset')) || 0 } catch { return 0 } })()
    const arFovSlider = (() => { try { return localStorage.getItem('ajna.ar.fov_slider') === '1' } catch { return false } })()
    const arCompass = (() => { try { return localStorage.getItem('ajna.ar.compass_indicator') !== '0' } catch { return true } })()
    const arAura = (() => { try { return localStorage.getItem('ajna.ar.aura') !== '0' } catch { return true } })()
    const arAuraRange = (() => { try { const v = parseFloat(localStorage.getItem('ajna.ar.aura_range')); return Number.isFinite(v) && v > 0 ? v : 100 } catch { return 100 } })()

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
        <label class="meta">Standort-Freigabe für neue Server</label>
        <select data-field="privacy-default" style="width:100%;margin-top:4px">
          ${privacy.LEVELS.map(l => `<option value="${l}" ${privacy.getDefault() === l ? 'selected' : ''}>${privacy.label(l)}</option>`).join('')}
        </select>
        <div class="meta" data-role="privacy-hint" style="margin-top:6px"></div>
        <div class="meta" data-role="privacy-overrides" style="margin-top:6px"></div>
        <button class="settings-btn secondary" data-action="privacy-apply-all" style="margin-top:6px">Auf alle Server anwenden</button>
        <div class="meta" style="margin-top:6px">
          Pro Server einstellbar unter „Server". Diese Einstellungen gelten nur auf diesem Gerät.
        </div>
      </section>

      <section class="settings-section">
        <h3>Audio</h3>
        <label class="meta" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" data-field="wand-audio" ${WandAudioFeedback.isEnabled() ? 'checked' : ''}>
          Audio-Hinweise (Name/Aktion vorlesen)
        </label>
      </section>

      <section class="settings-section">
        <h3>AR-Ansicht</h3>
        <label class="meta" style="display:flex;align-items:center;gap:10px">
          <span style="white-space:nowrap">Blickfeld (FOV)</span>
          <input type="range" data-field="ar-fov" min="0.5" max="2.0" step="0.02" value="${arFovFactor}" style="flex:1">
          <span class="meta" data-role="ar-fov-val" style="min-width:40px;text-align:right">${arFovFactor.toFixed(2)}×</span>
        </label>
        <div class="meta" style="margin-top:6px">
          Gleicht das Bodengitter an das Kamerabild an, falls es beim Neigen zu stark kippt.
          Hier justieren, oder unten den Live-Regler in der AR-Ansicht einschalten. Pro Gerät gespeichert.
        </div>
        <label class="meta" style="display:flex;align-items:center;gap:8px;margin-top:10px">
          <input type="checkbox" data-field="ar-fov-slider" ${arFovSlider ? 'checked' : ''}>
          FOV-Regler in der AR-Ansicht einblenden
        </label>
        <label class="meta" style="display:flex;align-items:center;gap:10px;margin-top:12px">
          <span style="white-space:nowrap">Nord-Offset (°)</span>
          <input type="number" data-field="ar-north" value="${arNorth}" step="1" style="width:80px">
          <button type="button" class="settings-btn-inline" data-action="ar-north-flip" style="width:auto;padding:2px 10px">↺ 180°</button>
        </label>
        <div class="meta" style="margin-top:6px">
          Falls Objekte im AR spiegelverkehrt liegen (Süd erscheint als Nord): auf 180 setzen (oder Button). Pro Gerät gespeichert.
        </div>
        <label class="meta" style="display:flex;align-items:center;gap:8px;margin-top:12px">
          <input type="checkbox" data-field="ar-compass" ${arCompass ? 'checked' : ''}>
          Kompass-Indikator im AR anzeigen
        </label>
        <div class="meta" style="margin-top:6px">
          Zeigt oben Heading + Kalibrier-Güte (Ampel). Grün+stabil, aber Welt verdreht → Nord-Offset;
          rot/zappelig → Kompass kalibrieren (Gerät in liegender 8 bewegen).
        </div>
        <label class="meta" style="display:flex;align-items:center;gap:8px;margin-top:12px">
          <input type="checkbox" data-field="ar-aura" ${arAura ? 'checked' : ''}>
          Objekt-Aura anzeigen (Call-Out beim Anvisieren)
        </label>
        <div class="meta" style="margin-top:6px">
          Zielst du mit dem Reticle auf ein Objekt, erscheint eine schwebende Info-Karte
          (Typ, Name, Eigentümer …). Aktionen bleiben im Tap-Menü.
        </div>
        <label class="meta" style="display:flex;align-items:center;gap:10px;margin-top:8px">
          <span style="white-space:nowrap">Reichweite</span>
          <input type="range" data-field="ar-aura-range" min="10" max="500" step="10" value="${arAuraRange}" style="flex:1">
          <span class="meta" data-role="ar-aura-range-val" style="min-width:46px;text-align:right">${arAuraRange} m</span>
        </label>
        <div class="meta" style="margin-top:6px">
          Nur Objekte innerhalb dieser Distanz zeigen einen Call-Out — kleiner = weniger visuelles Rauschen.
        </div>
      </section>

      <!-- Geräte: nur Verbinden + Status + Tür zu den geräte-spezifischen
           Einstellungen (alles, was nur mit verbundenem Gerät sinnvoll ist,
           liegt im jeweiligen Modal). -->
      <section class="settings-section">
        <h3>Geräte</h3>
        <div class="settings-row">
          <div class="label">
            <div>Zauberstab</div>
            <div class="meta" data-role="wand-status">${this.wandConnected ? 'verbunden' : 'nicht verbunden'}</div>
          </div>
          <button class="settings-btn-inline" data-action="wand-settings">Einstellungen</button>
        </div>
        <button class="settings-btn secondary" data-action="wand" style="margin-top:8px">
          ${this.wandConnected ? 'Zauberstab trennen' : 'Zauberstab verbinden'}
        </button>

        <div class="settings-row" style="margin-top:14px">
          <div class="label">
            <div>UWB</div>
            <div class="meta" data-role="uwb-status">${this.uwbConnected ? 'verbunden' : 'nicht verbunden'}</div>
          </div>
          <button class="settings-btn-inline" data-action="uwb-settings">Einstellungen</button>
        </div>
        <button class="settings-btn secondary" data-action="uwb" style="margin-top:8px">
          ${this.uwbConnected ? 'UWB trennen' : 'UWB verbinden'}
        </button>
      </section>

      <section class="settings-section">
        <h3>Hintergrund</h3>
        <label class="meta" style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" data-field="bg-service" ${MobileShell._bgServiceOn() ? 'checked' : ''}>
          App im Hintergrund ausführen (dauerhafte Benachrichtigung)
        </label>
        <div class="meta" style="margin-top:6px">
          Erzwingt den Hintergrunddienst, damit Stab-Verbindung, Sprachausgabe und
          Steuerung bei gesperrtem Bildschirm aktiv bleiben. Die Benachrichtigung
          zeigt den Verbindungszustand — auch ohne verbundenen Stab.
        </div>
      </section>

      <section class="settings-section">
        <h3>Standort</h3>
        <label class="meta" style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" data-field="real-gps" ${this.gps && !this.gps.isDummyMode() ? 'checked' : ''}>
          Echtes GPS verwenden (sonst Dummy-Position)
        </label>
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

      <section class="settings-section">
        <details>
          <summary>Debug-Log (Events)</summary>
          <div style="display:flex;justify-content:flex-end;margin:6px 0">
            <button class="settings-btn secondary" data-action="debug-log-clear" style="width:auto;padding:2px 10px">Leeren</button>
          </div>
          <pre data-role="debug-log" style="max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:11px ui-monospace,Menlo,Consolas,monospace;background:rgba(0,0,0,0.25);padding:8px;border-radius:6px;margin:0">${escapeHtml(this._debugLogText())}</pre>
        </details>
      </section>
    `

    this._wireSettingsEvents(root)
    this._updateDebugInfo()
  }

  // ── Geräte-Einstellungs-Modals (Bottom-Sheet) ─────────────────────────
  // Kapselt die geräte-spezifischen Einstellungen/Aktionen hinter einem Fenster,
  // damit die Einstellungs-Seite schlank bleibt. Verbinden bleibt in den Settings.

  _injectModalStyles() {
    if (document.getElementById('deviceModalStyles')) return
    const s = document.createElement('style')
    s.id = 'deviceModalStyles'
    s.textContent = `
      .device-modal-overlay { position:fixed; inset:0; z-index:2000;
        background:rgba(0,0,0,0.6); display:flex; align-items:flex-end; justify-content:center; }
      .device-modal { width:100%; max-width:560px; max-height:88vh; background:var(--bg,#0f1115);
        color:var(--fg,#eaeaea); border:1px solid var(--border,#2a2f37); border-bottom:none;
        border-top-left-radius:14px; border-top-right-radius:14px; display:flex; flex-direction:column;
        box-shadow:0 -8px 40px rgba(0,0,0,0.6); padding-bottom:env(safe-area-inset-bottom,0px); }
      .device-modal-header { display:flex; align-items:center; justify-content:space-between;
        padding:14px 16px; border-bottom:1px solid var(--border,#2a2f37); }
      .device-modal-header h3 { margin:0; font-size:15px; }
      .device-modal-close { background:transparent; border:none; color:var(--fg-muted,#8a8f99);
        font-size:26px; line-height:1; cursor:pointer; padding:0 4px; }
      .device-modal-body { padding:14px 16px; overflow-y:auto; }`
    document.head.appendChild(s)
  }

  _openDeviceModal(title, contentHtml, wireFn) {
    this._injectModalStyles()
    document.getElementById('deviceModal')?.remove()
    const overlay = document.createElement('div')
    overlay.id = 'deviceModal'
    overlay.className = 'device-modal-overlay'
    overlay.innerHTML = `
      <div class="device-modal" role="dialog" aria-modal="true">
        <header class="device-modal-header">
          <h3>${escapeHtml(title)}</h3>
          <button class="device-modal-close" aria-label="Schließen">×</button>
        </header>
        <div class="device-modal-body">${contentHtml}</div>
      </div>`
    const close = () => { this._deviceModalOpen = null; overlay.remove() }
    overlay.querySelector('.device-modal-close').addEventListener('click', close)
    overlay.addEventListener('click', e => { if (e.target === overlay) close() })
    document.body.appendChild(overlay)
    try { wireFn?.(overlay) } catch (e) { console.warn('[mobile] modal wire', e) }
    return overlay
  }

  _openWandModal() { this._deviceModalOpen = 'wand'; this._openDeviceModal('Zauberstab', this._wandSettingsHtml(), r => this._wireWandModal(r)) }
  _openUwbModal()  { this._deviceModalOpen = 'uwb';  this._openDeviceModal('UWB',        this._uwbSettingsHtml(),  r => this._wireUwbModal(r)) }

  // Bei Geräte-Statuswechsel (verbunden/getrennt) das offene Gerätefenster mit
  // frischem Zustand neu aufbauen, damit verbindungsabhängige Steuerungen
  // korrekt aktiviert/deaktiviert sind.
  _refreshDeviceModal() {
    if (!document.getElementById('deviceModal')) return
    if (this._deviceModalOpen === 'wand') this._openWandModal()
    else if (this._deviceModalOpen === 'uwb') this._openUwbModal()
  }

  _wandSettingsHtml() {
    return `
      <section class="settings-section">
        <div class="meta" style="margin-bottom:10px">${this.wandConnected ? 'verbunden' : 'nicht verbunden — verbindungsabhängige Aktionen sind deaktiviert'}</div>
        <label class="meta" style="display:block">Zeige-Modus
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
        <label class="meta" style="display:block;margin-top:10px">Licht-Effekt (läuft bis „Aus")
          <select class="settings-input" data-field="wand-effect" style="margin-top:4px" ${this.wandConnected ? '' : 'disabled'}>
            <option value="0">Aus</option>
            <option value="1">Rune</option>
            <option value="2">Taschenlampe (Stroboskop)</option>
            <option value="3">Strip: Grün</option>
            <option value="4">Strip: Blau</option>
            <option value="5">Strip: Regenbogen</option>
            <option value="6">Strip: Sparkle</option>
            <option value="7">Strip: Comet</option>
            <option value="8">Strip: Pulsieren</option>
            <option value="10">Stroboskop (alle LEDs, grell)</option>
            <option value="11">Scheinwerfer (alle LEDs, konstant)</option>
          </select>
        </label>
        <label class="meta" style="display:flex;align-items:center;gap:8px;margin-top:10px">
          <input type="checkbox" data-field="wand-audio-debug" ${WandAudioFeedback.isDebugEnabled() ? 'checked' : ''}>
          Debug-Ansagen (Zustände &amp; Events vorlesen)
        </label>
        <label class="meta" style="display:block;margin-top:8px">Nord-Ausrichtung (°)
          <input class="settings-input" data-field="wand-align" type="number" step="1"
                 value="${parseFloat(localStorage.getItem(ALIGN_KEY) || '0')}" style="margin-top:4px">
          <span class="meta">Feinkorrektur zusätzlich zur Auto-Deklination</span>
        </label>
        <div class="meta" data-role="wand-orientation" style="margin-top:8px">
          ${this.wandConnected ? 'Orientierung: —' : 'Orientierung: (Stab nicht verbunden)'}
        </div>
      </section>`
  }

  _uwbSettingsHtml() {
    const showAnchors = (() => { try { return localStorage.getItem('ajna.debug.show_uwb_anchors') === '1' } catch { return false } })()
    const autoConnect = UwbManager.autoConnectEnabled()
    const devices = this.uwb?.rememberedDevices?.() || []
    const devHtml = devices.length
      ? devices.map(d => `
          <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
            <span class="meta" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              ${escapeHtml(d.name || d.role)} <span style="opacity:.55">· ${escapeHtml(d.address || '?')}</span>
            </span>
            <button class="settings-btn-inline" data-action="uwb-forget" data-role="${escapeHtml(d.role)}" style="width:auto;padding:2px 8px">vergessen</button>
          </div>`).join('')
      : '<div class="meta" style="opacity:.6;margin-top:4px">Noch kein Gerät gemerkt – einmal „UWB verbinden".</div>'
    return `
      <section class="settings-section">
        <div class="meta" style="margin-bottom:10px">${this.uwbConnected ? 'verbunden' : 'nicht verbunden'}</div>
        <label class="meta" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" data-field="uwb-autoconnect" ${autoConnect ? 'checked' : ''}>
          Bekanntes Gerät beim Start automatisch verbinden
        </label>
        <div class="meta" style="margin-top:8px;font-weight:600">Bekannte Geräte</div>
        ${devHtml}
        <hr style="border:none;border-top:1px solid rgba(128,128,128,.25);margin:12px 0">
        <label class="meta" style="display:block">UWB-Modell
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
        <label class="meta" style="display:flex;align-items:center;gap:8px;margin-top:8px">
          <input type="checkbox" data-field="uwb-anchors-show" ${showAnchors ? 'checked' : ''}>
          Anker anzeigen (3D-Marker mit Höhe + Karte, Debug)
        </label>
        <button class="settings-btn secondary" data-action="uwb-net-share" style="width:100%;margin-top:6px">Netz teilen (Rechte)</button>
        <details style="margin-top:8px">
          <summary class="meta">Neues UWB-Netz veröffentlichen</summary>
          <input class="settings-input" data-field="uwb-net-name" placeholder="Name (z. B. Wohnzimmer)" style="margin-top:6px">
          <input class="settings-input" data-field="uwb-net-pan" placeholder="PANS-Netz-ID (aus DRTLS, z. B. 0x89AB)" style="margin-top:6px">
          <button class="settings-btn secondary" data-action="uwb-net-create" style="margin-top:6px;width:100%">Netz anlegen &amp; teilen</button>
        </details>
        <div class="meta" data-role="uwb-net-status" style="margin-top:6px"></div>
      </section>`
  }

  // Verbindungsabhängige Stab-Aktionen im Modal verdrahten.
  _wireWandModal(root) {
    const modeSel = root.querySelector('[data-field="pointing-mode"]')
    if (modeSel) {
      if (this.wand?.pointingMode) modeSel.value = this.wand.pointingMode
      modeSel.addEventListener('change', () => this.wand?.setPointingMode(modeSel.value))
    }
    const effSel = root.querySelector('[data-field="wand-effect"]')
    effSel?.addEventListener('change', () => {
      const id = parseInt(effSel.value, 10)
      if (Number.isFinite(id)) this.wand?.sendCommand({ cmd: 'light', id })
    })
    root.querySelector('[data-action="wand-calibrate"]')?.addEventListener('click', () => {
      this.wand?.calibrate('staff')
      const el = root.querySelector('[data-role="wand-orientation"]')
      if (el) el.textContent = 'Kalibriere … Stab senkrecht halten'
    })
    const audioDebugToggle = root.querySelector('[data-field="wand-audio-debug"]')
    audioDebugToggle?.addEventListener('change', () => {
      const on = audioDebugToggle.checked
      WandAudioFeedback.setDebugEnabled(on)
      const statusEl = root.querySelector('[data-role="wand-orientation"]')
      if (!on) return
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

  // UWB-Konfiguration/Aktionen im Modal verdrahten.
  _wireUwbModal(root) {
    // Auto-Reconnect an/aus (Default an) + gemerkte Geräte vergessen.
    const autoToggle = root.querySelector('[data-field="uwb-autoconnect"]')
    autoToggle?.addEventListener('change', () => UwbManager.setAutoConnect(autoToggle.checked))
    root.querySelectorAll('[data-action="uwb-forget"]').forEach(btn =>
      btn.addEventListener('click', () => {
        this.uwb?.forgetDevice(btn.dataset.role || 'viewer')
        this._refreshDeviceModal()
      }))

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
  }

  _wireSettingsEvents(root) {
    const action = sel => root.querySelector(`[data-action="${sel}"]`)

    action('debug-log-clear')?.addEventListener('click', () => messageLog.clear())

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
    action('wand-settings')?.addEventListener('click', () => this._openWandModal())
    action('uwb-settings')?.addEventListener('click', () => this._openUwbModal())

    const audioToggle = root.querySelector('[data-field="wand-audio"]')
    audioToggle?.addEventListener('change', () => WandAudioFeedback.setEnabled(audioToggle.checked))

    // AR-FOV-Kalibrierung: live über den AR-Client anwenden (falls initialisiert),
    // sonst nur persistieren, damit es beim nächsten AR-Start greift.
    const fovSlider = root.querySelector('[data-field="ar-fov"]')
    const fovVal = root.querySelector('[data-role="ar-fov-val"]')
    fovSlider?.addEventListener('input', () => {
      const f = parseFloat(fovSlider.value)
      if (!Number.isFinite(f)) return
      if (fovVal) fovVal.textContent = f.toFixed(2) + '×'
      if (window.arFovCalibration?.setFactor) window.arFovCalibration.setFactor(f)
      else { try { localStorage.setItem('ajna.ar.fov_factor', String(f)) } catch {} }
    })

    // Live-FOV-Regler in AR ein-/ausblenden (Default aus → saubere AR-Ansicht).
    const fovSliderToggle = root.querySelector('[data-field="ar-fov-slider"]')
    fovSliderToggle?.addEventListener('change', () => {
      const on = fovSliderToggle.checked
      try { localStorage.setItem('ajna.ar.fov_slider', on ? '1' : '0') } catch {}
      if (window.arFovCalibration?.setSliderVisible) window.arFovCalibration.setSliderVisible(on)
      else window.dispatchEvent(new CustomEvent('ajna:ar-fov-slider', { detail: on }))
    })

    // Kompass-Kalibrier-/Drift-Indikator in AR ein-/ausblenden (Default an).
    const compassToggle = root.querySelector('[data-field="ar-compass"]')
    compassToggle?.addEventListener('change', () => {
      const on = compassToggle.checked
      try { localStorage.setItem('ajna.ar.compass_indicator', on ? '1' : '0') } catch {}
      if (window.arCompass?.setVisible) window.arCompass.setVisible(on)
      else window.dispatchEvent(new CustomEvent('ajna:ar-compass', { detail: on }))
    })

    // Objekt-Aura (Call-Out) in AR ein-/ausblenden (Default an).
    const auraToggle = root.querySelector('[data-field="ar-aura"]')
    auraToggle?.addEventListener('change', () => {
      const on = auraToggle.checked
      try { localStorage.setItem('ajna.ar.aura', on ? '1' : '0') } catch {}
      if (window.arAura?.setVisible) window.arAura.setVisible(on)
      else window.dispatchEvent(new CustomEvent('ajna:ar-aura', { detail: on }))
    })

    // Callout-Reichweite (Meter) — steuert das visuelle Rauschen der Umgebung.
    const auraRange = root.querySelector('[data-field="ar-aura-range"]')
    const auraRangeVal = root.querySelector('[data-role="ar-aura-range-val"]')
    auraRange?.addEventListener('input', () => {
      const v = parseInt(auraRange.value, 10)
      if (!Number.isFinite(v)) return
      if (auraRangeVal) auraRangeVal.textContent = v + ' m'
      try { localStorage.setItem('ajna.ar.aura_range', String(v)) } catch {}
      window.dispatchEvent(new CustomEvent('ajna:ar-aura-range', { detail: v }))
    })

    // AR-Nord-Offset: korrigiert einen Kompass↔Daten-Heading-Versatz (z. B. 180°).
    const northInput = root.querySelector('[data-field="ar-north"]')
    const applyNorth = (deg) => {
      const d = ((Math.round(Number(deg) || 0) % 360) + 360) % 360
      if (northInput) northInput.value = d
      try { localStorage.setItem('ajna.ar.north_offset', String(d)) } catch {}
      window.dispatchEvent(new CustomEvent('ajna:ar-north', { detail: d }))
    }
    northInput?.addEventListener('change', () => applyNorth(northInput.value))
    root.querySelector('[data-action="ar-north-flip"]')?.addEventListener('click', () => applyNorth((parseFloat(northInput?.value) || 0) + 180))

    // Privatsphäre: Default für NEUE Server + „auf alle anwenden". Die Anzeige
    // nennt offen, wie viele Server abweichen — sonst wirkt der Default wie eine
    // Zusage, die er nicht ist (bestehende Übersteuerungen bleiben unberührt).
    const privSelect = root.querySelector('[data-field="privacy-default"]')
    const privHint = root.querySelector('[data-role="privacy-hint"]')
    const privOverrides = root.querySelector('[data-role="privacy-overrides"]')
    const renderPrivacy = () => {
      const lvl = privSelect?.value || privacy.getDefault()
      if (privHint) privHint.textContent = privacy.LEVEL_INFO[lvl]?.hint || ''
      const ids = (this.ajna?.getServers?.() || []).map(s => s.id)
      const n = ids.filter(id => privacy.hasOverride(id)).length
      if (privOverrides) {
        privOverrides.textContent = n
          ? `${n} Server ${n === 1 ? 'hat eine eigene' : 'haben eigene'} Einstellung — der Standard ändert daran nichts.`
          : 'Alle Server folgen diesem Standard.'
      }
    }
    privSelect?.addEventListener('change', () => {
      privacy.setDefault(privSelect.value)
      renderPrivacy()
    })
    root.querySelector('[data-action="privacy-apply-all"]')?.addEventListener('click', () => {
      const lvl = privSelect?.value || privacy.getDefault()
      const ids = (this.ajna?.getServers?.() || []).map(s => s.id)
      if (!confirm(`„${privacy.label(lvl)}" für ALLE ${ids.length} Server setzen und eigene Einstellungen verwerfen?`)) return
      privacy.applyToAll(lvl, ids)
      renderPrivacy()
    })
    renderPrivacy()

    const bgToggle = root.querySelector('[data-field="bg-service"]')
    bgToggle?.addEventListener('change', () => {
      const on = bgToggle.checked
      try { localStorage.setItem('ajna_bg_service', on ? '1' : '0') } catch {}
      this.wand?.setBackgroundService(on)
    })

    // Echtes GPS ↔ Dummy. An: Dummy aus (echtes GPS). Aus: Dummy an, an der
    // aktuellen Position eingefroren (kein Sprung auf eine Default-Koordinate).
    const realGpsToggle = root.querySelector('[data-field="real-gps"]')
    realGpsToggle?.addEventListener('change', () => {
      if (!this.gps) return
      if (realGpsToggle.checked) {
        this.gps.enableDummyMode(false)
      } else {
        const p = this.positionSource?.getWorldPosition?.() || this.gps.data
        if (p && Number.isFinite(p.lat)) this.gps.setDummyPosition(p.lat, p.lon, p.altitude || 0)
        this.gps.enableDummyMode(true)
      }
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

    // Anker-Debug-Anzeige (3D + Karte) umschalten → Overlay & Karte hören auf das Event.
    const anchorsShow = root.querySelector('[data-field="uwb-anchors-show"]')
    anchorsShow?.addEventListener('change', () => {
      const on = anchorsShow.checked
      try { localStorage.setItem('ajna.debug.show_uwb_anchors', on ? '1' : '0') } catch {}
      window.dispatchEvent(new CustomEvent('ajna:uwb-anchors', { detail: on }))
    })
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
      // Gemerktes Gerät → direkt per Adresse (kein Scan), sonst per Name suchen.
      const dev = this.uwb.rememberedDevice?.('viewer')
      await this.uwb.connect(dev?.address
        ? { role: 'viewer', address: dev.address, name: dev.name || 'DW' }
        : { role: 'viewer', name: 'DW' })
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
