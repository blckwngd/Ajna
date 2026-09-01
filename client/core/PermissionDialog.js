// Modal-Dialog für Objekt-Berechtigungen.
// Liest und schreibt ACEs gegen das PocketBase-Backend über AjnaManager.

import { injectServerBadgeStyles, renderServerBadge } from './ServerBadge.js'
import { t } from './i18n.js'
import { klickDaneben } from './klickDaneben.js'

const ALL_RIGHTS = ['view', 'edit', 'move', 'owner']
const IMPLICIT_AUDIENCES = new Set(['authenticated', 'anonymous', 'everyone'])

export class PermissionDialog {
  /**
   * @param {{ajna: import('./AjnaManager.js').AjnaManager}} opts
   */
  constructor({ ajna } = {}) {
    this.ajna = ajna
    this._injectStyles()
    injectServerBadgeStyles()
  }

  _injectStyles() {
    if (document.getElementById('ajnaPermissionDialogStyles')) return
    const style = document.createElement('style')
    style.id = 'ajnaPermissionDialogStyles'
    style.textContent = `
      .ajna-perm-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.55);
        z-index: 4000;
        display: flex; align-items: center; justify-content: center;
      }
      .ajna-perm-dialog {
        background: rgba(18,18,22,0.98);
        color: #eaeaea;
        border: 1px solid #3a3a44;
        border-radius: 8px;
        box-shadow: 0 12px 48px rgba(0,0,0,0.6);
        font: 12px ui-monospace, Menlo, Consolas, monospace;
        width: 560px;
        max-width: 92vw;
        max-height: 88vh;
        overflow: auto;
        padding: 16px 18px;
      }
      .ajna-perm-dialog h3 {
        margin: 0 0 4px;
        font-size: 13px;
        color: #f1c40f;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .ajna-perm-dialog .pd-sub {
        font-size: 11px; color: #888; margin-bottom: 12px;
      }
      .ajna-perm-dialog h4 {
        margin: 14px 0 6px;
        font-size: 11px; color: #aab;
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      .ajna-perm-dialog .pd-status {
        font-size: 11px; color: #888; padding: 8px;
      }
      .ajna-perm-dialog .pd-status.error { color: #d05050; }
      .ajna-perm-dialog .pd-ace {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 12px;
        align-items: center;
        padding: 8px 10px;
        background: #15151a;
        border-radius: 4px;
        margin-bottom: 4px;
        border-left: 3px solid #3a3a44;
      }
      .ajna-perm-dialog .pd-ace.implicit { border-left-color: #6e8db5; }
      .ajna-perm-dialog .pd-ace.group    { border-left-color: #c08a35; }
      .ajna-perm-dialog .pd-ace.user     { border-left-color: #4a8c4a; }
      .ajna-perm-dialog .pd-ace-subject strong { color: #eaeaea; }
      .ajna-perm-dialog .pd-ace-subject .pd-meta {
        display: block; font-size: 10px; color: #888;
      }
      .ajna-perm-dialog .pd-ace-rights {
        margin-top: 2px;
        font-size: 11px; color: #cde;
      }
      .ajna-perm-dialog .pd-ace-rights .pd-pill {
        display: inline-block;
        padding: 1px 6px;
        background: #2a2a32;
        border-radius: 10px;
        margin-right: 3px;
        font-size: 10px;
      }
      .ajna-perm-dialog .pd-ace-rights .pd-pill.interact {
        background: #2c4d6f; color: #cde;
      }
      .ajna-perm-dialog .pd-add {
        background: #15151a;
        border-radius: 4px;
        padding: 12px;
        margin-top: 8px;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .ajna-perm-dialog .pd-add label {
        display: block;
        font-size: 10px;
        color: #aab;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 4px;
      }
      .ajna-perm-dialog .pd-add select,
      .ajna-perm-dialog .pd-add input[type=text] {
        width: 100%; box-sizing: border-box;
        background: #0d0d12; color: #eaeaea;
        border: 1px solid #2a2a32; border-radius: 4px;
        padding: 4px 6px; font: inherit;
      }
      .ajna-perm-dialog .pd-rights-row {
        grid-column: 1 / -1;
        display: flex; flex-wrap: wrap; gap: 6px;
      }
      .ajna-perm-dialog .pd-rights-row label {
        display: inline-flex; align-items: center; gap: 4px;
        background: #0d0d12; padding: 4px 8px;
        border-radius: 4px; cursor: pointer;
        text-transform: none; letter-spacing: 0;
        color: #cde; margin: 0;
      }
      .ajna-perm-dialog .pd-interact-row { grid-column: 1 / -1; }
      .ajna-perm-dialog .pd-add-btn-row { grid-column: 1 / -1; }
      .ajna-perm-dialog button {
        background: #2a2a32; color: #eaeaea;
        border: 1px solid #3a3a44; border-radius: 4px;
        padding: 5px 12px; cursor: pointer; font: inherit;
      }
      .ajna-perm-dialog button:hover { background: #34343d; }
      .ajna-perm-dialog button:disabled { opacity: 0.4; cursor: default; }
      .ajna-perm-dialog button.primary {
        background: #2c5d8f; border-color: #3a78b6;
      }
      .ajna-perm-dialog button.primary:hover { background: #356da6; }
      .ajna-perm-dialog button.danger {
        background: #642424; border-color: #8c3030;
      }
      .ajna-perm-dialog button.danger:hover { background: #7a2c2c; }
      .ajna-perm-dialog .pd-footer {
        margin-top: 16px;
        display: flex; justify-content: flex-end; gap: 8px;
        border-top: 1px solid rgba(255,255,255,0.08);
        padding-top: 12px;
      }
    `
    document.head.appendChild(style)
  }

  async open(obj) {
    if (!this.ajna) {
      console.warn('PermissionDialog: kein AjnaManager — Dialog wird nicht geöffnet')
      return
    }

    const backdrop = document.createElement('div')
    backdrop.className = 'ajna-perm-backdrop'
    backdrop.innerHTML = `
      <div class="ajna-perm-dialog">
        <h3>Berechtigungen</h3>
        <div class="pd-sub">${this._escape(obj?.name || obj?.id || t('Unbenanntes Objekt'))}${renderServerBadge(this.ajna, obj?._origin)}</div>

        <h4>Aktuelle Einträge</h4>
        <div class="pd-ace-list">
          <div class="pd-status">lade …</div>
        </div>

        <h4>Neue Berechtigung</h4>
        <div class="pd-add">
          <div>
            <label>Subjekt-Typ</label>
            <select class="pd-subject-type">
              <option value="user">Spieler</option>
              <option value="group">Gruppe</option>
              <option value="authenticated">Authentifiziert (implizit)</option>
              <option value="anonymous">Anonym (implizit)</option>
              <option value="everyone">Jeder (implizit)</option>
            </select>
          </div>
          <div>
            <label>Subjekt</label>
            <select class="pd-subject"></select>
          </div>
          <div class="pd-rights-row">
            <label><input type="checkbox" value="view" checked> view</label>
            <label><input type="checkbox" value="edit"> edit</label>
            <label><input type="checkbox" value="move"> move</label>
            <label><input type="checkbox" value="owner"> owner</label>
          </div>
          <div class="pd-interact-row">
            <label>Erlaubte Interaktionen <span style="color:#666">(kommagetrennt, <code>*</code> für alle)</span></label>
            <input type="text" class="pd-interact" placeholder="z. B. attack, pet">
          </div>
          <div class="pd-add-btn-row" style="text-align:right;">
            <button class="primary pd-add-btn">Hinzufügen</button>
          </div>
        </div>

        <div class="pd-footer">
          <button class="pd-close">Schließen</button>
        </div>
      </div>
    `

    document.body.appendChild(backdrop)
    this._backdrop = backdrop
    this._obj = obj

    backdrop.querySelector('.pd-close').addEventListener('click', () => this.close())
    klickDaneben(backdrop, () => this.close())

    // Subject-Type → Subject-Dropdown koppeln
    const typeEl    = backdrop.querySelector('.pd-subject-type')
    const subjectEl = backdrop.querySelector('.pd-subject')
    const ownerCb   = backdrop.querySelector('input[value="owner"]')

    typeEl.addEventListener('change', () => this._refreshSubjectOptions())
    typeEl.addEventListener('change', () => {
      const art = typeEl.value
      if (IMPLICIT_AUDIENCES.has(art)) {
        ownerCb.checked = false
        ownerCb.disabled = true
      } else {
        ownerCb.disabled = false
      }
    })

    backdrop.querySelector('.pd-add-btn').addEventListener('click', () => this._handleAdd())

    // Daten laden
    try {
      const [aces, users, groups] = await Promise.all([
        this.ajna.listPermissions(obj.id),
        this.ajna.listUsers().catch(() => []),
        this.ajna.listGroups().catch(() => [])
      ])
      this._users  = users
      this._groups = groups
      this._userById  = new Map(users.map(u => [u.id, u]))
      this._groupById = new Map(groups.map(g => [g.id, g]))
      this._refreshSubjectOptions()
      this._renderAces(aces)
    } catch (err) {
      this._showError(`konnte Berechtigungen nicht laden: ${err?.message || err}`)
    }
  }

  close() {
    if (this._backdrop) {
      this._backdrop.remove()
      this._backdrop = null
    }
  }

  // ---------------------------------------------------------------------

  _refreshSubjectOptions() {
    if (!this._backdrop) return
    const typeEl    = this._backdrop.querySelector('.pd-subject-type')
    const subjectEl = this._backdrop.querySelector('.pd-subject')
    const art = typeEl.value

    if (IMPLICIT_AUDIENCES.has(art)) {
      subjectEl.innerHTML = '<option value="">— (implizit, kein Subjekt nötig) —</option>'
      subjectEl.disabled = true
      return
    }
    subjectEl.disabled = false

    if (art === 'user') {
      // users.listRule ist privacy-bedingt streng: jeder eingeloggte
      // Spieler sieht nur sich selbst. Direkte Spieler-zu-Spieler-Zuweisung
      // ist daher in der UI nicht möglich. Stattdessen läuft das später
      // über ein Einladungs-/Friends-System bzw. aktuell über Gruppen.
      const ownerId = this._obj?.owner
      const list = (this._users || []).filter(u => u.id !== ownerId)
      subjectEl.innerHTML = list.length
        ? list.map(u =>
            `<option value="${u.id}">${this._escape(u.email || u.name || u.id)}</option>`
          ).join('')
        : '<option value="">— direkte Spieler-Zuweisung nicht möglich (über Gruppen) —</option>'
    } else if (art === 'group') {
      subjectEl.innerHTML = (this._groups || []).length
        ? this._groups.map(g =>
            `<option value="${g.id}">${this._escape(g.name || g.id)}</option>`
          ).join('')
        : '<option value="">(keine Gruppen vorhanden)</option>'
    }
  }

  _renderAces(aces) {
    const container = this._backdrop?.querySelector('.pd-ace-list')
    if (!container) return
    container.innerHTML = ''

    if (!aces || aces.length === 0) {
      container.innerHTML = '<div class="pd-status">keine Einträge</div>'
      return
    }

    for (const ace of aces) {
      const kind = IMPLICIT_AUDIENCES.has(ace.subject_type)
        ? 'implicit'
        : ace.subject_type   // 'user' | 'group'

      const { label, meta } = this._describeSubject(ace)
      const rightsPills = (ace.rights || []).map(r =>
        `<span class="pd-pill">${this._escape(r)}</span>`
      ).join('')
      const interactPills = (ace.interact_actions || []).map(a =>
        `<span class="pd-pill interact">${this._escape(a)}</span>`
      ).join('')

      const row = document.createElement('div')
      row.className = `pd-ace ${kind}`
      row.innerHTML = `
        <div class="pd-ace-subject">
          <strong>${this._escape(label)}</strong>
          <span class="pd-meta">${this._escape(meta)}</span>
          <div class="pd-ace-rights">${rightsPills}${interactPills}</div>
        </div>
        <button class="danger">Entfernen</button>
      `
      row.querySelector('button').addEventListener('click', () => this._handleRemove(ace.id))
      container.appendChild(row)
    }
  }

  _describeSubject(ace) {
    if (ace.subject_type === 'user') {
      const u = this._userById?.get(ace.subject)
      return {
        label: u?.email || u?.username || ace.subject || '(unbekannter Spieler)',
        meta: 'Spieler'
      }
    }
    if (ace.subject_type === 'group') {
      const g = this._groupById?.get(ace.subject)
      return {
        label: g?.name || ace.subject || '(unbekannte Gruppe)',
        meta: g ? `Gruppe (${(g.members || []).length} Mitglieder)` : 'Gruppe'
      }
    }
    const map = {
      authenticated: t('Angemeldete Spieler'),
      anonymous:     t('Nicht angemeldete Besucher'),
      everyone:      'Jeder'
    }
    return { label: map[ace.subject_type] || ace.subject_type, meta: 'implizite Audience' }
  }

  async _handleAdd() {
    const bd = this._backdrop
    const typeEl    = bd.querySelector('.pd-subject-type')
    const subjectEl = bd.querySelector('.pd-subject')
    const addBtn    = bd.querySelector('.pd-add-btn')

    const subject_type = typeEl.value
    const subject      = IMPLICIT_AUDIENCES.has(subject_type) ? '' : subjectEl.value
    const rights       = [...bd.querySelectorAll('.pd-rights-row input:checked')].map(i => i.value)
    const interactRaw  = bd.querySelector('.pd-interact').value.trim()
    const interact_actions = interactRaw
      ? interactRaw.split(',').map(s => s.trim()).filter(Boolean)
      : []

    if (!IMPLICIT_AUDIENCES.has(subject_type) && !subject) {
      this._showError(
        subject_type === 'user'
          ? t('Einzelne Spieler lassen sich noch nicht zuweisen — dafür Gruppen benutzen.')
          : t('Bitte auswählen, für wen die Regel gilt')
      )
      return
    }

    addBtn.disabled = true
    try {
      await this.ajna.addPermission(this._obj.id, {
        subject_type, subject, rights, interact_actions
      })
      // Inputs zurücksetzen
      bd.querySelector('.pd-interact').value = ''
      await this._reloadAces()
    } catch (err) {
      this._showError(t('Hinzufügen fehlgeschlagen: {grund}', { grund: err?.message || err }))
    } finally {
      addBtn.disabled = false
    }
  }

  async _handleRemove(aceId) {
    try {
      await this.ajna.removePermission(aceId)
      await this._reloadAces()
    } catch (err) {
      this._showError(`Entfernen fehlgeschlagen: ${err?.message || err}`)
    }
  }

  async _reloadAces() {
    try {
      const aces = await this.ajna.listPermissions(this._obj.id)
      this._renderAces(aces)
    } catch (err) {
      this._showError(`Neuladen fehlgeschlagen: ${err?.message || err}`)
    }
  }

  _showError(text) {
    console.warn('[PermissionDialog]', text)
    // Wenn der Dialog noch offen ist, kurz oben anzeigen
    const bd = this._backdrop
    if (!bd) return
    const list = bd.querySelector('.pd-ace-list')
    if (list) list.innerHTML = `<div class="pd-status error">${this._escape(text)}</div>`
  }

  _escape(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c])
  }
}
