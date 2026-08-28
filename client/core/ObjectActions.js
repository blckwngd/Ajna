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
import { provenanceText } from './Provenance.js'
import { applyInteractionSideEffect } from './InteractionReply.js'
import { privacy } from './PrivacyPolicy.js'
import { aktionErlaubt, reichweiteVon, abstandM } from './aktionsReichweite.js'
import { wikiLinkOf } from './wikiLinks.js'
import { t } from './i18n.js'

const FALLBACK_ACTIONS = [
  { key: 'examine', label: 'Untersuchen' }
]

// Beschriftungen für bekannte Aktions-Keys. Greift, wenn ein Record seine
// Aktionen OHNE `label` liefert (z. B. per API/Agent angelegt) — sonst stünde
// der rohe Key im Menü („complete").
const ACTION_LABELS = {
  examine: 'Untersuchen', lesen: 'Lesen', read: 'Lesen',
  talk: 'Sprechen', sprechen: 'Sprechen',
  attack: 'Angreifen', feed: 'Füttern', collect: 'Einsammeln',
  accept: t('Auftrag annehmen'), annehmen: t('Auftrag annehmen'),
  complete: t('Auftrag erledigen'), erledigt: t('Auftrag erledigen'), erledigen: t('Auftrag erledigen'),
  call: 'Rufen', rufen: 'Rufen',
}

// Aktionen, die dem Agent die eigene Position mitgeben müssen, damit er
// überhaupt etwas tun kann („komm zu mir"). WIE genau die Position mitgeht,
// entscheidet allein die Privatsphäre-Stufe (privacy.positionFor) — hier steht
// nur, WELCHE Aktionen sie brauchen.
const POSITION_ACTIONS = new Set(['call', 'rufen'])
// Aktionen, die ein Gespräch öffnen statt ein Ereignis zu senden.
const TALK_ACTIONS = new Set(['talk', 'sprechen'])
const labelFor = (a) => a?.label || ACTION_LABELS[String(a?.key || '').toLowerCase()] || a?.key || '?'

export class ObjectActions {
  constructor({ ajna, editorUI, contextMenu, permissionDialog, onInteract, onInteractError, getPosition, onGizmo, onTalk }) {
    this.ajna = ajna
    this.editorUI = editorUI
    this.contextMenu = contextMenu
    this.permissionDialog = permissionDialog
    // „Verschieben/Drehen": heftet das Editor-Gizmo an das Objekt (AR-View).
    this.onGizmo = onGizmo || null
    // „Sprechen“ öffnet ein Gespräch statt ein Interaktions-Ereignis zu senden.
    this.onTalk = onTalk || null
    // EXAKTE Position des Spielers (bleibt auf dem Gerät). Nur Aktionen aus
    // POSITION_ACTIONS bekommen daraus überhaupt etwas mit — und auch dann nur
    // so genau, wie die Stufe für DIESEN Server es erlaubt.
    this.getPosition = getPosition || null
    // Erfolgs-Callback nach einer Interaktion (record, actionKey) — die View
    // verdrahtet hier ihr sicht-/hörbares Feedback (Toast/Highlight/TTS).
    this.onInteract = onInteract || null
    // Fehler-Callback (record, actionKey, message), wenn der Server die Wirkung
    // ablehnt — sonst würde der Erfolgs-Toast lügen. Ohne Callback: alert().
    this.onInteractError = onInteractError || null
  }

  /** Eingeloggter User für DIESES Objekt (Multi-Server: Client je `_origin`). */
  _meFor(record) {
    const client = this.ajna.clients?.get(record?._origin) || this.ajna.defaultClient
    return client?.currentUser?.() || null
  }

  /**
   * Die aufgelösten, gefilterten und beschrifteten Interaktionen eines Objekts —
   * exakt die Liste, die auch im Kontextmenü unter „Interaktionen" steht.
   *
   * Öffentlich, damit die Quick-Actions in 3D/AR dieselbe Quelle nutzen und
   * nicht auseinanderlaufen (Auftrags-Status-Filter, Beschriftungen, Fallback).
   *
   * @param {object} record
   * @returns {Array<{key:string,label:string}>}
   */
  actionsFor(record) {
    if (!record) return []
    // Aktions-Quelle: bevorzugt ein Top-Level-`actions`-Feld, sonst die vom
    // Objekt in `state.actions` hinterlegte Liste (so liefern World-Director-
    // Figuren z. B. "Sprechen"/"Füttern"). Fallback: nur "Untersuchen".
    const stateActions = Array.isArray(record.state?.actions) ? record.state.actions : null
    const actions = (Array.isArray(record.actions) && record.actions.length > 0)
      ? record.actions
      : (stateActions && stateActions.length > 0)
        ? stateActions
        : FALLBACK_ACTIONS
    // Aufträge: nur anbieten, was gerade wirklich möglich ist.
    const list = record.type === 'call'
      ? this._callActions(record, actions, this._meFor(record))
      : actions
    return list.map(a => ({ key: a.key, label: labelFor(a) }))
  }

  /** Interaktion auslösen — öffentlich für Quick-Actions und andere Views. */
  trigger(record, actionKey) { return this._triggerAction(record, actionKey) }

  // record = PocketBase-Record. x/y = Viewport-Pixelposition (für Menü).
  async showFor(record, x, y) {
    if (!record) return

    // Besitzer ODER User-/Gruppen-ACE mit owner-Recht dürfen Berechtigungen
    // verwalten und löschen (Server-Regeln seit Migration owner_right_in_rules).
    // myRights liest den effective_permissions-Cache — schnell und best effort:
    // schlägt die Abfrage fehl, bleibt es beim Besitzer-Check.
    const me = this._meFor(record)
    const isOwner = !!me && !!record.owner && me.id === record.owner
    let ownerRight = isOwner
    if (!ownerRight && me) {
      const r = await this.ajna.myRights?.(record.id)?.catch?.(() => null)
      ownerRight = !!(r?.rights || []).includes('owner')
    }

    // Einsammeln: eigene Objekte immer, fremde nur wenn `portable`. Nicht,
    // wenn das Objekt schon getragen wird. Server prüft die Rechte final.
    const collectible = !record.carried_by && (isOwner || !!record.state?.portable)

    const shownActions = this.actionsFor(record)

    // Wikipedia-/Commons-Link (Sicherheits-Allowlist: nur Wikimedia-Hosts,
    // nur state.source === "wikipedia" — siehe wikiLinks.js).
    const wikiUrl = wikiLinkOf(record)

    const items = [
      { label: 'Bearbeiten',     onClick: () => this.editorUI?.fillEditor?.(record) },
      this.onGizmo && { label: '✥ Verschieben/Drehen', onClick: () => this.onGizmo(record) },
      wikiUrl && {
        label: record.state?.wiki_kind === 'image' ? '🔗 Auf Commons öffnen' : '🔗 Wikipedia öffnen',
        onClick: () => window.open(wikiUrl, '_blank', 'noopener')
      },
      ownerRight && { label: 'Berechtigungen', onClick: () => this.permissionDialog?.open(record) },
      collectible && { label: '🎒 Einsammeln', onClick: () => this._pickup(record) },
      ownerRight && { label: 'Löschen', danger: true, onClick: () => this._confirmDelete(record) },
      { separator: true },
      { sectionLabel: 'Interaktionen' },
      // Aktionen mit Reichweite (`max_distance`) ausgrauen statt anbieten:
      // Ein Knopf, der nichts tut, ist schlimmer als kein Knopf. Der Grund
      // steht in der Zeile, sonst bliebe der Spieler ratlos.
      ...shownActions.map(a => {
        const roh = (record?.state?.actions || []).find(x => x?.key === a.key)
        const pruef = this._reichweitePruefen(record, roh)
        return {
          label: pruef.ok ? a.label : `${a.label} — ${pruef.kurz}`,
          disabled: !pruef.ok,
          onClick: () => this._triggerAction(record, a.key)
        }
      })
    ].filter(Boolean)

    // Server-Hinweis im Titel — Plain-Text-Suffix, da der ContextMenu
    // den Header per textContent rendert (kein HTML-Badge möglich).
    // Suffix ist leer, wenn nur ein Server registriert ist.
    const originSuffix = renderServerBadgeText(this.ajna, record._origin)
    // Herkunft nur, wenn sie NICHT stimmt — im Menütitel ist Platz knapp, und
    // eine Bestätigung, die immer dasteht, liest niemand mehr.
    const provWarn = provenanceText(window.agentFilters || null, record)
    const title = (provWarn ? `${provWarn}  ` : '')
      + (record.name || record.id) + (originSuffix ? `  ${originSuffix}` : '')

    this.contextMenu.show({
      x, y,
      title,
      items
    })
  }

  /**
   * Auftrags-Aktionen nach Status filtern — nur zeigen, was gerade geht:
   *   • „Annehmen"  nur solange der Auftrag offen ist. Auch der Aussteller darf
   *     das: seinen eigenen Auftrag durchzuspielen ist erlaubt (No-Op-Tausch)
   *     und beim Testen praktisch.
   *   • „Erledigt"  nur wenn DU ihn angenommen hast (sonst antwortet der Server
   *     mit 403 — ein Knopf, der immer scheitert, gehört nicht ins Menü).
   *   • bei 'pending' (Agent prüft), 'done', 'cancelled' ist nichts zu tun.
   * „Untersuchen" wird immer ergänzt: sonst bekäme der Spieler die Aufgabe nie
   * zu Gesicht (die Beschreibung steht in state.call.task).
   */
  _callActions(record, actions, me) {
    const c = record.state?.call || {}
    const status = c.status || 'open'
    const claimedByMe = !!me && c.claimedBy === me.id
    const out = actions.filter(a => {
      const k = String(a?.key || '').toLowerCase()
      if (k === 'accept' || k === 'annehmen') return status === 'open'
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
  /**
   * Reichweite einer Aktion prüfen — für die Menü-Darstellung.
   * Kurzform fürs Menü, ausführlich beim Auslösen (dort ist Platz).
   */
  _reichweitePruefen(record, aktion) {
    if (!reichweiteVon(aktion)) return { ok: true, kurz: '' }
    const stufe = privacy.levelFor(record?._origin)
    const p = this.getPosition?.()
    const d = p ? abstandM(record.lat, record.lon, p.lat, p.lon) : null
    const e = aktionErlaubt(aktion, stufe, d)
    if (e.ok) return { ok: true, kurz: '' }
    return {
      ok: false,
      kurz: e.grund === 'stufe' ? t('Standort-Freigabe nötig') : 'zu weit weg',
    }
  }

  async _triggerAction(record, actionKey) {
    // „Sprechen“ ist kein Interaktions-Ereignis, sondern der Einstieg in ein
    // Gespräch: Das Chatfenster wechselt in den Privatchat mit dem Konto, dem
    // die Figur gehört. Erst die dort getippten Nachrichten gehen über den
    // Chat-Transport an deren Agent.
    if (TALK_ACTIONS.has(String(actionKey).toLowerCase())) {
      this.onTalk?.(record)
      // Zusätzlich als Interaktion melden: Die Figur soll merken, dass jemand
      // vor ihr steht — sie hält an und ergreift das Wort. Ohne das säße der
      // Spieler vor einem leeren Chatfenster und müsste raten, wer anfängt.
      // Fehler bleiben still: nicht jede ansprechbare Figur hat einen Agent.
      this.ajna.interact(record.id, actionKey)
        .catch(err => console.debug('[talk] interact:', err?.message || err))
      return
    }
    try {
      // REICHWEITE (`max_distance` an der Aktion): Nähe lässt sich nur prüfen,
      // wenn der Standort überhaupt freigegeben ist. Hier wird ABGEBROCHEN
      // statt gesendet — der Agent lehnte sonst ab, und der Spieler stünde vor
      // einer Aktion, die scheinbar nichts tut. Siehe core/aktionsReichweite.js.
      const aktion = (record?.state?.actions || []).find(a => a?.key === actionKey)
      const reichw = reichweiteVon(aktion)
      if (reichw > 0) {
        const stufe = privacy.levelFor(record?._origin)
        const p = this.getPosition?.()
        const d = p ? abstandM(record.lat, record.lon, p.lat, p.lon) : null
        const erlaubt = aktionErlaubt(aktion, stufe, d)
        if (!erlaubt.ok) {
          try { this.onInteractError?.(record, actionKey, erlaubt.text) }
          catch (e) { console.warn('[interact] error feedback', e) }
          if (!this.onInteractError) alert(erlaubt.text)
          return
        }
      }

      // Positions-Aktionen („Rufen"): Payload streng nach Stufe. Bei „Verborgen"
      // gibt es keine Koordinaten — dann die Aktion gar nicht erst senden, sonst
      // flöge der Drache irgendwohin und der Spieler wüsste nicht, warum.
      let payload
      // Eine Aktion mit Reichweite braucht die Position beim Agent — sonst kann
      // er sie nicht prüfen. Sie geht wie immer durch die Stufe.
      if (reichw > 0 && !POSITION_ACTIONS.has(String(actionKey).toLowerCase())) {
        const at = privacy.positionFor(record?._origin, this.getPosition?.())
        if (at) payload = { at }
      }
      if (POSITION_ACTIONS.has(String(actionKey).toLowerCase())) {
        const serverId = record?._origin
        const at = privacy.positionFor(serverId, this.getPosition?.())
        if (!at) {
          const why = this.getPosition?.()
            ? `„${labelFor({ key: actionKey })}" braucht eine Standort-Freigabe für diesen Server (Einstellungen → Privatsphäre).`
            : t('Keine Position verfügbar.')
          try { this.onInteractError?.(record, actionKey, why) }
          catch (e) { console.warn('[interact] error feedback', e) }
          if (!this.onInteractError) alert(why)
          return
        }
        payload = { at }
      }
      const res = await this.ajna.interact(record.id, actionKey, payload)
      console.log('[interact]', actionKey, '→', res)
      // ZUERST die Nebenwirkung (Einsammeln → Inventar, Auftrag → annehmen/
      // abschließen), DANN das Feedback: der Reply-Text leitet sich nur aus dem
      // Aktions-Key ab und würde sonst Erfolg melden, obwohl der Server ablehnt.
      // (Früher lief das Feedback zuerst, weil „Einsammeln" das Objekt löschte —
      // seit dem Inventar-Umbau setzt es nur carried_by, der Record bleibt.)
      const effect = await applyInteractionSideEffect(this.ajna, record, actionKey)
      if (effect?.handled && !effect.ok) {
        try { this.onInteractError?.(record, actionKey, effect.error) }
        catch (e) { console.warn('[interact] error feedback', e) }
        if (!this.onInteractError) alert(t('Aktion nicht möglich: {grund}', { grund: effect.error }))
        return
      }
      // Sicht-/hörbares Feedback (Reply-Toast, Highlight-Puls, TTS-Ansage).
      try { this.onInteract?.(record, actionKey) } catch (e) { console.warn('[interact] feedback', e) }
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
      alert(t('Aufnehmen nicht möglich: {grund}', { grund: detail }))
    }
  }

  async _confirmDelete(record) {
    const label = record.name || record.id
    if (!window.confirm(`"${label}" wirklich löschen?`)) return
    try {
      await this.ajna.deleteObject(record.id)
    } catch (err) {
      console.warn('deleteObject fehlgeschlagen', err)
      alert(t('Löschen fehlgeschlagen: {grund}', { grund: err?.message || err }))
    }
  }
}
