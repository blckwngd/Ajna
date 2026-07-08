// InventoryUI — Inventar-Fenster (Karte + AR), im Stil klassischer Rollenspiel-
// Inventare. Zeigt zwei Bereiche:
//   • Gegenstände — Welt-Objekte, die der User trägt (carried_by = ich). Icon =
//     dasselbe Emoji wie auf der Karte. Aktionen je Item: Untersuchen,
//     Bearbeiten (Standard-Editor), Platzieren (zurück in die Welt), Löschen.
//   • Geräte — verbundene BLE-Geräte (Wand/UWB) als synthetische Kacheln mit
//     Status + gerätespezifischen Aktionen (vom Host über getDevices geliefert).
//
// Platzieren: Item wählen → „Platzieren" ruft onPlace(record) (Host schaltet in
// den Tipp-Modus: nächster Tipp auf Karte/AR-Boden setzt das Objekt). Zusätzlich
// ist jede Item-Kachel ein Drag&Drop-Quell-Element (Desktop) — der Host lauscht
// auf 'drop' und liest die Objekt-ID aus dataTransfer (DRAG_MIME).
//
// Selbst-enthaltend: erzeugt einen schwebenden 🎒-Button + das Overlay-Fenster
// und injiziert eigenes CSS. Der Host reicht nur Callbacks herein.

import { emojiOf } from './Appearance.js'

export const DRAG_MIME = 'application/x-ajna-inventory-item'

// Fallback-Emoji je Typ (wenn appearance.emoji fehlt) — spiegelt die Karte.
const TYPE_EMOJI = {
  npc: '🧑', enemy: '👹', animal: '🐾', dragon: '🐉',
  item: '💎', hint: '💡', poi: '📍', wifi: '📶',
}
const iconFor = (obj) => emojiOf(obj) || TYPE_EMOJI[(obj.type || '').toLowerCase()] || '📦'

export class InventoryUI {
  /**
   * @param {{
   *   ajna: import('./AjnaManager.js').AjnaManager,
   *   editorUI?: object,
   *   onExamine?: (record:object)=>void,
   *   onPlace?: (record:object)=>void,
   *   getDevices?: ()=>Array<{key:string,name:string,emoji:string,connected:boolean,actions?:Array<{label:string,run:()=>void,danger?:boolean}>}>,
   * }} opts
   */
  constructor({ ajna, editorUI = null, onExamine = null, onPlace = null, getDevices = null, container = null } = {}) {
    this.ajna = ajna
    this.editorUI = editorUI
    this.onExamine = onExamine
    this.onPlace = onPlace
    this.getDevices = getDevices
    // FAB + Fenster in den View-Container hängen (nicht document.body): so
    // blendet die Shell sie mit dem inaktiven Tab aus (.shell-view display:none)
    // — sonst gäbe es doppelte 🎒-Buttons (map- + ar-Bundle laufen parallel).
    this.container = container || document.body
    this._open = false
    this._selectedId = null
    this._injectStyles()
    this._buildDom()
    // Live-Refresh: Inventar ändert sich, sobald Objekte auf-/abgelegt werden.
    this._unsub = ajna.onObjectsChanged?.(() => { if (this._open) this._render() }) || null
  }

  toggle() { this._open ? this.close() : this.open() }
  open()  { this._open = true;  this.root.hidden = false; this._render() }
  close() { this._open = false; this.root.hidden = true; this._selectedId = null }
  /** Neu zeichnen, falls offen (z. B. nach Geräte-Statuswechsel). */
  refresh() { if (this._open) this._render() }

  // ── DOM ──────────────────────────────────────────────────────────────
  _buildDom() {
    // Schwebender Öffnen-Button
    this.fab = document.createElement('button')
    this.fab.className = 'ajna-inv-fab'
    this.fab.type = 'button'
    this.fab.title = 'Inventar'
    this.fab.textContent = '🎒'
    this.fab.addEventListener('click', () => this.toggle())
    this.container.appendChild(this.fab)

    // Overlay-Fenster
    this.root = document.createElement('div')
    this.root.className = 'ajna-inv-overlay'
    this.root.hidden = true
    this.root.innerHTML = `
      <div class="ajna-inv-window" role="dialog" aria-label="Inventar">
        <div class="ajna-inv-head">
          <span class="ajna-inv-title">🎒 Inventar</span>
          <button type="button" class="ajna-inv-close" title="Schließen">✕</button>
        </div>
        <div class="ajna-inv-body">
          <div class="ajna-inv-section-label">Gegenstände</div>
          <div class="ajna-inv-grid" data-role="items"></div>
          <div class="ajna-inv-section-label" data-role="devices-label">Geräte</div>
          <div class="ajna-inv-grid" data-role="devices"></div>
        </div>
        <div class="ajna-inv-foot" data-role="foot" hidden></div>
      </div>`
    // Klick auf den dunklen Rand schließt.
    this.root.addEventListener('click', (e) => { if (e.target === this.root) this.close() })
    this.root.querySelector('.ajna-inv-close').addEventListener('click', () => this.close())
    this.container.appendChild(this.root)
    this._itemsEl = this.root.querySelector('[data-role="items"]')
    this._devicesEl = this.root.querySelector('[data-role="devices"]')
    this._devicesLabel = this.root.querySelector('[data-role="devices-label"]')
    this._footEl = this.root.querySelector('[data-role="foot"]')
  }

  // ── Render ───────────────────────────────────────────────────────────
  _render() {
    const items = this.ajna.inventoryItems?.() || []
    this._itemsEl.innerHTML = ''
    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'ajna-inv-empty'
      empty.textContent = 'Inventar leer — Objekte über „Einsammeln" aufnehmen.'
      this._itemsEl.appendChild(empty)
    } else {
      // Stapelbare Items (state.stackable) nach Name+Modell gruppieren → EINE
      // Kachel mit ×N-Badge; alles andere einzeln. Aktionen wirken auf eine
      // Instanz (das Repräsentanten-Objekt) — Platzieren/Löschen zählt den Stapel
      // beim nächsten Render runter.
      const stacks = new Map()
      const singles = []
      for (const rec of items) {
        if (rec.state?.stackable) {
          const key = (rec.name || '') + '|' + (rec.appearance?.gltf || '')
          const s = stacks.get(key) || { rep: rec, count: 0 }
          s.count++
          stacks.set(key, s)
        } else singles.push(rec)
      }
      for (const rec of singles) this._itemsEl.appendChild(this._itemTile(rec))
      for (const s of stacks.values()) this._itemsEl.appendChild(this._itemTile(s.rep, s.count))
    }

    // Geräte-Kacheln (optional)
    const devices = this.getDevices?.() || []
    this._devicesLabel.hidden = devices.length === 0
    this._devicesEl.hidden = devices.length === 0
    this._devicesEl.innerHTML = ''
    for (const d of devices) this._devicesEl.appendChild(this._deviceTile(d))

    // Fußzeile für die aktuelle Auswahl aktualisieren.
    this._renderFoot()
  }

  _itemTile(rec, count = 1) {
    const tile = document.createElement('div')
    tile.className = 'ajna-inv-slot' + (rec.id === this._selectedId ? ' selected' : '')
    tile.draggable = true
    tile.title = count > 1 ? `${rec.name || rec.id} ×${count}` : (rec.name || rec.id)
    const badge = count > 1 ? `<span class="ajna-inv-badge">×${count}</span>` : ''
    tile.innerHTML = `<span class="ajna-inv-emoji">${iconFor(rec)}</span><span class="ajna-inv-name"></span>${badge}`
    tile.querySelector('.ajna-inv-name').textContent = rec.name || rec.id
    tile.addEventListener('click', () => {
      this._selectedId = this._selectedId === rec.id ? null : rec.id
      this._render()
    })
    // Drag&Drop-Quelle (Desktop): Objekt-ID + Klartext.
    tile.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(DRAG_MIME, rec.id)
      e.dataTransfer.setData('text/plain', rec.id)
      e.dataTransfer.effectAllowed = 'move'
    })
    return tile
  }

  _deviceTile(d) {
    const tile = document.createElement('div')
    tile.className = 'ajna-inv-slot device' + (d.connected ? '' : ' offline')
    tile.title = d.name
    tile.innerHTML = `
      <span class="ajna-inv-emoji">${d.emoji || '🔧'}</span>
      <span class="ajna-inv-name"></span>
      <span class="ajna-inv-status">${d.connected ? 'verbunden' : 'getrennt'}</span>`
    tile.querySelector('.ajna-inv-name').textContent = d.name
    tile.addEventListener('click', () => {
      this._selectedId = this._selectedId === `dev:${d.key}` ? null : `dev:${d.key}`
      this._render()
    })
    return tile
  }

  // Aktionsleiste für die aktuelle Auswahl (Item oder Gerät).
  _renderFoot() {
    const foot = this._footEl
    foot.innerHTML = ''
    if (!this._selectedId) { foot.hidden = true; return }

    let name = ''
    let actions = []
    if (this._selectedId.startsWith('dev:')) {
      const d = (this.getDevices?.() || []).find(x => `dev:${x.key}` === this._selectedId)
      if (!d) { this._selectedId = null; foot.hidden = true; return }
      name = d.name
      actions = (d.actions || []).map(a => ({ label: a.label, danger: a.danger, run: () => { a.run?.(); } }))
    } else {
      const rec = (this.ajna.inventoryItems?.() || []).find(r => r.id === this._selectedId)
      if (!rec) { this._selectedId = null; foot.hidden = true; return }
      name = rec.name || rec.id
      actions = [
        { label: '🔍 Untersuchen', run: () => this.onExamine?.(rec) },
        { label: '✏️ Bearbeiten', run: () => { this.editorUI?.fillEditor?.(rec); this.close() } },
        { label: '📍 Platzieren', run: () => { this.close(); this.onPlace?.(rec) } },
        { label: '🗑 Löschen', danger: true, run: () => this._delete(rec) },
      ]
    }

    const label = document.createElement('div')
    label.className = 'ajna-inv-foot-name'
    label.textContent = name
    foot.appendChild(label)
    const bar = document.createElement('div')
    bar.className = 'ajna-inv-foot-actions'
    for (const a of actions) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ajna-inv-act' + (a.danger ? ' danger' : '')
      b.textContent = a.label
      b.addEventListener('click', () => a.run())
      bar.appendChild(b)
    }
    foot.appendChild(bar)
    foot.hidden = false
  }

  async _delete(rec) {
    if (!window.confirm(`"${rec.name || rec.id}" wirklich löschen?`)) return
    try { await this.ajna.deleteObject(rec.id); this._selectedId = null; this._render() }
    catch (err) { alert('Löschen fehlgeschlagen: ' + (err?.message || err)) }
  }

  dispose() { try { this._unsub?.() } catch {} ; this.root?.remove(); this.fab?.remove() }

  // ── CSS ──────────────────────────────────────────────────────────────
  _injectStyles() {
    if (document.getElementById('ajna-inv-styles')) return
    const bottom = 'calc(var(--tabbar-height, 0px) + var(--safe-bottom, env(safe-area-inset-bottom, 0px)) + 16px)'
    const s = document.createElement('style')
    s.id = 'ajna-inv-styles'
    s.textContent = `
      .ajna-inv-fab {
        position: fixed; right: 16px; bottom: ${bottom}; z-index: 4000;
        width: 52px; height: 52px; border-radius: 50%; border: 1px solid #3a3a44;
        background: rgba(24,24,30,0.94); color: #fff; font-size: 24px; cursor: pointer;
        box-shadow: 0 3px 12px rgba(0,0,0,0.4);
      }
      .ajna-inv-fab:active { transform: scale(0.96); }
      .ajna-inv-overlay {
        position: fixed; inset: 0; z-index: 5500; display: flex;
        align-items: center; justify-content: center;
        background: rgba(0,0,0,0.5); padding: 16px;
        padding-bottom: calc(16px + var(--safe-bottom, env(safe-area-inset-bottom, 0px)));
      }
      /* Höhere Spezifität als die Basisregel, sonst überstimmt display:flex das
         hidden-Attribut → Fenster wäre immer offen und ließe sich nicht schließen. */
      .ajna-inv-overlay[hidden] { display: none; }
      .ajna-inv-window {
        width: min(560px, 96vw); max-height: 82vh; display: flex; flex-direction: column;
        background: linear-gradient(180deg, #23242c, #1a1b21);
        border: 2px solid #4a3f2e; border-radius: 12px; color: #e8e6df;
        box-shadow: 0 10px 40px rgba(0,0,0,0.6); overflow: hidden;
        font: 14px system-ui, sans-serif;
      }
      .ajna-inv-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 14px; background: rgba(74,63,46,0.35);
        border-bottom: 1px solid #4a3f2e;
      }
      .ajna-inv-title { font-weight: 700; letter-spacing: 0.3px; }
      .ajna-inv-close {
        background: none; border: none; color: #bbb; font-size: 18px; cursor: pointer;
      }
      .ajna-inv-body { padding: 12px 14px; overflow-y: auto; }
      .ajna-inv-section-label {
        font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px;
        color: #b9a77f; margin: 4px 0 8px;
      }
      .ajna-inv-grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(78px, 1fr));
        gap: 8px; margin-bottom: 12px;
      }
      .ajna-inv-slot {
        position: relative;
        display: flex; flex-direction: column; align-items: center; gap: 4px;
        padding: 8px 4px; min-height: 78px; cursor: pointer; user-select: none;
        background: rgba(255,255,255,0.04); border: 1px solid #3a3a44; border-radius: 8px;
        text-align: center;
      }
      .ajna-inv-badge {
        position: absolute; top: 3px; right: 4px;
        background: #c9a24b; color: #1a1a1a; font: 700 10px/15px system-ui, sans-serif;
        border-radius: 8px; padding: 0 5px; min-width: 15px;
      }
      .ajna-inv-slot:hover { background: rgba(255,255,255,0.08); }
      .ajna-inv-slot.selected { border-color: #c9a24b; box-shadow: 0 0 0 1px #c9a24b inset; }
      .ajna-inv-slot.device.offline { opacity: 0.55; }
      .ajna-inv-emoji { font-size: 30px; line-height: 1; }
      .ajna-inv-name {
        font-size: 11px; line-height: 1.15; max-width: 100%;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; width: 100%;
      }
      .ajna-inv-status { font-size: 9px; color: #9a9; }
      .ajna-inv-empty { color: #8a8a90; font-size: 13px; padding: 12px 4px; }
      .ajna-inv-foot {
        border-top: 1px solid #4a3f2e; padding: 10px 14px; background: rgba(0,0,0,0.25);
      }
      .ajna-inv-foot-name { font-weight: 600; margin-bottom: 8px; }
      .ajna-inv-foot-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .ajna-inv-act {
        padding: 7px 11px; border-radius: 8px; border: 1px solid #3a3a44;
        background: rgba(255,255,255,0.06); color: #e8e6df; font-size: 13px; cursor: pointer;
      }
      .ajna-inv-act:hover { background: rgba(255,255,255,0.12); }
      .ajna-inv-act.danger { border-color: #7a3a3a; color: #f2b8b8; }
    `
    document.head.appendChild(s)
  }
}
