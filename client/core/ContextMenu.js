// Wiederverwendbares Popover-Menü für Objekt-Aktionen.
// Item-Format:
//   { label, onClick, danger?, disabled? }    — klickbare Zeile
//   { separator: true }                       — Trennlinie
//   { sectionLabel: "..." }                   — Sub-Überschrift
export class ContextMenu {
  constructor() {
    this.el = null
    this._onDocClick = this._onDocClick.bind(this)
    this._onKey = this._onKey.bind(this)
    this._injectStyles()
  }

  _injectStyles() {
    if (document.getElementById('ajnaContextMenuStyles')) return
    const style = document.createElement('style')
    style.id = 'ajnaContextMenuStyles'
    style.textContent = `
      .ajna-context-menu {
        position: fixed;
        background: rgba(18,18,22,0.96);
        color: #eaeaea;
        border: 1px solid #3a3a44;
        border-radius: 6px;
        box-shadow: 0 6px 24px rgba(0,0,0,0.5);
        font: 12px ui-monospace, Menlo, Consolas, monospace;
        z-index: 5000;
        min-width: 200px;
        max-width: 280px;
        padding: 4px 0;
        user-select: none;
      }
      .ajna-context-menu .ctx-header {
        padding: 6px 12px 6px;
        font-size: 11px;
        color: #f1c40f;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        margin-bottom: 4px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ajna-context-menu .ctx-item {
        padding: 5px 14px;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ajna-context-menu .ctx-item:hover { background: #2c5d8f; }
      .ajna-context-menu .ctx-item.danger:hover { background: #8c3030; }
      .ajna-context-menu .ctx-item.disabled { color: #666; cursor: default; }
      .ajna-context-menu .ctx-item.disabled:hover { background: transparent; }
      .ajna-context-menu .ctx-separator {
        height: 1px;
        background: rgba(255,255,255,0.08);
        margin: 4px 0;
      }
      .ajna-context-menu .ctx-section-label {
        padding: 4px 14px 2px;
        font-size: 10px;
        color: #888;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
    `
    document.head.appendChild(style)
  }

  show({ x, y, title, items }) {
    this.hide()

    const el = document.createElement('div')
    el.className = 'ajna-context-menu'
    // Verhindert, dass ein Klick auf das Menü als "Außenklick" gewertet wird.
    el.addEventListener('click', ev => ev.stopPropagation())

    if (title) {
      const header = document.createElement('div')
      header.className = 'ctx-header'
      header.textContent = title
      el.appendChild(header)
    }

    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div')
        sep.className = 'ctx-separator'
        el.appendChild(sep)
        continue
      }
      if (item.sectionLabel) {
        const lbl = document.createElement('div')
        lbl.className = 'ctx-section-label'
        lbl.textContent = item.sectionLabel
        el.appendChild(lbl)
        continue
      }
      const row = document.createElement('div')
      row.className = 'ctx-item'
      if (item.danger) row.classList.add('danger')
      if (item.disabled) row.classList.add('disabled')
      row.textContent = item.label
      if (!item.disabled) {
        row.addEventListener('click', () => {
          this.hide()
          item.onClick?.()
        })
      }
      el.appendChild(row)
    }

    document.body.appendChild(el)

    // Positionieren — Viewport-Rand respektieren
    const rect = el.getBoundingClientRect()
    const maxX = window.innerWidth - rect.width - 8
    // Untere Steuerleisten (App-Tabbar + System-Navigation/Safe-Area) meiden,
    // sonst klemmt das Menü dahinter. Zone über dieselbe CSS-Berechnung messen
    // wie die Popups (Fallbacks greifen auf Standalone-Seiten ohne Shell-Vars).
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;left:-9999px;bottom:0;width:0;'
      + 'height:calc(var(--tabbar-height, 0px) + var(--safe-bottom, env(safe-area-inset-bottom, 0px)))'
    document.body.appendChild(probe)
    const bottomInset = probe.getBoundingClientRect().height
    probe.remove()
    const maxY = window.innerHeight - bottomInset - rect.height - 8
    el.style.left = Math.min(Math.max(x, 8), maxX) + 'px'
    el.style.top  = Math.min(Math.max(y, 8), maxY) + 'px'

    this.el = el

    // setTimeout, damit der aktuelle Click-Event (der das Menü gerade
    // geöffnet hat) das Listener-Setup nicht direkt auslöst.
    setTimeout(() => {
      document.addEventListener('click', this._onDocClick)
      document.addEventListener('keydown', this._onKey)
    }, 0)
  }

  _onDocClick(ev) {
    if (this.el && !this.el.contains(ev.target)) this.hide()
  }

  _onKey(ev) {
    if (ev.key === 'Escape') this.hide()
  }

  hide() {
    document.removeEventListener('click', this._onDocClick)
    document.removeEventListener('keydown', this._onKey)
    if (this.el) {
      this.el.remove()
      this.el = null
    }
  }
}
