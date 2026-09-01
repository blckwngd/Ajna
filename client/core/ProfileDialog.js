// Modal-Dialog für das User-Profil — aktuell der Default-Permissions-Editor.
//
// `users.default_permissions` ist ein JSON-Feld am User-Record, das beim
// Anlegen eines neuen Objekts vom PB-Hook (applyOwnerDefaults) als ACEs
// in object_permissions materialisiert wird. Vorher konnte man das nur
// über die PB-Admin-UI als JSON tippen — dieser Dialog macht es zu einem
// First-Class-Workflow im Client.
//
// Sicht-/Edit-Konvention identisch zur PermissionDialog (gleiche subject_types,
// gleiche rights), aber Daten-Scope ist user.default_permissions statt
// object_permissions auf einem konkreten Objekt.
//
// Spätere Erweiterung: gleiche Modal kann weitere Profil-Settings aufnehmen
// (Anzeigename, Avatar-URL, Sync-Server-Liste etc.).


import { t } from './i18n.js'
import { klickDaneben } from './klickDaneben.js'

const IMPLICIT_AUDIENCES = new Set(['authenticated', 'anonymous', 'everyone'])
const ALL_RIGHTS = ['view', 'edit', 'move']
const SUBJECT_TYPE_LABELS = {
  authenticated: t('Angemeldete Spieler'),
  anonymous:     t('Nicht angemeldete Besucher'),
  everyone:      t('Alle, auch nicht angemeldete'),
  user:          t('Bestimmter Spieler'),
  group:         t('Bestimmte Gruppe')
}

export class ProfileDialog {
  /**
   * @param {{ajna: import('./AjnaManager.js').AjnaManager}} opts
   */
  constructor({ ajna } = {}) {
    this.ajna = ajna
    // (Standort-Teilen-Schalter entfernt — sitzt jetzt nur in den Einstellungen.)
    this._backdrop = null
    this._aces = []
    this._users = []
    this._groups = []
    this._injectStyles()
  }

  async open() {
    if (!this.ajna?.isLoggedIn()) {
      console.warn('ProfileDialog: nicht eingeloggt')
      return
    }
    // Deep-copy der aktuellen Defaults, damit "Abbrechen" wirklich verwirft.
    const current = this.ajna.getMyDefaultPermissions() || []
    this._aces = JSON.parse(JSON.stringify(current))
    // Lookups für user-/group-Dropdown — fallen still, wenn der User die
    // Collections nicht listen darf (users.listRule ist strikt privat).
    try { this._users  = await this.ajna.listUsers()  } catch { this._users  = [] }
    try { this._groups = await this.ajna.listGroups() } catch { this._groups = [] }
    this._mount()
    this._render()
  }

  close() {
    this._backdrop?.remove()
    this._backdrop = null
  }

  // ───────────────────────────────────────────────────────────────────

  _mount() {
    if (this._backdrop) return
    const bd = document.createElement('div')
    bd.className = 'ajna-prof-backdrop'
    klickDaneben(bd, () => this.close())

    const dlg = document.createElement('div')
    dlg.className = 'ajna-prof-dialog'
    dlg.innerHTML = `
      <div class="prof-head">
        <h3>Mein Profil</h3>
        <button class="prof-close" title="Schließen">✕</button>
      </div>

      <section class="prof-privacy">
        <h4>Sicherheit</h4>
        <label class="prof-share">
          <input type="checkbox" data-role="allow-ext-models">
          <span>Externe 3D-Modell-URLs erlauben</span>
        </label>
        <p class="prof-share-desc">
          Erlaubt, Objekte mit Modellen von <strong>fremden Servern</strong> zu
          verlinken und solche Modelle zu laden. Standardmäßig aus
          (Missbrauchsschutz). Lokale Modelle und Modelle vom Herkunfts-Server
          sind immer erlaubt.
        </p>
      </section>

      <h4>Standard-Berechtigungen</h4>
      <p class="prof-desc">
        Diese Berechtigungen werden auf <strong>jedes neue Objekt</strong>
        angewendet, das du anlegst. Du kannst sie pro Objekt nachträglich
        über das Kontextmenü → Berechtigungen feiner einstellen.
      </p>

      <h4>Aktuelle Einträge</h4>
      <div class="prof-list" data-role="list"></div>

      <h4>Neue Berechtigung hinzufügen</h4>
      <div class="prof-add">
        <div class="prof-add-row">
          <label>Subjekt-Typ</label>
          <select class="prof-subject-type"></select>
        </div>
        <div class="prof-add-row prof-add-row-subject" style="display:none">
          <label>Subjekt</label>
          <select class="prof-subject"></select>
        </div>
        <div class="prof-add-row">
          <label>Rechte</label>
          <div class="prof-rights">
            ${ALL_RIGHTS.map(r => `<label><input type="checkbox" value="${r}"${r === 'view' ? ' checked' : ''}> ${r}</label>`).join('')}
          </div>
        </div>
        <div class="prof-add-row">
          <label>Interaktionen</label>
          <input type="text" class="prof-interact" placeholder="komma-separiert, z. B. attack, examine (optional)">
        </div>
        <div class="prof-add-row">
          <span></span>
          <button class="prof-add-btn primary">Hinzufügen</button>
        </div>
      </div>

      <div class="prof-status" data-role="status"></div>
      <div class="prof-actions">
        <button class="prof-save primary">Speichern</button>
        <button class="prof-cancel">Abbrechen</button>
      </div>
    `

    bd.appendChild(dlg)
    document.body.appendChild(bd)
    this._backdrop = bd

    // Subject-type-Optionen füllen
    const typeEl = dlg.querySelector('.prof-subject-type')
    for (const art of Object.keys(SUBJECT_TYPE_LABELS)) {
      const opt = document.createElement('option')
      opt.value = art
      opt.textContent = SUBJECT_TYPE_LABELS[art]
      typeEl.appendChild(opt)
    }

    // Standort-Teilen-Schalter sitzt jetzt NUR noch in den Einstellungen
    // (präsent + einfach erreichbar) — hier bewusst entfernt (war doppelt).

    // Sicherheit: globaler Schalter für externe 3D-Modell-URLs (Default aus).
    // Gelesen von EditorUI (URL-Eingabe) und GameObject (Laden fremd-origin).
    const ext = dlg.querySelector('[data-role="allow-ext-models"]')
    if (ext) {
      try { ext.checked = localStorage.getItem('ajna_allow_ext_models') === '1' } catch {}
      ext.addEventListener('change', () => {
        try { localStorage.setItem('ajna_allow_ext_models', ext.checked ? '1' : '0') } catch {}
      })
    }

    // Event-Bindings
    dlg.querySelector('.prof-close')      .addEventListener('click', () => this.close())
    dlg.querySelector('.prof-cancel')     .addEventListener('click', () => this.close())
    dlg.querySelector('.prof-save')       .addEventListener('click', () => this._save())
    dlg.querySelector('.prof-add-btn')    .addEventListener('click', () => this._handleAdd())
    dlg.querySelector('.prof-subject-type').addEventListener('change', () => this._updateSubjectField())

    this._updateSubjectField()
  }

  _updateSubjectField() {
    const bd = this._backdrop
    if (!bd) return
    const art = bd.querySelector('.prof-subject-type').value
    const row = bd.querySelector('.prof-add-row-subject')
    const sel = bd.querySelector('.prof-subject')

    if (IMPLICIT_AUDIENCES.has(art)) {
      row.style.display = 'none'
      sel.innerHTML = ''
      return
    }

    row.style.display = ''
    sel.innerHTML = ''

    if (art === 'user') {
      // Eigene User-ID ausklammern — ein selbst-ACE ist sinnlos, weil
      // der Owner sowieso alle Rechte hat.
      const me = this.ajna.currentUser()
      const others = this._users.filter(u => u.id !== me?.id)
      if (others.length === 0) {
        sel.innerHTML = '<option value="">— keine weiteren Spieler sichtbar (Privacy-Rule) —</option>'
        return
      }
      for (const u of others) {
        const opt = document.createElement('option')
        opt.value = u.id
        opt.textContent = u.email || u.name || u.id
        sel.appendChild(opt)
      }
    } else if (art === 'group') {
      if (this._groups.length === 0) {
        sel.innerHTML = '<option value="">— keine Gruppen vorhanden —</option>'
        return
      }
      for (const g of this._groups) {
        const opt = document.createElement('option')
        opt.value = g.id
        opt.textContent = g.name || g.id
        sel.appendChild(opt)
      }
    }
  }

  _handleAdd() {
    const bd = this._backdrop
    const type = bd.querySelector('.prof-subject-type').value
    const subject = IMPLICIT_AUDIENCES.has(type)
      ? ''
      : bd.querySelector('.prof-subject').value
    if (!IMPLICIT_AUDIENCES.has(type) && !subject) {
      return this._setStatus(t('Bitte auswählen, für wen die Regel gilt'), 'error')
    }

    const rights = Array.from(bd.querySelectorAll('.prof-rights input:checked'))
      .map(i => i.value)
    if (rights.length === 0) {
      return this._setStatus(t('Mindestens ein Recht wählen.'), 'error')
    }

    const interactRaw = bd.querySelector('.prof-interact').value.trim()
    const interact_actions = interactRaw
      ? interactRaw.split(',').map(s => s.trim()).filter(Boolean)
      : []

    // Dedup auf Basis aller Felder — verhindert ungewollte Duplikate.
    const dupe = this._aces.find(a =>
      a.subject_type === type &&
      (a.subject || '') === subject &&
      _sameArr(a.rights, rights) &&
      _sameArr(a.interact_actions, interact_actions)
    )
    if (dupe) {
      return this._setStatus(t('Identischer Eintrag existiert bereits.'), 'error')
    }

    this._aces.push({ subject_type: type, subject, rights, interact_actions })
    bd.querySelector('.prof-interact').value = ''
    this._renderList()
    this._setStatus(t('Hinzugefügt — vergiss nicht zu speichern.'))
  }

  _renderList() {
    const bd = this._backdrop
    if (!bd) return
    const list = bd.querySelector('[data-role="list"]')
    list.innerHTML = ''

    if (this._aces.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'prof-empty'
      empty.textContent = '(keine Einträge — neue Objekte sind nur für dich selbst sichtbar)'
      list.appendChild(empty)
      return
    }

    for (let i = 0; i < this._aces.length; i++) {
      const ace = this._aces[i]
      const row = document.createElement('div')
      row.className = 'prof-ace'

      const label = document.createElement('div')
      label.className = 'prof-ace-label'
      label.textContent = this._describeAce(ace)

      const rights = document.createElement('div')
      rights.className = 'prof-ace-rights'
      for (const r of (ace.rights || [])) {
        const pill = document.createElement('span')
        pill.className = 'prof-pill'
        pill.textContent = r
        rights.appendChild(pill)
      }
      for (const a of (ace.interact_actions || [])) {
        const pill = document.createElement('span')
        pill.className = 'prof-pill prof-pill-interact'
        pill.textContent = a
        rights.appendChild(pill)
      }

      const rm = document.createElement('button')
      rm.className = 'prof-remove'
      rm.title = 'Entfernen'
      rm.textContent = '✕'
      rm.addEventListener('click', () => {
        this._aces.splice(i, 1)
        this._renderList()
        this._setStatus(t('Eintrag entfernt — vergiss nicht zu speichern.'))
      })

      row.appendChild(label)
      row.appendChild(rights)
      row.appendChild(rm)
      list.appendChild(row)
    }
  }

  _render() {
    this._renderList()
  }

  _describeAce(ace) {
    if (IMPLICIT_AUDIENCES.has(ace.subject_type)) {
      return SUBJECT_TYPE_LABELS[ace.subject_type] || ace.subject_type
    }
    if (ace.subject_type === 'user') {
      const u = this._users.find(u => u.id === ace.subject)
      const label = u?.email || u?.name || ace.subject
      return `Spieler: ${label}`
    }
    if (ace.subject_type === 'group') {
      const g = this._groups.find(g => g.id === ace.subject)
      return `Gruppe: ${g?.name || ace.subject}`
    }
    return ace.subject_type
  }

  async _save() {
    try {
      await this.ajna.setMyDefaultPermissions(this._aces)
      this._setStatus('Gespeichert.', 'ok')
      setTimeout(() => this.close(), 700)
    } catch (err) {
      this._setStatus(t('Speichern fehlgeschlagen: ') + (err?.message || err), 'error')
    }
  }

  _setStatus(text, kind = '') {
    const el = this._backdrop?.querySelector('[data-role="status"]')
    if (!el) return
    el.textContent = text
    el.className = `prof-status ${kind}`
  }

  _injectStyles() {
    if (document.getElementById('ajnaProfileDialogStyles')) return
    const style = document.createElement('style')
    style.id = 'ajnaProfileDialogStyles'
    style.textContent = `
      .ajna-prof-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.55);
        z-index: 4200;
        display: flex; align-items: center; justify-content: center;
      }
      .ajna-prof-dialog {
        background: rgba(18,18,22,0.98);
        color: #eaeaea;
        border: 1px solid #3a3a44;
        border-radius: 8px;
        box-shadow: 0 12px 48px rgba(0,0,0,0.6);
        font: 12px ui-monospace, Menlo, Consolas, monospace;
        width: 600px; max-width: 92vw;
        max-height: 88vh; overflow: auto;
        padding: 16px 18px;
      }
      .ajna-prof-dialog .prof-head {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 8px;
      }
      .ajna-prof-dialog h3 {
        margin: 0;
        font-size: 13px; color: #f1c40f;
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      .ajna-prof-dialog h4 {
        margin: 14px 0 8px;
        font-size: 11px; color: #aab;
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      .ajna-prof-dialog .prof-close {
        background: transparent; color: #aab;
        border: 1px solid #3a3a44; border-radius: 4px;
        padding: 2px 8px; cursor: pointer;
      }
      .ajna-prof-dialog .prof-close:hover { color: #fff; }
      .ajna-prof-dialog .prof-desc {
        margin: 0 0 10px;
        font-size: 11px; color: #aab; line-height: 1.5;
      }
      .ajna-prof-dialog .prof-empty {
        font-size: 11px; color: #777; font-style: italic;
        padding: 8px 10px;
      }

      .ajna-prof-dialog .prof-ace {
        display: grid;
        grid-template-columns: 1fr auto auto;
        gap: 8px; align-items: center;
        background: #15151a;
        border-radius: 4px;
        padding: 8px 10px;
        margin-bottom: 6px;
        border-left: 3px solid #2c5d8f;
      }
      .ajna-prof-dialog .prof-ace-label { color: #eaeaea; }
      .ajna-prof-dialog .prof-ace-rights { display: flex; gap: 4px; flex-wrap: wrap; }
      .ajna-prof-dialog .prof-pill {
        font-size: 10px; padding: 1px 6px;
        border-radius: 8px;
        border: 1px solid #356da6;
        color: #6fc8ff;
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      .ajna-prof-dialog .prof-pill-interact {
        border-color: #6a5520; color: #f1c40f;
      }
      .ajna-prof-dialog .prof-remove {
        background: #8f3030; color: #fff;
        border: none; border-radius: 4px;
        padding: 2px 8px; cursor: pointer;
        font: inherit;
      }
      .ajna-prof-dialog .prof-remove:hover { background: #a64141; }

      .ajna-prof-dialog .prof-add {
        background: #15151a;
        border-radius: 4px;
        padding: 10px;
        margin-bottom: 8px;
      }
      .ajna-prof-dialog .prof-add-row {
        display: grid;
        grid-template-columns: 120px 1fr;
        gap: 8px; align-items: center;
        margin-bottom: 6px;
      }
      .ajna-prof-dialog .prof-add-row label {
        color: #aab; font-size: 11px;
      }
      .ajna-prof-dialog .prof-add select,
      .ajna-prof-dialog .prof-add input[type=text] {
        background: #0e0e12; color: #eaeaea;
        border: 1px solid #3a3a44; border-radius: 4px;
        padding: 4px 8px; font: inherit;
      }
      .ajna-prof-dialog .prof-rights {
        display: flex; gap: 12px;
      }
      .ajna-prof-dialog .prof-rights label {
        font-size: 12px; color: #eaeaea;
        display: inline-flex; align-items: center; gap: 4px;
      }

      .ajna-prof-dialog button.primary {
        background: #2c5d8f; color: #fff;
        border: none; border-radius: 4px;
        padding: 5px 12px; cursor: pointer;
        font: inherit;
      }
      .ajna-prof-dialog button.primary:hover { background: #356da6; }
      .ajna-prof-dialog button {
        background: #2a2a32; color: #eaeaea;
        border: 1px solid #3a3a44; border-radius: 4px;
        padding: 5px 12px; cursor: pointer;
        font: inherit;
      }
      .ajna-prof-dialog button:hover { background: #34343d; }

      .ajna-prof-dialog .prof-status {
        min-height: 18px;
        font-size: 11px; color: #888; padding: 6px 0;
      }
      .ajna-prof-dialog .prof-status.ok    { color: #6fd28e; }
      .ajna-prof-dialog .prof-status.error { color: #d05050; }

      .ajna-prof-dialog .prof-actions {
        display: flex; gap: 8px; justify-content: flex-end;
        margin-top: 8px;
      }
    `
    document.head.appendChild(style)
  }
}

function _sameArr(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return (a?.length ?? 0) === (b?.length ?? 0)
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}
