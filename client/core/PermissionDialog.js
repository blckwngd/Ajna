// Modal-Dialog für Objekt-Berechtigungen.
// UI-Vorbau mit Platzhalter-Daten — schreibt nicht ans Backend.
// Sobald der Resolver/Express-Endpunkte stehen, wird das Save/Add hier
// gegen die echten Routen verdrahtet.

// Platzhalter-Datenquellen (später durch echte Backend-Abfragen ersetzen)
const PLACEHOLDER_USERS = [
  { id: 'user_1', label: 'Du (Besitzer)',     meta: 'abarth@kloeschinski.de' },
  { id: 'user_2', label: 'Anna Beispiel',     meta: 'anna@example.com' },
  { id: 'user_3', label: 'Tim Beispiel',      meta: 'tim@example.com' },
  { id: 'user_4', label: 'Lara Beispiel',     meta: 'lara@example.com' }
]
const PLACEHOLDER_GROUPS = [
  { id: 'group_1', label: 'Familie Barth',    meta: '3 Mitglieder' },
  { id: 'group_2', label: 'Nachbarschaft',    meta: '12 Mitglieder, 2 Untergruppen' },
  { id: 'group_3', label: 'Spielrunde Mittwoch', meta: '5 Mitglieder' }
]
const ALL_RIGHTS = ['view', 'edit', 'move', 'owner']
const IMPLICIT_AUDIENCES = new Set(['authenticated', 'anonymous', 'everyone'])

export class PermissionDialog {
  constructor() {
    this._injectStyles()
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
      .ajna-perm-dialog .pd-ace.owner    { border-left-color: #f1c40f; }
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
      .ajna-perm-dialog .pd-placeholder-note {
        margin-top: 10px;
        font-size: 10px;
        color: #6a6a72;
        font-style: italic;
        text-align: center;
      }
    `
    document.head.appendChild(style)
  }

  open(obj) {
    // Platzhalter-ACE-Liste — wird ersetzt, sobald object_permissions
    // im Backend liegt.
    const aces = [
      { kind: 'owner', subject_type: 'user', subject_id: 'user_1',
        subject_label: 'Du', subject_meta: 'abarth@kloeschinski.de — Besitzer',
        rights: ['owner', 'view', 'edit', 'move'], interact_actions: ['*'] },
      { kind: 'group', subject_type: 'group', subject_id: 'group_1',
        subject_label: 'Familie Barth', subject_meta: '3 Mitglieder',
        rights: ['view', 'edit'], interact_actions: ['turn_on', 'turn_off'] },
      { kind: 'implicit', subject_type: 'authenticated',
        subject_label: 'Authentifizierte Spieler', subject_meta: 'implizite Audience',
        rights: ['view'], interact_actions: [] }
    ]

    const backdrop = document.createElement('div')
    backdrop.className = 'ajna-perm-backdrop'
    backdrop.innerHTML = `
      <div class="ajna-perm-dialog">
        <h3>Berechtigungen</h3>
        <div class="pd-sub">${this._escape(obj?.name || obj?.id || 'Unbenanntes Objekt')}</div>

        <h4>Aktuelle Einträge</h4>
        <div class="pd-ace-list"></div>

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
            <input type="text" class="pd-interact" placeholder="z. B. turn_on, turn_off">
          </div>
          <div class="pd-add-btn-row" style="text-align:right;">
            <button class="primary pd-add-btn">Hinzufügen</button>
          </div>
        </div>

        <div class="pd-placeholder-note">
          Platzhalter-Daten — Backend-Anbindung folgt mit dem Permission-Resolver.
        </div>

        <div class="pd-footer">
          <button class="pd-close">Schließen</button>
          <button class="primary pd-save">Speichern</button>
        </div>
      </div>
    `

    document.body.appendChild(backdrop)

    const aceListEl = backdrop.querySelector('.pd-ace-list')
    this._renderAces(aceListEl, aces)

    // Subject-Dropdown an Subject-Typ koppeln
    const subjectTypeEl = backdrop.querySelector('.pd-subject-type')
    const subjectEl    = backdrop.querySelector('.pd-subject')
    const updateSubjectOptions = () => {
      const type = subjectTypeEl.value
      if (IMPLICIT_AUDIENCES.has(type)) {
        subjectEl.innerHTML = '<option value="">— (implizit, kein Subjekt nötig) —</option>'
        subjectEl.disabled = true
      } else {
        const list = type === 'user' ? PLACEHOLDER_USERS : PLACEHOLDER_GROUPS
        subjectEl.innerHTML = list.map(s =>
          `<option value="${s.id}">${this._escape(s.label)} <span>(${this._escape(s.meta)})</span></option>`
        ).join('')
        subjectEl.disabled = false
      }
    }
    subjectTypeEl.addEventListener('change', updateSubjectOptions)
    updateSubjectOptions()

    // Owner-Checkbox nur für user/group erlauben (Spec-Regel)
    const ownerCheckbox = backdrop.querySelector('input[value="owner"]')
    const enforceOwnerRule = () => {
      const type = subjectTypeEl.value
      if (IMPLICIT_AUDIENCES.has(type)) {
        ownerCheckbox.checked = false
        ownerCheckbox.disabled = true
      } else {
        ownerCheckbox.disabled = false
      }
    }
    subjectTypeEl.addEventListener('change', enforceOwnerRule)
    enforceOwnerRule()

    // Buttons
    backdrop.querySelector('.pd-close').addEventListener('click', () => backdrop.remove())
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) backdrop.remove()
    })
    backdrop.querySelector('.pd-save').addEventListener('click', () => {
      console.log('[perm] save (Platzhalter — Backend-Anbindung folgt)')
      backdrop.remove()
    })
    backdrop.querySelector('.pd-add-btn').addEventListener('click', () => {
      const rights = [...backdrop.querySelectorAll('.pd-rights-row input:checked')].map(i => i.value)
      const interactRaw = backdrop.querySelector('.pd-interact').value.trim()
      const interact = interactRaw
        ? interactRaw.split(',').map(s => s.trim()).filter(Boolean)
        : []

      const newAce = {
        kind: IMPLICIT_AUDIENCES.has(subjectTypeEl.value) ? 'implicit'
            : subjectTypeEl.value === 'group' ? 'group' : 'user',
        subject_type: subjectTypeEl.value,
        subject_id: subjectEl.disabled ? null : subjectEl.value,
        subject_label: subjectEl.disabled
          ? this._implicitLabel(subjectTypeEl.value)
          : (subjectEl.selectedOptions[0]?.textContent.replace(/\s*\(.*?\)\s*$/, '') ?? subjectEl.value),
        subject_meta: subjectEl.disabled ? 'implizite Audience' : '',
        rights, interact_actions: interact
      }

      console.log('[perm] add ACE (Platzhalter — Backend-Anbindung folgt):', newAce)
      aces.push(newAce)
      this._renderAces(aceListEl, aces)
    })
  }

  _renderAces(container, aces) {
    container.innerHTML = ''
    if (aces.length === 0) {
      container.innerHTML = '<div style="color:#666;padding:6px;font-style:italic;">Keine Einträge.</div>'
      return
    }
    for (const ace of aces) {
      const row = document.createElement('div')
      row.className = `pd-ace ${ace.kind === 'owner' ? 'owner' : ace.kind}`
      const rightsPills = ace.rights.map(r =>
        `<span class="pd-pill">${this._escape(r)}</span>`
      ).join('')
      const interactPills = (ace.interact_actions || []).map(a =>
        `<span class="pd-pill interact">${this._escape(a)}</span>`
      ).join('')
      row.innerHTML = `
        <div class="pd-ace-subject">
          <strong>${this._escape(ace.subject_label)}</strong>
          <span class="pd-meta">${this._escape(ace.subject_meta || '')}</span>
          <div class="pd-ace-rights">${rightsPills}${interactPills}</div>
        </div>
        <button class="danger">Entfernen</button>
      `
      row.querySelector('button').addEventListener('click', () => {
        console.log('[perm] remove ACE (Platzhalter — Backend-Anbindung folgt):', ace)
        const idx = aces.indexOf(ace)
        if (idx >= 0) aces.splice(idx, 1)
        this._renderAces(container, aces)
      })
      container.appendChild(row)
    }
  }

  _implicitLabel(type) {
    return ({
      authenticated: 'Authentifizierte Spieler',
      anonymous:     'Anonyme Spieler',
      everyone:      'Jeder'
    })[type] ?? type
  }

  _escape(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c])
  }
}
