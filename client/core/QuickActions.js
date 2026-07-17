// QuickActions — Schnellzugriff-Knöpfe am rechten Bildschirmrand für das aktuell
// ANVISIERTE oder GELOCKTE Objekt (3D- und AR-Ansicht).
//
// Zeigt die ersten `max` Interaktionen aus DERSELBEN Liste wie das Kontextmenü
// (ObjectActions.actionsFor) — inklusive Auftrags-Status-Filter und
// Beschriftungen. Damit können Menü und Schnellzugriff nicht auseinanderlaufen.
//
// Reine Anzeige + Auslösen: den Fokus liefert der Aufrufer via setTarget(),
// die Wirkung läuft über den injizierten onAction-Callback.

const STYLE_ID = 'ajna-quickactions-style'

export class QuickActions {
  /**
   * @param {{parent?:HTMLElement, getActions:(rec:object)=>Array<{key:string,label:string}>,
   *          onAction:(rec:object, key:string)=>void, max?:number}} opts
   */
  constructor({ parent = document.body, getActions, onAction, max = 3 } = {}) {
    this.parent = parent
    this.getActions = getActions
    this.onAction = onAction
    this.max = max
    this._el = null
    this._record = null
    this._sig = null
    this._injectStyles()
  }

  /**
   * Fokussiertes Objekt setzen (null → ausblenden). Darf pro Frame kommen: eine
   * Signatur aus ID + Aktionen + Auftrags-Status verhindert unnötige Rebuilds,
   * lässt aber Änderungen (z. B. offen → angenommen) sofort durch.
   */
  setTarget(record) {
    if (!record) { this._hide(); return }
    const actions = (this.getActions?.(record) || []).slice(0, this.max)
    if (!actions.length) { this._hide(); return }
    const sig = `${record.id}:${record.state?.call?.status || ''}:${actions.map(a => a.key).join(',')}`
    this._record = record
    if (sig === this._sig) return
    this._sig = sig
    this._render(record, actions)
  }

  _hide() {
    this._record = null
    this._sig = null
    if (this._el) this._el.style.display = 'none'
  }

  _ensure() {
    if (this._el) return this._el
    const el = document.createElement('div')
    el.className = 'ajna-quickactions'
    this.parent.appendChild(el)
    this._el = el
    return el
  }

  _render(record, actions) {
    const el = this._ensure()
    el.textContent = ''
    for (const a of actions) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'ajna-qa-btn'
      btn.textContent = a.label          // Nutzertext → textContent, kein HTML
      btn.title = a.label
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation()             // nicht zusätzlich ins Objekt-Picking
        // Immer den AKTUELLEN Record nehmen: zwischen Rendern und Klick kann der
        // Fokus/Status gewechselt haben.
        const rec = this._record
        if (rec) this.onAction?.(rec, a.key)
      })
      // Verhindert, dass der Klick als Kamera-/Gaze-Interaktion durchschlägt.
      ;['pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach(t =>
        btn.addEventListener(t, ev => ev.stopPropagation()))
      el.appendChild(btn)
    }
    el.style.display = 'flex'
  }

  dispose() { this._el?.remove(); this._el = null; this._record = null; this._sig = null }

  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const css = `
    .ajna-quickactions{position:absolute;right:12px;top:50%;transform:translateY(-50%);z-index:1001;
      display:none;flex-direction:column;gap:8px;align-items:flex-end;max-width:44vw}
    .ajna-qa-btn{pointer-events:auto;cursor:pointer;
      background:rgba(0,0,0,.62);color:#fff;border:1px solid rgba(255,255,255,.22);
      border-radius:10px;padding:10px 14px;font:13px system-ui,sans-serif;
      backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);
      box-shadow:0 4px 16px rgba(0,0,0,.45);
      max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      min-height:40px}
    .ajna-qa-btn:active{transform:scale(.96);background:rgba(30,30,38,.85)}
    @media (max-width:480px){ .ajna-qa-btn{padding:9px 11px;font-size:12px;min-height:38px} }`
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = css
    document.head.appendChild(el)
  }
}
