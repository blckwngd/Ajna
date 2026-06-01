// Baut das Kontextmenü für ein Objekt auf — wird von AR-Client (Mesh-Klick)
// und Map-Client (Marker-Klick) gleichermaßen benutzt. Verlinkt die Aktionen
// mit den vorhandenen UI-/Daten-Schichten:
//   - Bearbeiten      → editorUI.fillEditor(record)
//   - Berechtigungen  → permissionDialog.open(record)
//   - Löschen         → ajna.deleteObject(id) nach Bestätigung
//   - Interaktionen   → record.actions
//
// Die Liste der verfügbaren Aktionen kommt aus dem PB-Record. Hat das
// Objekt keine eigenen actions hinterlegt, bieten wir nur "Untersuchen"
// als generischen Fallback — primär für Debugging/Inspect, kein echtes
// Verhalten. Alle anderen Optionen sollen das Objekt selbst beisteuern.

import { renderServerBadgeText } from './ServerBadge.js'

const FALLBACK_ACTIONS = [
  { key: 'examine', label: 'Untersuchen' }
]

export class ObjectActions {
  constructor({ ajna, editorUI, contextMenu, permissionDialog }) {
    this.ajna = ajna
    this.editorUI = editorUI
    this.contextMenu = contextMenu
    this.permissionDialog = permissionDialog
  }

  // record = PocketBase-Record. x/y = Viewport-Pixelposition (für Menü).
  showFor(record, x, y) {
    if (!record) return

    const actions = Array.isArray(record.actions) && record.actions.length > 0
      ? record.actions
      : FALLBACK_ACTIONS

    // Owner-Check: nur Besitzer dürfen Berechtigungen verwalten. Bei
    // Multi-Server den passenden AjnaClient für record._origin nehmen,
    // weil der eingeloggte User pro Server unterschiedlich sein kann.
    const client = this.ajna.clients?.get(record._origin) || this.ajna.defaultClient
    const me = client?.currentUser?.()
    const isOwner = !!me && !!record.owner && me.id === record.owner

    const items = [
      { label: 'Bearbeiten',     onClick: () => this.editorUI?.fillEditor?.(record) },
      isOwner && { label: 'Berechtigungen', onClick: () => this.permissionDialog?.open(record) },
      isOwner && { label: 'Löschen', danger: true, onClick: () => this._confirmDelete(record) },
      { separator: true },
      { sectionLabel: 'Interaktionen' },
      ...actions.map(a => ({
        label: a.label || a.key,
        onClick: () => this._triggerAction(record, a.key)
      }))
    ].filter(Boolean)

    // Server-Hinweis im Titel — Plain-Text-Suffix, da der ContextMenu
    // den Header per textContent rendert (kein HTML-Badge möglich).
    // Suffix ist leer, wenn nur ein Server registriert ist.
    const originSuffix = renderServerBadgeText(this.ajna, record._origin)
    const title = (record.name || record.id) + (originSuffix ? `  ${originSuffix}` : '')

    this.contextMenu.show({
      x, y,
      title,
      items
    })
  }

  // Ruft die serverseitige Route auf, die nach Permission-Check ein
  // ephemeres Event über den PocketBase-Subscriptions-Broker an alle
  // interessierten Clients (inkl. dem zugewiesenen Agent) verteilt.
  async _triggerAction(record, actionKey) {
    try {
      const res = await this.ajna.interact(record.id, actionKey)
      console.log('[interact]', actionKey, '→', res)
    } catch (err) {
      // PocketBase liefert bei 403/404 eine JSON-Antwort mit response.data
      const detail = err?.response?.data?.error || err?.message || String(err)
      console.warn('[interact] failed:', detail)
      alert(`Interaktion "${actionKey}" nicht möglich: ${detail}`)
    }
  }

  async _confirmDelete(record) {
    const label = record.name || record.id
    if (!window.confirm(`"${label}" wirklich löschen?`)) return
    try {
      await this.ajna.deleteObject(record.id)
    } catch (err) {
      console.warn('deleteObject fehlgeschlagen', err)
      alert('Löschen fehlgeschlagen: ' + (err?.message || err))
    }
  }
}
