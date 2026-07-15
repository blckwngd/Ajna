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
import { applyInteractionSideEffect } from './InteractionReply.js'

const FALLBACK_ACTIONS = [
  { key: 'examine', label: 'Untersuchen' }
]

export class ObjectActions {
  constructor({ ajna, editorUI, contextMenu, permissionDialog, onInteract }) {
    this.ajna = ajna
    this.editorUI = editorUI
    this.contextMenu = contextMenu
    this.permissionDialog = permissionDialog
    // Erfolgs-Callback nach einer Interaktion (record, actionKey) — die View
    // verdrahtet hier ihr sicht-/hörbares Feedback (Toast/Highlight/TTS).
    this.onInteract = onInteract || null
  }

  // record = PocketBase-Record. x/y = Viewport-Pixelposition (für Menü).
  showFor(record, x, y) {
    if (!record) return

    // Aktions-Quelle: bevorzugt ein Top-Level-`actions`-Feld, sonst die vom
    // Objekt in `state.actions` hinterlegte Liste (so liefern World-Director-
    // Figuren z. B. "Sprechen"/"Füttern"). Fallback: nur "Untersuchen".
    const stateActions = Array.isArray(record.state?.actions) ? record.state.actions : null
    const actions = (Array.isArray(record.actions) && record.actions.length > 0)
      ? record.actions
      : (stateActions && stateActions.length > 0)
        ? stateActions
        : FALLBACK_ACTIONS

    // Owner-Check: nur Besitzer dürfen Berechtigungen verwalten. Bei
    // Multi-Server den passenden AjnaClient für record._origin nehmen,
    // weil der eingeloggte User pro Server unterschiedlich sein kann.
    const client = this.ajna.clients?.get(record._origin) || this.ajna.defaultClient
    const me = client?.currentUser?.()
    const isOwner = !!me && !!record.owner && me.id === record.owner

    // Einsammeln: eigene Objekte immer, fremde nur wenn `portable`. Nicht,
    // wenn das Objekt schon getragen wird. Server prüft die Rechte final.
    const collectible = !record.carried_by && (isOwner || !!record.state?.portable)

    // Aufträge: nur anbieten, was gerade wirklich möglich ist.
    const shownActions = record.type === 'call'
      ? this._callActions(record, actions, me, isOwner)
      : actions

    const items = [
      { label: 'Bearbeiten',     onClick: () => this.editorUI?.fillEditor?.(record) },
      isOwner && { label: 'Berechtigungen', onClick: () => this.permissionDialog?.open(record) },
      collectible && { label: '🎒 Einsammeln', onClick: () => this._pickup(record) },
      isOwner && { label: 'Löschen', danger: true, onClick: () => this._confirmDelete(record) },
      { separator: true },
      { sectionLabel: 'Interaktionen' },
      ...shownActions.map(a => ({
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

  /**
   * Auftrags-Aktionen nach Status filtern — nur zeigen, was gerade geht:
   *   • „Annehmen"  nur solange der Auftrag offen ist (und nicht dein eigener:
   *     den eigenen darf man laut Server nicht abschließen — Sackgasse).
   *   • „Erledigt"  nur wenn DU ihn angenommen hast (sonst antwortet der Server
   *     mit 403 — ein Knopf, der immer scheitert, gehört nicht ins Menü).
   *   • bei 'pending' (Agent prüft), 'done', 'cancelled' ist nichts zu tun.
   * „Untersuchen" wird immer ergänzt: sonst bekäme der Spieler die Aufgabe nie
   * zu Gesicht (die Beschreibung steht in state.call.task).
   */
  _callActions(record, actions, me, isOwner) {
    const c = record.state?.call || {}
    const status = c.status || 'open'
    const claimedByMe = !!me && c.claimedBy === me.id
    const out = actions.filter(a => {
      const k = String(a?.key || '').toLowerCase()
      if (k === 'accept' || k === 'annehmen') return status === 'open' && !isOwner
      if (k === 'complete' || k === 'erledigt' || k === 'erledigen') return status === 'claimed' && claimedByMe
      return true
    })
    if (!out.some(a => /^(examine|lesen|read)$/i.test(String(a?.key || '')))) {
      out.unshift({ key: 'examine', label: 'Untersuchen' })
    }
    return out
  }

  // Ruft die serverseitige Route auf, die nach Permission-Check ein
  // ephemeres Event über den PocketBase-Subscriptions-Broker an alle
  // interessierten Clients (inkl. dem zugewiesenen Agent) verteilt.
  async _triggerAction(record, actionKey) {
    try {
      const res = await this.ajna.interact(record.id, actionKey)
      console.log('[interact]', actionKey, '→', res)
      // Sicht-/hörbares Feedback (Reply-Toast, Highlight-Puls, TTS-Ansage) —
      // BEVOR eine evtl. Nebenwirkung den Record entfernt.
      try { this.onInteract?.(record, actionKey) } catch (e) { console.warn('[interact] feedback', e) }
      // Nebenwirkung (z. B. „Einsammeln" → Objekt löschen, falls berechtigt).
      await applyInteractionSideEffect(this.ajna, record, actionKey)
    } catch (err) {
      // Der interact-Hook antwortet mit { error: "…" } (nicht PB-Standard
      // { message }), deshalb response.error zuerst prüfen — sonst zeigt das
      // SDK seine generische Default-Message ("Something went wrong …").
      const detail = err?.response?.error
                  || err?.response?.message
                  || err?.response?.data?.error
                  || err?.message || String(err)
      console.warn('[interact] failed:', detail)
      alert(`Interaktion "${actionKey}" nicht möglich: ${detail}`)
    }
  }

  // Einsammeln → Inventar (server-autoritativ). Bei fehlenden Rechten (403)
  // eine kurze Meldung; sonst zieht das Objekt via Realtime ins Inventar um.
  async _pickup(record) {
    try {
      await this.ajna.pickup(record.id)
    } catch (err) {
      const detail = err?.response?.error || err?.message || String(err)
      console.warn('[inventory] Aufnehmen fehlgeschlagen:', detail)
      alert('Aufnehmen nicht möglich: ' + detail)
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
