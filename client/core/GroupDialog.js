// Modal-Dialog für Gruppen-Verwaltung.
//
// Zwei Bereiche:
//   - "Meine Gruppen": Gruppen, deren Owner der eingeloggte User ist.
//     Voll bearbeitbar — Anlegen, Umbenennen, Member/Subgroups pflegen,
//     Löschen.
//   - "Mitgliedschaften": Gruppen, in denen der User Member, aber nicht
//     Owner ist. Aktuell nur Anzeige; "Austreten" ist ein Platzhalter
//     für ein späteres Feature, in dem Spieler selbst aus Gruppen
//     ausscheiden können.
//
// Konzeptionell so aufgebaut, dass die Inhalte später in ein Babylon-GUI-
// Floating-Panel für immersive XR konvertierbar sind — ein in sich
// geschlossenes Modal-Element ohne Bezug zur umgebenden 2D-UI.

import { t } from './i18n.js'

export class GroupDialog {
  /**
   * @param {{ajna: import('./AjnaManager.js').AjnaManager}} opts
   */
  constructor({ ajna } = {}) {
    this.ajna = ajna
    this._injectStyles()
  }

  _injectStyles() {
    if (document.getElementById('ajnaGroupDialogStyles')) return
    const style = document.createElement('style')
    style.id = 'ajnaGroupDialogStyles'
    style.textContent = `
      .ajna-gd-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.55);
        z-index: 4000;
        display: flex; align-items: center; justify-content: center;
      }
      .ajna-gd-dialog {
        background: rgba(18,18,22,0.98);
        color: #eaeaea;
        border: 1px solid #3a3a44;
        border-radius: 8px;
        box-shadow: 0 12px 48px rgba(0,0,0,0.6);
        font: 12px ui-monospace, Menlo, Consolas, monospace;
        width: 620px;
        max-width: 92vw;
        max-height: 88vh;
        overflow: auto;
        padding: 16px 18px;
      }
      .ajna-gd-dialog h3 {
        margin: 0 0 14px;
        font-size: 13px;
        color: #f1c40f;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .ajna-gd-dialog h4 {
        margin: 14px 0 8px;
        font-size: 11px; color: #aab;
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      .ajna-gd-dialog .gd-status {
        font-size: 11px; color: #888; padding: 8px;
      }
      .ajna-gd-dialog .gd-status.error { color: #d05050; }
      .ajna-gd-dialog .gd-empty {
        font-size: 11px; color: #777; font-style: italic;
        padding: 6px 10px;
      }
      .ajna-gd-dialog .gd-empty-inline {
        font-size: 11px; color: #777; font-style: italic;
      }

      /* --- Owned group rows --- */
      .ajna-gd-dialog .gd-group-row {
        background: #15151a;
        border-radius: 4px;
        padding: 10px 12px;
        margin-bottom: 8px;
        border-left: 3px solid #c08a35;
      }
      .ajna-gd-dialog .gd-group-header {
        display: flex; gap: 6px; align-items: center;
        margin-bottom: 8px;
      }
      .ajna-gd-dialog .gd-group-header input {
        flex: 1;
        background: #0d0d12; color: #eaeaea;
        border: 1px solid #2a2a32; border-radius: 4px;
        padding: 4px 6px; font: inherit;
      }
      .ajna-gd-dialog label {
        display: block;
        font-size: 10px;
        color: #888;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 4px 0 4px;
      }
      .ajna-gd-dialog .gd-subblock {
        margin-top: 6px;
      }
      .ajna-gd-dialog .gd-tags {
        display: flex; flex-wrap: wrap; gap: 4px;
        padding: 2px 0;
      }
      .ajna-gd-dialog .gd-tag {
        display: inline-flex; align-items: center; gap: 4px;
        background: #2a2a32; color: #eaeaea;
        padding: 2px 4px 2px 8px;
        border-radius: 10px;
        font-size: 11px;
      }
      .ajna-gd-dialog .gd-tag button {
        background: transparent; color: #d05050;
        border: none; padding: 0 4px;
        cursor: pointer; font: inherit;
        line-height: 1;
      }
      .ajna-gd-dialog .gd-tag button:hover { color: #ff7070; }
      .ajna-gd-dialog .gd-add-row {
        display: flex; gap: 4px;
        margin-top: 4px;
      }
      .ajna-gd-dialog .gd-add-row input,
      .ajna-gd-dialog .gd-add-row select {
        flex: 1;
        background: #0d0d12; color: #eaeaea;
        border: 1px solid #2a2a32; border-radius: 4px;
        padding: 3px 6px; font: inherit;
      }

      /* --- Create-row + membership rows --- */
      .ajna-gd-dialog .gd-create-row {
        display: flex; gap: 6px;
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px dashed rgba(255,255,255,0.08);
      }
      .ajna-gd-dialog .gd-create-row input {
        flex: 1;
        background: #0d0d12; color: #eaeaea;
        border: 1px solid #2a2a32; border-radius: 4px;
        padding: 4px 6px; font: inherit;
      }
      .ajna-gd-dialog .gd-membership-row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 6px 12px;
        align-items: center;
        background: #15151a;
        border-radius: 4px;
        padding: 8px 12px;
        margin-bottom: 4px;
        border-left: 3px solid #6e8db5;
      }
      .ajna-gd-dialog .gd-membership-name {
        color: #eaeaea;
      }
      .ajna-gd-dialog .gd-membership-meta {
        grid-column: 1;
        font-size: 10px; color: #888;
      }

      /* --- Buttons --- */
      .ajna-gd-dialog button {
        background: #2a2a32; color: #eaeaea;
        border: 1px solid #3a3a44; border-radius: 4px;
        padding: 4px 10px; cursor: pointer; font: inherit;
      }
      .ajna-gd-dialog button:hover { background: #34343d; }
      .ajna-gd-dialog button:disabled { opacity: 0.45; cursor: default; }
      .ajna-gd-dialog button:disabled:hover { background: #2a2a32; }
      .ajna-gd-dialog button.primary {
        background: #2c5d8f; border-color: #3a78b6;
      }
      .ajna-gd-dialog button.primary:hover { background: #356da6; }
      .ajna-gd-dialog button.danger {
        background: #642424; border-color: #8c3030;
      }
      .ajna-gd-dialog button.danger:hover { background: #7a2c2c; }

      .ajna-gd-dialog .gd-footer {
        margin-top: 16px;
        display: flex; justify-content: flex-end; gap: 8px;
        border-top: 1px solid rgba(255,255,255,0.08);
        padding-top: 12px;
      }
      .ajna-gd-dialog .gd-hint {
        font-size: 10px;
        color: #888;
        font-style: italic;
        margin-top: 4px;
      }

      /* --- Invitations --- */
      .ajna-gd-dialog .gd-invite-row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px 12px;
        align-items: center;
        background: #15151a;
        border-radius: 4px;
        padding: 8px 12px;
        margin-bottom: 4px;
        border-left: 3px solid #f1c40f;
      }
      .ajna-gd-dialog .gd-invite-title strong { color: #f1c40f; }
      .ajna-gd-dialog .gd-invite-actions {
        display: flex; gap: 4px;
      }
      .ajna-gd-dialog .gd-tag-pending {
        background: #3a3a32;
        color: #d0c060;
      }
      .ajna-gd-dialog .gd-tag-pending button { color: #d05050; }
    `
    document.head.appendChild(style)
  }

  async open() {
    if (!this.ajna || !this.ajna.isLoggedIn()) {
      window.alert(t('Bitte zuerst anmelden.'))
      return
    }

    this._userId = this.ajna.currentUser().id

    const backdrop = document.createElement('div')
    backdrop.className = 'ajna-gd-backdrop'
    backdrop.innerHTML = `
      <div class="ajna-gd-dialog">
        <h3>Gruppen</h3>

        <h4>Eingehende Einladungen</h4>
        <div class="gd-incoming-list"><div class="gd-status">lade …</div></div>

        <h4>Meine Gruppen</h4>
        <div class="gd-owned-list"><div class="gd-status">lade …</div></div>
        <div class="gd-create-row">
          <input class="gd-new-name" placeholder="${t('Neue Gruppe (Name)')}">
          <button class="primary gd-create-btn">Anlegen</button>
        </div>

        <h4>Mitgliedschaften</h4>
        <div class="gd-membership-list"><div class="gd-status">lade …</div></div>
        <div class="gd-hint">
          Spieler können später aus Gruppen austreten — die Funktion folgt im nächsten Schritt.
        </div>

        <div class="gd-footer">
          <button class="gd-close">Schließen</button>
        </div>
      </div>
    `
    document.body.appendChild(backdrop)
    this._backdrop = backdrop

    backdrop.querySelector('.gd-close').addEventListener('click', () => this.close())
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) this.close()
    })
    backdrop.querySelector('.gd-create-btn').addEventListener('click', () => this._handleCreate())
    backdrop.querySelector('.gd-new-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') this._handleCreate()
    })

    await this._reload()
  }

  close() {
    if (this._backdrop) {
      this._backdrop.remove()
      this._backdrop = null
    }
  }

  // -------------------------------------------------------------------

  async _reload() {
    try {
      const [groups, incoming, outgoing] = await Promise.all([
        this.ajna.listGroups(),
        this.ajna.listIncomingInvitations().catch(() => []),
        this.ajna.listOutgoingInvitations().catch(() => [])
      ])
      this._allGroups = groups
      this._outgoingByGroup = new Map()
      for (const inv of outgoing) {
        const list = this._outgoingByGroup.get(inv.group) || []
        list.push(inv)
        this._outgoingByGroup.set(inv.group, list)
      }

      const owned = groups.filter(g => g.owner === this._userId)
      const memberships = groups.filter(g =>
        g.owner !== this._userId && (g.members || []).includes(this._userId)
      )
      this._renderIncoming(incoming)
      this._renderOwned(owned)
      this._renderMemberships(memberships)
    } catch (err) {
      this._showError(t('Konnte Daten nicht laden: ') + (err?.message || err))
    }
  }

  _renderIncoming(invitations) {
    const container = this._backdrop.querySelector('.gd-incoming-list')
    container.innerHTML = ''
    if (invitations.length === 0) {
      container.innerHTML = '<div class="gd-empty">keine offenen Einladungen</div>'
      return
    }
    for (const inv of invitations) {
      const row = document.createElement('div')
      row.className = 'gd-invite-row gd-invite-incoming'
      row.innerHTML = `
        <div class="gd-invite-info">
          <div class="gd-invite-title">
            <strong>${this._escape(inv.inviter_email || inv.inviter)}</strong>
            lädt dich ein in
            <strong>${this._escape(inv.group_name || inv.group)}</strong>
          </div>
        </div>
        <div class="gd-invite-actions">
          <button class="primary gd-accept">Annehmen</button>
          <button class="danger gd-decline">Ablehnen</button>
        </div>
      `
      row.querySelector('.gd-accept').addEventListener('click', () => this._handleAccept(inv.id))
      row.querySelector('.gd-decline').addEventListener('click', () => this._handleDecline(inv.id))
      container.appendChild(row)
    }
  }

  _renderOwned(groups) {
    const container = this._backdrop.querySelector('.gd-owned-list')
    container.innerHTML = ''

    if (groups.length === 0) {
      container.innerHTML = '<div class="gd-empty">noch keine Gruppen angelegt</div>'
      return
    }

    for (const g of groups) {
      const row = document.createElement('div')
      row.className = 'gd-group-row'
      row.innerHTML = `
        <div class="gd-group-header">
          <input class="gd-name-edit" type="text" value="${this._escape(g.name)}">
          <button class="gd-save-name">Umbenennen</button>
          <button class="danger gd-delete">Löschen</button>
        </div>

        <div class="gd-subblock">
          <label>Mitglieder</label>
          <div class="gd-tags gd-members-list"></div>
        </div>

        <div class="gd-subblock">
          <label>Einladen</label>
          <div class="gd-add-row gd-invite-row">
            <select class="gd-invite-kind">
              <option value="name">Anzeigename</option>
              <option value="email">E-Mail</option>
            </select>
            <input type="text" class="gd-invite-input" placeholder="Anzeigename">
            <button class="gd-send-invite">Einladen</button>
          </div>
          <div class="gd-tags gd-pending-list"></div>
        </div>

        <div class="gd-subblock">
          <label>Untergruppen</label>
          <div class="gd-tags gd-subgroups-list"></div>
          <div class="gd-add-row">
            <select class="gd-new-subgroup"></select>
            <button class="gd-add-subgroup">Hinzufügen</button>
          </div>
        </div>
      `

      this._renderMembers(row.querySelector('.gd-members-list'), g)
      this._renderSubgroups(row.querySelector('.gd-subgroups-list'), g)
      this._renderPending(row.querySelector('.gd-pending-list'), g)
      this._populateSubgroupOptions(row.querySelector('.gd-new-subgroup'), g)

      row.querySelector('.gd-save-name').addEventListener('click', () => {
        const v = row.querySelector('.gd-name-edit').value.trim()
        if (v && v !== g.name) this._handleRename(g.id, v)
      })
      row.querySelector('.gd-delete').addEventListener('click', () => this._handleDelete(g))

      const kindEl  = row.querySelector('.gd-invite-kind')
      const inputEl = row.querySelector('.gd-invite-input')
      const updatePlaceholder = () => {
        inputEl.placeholder = kindEl.value === 'email'
          ? 'email@example.com'
          : 'Anzeigename'
        inputEl.type = kindEl.value === 'email' ? 'email' : 'text'
      }
      kindEl.addEventListener('change', updatePlaceholder)

      row.querySelector('.gd-send-invite').addEventListener('click', () => {
        const value = inputEl.value.trim()
        if (!value) return
        const target = kindEl.value === 'email' ? { email: value } : { name: value }
        this._handleInvite(g, target)
        inputEl.value = ''
      })
      inputEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') row.querySelector('.gd-send-invite').click()
      })

      row.querySelector('.gd-add-subgroup').addEventListener('click', () => {
        const sel = row.querySelector('.gd-new-subgroup')
        const sid = sel.value
        if (sid) this._handleAddSubgroup(g, sid)
      })

      container.appendChild(row)
    }
  }

  _renderPending(container, group) {
    container.innerHTML = ''
    const pending = this._outgoingByGroup?.get(group.id) || []
    if (pending.length === 0) return
    for (const inv of pending) {
      const tag = document.createElement('span')
      tag.className = 'gd-tag gd-tag-pending'
      tag.innerHTML = `
        <span>📨 ${this._escape(inv.invitee_email || inv.invitee)}</span>
        <button title="zurückziehen">×</button>
      `
      tag.querySelector('button').addEventListener('click', () => this._handleCancel(inv.id))
      container.appendChild(tag)
    }
  }

  _renderMembers(container, group) {
    container.innerHTML = ''
    const members = group.members || []
    if (members.length === 0) {
      container.innerHTML = '<div class="gd-empty-inline">noch keine Mitglieder</div>'
      return
    }
    for (const memberId of members) {
      const label = memberId === this._userId ? `${memberId} (du)` : memberId
      const tag = document.createElement('span')
      tag.className = 'gd-tag'
      tag.innerHTML = `${this._escape(label)} <button title="entfernen">×</button>`
      tag.querySelector('button').addEventListener('click', () =>
        this._handleRemoveMember(group, memberId))
      container.appendChild(tag)
    }
  }

  _renderSubgroups(container, group) {
    container.innerHTML = ''
    const subs = group.subgroups || []
    if (subs.length === 0) {
      container.innerHTML = '<div class="gd-empty-inline">keine</div>'
      return
    }
    for (const subId of subs) {
      const sub = this._allGroups.find(x => x.id === subId)
      const tag = document.createElement('span')
      tag.className = 'gd-tag'
      tag.innerHTML = `${this._escape(sub?.name || subId)} <button title="entfernen">×</button>`
      tag.querySelector('button').addEventListener('click', () =>
        this._handleRemoveSubgroup(group, subId))
      container.appendChild(tag)
    }
  }

  _populateSubgroupOptions(selectEl, current) {
    // Nur Gruppen, die mir gehören, dürfen Subgroup werden — und keine
    // bereits zugewiesenen oder die Gruppe selbst (sonst Zyklus auf 0).
    // Tiefe Zyklus-Erkennung steht später, das hier deckt den 1-Hop-Fall ab.
    const ownedByMe = (this._allGroups || []).filter(g => g.owner === this._userId)
    const assigned = new Set(current.subgroups || [])
    const candidates = ownedByMe.filter(g => g.id !== current.id && !assigned.has(g.id))
    if (candidates.length === 0) {
      selectEl.innerHTML = '<option value="">(keine verfügbar)</option>'
      selectEl.disabled = true
      return
    }
    selectEl.disabled = false
    selectEl.innerHTML =
      '<option value="">— wählen —</option>' +
      candidates.map(g => `<option value="${g.id}">${this._escape(g.name)}</option>`).join('')
  }

  _renderMemberships(groups) {
    const container = this._backdrop.querySelector('.gd-membership-list')
    container.innerHTML = ''
    if (groups.length === 0) {
      container.innerHTML = '<div class="gd-empty">keine Mitgliedschaften in fremden Gruppen</div>'
      return
    }
    for (const g of groups) {
      const row = document.createElement('div')
      row.className = 'gd-membership-row'
      row.innerHTML = `
        <div class="gd-membership-name">${this._escape(g.name)}</div>
        <button class="gd-leave" disabled title="${t('Austreten folgt im nächsten Schritt')}">Austreten</button>
        <div class="gd-membership-meta">Besitzer: ${this._escape(g.owner)} · Mitglieder: ${(g.members || []).length}</div>
      `
      container.appendChild(row)
    }
  }

  // -------------------------------------------------------------------
  //  Handler
  // -------------------------------------------------------------------

  async _handleCreate() {
    const input = this._backdrop.querySelector('.gd-new-name')
    const name = input.value.trim()
    if (!name) return
    try {
      await this.ajna.createGroup(name, { members: [this._userId] })
      input.value = ''
      await this._reload()
    } catch (err) {
      this._showError(t('Anlegen fehlgeschlagen: ') + (err?.message || err))
    }
  }

  async _handleRename(id, newName) {
    try {
      await this.ajna.updateGroup(id, { name: newName })
      await this._reload()
    } catch (err) {
      this._showError(t('Umbenennen fehlgeschlagen: ') + (err?.message || err))
    }
  }

  async _handleDelete(group) {
    if (!window.confirm(`Gruppe "${group.name}" wirklich löschen?\n(ACEs, die auf diese Gruppe zeigen, verlieren ihre Wirkung.)`)) {
      return
    }
    try {
      await this.ajna.deleteGroup(group.id)
      await this._reload()
    } catch (err) {
      this._showError(t('Löschen fehlgeschlagen: ') + (err?.message || err))
    }
  }

  async _handleInvite(group, target) {
    try {
      await this.ajna.inviteToGroup(group.id, target)
      await this._reload()
    } catch (err) {
      const detail = err?.response?.data?.error || err?.message || String(err)
      this._showError(t('Einladung fehlgeschlagen: ') + detail)
    }
  }

  async _handleAccept(invId) {
    try {
      await this.ajna.acceptInvitation(invId)
      await this._reload()
    } catch (err) {
      const detail = err?.response?.data?.error || err?.message || String(err)
      this._showError(t('Annehmen fehlgeschlagen: ') + detail)
    }
  }

  async _handleDecline(invId) {
    try {
      await this.ajna.declineInvitation(invId)
      await this._reload()
    } catch (err) {
      const detail = err?.response?.data?.error || err?.message || String(err)
      this._showError(t('Ablehnen fehlgeschlagen: ') + detail)
    }
  }

  async _handleCancel(invId) {
    if (!window.confirm(t('Einladung wirklich zurückziehen?'))) return
    try {
      await this.ajna.cancelInvitation(invId)
      await this._reload()
    } catch (err) {
      this._showError(t('Zurückziehen fehlgeschlagen: ') + (err?.message || err))
    }
  }

  async _handleRemoveMember(group, memberId) {
    try {
      await this.ajna.updateGroup(group.id, {
        members: (group.members || []).filter(id => id !== memberId)
      })
      await this._reload()
    } catch (err) {
      this._showError(t('Mitglied entfernen fehlgeschlagen: ') + (err?.message || err))
    }
  }

  async _handleAddSubgroup(group, subId) {
    if ((group.subgroups || []).includes(subId)) return
    if (subId === group.id) {
      this._showError(t('Gruppe kann nicht sich selbst enthalten'))
      return
    }
    try {
      await this.ajna.updateGroup(group.id, {
        subgroups: [...(group.subgroups || []), subId]
      })
      await this._reload()
    } catch (err) {
      this._showError(t('Untergruppe hinzufügen fehlgeschlagen: ') + (err?.message || err))
    }
  }

  async _handleRemoveSubgroup(group, subId) {
    try {
      await this.ajna.updateGroup(group.id, {
        subgroups: (group.subgroups || []).filter(id => id !== subId)
      })
      await this._reload()
    } catch (err) {
      this._showError(t('Untergruppe entfernen fehlgeschlagen: ') + (err?.message || err))
    }
  }

  // -------------------------------------------------------------------

  _showError(msg) {
    console.warn('[GroupDialog]', msg)
    window.alert(msg)
  }

  _escape(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c])
  }
}
