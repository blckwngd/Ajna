// Baut das Kontextmenü für ein Objekt auf — wird von AR-Client (Mesh-Klick)
// und Map-Client (Marker-Klick) gleichermaßen benutzt. Verlinkt die Aktionen
// mit den vorhandenen UI-/Daten-Schichten:
//   - Bearbeiten      → editorUI.fillEditor(record)
//   - Berechtigungen  → permissionDialog.open(record)
//   - Löschen         → ajna.deleteObject(id) nach Bestätigung
//   - Interaktionen   → record.actions (Platzhalter solange nicht im PB-Schema)
//
// Die Liste der verfügbaren Aktionen ist absichtlich dynamisch: jedes
// Objekt kann seine eigenen Aktionen mitbringen. Solange `actions` nicht
// im Backend-Record steht, fallen wir auf einen kleinen Platzhalter zurück,
// damit das Menü demonstrierbar bleibt.

import { renderServerBadgeText } from './ServerBadge.js'

const PLACEHOLDER_ACTIONS = [
  { key: 'turn_on',  label: 'Einschalten' },
  { key: 'turn_off', label: 'Ausschalten' },
  { key: 'inspect',  label: 'Untersuchen' }
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
      : PLACEHOLDER_ACTIONS

    const items = [
      { label: 'Bearbeiten',     onClick: () => this.editorUI?.fillEditor?.(record) },
      { label: 'Berechtigungen', onClick: () => this.permissionDialog?.open(record) },
      { label: 'Löschen',        danger: true, onClick: () => this._confirmDelete(record) },
      { separator: true },
      { sectionLabel: 'Interaktionen' },
      ...actions.map(a => ({
        label: a.label || a.key,
        onClick: () => this._triggerAction(record, a.key)
      }))
    ]

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
