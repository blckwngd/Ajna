// InfoHint — ein ℹ️ neben einem Bedienelement, das die Erklärung erst auf
// Wunsch zeigt.
//
// Warum: ehrliche Erklärtexte sind lang. Dauerhaft eingeblendet erschlagen sie
// die Zeile, und man liest sie nach dem zweiten Mal ohnehin nicht mehr — man
// braucht sie genau einmal, beim Verstehen. Das Icon hält die Erklärung in
// Reichweite, ohne sie jedem Blick aufzudrängen.
//
// Bewusst KEIN title=""-Attribut: das erscheint erst nach ~1 s Hover, ist auf
// Touch-Geräten gar nicht erreichbar und lässt sich nicht formatieren.
//
// Verwendung:
//   row.appendChild(infoHint('Kurze Erklärung.'))
//   row.appendChild(infoHint(() => dynamischerText, { title: 'Standort-Freigabe' }))
//
// Der Text darf eine Funktion sein — sie wird bei JEDEM Öffnen ausgewertet, das
// Popup zeigt also nie einen veralteten Stand.

const POPUP_CLASS = 'ajna-info-pop'
let openPopup = null   // nur EINES gleichzeitig — zwei offene Zettel sind Unfug

/**
 * @param {string | (() => string)} text  Erklärung (Funktion = bei jedem Öffnen neu)
 * @param {{title?: string | (() => string), label?: string}} [opts]
 *   title: fette Überschrift (auch als Funktion); label: aria-label (Default „Erklärung")
 * @returns {HTMLButtonElement}
 */
export function infoHint(text, { title = '', label = 'Erklärung' } = {}) {
  injectStyles()
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'ajna-info-btn'
  btn.textContent = 'ℹ️'
  btn.setAttribute('aria-label', label)
  btn.setAttribute('aria-expanded', 'false')

  const toggle = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (openPopup?.owner === btn) { closePopup(); return }
    closePopup()
    showPopup(btn, val(text), val(title))
  }
  // click statt pointerdown: sonst schließt der eigene Klick das Popup sofort
  // wieder über den Außenklick-Listener.
  btn.addEventListener('click', toggle)
  return btn
}

/** Offenes Popup schließen (z. B. wenn ein Dialog zumacht). */
export function closeInfoHint() { closePopup() }

// ── Internals ────────────────────────────────────────────────────────────

const val = v => (typeof v === 'function' ? v() : v)

function showPopup(btn, body, title) {
  const pop = document.createElement('div')
  pop.className = POPUP_CLASS
  pop.setAttribute('role', 'dialog')
  if (title) {
    const h = document.createElement('div')
    h.className = 'ajna-info-title'
    h.textContent = title
    pop.appendChild(h)
  }
  const p = document.createElement('div')
  p.textContent = body      // textContent, nicht innerHTML: der Text kommt teils
  pop.appendChild(p)        // aus Server-/Nutzerdaten (Server-Labels)
  document.body.appendChild(pop)

  position(pop, btn)
  btn.setAttribute('aria-expanded', 'true')
  requestAnimationFrame(() => pop.classList.add('show'))

  // Schließen: Außenklick, Escape, Scrollen/Resize (dann stimmt die Position
  // nicht mehr — neu berechnen wäre Aufwand für einen Zettel, den man ohnehin
  // gleich wieder wegklickt).
  const onDown = (e) => { if (!pop.contains(e.target) && e.target !== btn) closePopup() }
  const onKey = (e) => { if (e.key === 'Escape') closePopup() }
  const onScroll = () => closePopup()
  setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll)

  openPopup = {
    el: pop, owner: btn, raf: 0,
    cleanup: () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      cancelAnimationFrame(openPopup.raf)
    }
  }
  watchOwner()
}

// Sicherheitsnetz: verschwindet der Button, verschwindet das Popup.
// Panels bauen sich neu auf (MobileShell._renderSettings ersetzt bei jedem
// Wand-/UWB-Event das ganze innerHTML) — ohne das bliebe ein Zettel stehen, der
// zu einem Element gehört, das es nicht mehr gibt. Die Alternative wäre, jeden
// künftigen Aufrufer an closeInfoHint() zu erinnern; das vergisst man einmal und
// merkt es nie. Kosten: eine rAF-Schleife, solange EIN Popup offen ist.
function watchOwner() {
  if (!openPopup) return
  if (!openPopup.owner.isConnected) { closePopup(); return }
  openPopup.raf = requestAnimationFrame(watchOwner)
}

function closePopup() {
  if (!openPopup) return
  openPopup.cleanup()
  // Nach einem Panel-Neuaufbau ist der Button weg — das Attribut zu setzen wäre
  // dann sinnlos, aber harmlos; isConnected zu prüfen spart nichts.
  openPopup.owner.setAttribute('aria-expanded', 'false')
  openPopup.el.remove()
  openPopup = null
}

// Unter dem Icon, linksbündig — und innerhalb des Fensters gehalten. Auf dem
// Handy ist rechts neben einem Dropdown fast kein Platz: die Klemmung unten ist
// der Unterschied zwischen lesbar und halb abgeschnitten.
function position(pop, btn) {
  const r = btn.getBoundingClientRect()
  const pad = 8
  const w = pop.offsetWidth
  const h = pop.offsetHeight

  let left = r.left
  if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad
  if (left < pad) left = pad

  let top = r.bottom + 6
  if (top + h > window.innerHeight - pad) {
    const above = r.top - h - 6
    top = above >= pad ? above : Math.max(pad, window.innerHeight - h - pad)
  }
  pop.style.left = `${Math.round(left)}px`
  pop.style.top = `${Math.round(top)}px`
}

function injectStyles() {
  if (document.getElementById('ajnaInfoHintStyles')) return
  const style = document.createElement('style')
  style.id = 'ajnaInfoHintStyles'
  style.textContent = `
    .ajna-info-btn {
      background: none; border: none; cursor: pointer; padding: 0 2px;
      font-size: 12px; line-height: 1; opacity: 0.65;
      /* Touch-Ziel vergrößern, ohne die Zeile aufzublähen */
      min-width: 22px; min-height: 22px;
    }
    .ajna-info-btn:hover, .ajna-info-btn[aria-expanded="true"] { opacity: 1; }
    .${POPUP_CLASS} {
      position: fixed;
      max-width: min(280px, calc(100vw - 16px));
      background: rgba(18,18,22,0.97);
      color: #dcdcdc;
      border: 1px solid #4a4a55;
      border-radius: 6px;
      padding: 8px 10px;
      font: 11px/1.45 system-ui, -apple-system, sans-serif;
      /* Absätze im Text als \\n\\n schreibbar halten — der Inhalt geht als
         textContent rein (kein innerHTML), also muss das CSS die Umbrüche tun. */
      white-space: pre-line;
      box-shadow: 0 6px 20px rgba(0,0,0,0.55);
      /* Über den Dialogen (4100) und der Toast-Leiste (6000): ein Popup, das
         man selbst aufgemacht hat, darf nichts verdecken. */
      z-index: 6100;
      opacity: 0; transform: translateY(-3px);
      transition: opacity 120ms ease-out, transform 120ms ease-out;
    }
    .${POPUP_CLASS}.show { opacity: 1; transform: translateY(0); }
    .ajna-info-title { font-weight: 600; color: #fff; margin-bottom: 4px; }
  `
  document.head.appendChild(style)
}
