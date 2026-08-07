// Modal-Dialog für die Server-Verwaltung.
//
// Zwei Bereiche:
//   - "Bekannte Server": pro Eintrag Login/Logout, Connect/Disconnect,
//     Default-Stern, Umbenennen, Entfernen.
//   - "Server hinzufügen": Formular URL + Label.
//
// Visuell an GroupDialog/PermissionDialog angelehnt — gemeinsamer
// dunkler Stil mit eigenem CSS-Scope (Klassen-Präfix `ajna-sd-`).
//
// Die Dialog-Daten kommen ausschließlich aus AjnaManager.getServers();
// State-Änderungen (Login, Connect, Add, Remove) feuern via
// `onServersChanged` ein Re-Render. Kein eigenes State-Caching.
//
// Ausnahme: die Standort-Freigabe pro Server kommt aus PrivacyPolicy
// (gerätelokal, nicht vom Server) — sie steht hier, weil man sie beim Blick auf
// „welchen Servern bin ich verbunden?" bewertet, nicht in einem Extra-Dialog.

import { privacy } from './PrivacyPolicy.js'
import { infoHint, closeInfoHint } from './InfoHint.js'

export class ServerDialog {
  /**
   * @param {{ajna: import('./AjnaManager.js').AjnaManager}} opts
   */
  constructor({ ajna } = {}) {
    this.ajna = ajna
    this._backdrop = null
    this._status = ''
    this._statusKind = ''
    // serverId → 'pending'|'confirmed'|'unreachable' — Ergebnis der
    // Server-Verifikation (authRefresh), für genaue „eingeloggt"-Badges.
    this._verify = new Map()
    this._injectStyles()
    this._unsubServers = this.ajna.onServersChanged(() => {
      if (!this._backdrop) return
      // Debounce: Auth-/Server-Events kommen in Schüben (z. B. Token-Save nach
      // authRefresh) — pro Schub EIN Re-Render statt Render-Sturm.
      clearTimeout(this._renderT)
      this._renderT = setTimeout(() => { if (this._backdrop) this._render() }, 100)
    })
  }

  open() {
    if (this._backdrop) return
    this._verify.clear()   // pro Öffnen EINMAL frisch verifizieren (siehe _verifySessions)
    this._mount()
    this._render()
  }

  close() {
    // Das Popup hängt an document.body, nicht am Dialog — ohne das bliebe es
    // nach dem Schließen frei schwebend stehen.
    closeInfoHint()
    this._backdrop?.remove()
    this._backdrop = null
  }

  dispose() {
    this._privacyUnsub?.()
    this._privacyUnsub = null
    this.close()
    this._unsubServers?.()
  }

  // ===================================================================
  //  Layout
  // ===================================================================

  _mount() {
    const bd = document.createElement('div')
    bd.className = 'ajna-sd-backdrop'
    bd.addEventListener('click', ev => { if (ev.target === bd) this.close() })

    const dlg = document.createElement('div')
    dlg.className = 'ajna-sd-dialog'
    dlg.innerHTML = `
      <div class="sd-head">
        <h3>Server</h3>
        <button class="sd-close" title="Schließen">✕</button>
      </div>

      <div class="sd-status" data-role="status"></div>

      <h4>Bekannte Server</h4>
      <div class="sd-list" data-role="list"></div>

      <h4>Server hinzufügen</h4>
      <form class="sd-add-form" autocomplete="off">
        <input type="url"  name="url"   placeholder="http://server.example:8090" required>
        <input type="text" name="label" placeholder="Label (optional)">
        <button type="submit">Hinzufügen</button>
      </form>
    `
    dlg.querySelector('.sd-close').addEventListener('click', () => this.close())
    dlg.querySelector('.sd-add-form').addEventListener('submit', ev => this._handleAdd(ev))

    bd.appendChild(dlg)
    document.body.appendChild(bd)
    this._backdrop = bd
  }

  _setStatus(text, kind = '') {
    this._status = text
    this._statusKind = kind
    const el = this._backdrop?.querySelector('[data-role="status"]')
    if (el) {
      el.textContent = text
      el.className = `sd-status ${kind}`
    }
  }

  _render() {
    if (!this._backdrop) return
    // Ein Re-Render ersetzt die Zeilen samt ℹ️-Buttons — ein offenes Popup
    // gehörte danach zu einem Button, den es nicht mehr gibt.
    closeInfoHint()
    const list = this._backdrop.querySelector('[data-role="list"]')
    list.innerHTML = ''

    const servers = this.ajna.getServers()
    if (servers.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'sd-empty'
      empty.textContent = 'keine Server konfiguriert'
      list.appendChild(empty)
      return
    }

    for (const s of servers) list.appendChild(this._renderServerRow(s))

    // „eingeloggt"-Server gegen den Server verifizieren (authRefresh) und die
    // Badges nachziehen — sonst zeigt ein unerreichbarer Server fälschlich
    // „eingeloggt" (isLoggedIn ist nur ein lokaler Token-Check).
    this._verifySessions(servers)
  }

  // serverId → Badge-Container aktuell halten (ohne die ganze Zeile/Formulare
  // neu zu rendern, damit z. B. ein offenes Login-Feld erhalten bleibt).
  _fillBadges(badges, s) {
    badges.innerHTML = ''
    const add = (cls, text, title) => {
      const b = document.createElement('span')
      b.className = `sd-badge ${cls}`
      b.textContent = text
      if (title) b.title = title
      badges.appendChild(b)
    }
    if (s.isDefault) add('default', 'Standard', 'Standard-Server (Default für neue Objekte und Operationen).')
    if (s.isConnected) add('online', 'verbunden', 'Angemeldet und Realtime-Verbindung aktiv (Live-Updates).')
    if (s.isLoggedIn && !s.isConnected) {
      const v = this._verify.get(s.id)
      if (v === 'unreachable') {
        add('warn', 'Token (offline)', 'Lokales Token vorhanden, aber der Server hat es nicht bestätigt '
          + '(nicht erreichbar oder Timeout). Über „Verbinden" erneut versuchen.')
      } else if (v === 'confirmed') {
        add('idle', 'eingeloggt', 'Angemeldet — Token vom Server bestätigt, aber keine Realtime-Verbindung. '
          + '„Verbinden" baut sie auf.')
      } else {
        // undefined | 'pending' — lokal gültig, Server-Check läuft noch.
        add('idle', v === 'pending' ? 'eingeloggt …' : 'eingeloggt', 'Gültiges Token (lokal). '
          + 'Wird gegen den Server verifiziert …')
      }
    }
  }

  _verifySessions(servers) {
    for (const s of servers) {
      if (!(s.isLoggedIn && !s.isConnected)) continue   // nur die „eingeloggt"-Fälle
      // SCHLEIFENSCHUTZ: pro Dialog-Öffnung nur EINMAL je Server verifizieren.
      // Jedes _render() rief sonst erneut authRefresh → Token-Save → servers-
      // Changed → _render → … (Endlosschleife; open() leert _verify wieder).
      const v = this._verify.get(s.id)
      if (v === 'confirmed' || v === 'unreachable' || v === 'pending') continue
      this._verify.set(s.id, 'pending')
      this.ajna.verifyServerSession(s.id).then(status => {
        // 'revoked'/'logged-out' → Token weg; AjnaManager feuert onServersChanged
        // → _render() zieht alles neu (Login-Status hat sich geändert).
        if (status === 'revoked' || status === 'logged-out') { this._verify.delete(s.id); return }
        this._verify.set(s.id, status)        // 'confirmed' | 'unreachable'
        this._updateRowBadges(s)
      }).catch(() => {})
    }
  }

  _updateRowBadges(s) {
    const list = this._backdrop?.querySelector('[data-role="list"]')
    const row = list && Array.from(list.children).find(r => r.dataset?.serverId === s.id)
    if (row) this._fillBadges(row.querySelector('.sd-badges'), s)
  }

  _renderServerRow(s) {
    const row = document.createElement('div')
    row.className = 'sd-server-row'
    if (s.isDefault) row.classList.add('default')

    const userLabel = s.isLoggedIn
      ? (s.currentUser?.email || s.currentUser?.name || '(eingeloggt)')
      : '(ausgeloggt)'

    row.innerHTML = `
      <div class="sd-server-info">
        <div class="sd-server-head">
          <strong class="sd-label"></strong>
          <span class="sd-badges"></span>
        </div>
        <div class="sd-server-url"></div>
        <div class="sd-server-meta"></div>
        <div class="sd-privacy-row">
          <label>Standort:</label>
          <select class="sd-privacy">
            ${privacy.LEVELS.map(l => `<option value="${l}">${privacy.label(l)}</option>`).join('')}
          </select>
          <button class="sd-privacy-reset" title="Wieder dem Standard folgen">↺</button>
        </div>
      </div>
      <div class="sd-server-actions">
        <div class="sd-login-row" style="display:none">
          <input type="email"    class="sd-login-email"    placeholder="E-Mail">
          <input type="password" class="sd-login-password" placeholder="Passwort">
          <button class="sd-login-submit">OK</button>
          <button class="sd-login-cancel">Abbrechen</button>
        </div>
        <div class="sd-action-row">
          <button class="sd-login-toggle">${s.isLoggedIn ? 'Logout' : 'Login'}</button>
          <button class="sd-connect-toggle" ${s.isLoggedIn ? '' : 'disabled'}>${s.isConnected ? 'Trennen' : 'Verbinden'}</button>
          <button class="sd-set-default" ${s.isDefault ? 'disabled' : ''}>Als Standard</button>
          <button class="sd-rename">Umbenennen</button>
          <button class="sd-remove danger" ${s.isDefault ? 'disabled' : ''}>Entfernen</button>
        </div>
      </div>
    `
    row.querySelector('.sd-label').textContent = s.label
    row.querySelector('.sd-server-url').textContent = s.url
    row.querySelector('.sd-server-meta').textContent = `User: ${userLabel}`

    row.dataset.serverId = s.id
    this._fillBadges(row.querySelector('.sd-badges'), s)

    // Standort-Freigabe pro Server: man vertraut nicht jedem Server gleich viel.
    // Ohne eigene Wahl folgt die Zeile dem Profil-Standard; das ↺ nimmt eine
    // Übersteuerung wieder zurück.
    const privSelect = row.querySelector('.sd-privacy')
    const privReset = row.querySelector('.sd-privacy-reset')
    // Erklärung hinter dem ℹ️ statt als Dauertext: die Stufen brauchen ehrliche,
    // also lange Sätze — eingeblendet erschlagen sie die Server-Zeile.
    // Funktion statt fertigem Text: sie wird bei jedem Öffnen neu ausgewertet
    // und zeigt damit immer die GERADE gewählte Stufe.
    row.querySelector('.sd-privacy-row').appendChild(infoHint(() => {
      const lvl = privacy.levelFor(s.id)
      const prefix = privacy.hasOverride(s.id)
        ? `Eigene Einstellung für diesen Server.\n\n`
        : `Folgt dem Standard aus den Einstellungen (↺ ist nur bei einer eigenen Einstellung sichtbar).\n\n`
      return prefix + (privacy.LEVEL_INFO[lvl]?.hint || '')
    }, { title: () => `Standort-Freigabe: ${privacy.label(privacy.levelFor(s.id))}` }))
    const renderPriv = () => {
      const lvl = privacy.levelFor(s.id)
      privSelect.value = lvl
      privReset.style.visibility = privacy.hasOverride(s.id) ? 'visible' : 'hidden'
    }
    privSelect.addEventListener('change', () => { privacy.setLevel(s.id, privSelect.value); renderPriv() })
    privReset.addEventListener('click', () => { privacy.clearLevel(s.id); renderPriv() })
    this._privacyUnsub ||= privacy.onChange(() => { if (this._backdrop) this._render() })
    renderPriv()

    const loginRow = row.querySelector('.sd-login-row')
    const actionRow = row.querySelector('.sd-action-row')
    row.querySelector('.sd-login-toggle').addEventListener('click', () => {
      if (s.isLoggedIn) {
        this.ajna.logoutFromServer(s.id)
        this._setStatus(`Ausgeloggt: ${s.label}`)
      } else {
        loginRow.style.display = 'flex'
        actionRow.style.display = 'none'
        loginRow.querySelector('.sd-login-email').focus()
      }
    })
    row.querySelector('.sd-login-cancel').addEventListener('click', () => {
      loginRow.style.display = 'none'
      actionRow.style.display = 'flex'
    })
    row.querySelector('.sd-login-submit').addEventListener('click', async () => {
      const email = loginRow.querySelector('.sd-login-email').value.trim()
      const pw    = loginRow.querySelector('.sd-login-password').value
      if (!email || !pw) {
        this._setStatus('E-Mail und Passwort erforderlich', 'error')
        return
      }
      try {
        await this.ajna.loginToServer(s.id, email, pw)
        this._setStatus(`Eingeloggt: ${s.label}`)
        // Nach erfolgreichem Login direkt connecten — sonst sieht der
        // User keine Daten von diesem Server.
        try { await this.ajna.connectServer(s.id) }
        catch (err) {
          this._setStatus(`Login ok, Verbinden fehlgeschlagen: ${err?.message || err}`, 'error')
        }
      } catch (err) {
        this._setStatus(`Login fehlgeschlagen: ${err?.message || err}`, 'error')
      }
    })

    row.querySelector('.sd-connect-toggle').addEventListener('click', async () => {
      try {
        if (s.isConnected) {
          await this.ajna.disconnectServer(s.id)
          this._setStatus(`Getrennt: ${s.label}`)
        } else {
          await this.ajna.connectServer(s.id)
          this._setStatus(`Verbunden: ${s.label}`)
        }
      } catch (err) {
        this._setStatus(`Fehler: ${err?.message || err}`, 'error')
      }
    })

    row.querySelector('.sd-set-default').addEventListener('click', () => {
      try {
        this.ajna.setDefaultServer(s.id)
        this._setStatus(`Standard: ${s.label}`)
      } catch (err) {
        this._setStatus(err?.message || String(err), 'error')
      }
    })

    row.querySelector('.sd-rename').addEventListener('click', () => {
      const next = prompt('Neuer Server-Label:', s.label)
      if (next && next.trim()) {
        this.ajna.renameServer(s.id, next.trim())
        this._setStatus(`Umbenannt: ${next.trim()}`)
      }
    })

    row.querySelector('.sd-remove').addEventListener('click', async () => {
      if (!confirm(`Server "${s.label}" wirklich entfernen? Login-Token wird gelöscht.`)) return
      try {
        await this.ajna.removeServer(s.id)
        this._setStatus(`Entfernt: ${s.label}`)
      } catch (err) {
        this._setStatus(err?.message || String(err), 'error')
      }
    })

    return row
  }

  async _handleAdd(ev) {
    ev.preventDefault()
    const form = ev.currentTarget
    const url = form.url.value.trim()
    const label = form.label.value.trim() || url
    if (!url) return
    try {
      this.ajna.addServer(url, label)
      form.reset()
      this._setStatus(`Hinzugefügt: ${label}`)
    } catch (err) {
      this._setStatus(err?.message || String(err), 'error')
    }
  }

  // ===================================================================
  //  Styles
  // ===================================================================

  _injectStyles() {
    if (document.getElementById('ajnaServerDialogStyles')) return
    const style = document.createElement('style')
    style.id = 'ajnaServerDialogStyles'
    style.textContent = `
      .ajna-sd-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.55);
        z-index: 4100;
        display: flex; align-items: center; justify-content: center;
      }
      .ajna-sd-dialog {
        background: rgba(18,18,22,0.98);
        color: #eaeaea;
        border: 1px solid #3a3a44;
        border-radius: 8px;
        box-shadow: 0 12px 48px rgba(0,0,0,0.6);
        font: 12px ui-monospace, Menlo, Consolas, monospace;
        width: 680px;
        max-width: 92vw;
        max-height: 88vh;
        overflow: auto;
        padding: 16px 18px;
      }
      .ajna-sd-dialog .sd-head {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 12px;
      }
      .ajna-sd-dialog h3 {
        margin: 0;
        font-size: 13px; color: #f1c40f;
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      .ajna-sd-dialog h4 {
        margin: 14px 0 8px;
        font-size: 11px; color: #aab;
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      .ajna-sd-dialog .sd-close {
        background: transparent; color: #aab;
        border: 1px solid #3a3a44; border-radius: 4px;
        padding: 2px 8px; cursor: pointer;
      }
      .ajna-sd-dialog .sd-close:hover { color: #fff; }

      .ajna-sd-dialog .sd-status {
        min-height: 18px;
        font-size: 11px; color: #888; padding: 4px 0;
      }
      .ajna-sd-dialog .sd-status.error { color: #d05050; }

      .ajna-sd-dialog .sd-empty {
        font-size: 11px; color: #777; font-style: italic;
        padding: 6px 10px;
      }

      .ajna-sd-dialog .sd-server-row {
        background: #15151a;
        border-radius: 4px;
        padding: 10px 12px;
        margin-bottom: 8px;
        border-left: 3px solid #3a3a44;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 10px;
      }
      .ajna-sd-dialog .sd-server-row.default { border-left-color: #f1c40f; }

      .ajna-sd-dialog .sd-server-head {
        display: flex; align-items: center; gap: 8px;
        margin-bottom: 4px;
      }
      .ajna-sd-dialog .sd-label { font-size: 13px; color: #fff; }
      .ajna-sd-dialog .sd-server-url {
        font-size: 11px; color: #88a; word-break: break-all;
        margin-bottom: 2px;
      }
      .ajna-sd-dialog .sd-server-meta { font-size: 11px; color: #888; }
      .ajna-sd-dialog .sd-privacy-row {
        display: flex; align-items: center; gap: 6px; margin-top: 6px;
      }
      .ajna-sd-dialog .sd-privacy-row label { font-size: 11px; color: #888; }
      .ajna-sd-dialog .sd-privacy {
        background: #1a1a1a; color: #ddd; border: 1px solid #444;
        border-radius: 4px; padding: 2px 4px; font-size: 11px;
      }
      .ajna-sd-dialog .sd-privacy-reset {
        background: none; border: none; color: #888; cursor: pointer;
        font-size: 12px; padding: 0 4px;
      }
      .ajna-sd-dialog .sd-privacy-reset:hover { color: #ddd; }

      .ajna-sd-dialog .sd-badge {
        display: inline-block;
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 8px;
        border: 1px solid #3a3a44;
        color: #aab;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .ajna-sd-dialog .sd-badge.default { color: #f1c40f; border-color: #6a5520; }
      .ajna-sd-dialog .sd-badge.online  { color: #6fc8c8; border-color: #245959; }
      .ajna-sd-dialog .sd-badge.idle    { color: #c8a06f; border-color: #594224; }
      .ajna-sd-dialog .sd-badge.warn    { color: #e08a3c; border-color: #6a3f18; }

      .ajna-sd-dialog .sd-server-actions {
        min-width: 240px;
      }
      .ajna-sd-dialog .sd-action-row,
      .ajna-sd-dialog .sd-login-row {
        display: flex; flex-wrap: wrap; gap: 4px;
        justify-content: flex-end;
      }
      .ajna-sd-dialog .sd-action-row button,
      .ajna-sd-dialog .sd-login-row button {
        background: #2c5d8f; color: #fff;
        border: none; border-radius: 4px;
        padding: 4px 10px; cursor: pointer;
        font: inherit;
      }
      .ajna-sd-dialog .sd-action-row button:hover,
      .ajna-sd-dialog .sd-login-row button:hover { background: #356da6; }
      .ajna-sd-dialog .sd-action-row button:disabled,
      .ajna-sd-dialog .sd-login-row button:disabled {
        background: #2a2a30; color: #555; cursor: not-allowed;
      }
      .ajna-sd-dialog .sd-action-row button.danger { background: #8f3030; }
      .ajna-sd-dialog .sd-action-row button.danger:hover { background: #a64141; }

      .ajna-sd-dialog .sd-login-row input {
        flex: 1; min-width: 100px;
        background: #0e0e12; color: #eaeaea;
        border: 1px solid #3a3a44; border-radius: 4px;
        padding: 4px 8px; font: inherit;
      }

      .ajna-sd-dialog .sd-add-form {
        display: grid;
        grid-template-columns: 1.5fr 1fr auto;
        gap: 6px;
      }
      .ajna-sd-dialog .sd-add-form input {
        background: #0e0e12; color: #eaeaea;
        border: 1px solid #3a3a44; border-radius: 4px;
        padding: 6px 10px; font: inherit;
      }
      .ajna-sd-dialog .sd-add-form button {
        background: #2c8f5d; color: #fff;
        border: none; border-radius: 4px;
        padding: 6px 14px; cursor: pointer;
        font: inherit;
      }
      .ajna-sd-dialog .sd-add-form button:hover { background: #35a66d; }
    `
    document.head.appendChild(style)
  }
}
