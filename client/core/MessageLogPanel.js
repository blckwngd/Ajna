// MessageLogPanel — das Chat-/Verlaufsfenster. Ein schwebender Auslöser (💬 mit
// Ungelesen-Zähler) öffnet ein scrollbares Fenster mit dem Nachrichtenverlauf
// aus MessageLog. Zwei Filter: „Verlauf" (nur Spieler-relevantes: Dialoge,
// Aktionen, System) und „Alle" (inkl. UWB/Debug zum Nachvollziehen von Fehlern).
//
// Body-Overlay + eigener Auslöser → funktioniert in jeder View, ohne dass die
// jeweilige View etwas beisteuern muss. Der Verlauf selbst ist persistent
// (MessageLog/localStorage), das Fenster ist nur die Ansicht.

import { messageLog, CATS } from './MessageLog.js'
import { makeDraggable } from './draggable.js'

const FILTER_KEY = 'ajna.msglog.filter'   // 'player' | 'all'
const STYLE_ID = 'ajna-msglog-style'

const fmtTime = (t) => { try { return new Date(t).toTimeString().slice(0, 5) } catch { return '' } }

export class MessageLogPanel {
  constructor({ parent = document.body } = {}) {
    this.parent = parent
    this._open = false
    this._unread = 0
    this._filter = (() => { try { return localStorage.getItem(FILTER_KEY) === 'all' ? 'all' : 'player' } catch { return 'player' } })()
    this._injectStyles()
    this._buildLauncher()
    // Live: Badge hochzählen (geschlossen) bzw. Liste ergänzen (offen).
    this._unsub = messageLog.onChange((entry) => this._onLog(entry))
  }

  destroy() {
    try { this._unsub?.() } catch {}
    try { this._dragCleanup?.() } catch {}
    this._launcher?.remove()
    this._overlay?.remove()
    this._launcher = this._overlay = null
  }

  _visible(entry) { return this._filter === 'all' || CATS[entry.cat]?.player }

  _onLog(entry) {
    if (entry === null) { if (this._open) this._renderList(); return }   // clear
    if (this._open) {
      if (this._visible(entry)) this._appendRow(entry)
    } else if (this._visible(entry)) {
      this._unread++
      this._updateBadge()
    }
  }

  // ── Auslöser (schwebender Button) ────────────────────────────────────
  _buildLauncher() {
    const btn = document.createElement('button')
    btn.className = 'ajna-msglog-launcher'
    btn.type = 'button'
    btn.setAttribute('aria-label', 'Verlauf')
    btn.innerHTML = '<span class="mlg-ico">💬</span><span class="mlg-badge" hidden>0</span>'
    this.parent.appendChild(btn)
    this._launcher = btn
    this._badge = btn.querySelector('.mlg-badge')
    // Verschiebbar (Position gemerkt); Tap ohne Bewegung öffnet/schließt.
    this._dragCleanup = makeDraggable(btn, { key: 'ajna.msglog.pos', onClick: () => this.toggle() })
  }

  _updateBadge() {
    if (!this._badge) return
    if (this._unread > 0) { this._badge.hidden = false; this._badge.textContent = this._unread > 99 ? '99+' : String(this._unread) }
    else this._badge.hidden = true
  }

  // ── Fenster ──────────────────────────────────────────────────────────
  toggle() { this._open ? this.close() : this.open() }

  open() {
    if (this._open) return
    this._open = true
    this._unread = 0
    this._updateBadge()
    const ov = document.createElement('div')
    ov.className = 'ajna-msglog-overlay'
    ov.innerHTML = `
      <div class="ajna-msglog" role="dialog" aria-modal="true" aria-label="Verlauf">
        <header>
          <h3>Verlauf</h3>
          <div class="mlg-filter" role="group">
            <button type="button" data-f="player" class="${this._filter === 'player' ? 'on' : ''}">Verlauf</button>
            <button type="button" data-f="all" class="${this._filter === 'all' ? 'on' : ''}">Alle</button>
          </div>
          <button class="mlg-clear" type="button" title="Verlauf leeren">Leeren</button>
          <button class="mlg-close" type="button" aria-label="Schließen">×</button>
        </header>
        <div class="mlg-list" data-role="list"></div>
      </div>`
    ov.addEventListener('click', e => { if (e.target === ov) this.close() })
    ov.querySelector('.mlg-close').addEventListener('click', () => this.close())
    ov.querySelector('.mlg-clear').addEventListener('click', () => {
      if (window.confirm('Verlauf wirklich leeren?')) messageLog.clear()
    })
    ov.querySelectorAll('.mlg-filter button').forEach(b =>
      b.addEventListener('click', () => this._setFilter(b.dataset.f, ov)))
    this.parent.appendChild(ov)
    this._overlay = ov
    this._listEl = ov.querySelector('[data-role="list"]')
    this._renderList()
  }

  close() {
    this._open = false
    this._overlay?.remove()
    this._overlay = this._listEl = null
  }

  _setFilter(f, ov) {
    this._filter = f === 'all' ? 'all' : 'player'
    try { localStorage.setItem(FILTER_KEY, this._filter) } catch {}
    ov.querySelectorAll('.mlg-filter button').forEach(b => b.classList.toggle('on', b.dataset.f === this._filter))
    this._renderList()
  }

  _rowHtml(entry) {
    const c = CATS[entry.cat] || CATS.system
    return `<div class="mlg-row mlg-${entry.cat}">`
      + `<span class="mlg-t">${fmtTime(entry.t)}</span>`
      + `<span class="mlg-i">${c.icon}</span>`
      + `<span class="mlg-x"></span>`
      + `</div>`
  }

  // Text als textContent setzen (kein HTML-Injection über Nachrichteninhalte).
  _appendRow(entry) {
    if (!this._listEl) return
    const atBottom = this._listEl.scrollHeight - this._listEl.scrollTop - this._listEl.clientHeight < 40
    const tmp = document.createElement('div')
    tmp.innerHTML = this._rowHtml(entry)
    const row = tmp.firstElementChild
    row.querySelector('.mlg-x').textContent = entry.text
    this._listEl.appendChild(row)
    if (atBottom) this._listEl.scrollTop = this._listEl.scrollHeight
  }

  _renderList() {
    if (!this._listEl) return
    const rows = messageLog.entries(e => this._visible(e))
    if (!rows.length) {
      this._listEl.innerHTML = '<div class="mlg-empty">Noch keine Einträge.</div>'
      return
    }
    this._listEl.innerHTML = rows.map(e => this._rowHtml(e)).join('')
    // Texte sicher als textContent nachtragen (Reihenfolge = rows).
    const xs = this._listEl.querySelectorAll('.mlg-x')
    rows.forEach((e, i) => { if (xs[i]) xs[i].textContent = e.text })
    this._listEl.scrollTop = this._listEl.scrollHeight
  }

  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const css = `
    .ajna-msglog-launcher{position:fixed;right:18px;bottom:calc(var(--tabbar-height,0px) + var(--safe-bottom,env(safe-area-inset-bottom,0px)) + 80px);z-index:5500;
      width:48px;height:48px;border-radius:50%;border:1px solid #3a3a44;background:rgba(24,24,30,.92);color:#eaeaea;
      font-size:22px;line-height:1;cursor:pointer;box-shadow:0 6px 22px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
    .ajna-msglog-launcher .mlg-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;
      background:#e0533b;color:#fff;font:600 11px system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
    .ajna-msglog-overlay{position:fixed;inset:0;z-index:6100;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center}
    .ajna-msglog{width:100%;max-width:560px;max-height:min(70vh,560px);display:flex;flex-direction:column;
      background:rgba(18,18,22,.98);color:#eaeaea;border:1px solid #34343e;border-bottom:none;border-radius:14px 14px 0 0;
      box-shadow:0 -8px 40px rgba(0,0,0,.5);padding-bottom:calc(var(--safe-bottom,env(safe-area-inset-bottom,0px)))}
    .ajna-msglog header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2b2b33}
    .ajna-msglog header h3{margin:0;font:600 15px system-ui,sans-serif;flex:0 0 auto}
    .ajna-msglog .mlg-filter{margin-left:auto;display:flex;border:1px solid #3a3a44;border-radius:8px;overflow:hidden}
    .ajna-msglog .mlg-filter button{background:none;border:none;color:#b8b8c0;font:12px system-ui,sans-serif;padding:4px 10px;cursor:pointer}
    .ajna-msglog .mlg-filter button.on{background:#33343e;color:#fff}
    .ajna-msglog .mlg-clear{background:none;border:1px solid #3a3a44;color:#c9c9d0;border-radius:8px;font:12px system-ui,sans-serif;padding:4px 10px;cursor:pointer}
    .ajna-msglog .mlg-close{background:none;border:none;color:#c9c9d0;font-size:22px;line-height:1;cursor:pointer;padding:0 4px}
    .ajna-msglog .mlg-list{overflow-y:auto;padding:8px 12px;flex:1;-webkit-overflow-scrolling:touch}
    .ajna-msglog .mlg-empty{opacity:.55;font:13px system-ui,sans-serif;text-align:center;padding:24px 0}
    .ajna-msglog .mlg-row{display:flex;gap:8px;align-items:baseline;padding:5px 8px;margin:3px 0;border-radius:8px;
      border-left:3px solid #444;background:rgba(255,255,255,.03);font:13px system-ui,sans-serif}
    .ajna-msglog .mlg-row .mlg-t{color:#7d7d88;font:11px ui-monospace,Menlo,Consolas,monospace;flex:0 0 auto}
    .ajna-msglog .mlg-row .mlg-i{flex:0 0 auto}
    .ajna-msglog .mlg-row .mlg-x{flex:1;word-break:break-word;white-space:pre-wrap}
    .ajna-msglog .mlg-dialog{border-left-color:#5b8dd6}
    .ajna-msglog .mlg-interact{border-left-color:#c79be0}
    .ajna-msglog .mlg-system{border-left-color:#6fae7a}
    .ajna-msglog .mlg-uwb{border-left-color:#d6a95b}
    .ajna-msglog .mlg-debug{border-left-color:#666;opacity:.85}
    .ajna-msglog .mlg-debug .mlg-x{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}`
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = css
    document.head.appendChild(el)
  }
}
