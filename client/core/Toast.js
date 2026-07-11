// Minimaler Toast-Notifier — zentriert am unteren Bildschirmrand.
// Mehrere Toasts stapeln sich übereinander; jeder verschwindet nach
// `timeout` ms automatisch.
export class Toast {
  constructor() {
    this._injectStyles()
    this.container = document.createElement('div')
    this.container.className = 'ajna-toast-container'
    document.body.appendChild(this.container)
  }

  _injectStyles() {
    if (document.getElementById('ajnaToastStyles')) return
    const style = document.createElement('style')
    style.id = 'ajnaToastStyles'
    style.textContent = `
      .ajna-toast-container {
        position: fixed;
        /* Über App-Tabbar UND System-Navigationsleiste (Safe-Area) halten, sonst
           verschwindet der Toast dahinter. Fallbacks (0px / env()) greifen auf
           den Standalone-Seiten ohne Shell-Variablen. */
        bottom: calc(var(--tabbar-height, 0px) + var(--safe-bottom, env(safe-area-inset-bottom, 0px)) + 16px);
        left: 50%;
        transform: translateX(-50%);
        display: flex; flex-direction: column;
        gap: 6px; align-items: center;
        pointer-events: none;
        z-index: 6000;
      }
      .ajna-toast {
        background: rgba(18,18,22,0.92);
        color: #eaeaea;
        font: 12px ui-monospace, Menlo, Consolas, monospace;
        padding: 8px 14px;
        border-radius: 6px;
        border: 1px solid #3a3a44;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
        max-width: 70vw;
        opacity: 0;
        transform: translateY(10px);
        transition: opacity 180ms ease-out, transform 180ms ease-out;
      }
      .ajna-toast.show { opacity: 1; transform: translateY(0); }
      .ajna-toast .toast-title {
        color: #f1c40f;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-size: 10px;
        margin-right: 8px;
      }
    `
    document.head.appendChild(style)
  }

  show(text, { title, timeout = 2000 } = {}) {
    // Kurzlebige Toasts zusätzlich in den persistenten Verlauf (Chat-/Debug-
    // Fenster), damit Hinweise/Fehler später nachvollziehbar bleiben.
    try { window.ajnaLog?.push(title ? `${title}: ${text}` : text, 'system') } catch {}
    const el = document.createElement('div')
    el.className = 'ajna-toast'
    if (title) {
      const t = document.createElement('span')
      t.className = 'toast-title'
      t.textContent = title
      el.appendChild(t)
    }
    el.appendChild(document.createTextNode(text))
    this.container.appendChild(el)

    // Fade-in
    requestAnimationFrame(() => el.classList.add('show'))

    setTimeout(() => {
      el.classList.remove('show')
      setTimeout(() => el.remove(), 200)
    }, timeout)
  }
}
