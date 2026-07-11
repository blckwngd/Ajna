// makeDraggable — einen schwebenden Button per Drag verschiebbar machen und die
// Position merken (localStorage). Unterscheidet Klick von Drag über einen kleinen
// Bewegungs-Schwellwert, damit der normale Klick (Toggle) erhalten bleibt:
//   • kaum bewegt  → onClick() (wie ein normaler Tap)
//   • gezogen      → neue Position, gemerkt
//
// Bewusst über eine Callback-Seam (onClick) statt eines eigenen click-Listeners,
// sonst würde nach einem Klick sowohl der native click ALS AUCH onClick feuern.
// Der Aufrufer entfernt daher seinen eigenen click-Handler.

const THRESH = 6   // px, ab hier ist es ein Drag statt eines Klicks

const clamp = (v, min, max) => Math.max(min, Math.min(max, v))

/**
 * @param {HTMLElement} el
 * @param {{ key: string, onClick?: () => void }} opts  key = localStorage-Schlüssel für {left,top}
 * @returns {() => void} cleanup (entfernt den resize-Listener)
 */
export function makeDraggable(el, { key, onClick } = {}) {
  if (!el) return () => {}
  el.style.touchAction = 'none'   // Browser-Scroll beim Ziehen unterdrücken

  const applySaved = () => {
    let p = null
    try { p = JSON.parse(localStorage.getItem(key) || 'null') } catch {}
    if (!p || !Number.isFinite(p.left) || !Number.isFinite(p.top)) return
    const w = el.offsetWidth || 48, h = el.offsetHeight || 48
    // In den Sichtbereich clampen (Fenstergröße/Orientierung kann sich ändern).
    el.style.left = clamp(p.left, 4, window.innerWidth - w - 4) + 'px'
    el.style.top = clamp(p.top, 4, window.innerHeight - h - 4) + 'px'
    el.style.right = 'auto'
    el.style.bottom = 'auto'
  }
  // Nach dem Layout anwenden (offsetWidth muss stehen).
  requestAnimationFrame(applySaved)

  let startX = 0, startY = 0, origL = 0, origT = 0, moved = false, dragging = false

  const onMove = (e) => {
    if (!dragging) return
    const dx = e.clientX - startX, dy = e.clientY - startY
    if (!moved && Math.hypot(dx, dy) > THRESH) moved = true
    if (!moved) return
    const w = el.offsetWidth, h = el.offsetHeight
    el.style.left = clamp(origL + dx, 4, window.innerWidth - w - 4) + 'px'
    el.style.top = clamp(origT + dy, 4, window.innerHeight - h - 4) + 'px'
    el.style.right = 'auto'
    el.style.bottom = 'auto'
    e.preventDefault()
  }
  const onUp = (e) => {
    if (!dragging) return
    dragging = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    try { el.releasePointerCapture?.(e.pointerId) } catch {}
    if (moved) {
      try { localStorage.setItem(key, JSON.stringify({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) })) } catch {}
    } else {
      onClick?.()   // war nur ein Tap
    }
  }
  const onDown = (e) => {
    if (e.button != null && e.button !== 0) return   // nur primär/Touch
    dragging = true; moved = false
    startX = e.clientX; startY = e.clientY
    const r = el.getBoundingClientRect()
    origL = r.left; origT = r.top
    try { el.setPointerCapture?.(e.pointerId) } catch {}
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }
  el.addEventListener('pointerdown', onDown)
  window.addEventListener('resize', applySaved)

  return () => {
    el.removeEventListener('pointerdown', onDown)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    window.removeEventListener('resize', applySaved)
  }
}
