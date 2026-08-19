// ObjectAura — schwebende „Call-Out"-Karte für das aktuell FOKUSSIERTE Objekt in
// der AR (das, worauf das Reticle zeigt). Zeigt Identität/Metadaten — NICHT
// Aktionen (die bleiben im Tap-Menü). Das ist die zivile Umsetzung der
// D-Raum-„Call-Outs" (schwebende Info über Entitäten).
//
// Datengetrieben: rendert nur vorhandene Felder. Sobald später Reputation,
// Fraktion oder Tags an Objekten existieren, taucht das ohne Codeänderung auf.
//
// Reine Anzeige. Der Fokus (welches Objekt) kommt vom Aufrufer via setTarget().

import { emojiOf } from './Appearance.js'
import { provenanceInfo } from './Provenance.js'
import { TYPE_LABEL } from './SpawnHere.js'
import { describeRequires } from './InteractionReply.js'

const FLAG_KEY = 'ajna.ar.aura'   // '0' blendet aus; Default an

export class ObjectAura {
  /**
   * @param {{ parent?:HTMLElement, getMe?:()=>({id?:string}|null),
   *           getFilters?:()=>object|null }} opts
   *   getFilters liefert die AgentFilters-Instanz — nur sie weiß, wem ein
   *   Source-Name gehört, und damit, ob die Herkunft eines Objekts stimmt.
   */
  constructor({ parent = document.body, getMe = () => null, getFilters = () => null } = {}) {
    this.parent = parent
    this.getMe = getMe
    this.getFilters = getFilters
    this._active = false     // AR-Modus an?
    this._card = null
    this._reticle = null
    this._lastSig = null
  }

  static enabled() { try { return localStorage.getItem(FLAG_KEY) !== '0' } catch { return true } }
  static setEnabled(on) { try { localStorage.setItem(FLAG_KEY, on ? '1' : '0') } catch {} }

  // AR-Modus an: Reticle zeigen (nur wenn eingeschaltet). Karte kommt bei Fokus.
  activate() {
    this._active = true
    if (ObjectAura.enabled()) this._showReticle(); else this._hideAll()
  }
  deactivate() { this._active = false; this._hideAll() }

  // Vom Einstellungs-Toggle (wirkt sofort, wenn AR aktiv).
  setVisible(on) {
    ObjectAura.setEnabled(on)
    if (!this._active) return
    if (on) this._showReticle(); else this._hideAll()
  }

  /** Fokussiertes Objekt setzen (null → Karte ausblenden). Kann pro Frame mit dem
   *  Live-Record aufgerufen werden — die Signatur (id + Call-Status) verhindert
   *  unnötige Rebuilds, lässt aber Status-Wechsel (offen→erledigt) sofort durch. */
  setTarget(record) {
    if (!this._active || !ObjectAura.enabled()) return
    const sig = record ? `${record.id}:${record.state?.call?.status || ''}` : null
    if (sig === this._lastSig) return
    this._lastSig = sig
    if (!record) { this._hideCard(); return }
    this._renderCard(record)
  }

  // ── DOM ──────────────────────────────────────────────────────────────
  _showReticle() {
    if (!this._reticle) {
      const r = document.createElement('div')
      r.style.cssText =
        'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:999;pointer-events:none;' +
        'width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.7);' +
        'box-shadow:0 0 4px rgba(0,0,0,.6);background:rgba(255,255,255,.12)'
      this.parent.appendChild(r)
      this._reticle = r
    }
    this._reticle.style.display = 'block'
  }

  _hideCard() { if (this._card) this._card.style.display = 'none' }
  _hideAll() {
    this._hideCard()
    if (this._reticle) this._reticle.style.display = 'none'
    this._lastSig = null
  }

  _ensureCard() {
    if (this._card) return this._card
    const el = document.createElement('div')
    el.className = 'ar-object-aura'
    // Unter dem Kompass-Badge (safe-top + 8), oberhalb der Bildmitte.
    el.style.cssText =
      'position:absolute;left:50%;transform:translateX(-50%);' +
      'top:calc(env(safe-area-inset-top, 0px) + 64px);z-index:1000;pointer-events:none;' +
      'min-width:150px;max-width:min(86vw,340px);text-align:center;' +
      'background:rgba(0,0,0,.6);color:#fff;font:13px system-ui,sans-serif;' +
      'padding:8px 12px;border-radius:11px;backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);' +
      'box-shadow:0 6px 22px rgba(0,0,0,.45)'
    this.parent.appendChild(el)
    this._card = el
    return el
  }

  _renderCard(record) {
    const el = this._ensureCard()
    el.textContent = ''   // leeren

    const typeText = TYPE_LABEL[record?.type] || record?.type || 'Objekt'
    let emoji = ''
    try { emoji = emojiOf(record) || '' } catch {}

    const head = document.createElement('div')
    head.style.cssText = 'font-size:11px;opacity:.75;letter-spacing:.02em'
    head.textContent = `${emoji ? emoji + ' ' : ''}${typeText}`.trim()

    const name = document.createElement('div')
    name.style.cssText = 'font-size:16px;font-weight:600;margin-top:1px;word-break:break-word'
    name.textContent = record?.name || record?.id || 'Objekt'

    el.append(head, name)

    // Chips — nur was vorhanden ist (wächst mit Reputation/Fraktion/Tags).
    const chips = []
    // Herkunft zuerst — sie entscheidet, wie der Rest zu lesen ist.
    const prov = provenanceInfo(this.getFilters?.(), record)
    if (prov) chips.push({ t: prov.text, c: prov.color, title: prov.title })
    const me = this.getMe?.()
    if (me?.id && record?.owner && me.id === record.owner) chips.push({ t: 'Deins', c: '#5b8dd6' })
    if (record?.state?.portable) chips.push({ t: '🎒 tragbar', c: '#6fae7a' })
    // Auftrag (Call): Belohnung + Status prominent.
    const call = record?.type === 'call' ? (record.state?.call || {}) : null
    if (call) {
      // Belohnung = treuhänderisch gebundene Items des Ausstellers (nie gemünzt).
      const rewards = Array.isArray(call.rewardItems) ? call.rewardItems.length : 0
      if (rewards) chips.push({ t: `🎁 ${rewards}`, c: '#e6b23a' })
      // Wiederholbar: der Vorrat sagt, wie oft noch.
      if (call.repeatable) {
        const perRun = Math.max(1, Number(call.rewardPerRun) || 1)
        chips.push({ t: `🔁 noch ${Math.floor(rewards / perRun)}×`, c: '#6fae7a' })
      }
      // Forderungen lesbar statt nur gezählt („📥 3× Wolfsfell").
      for (const r of describeRequires(call).slice(0, 3)) chips.push({ t: `📥 ${r}`, c: '#5b8dd6' })
      const st = {
        open: ['offen', '#54c26b'], claimed: ['angenommen', '#e6b23a'],
        pending: ['wird geprüft', '#5b8dd6'],
        done: ['erledigt', '#8a8f99'], cancelled: ['abgebrochen', '#8a8f99']
      }
      const [w, c] = st[call.status] || ['offen', '#54c26b']
      chips.push({ t: w, c })
    }
    if (Number.isFinite(record?.reputation)) chips.push({ t: `⭐ ${record.reputation}`, c: '#e6b23a' })
    const faction = record?.expand?.group?.name || record?.state?.faction
    if (faction) chips.push({ t: `🛡️ ${faction}`, c: '#c79be0' })
    const tags = Array.isArray(record?.state?.tags) ? record.state.tags : []
    for (const tag of tags.slice(0, 4)) if (tag) chips.push({ t: `#${tag}`, c: '#8a8f99' })

    if (chips.length) {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;justify-content:center;margin-top:7px'
      for (const c of chips) {
        const s = document.createElement('span')
        s.style.cssText = `font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.1);border-left:3px solid ${c.c}`
        if (c.title) s.title = c.title
        s.textContent = c.t
        row.appendChild(s)
      }
      el.appendChild(row)
    }

    // Notiz/Beschreibung (gekürzt), falls vorhanden — bei Calls der Auftragstext.
    const note = call?.task || record?.description || record?.state?.note
    if (note) {
      const n = document.createElement('div')
      n.style.cssText = 'font-size:12px;opacity:.85;margin-top:7px;line-height:1.3'
      const s = String(note)
      n.textContent = s.length > 140 ? s.slice(0, 139).trimEnd() + '…' : s
      el.appendChild(n)
    }

    el.style.display = 'block'
  }

  dispose() {
    this._card?.remove(); this._reticle?.remove()
    this._card = this._reticle = null
  }
}
