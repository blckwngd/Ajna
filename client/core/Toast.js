// Minimaler Toast-Notifier — zentriert am unteren Bildschirmrand.
// Mehrere Toasts stapeln sich untereinander (neuester unten, ältere rutschen
// nach oben); jeder verschwindet nach `timeout` ms automatisch.

const MAX_VISIBLE = 4        // mehr würde den Bildschirm zulaufen lassen
// Anzeigedauer. Länger als üblich, weil der Toast jetzt ANKLICKBAR ist: Er
// zeigt nicht nur an, er ist auch der Weg ins Gespräch. Fünf Sekunden reichten
// zum Lesen, aber nicht zum Entscheiden und Treffen.
const DEFAULT_TIMEOUT = 8000

export class Toast {
  constructor() {
    this._injectStyles()
    // EIN Container für alle Instanzen: AR- und Karten-Bundle laufen in der
    // Mobile-Shell in derselben Seite und hatten je einen eigenen Container an
    // identischer Position — die Toasts lagen übereinander und sahen aus, als
    // würden sie einander überschreiben.
    let c = document.querySelector('.ajna-toast-container')
    if (!c) {
      c = document.createElement('div')
      c.className = 'ajna-toast-container'
      document.body.appendChild(c)
    }
    this.container = c
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
      .ajna-toast.klickbar { cursor: pointer; }
      .ajna-toast.klickbar:hover { filter: brightness(1.18); }
      .ajna-toast.klickbar:focus-visible { outline: 2px solid #4a9d5f; outline-offset: 2px; }
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

  /**
   * @param {string} text
   * @param {{title?: string, timeout?: number, log?: boolean}} [opts]
   *   `log: false`, wenn der Aufrufer den Verlaufs-Eintrag selbst schreibt —
   *   sonst stünde dieselbe Zeile zweimal im Fenster (einmal als Gespräch,
   *   einmal als System-Hinweis).
   */
  show(text, { title, timeout = DEFAULT_TIMEOUT, log = true, onClick = null } = {}) {
    // Kurzlebige Toasts zusätzlich in den persistenten Verlauf (Chat-/Debug-
    // Fenster), damit Hinweise/Fehler später nachvollziehbar bleiben.
    if (log) { try { window.ajnaLog?.push(title ? `${title}: ${text}` : text, 'system') } catch {} }
    const el = document.createElement('div')
    el.className = 'ajna-toast'
    if (title) {
      const t = document.createElement('span')
      t.className = 'toast-title'
      t.textContent = title
      el.appendChild(t)
    }
    el.appendChild(document.createTextNode(text))

    // ANKLICKBAR: Der Toast führt in den Verlauf. Damit kann eine Figur etwas
    // sagen, OHNE dass sich sofort ein Fenster über die Szene legt — wer
    // antworten will, tippt auf die Meldung. Das Fenster aufzudrängen hat die
    // Sicht in genau dem Moment blockiert, in dem man die Figur ansieht.
    el.classList.add('klickbar')
    el.setAttribute('role', 'button')
    el.setAttribute('tabindex', '0')
    el.title = 'Öffnet den Verlauf'
    const oeffnen = () => {
      el.classList.remove('show')
      setTimeout(() => el.remove(), 200)
      try { onClick ? onClick() : window.ajnaLogPanel?.open() } catch (err) {
        console.warn('[toast] Öffnen:', err?.message || err)
      }
    }
    el.addEventListener('click', oeffnen)
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); oeffnen() }
    })

    this.container.appendChild(el)

    // Bei einem Schwall (z. B. Auftrags-Abschluss) die ältesten wegnehmen,
    // statt den Bildschirm vollaufen zu lassen.
    const all = this.container.querySelectorAll('.ajna-toast')
    for (let i = 0; i < all.length - MAX_VISIBLE; i++) all[i].remove()

    // Fade-in
    requestAnimationFrame(() => el.classList.add('show'))

    setTimeout(() => {
      el.classList.remove('show')
      setTimeout(() => el.remove(), 200)
    }, timeout)
  }
}
