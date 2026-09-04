// makeDraggable — einen schwebenden Button per Drag verschiebbar machen und die
// Position merken (localStorage). Tap und Drag werden sauber getrennt:
//   • Tap  → natives click-Event löst onClick() aus (auf Mobil zuverlässig)
//   • Drag → Pointer-Events verschieben; der darauf folgende click wird geschluckt
//
// WICHTIG (Mobil/Android-WebView): KEIN setPointerCapture. Damit wurde bei kurzem
// Antippen die pointerup-Sequenz nicht sauber beendet — es öffnete erst nach
// langem Druck. Touch-Pointer haben ohnehin implizites Capture; fürs Verschieben
// mit der Maus genügen window-Listener. Der Aufrufer entfernt seinen eigenen
// click-Handler und übergibt onClick hier.

const THRESH = 6   // px, ab hier ist es ein Drag statt eines Taps

const clamp = (v, min, max) => Math.max(min, Math.min(max, v))

/**
 * @param {HTMLElement} el
 * @param {{ key: string, onClick?: () => void, handle?: HTMLElement }} opts
 *        key = localStorage-Schlüssel für {left,top};
 *        handle = Anfasser (z. B. Kopfzeile eines Panels). Ohne Angabe ist das
 *        Element selbst der Anfasser — bei einem Panel mit eigenem Inhalt (Karte,
 *        Liste) würde sonst jeder Griff hinein das Fenster verschieben.
 *        aktiv = solange das `false` liefert, wird weder gezogen noch eine
 *        gemerkte Position angewandt. Für Fenster, die zeitweise fest sitzen
 *        (angedockte Minimap): Ohne das schriebe ein Fenstergrößenwechsel die
 *        alte Freiposition zurück und schöbe das angedockte Fenster weg.
 * @returns {() => void} cleanup (entfernt alle Listener)
 */
export function makeDraggable(el, { key, onClick, handle = null, aktiv = null } = {}) {
  if (!el) return () => {}
  const grip = handle || el
  grip.style.touchAction = 'none'   // Browser-Scroll/Gesten beim Ziehen unterdrücken

  const applySaved = () => {
    if (aktiv && !aktiv()) return
    let p = null
    try { p = JSON.parse(localStorage.getItem(key) || 'null') } catch {}
    if (!p || !Number.isFinite(p.left) || !Number.isFinite(p.top)) return
    const w = el.offsetWidth, h = el.offsetHeight
    if (!w || !h) return    // noch kein Layout (ausgeblendet) — der Beobachter unten holt es nach
    el.style.left = clamp(p.left, 4, window.innerWidth - w - 4) + 'px'
    el.style.top = clamp(p.top, 4, window.innerHeight - h - 4) + 'px'
    el.style.right = 'auto'
    el.style.bottom = 'auto'
  }
  requestAnimationFrame(applySaved)   // nach dem Layout (offsetWidth muss stehen)

  // Elemente, die anfangs versteckt sind (Panel hinter einem Auslöser), haben
  // beim ersten Frame keine Maße — ohne das hier würde die gemerkte Position
  // gegen 0×0 geklemmt und das Fenster säße beim Öffnen am falschen Fleck.
  let ro = null
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      if (!el.offsetWidth) return
      applySaved()
      ro.disconnect(); ro = null
    })
    ro.observe(el)
  }

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
  const onUp = () => {
    if (!dragging) return
    dragging = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    if (moved) {
      // Position merken. `moved` bleibt true, bis der folgende click geschluckt
      // wurde bzw. der nächste pointerdown es zurücksetzt (Selbstheilung, falls
      // nach einem Touch-Drag gar kein click kommt).
      try { localStorage.setItem(key, JSON.stringify({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) })) } catch {}
    }
  }
  const onDown = (e) => {
    if (aktiv && !aktiv()) return
    if (e.button != null && e.button !== 0) return   // nur primär/Touch
    if (dragging) return   // zweiter Finger darf den laufenden Zug nicht kapern
    dragging = true; moved = false
    startX = e.clientX; startY = e.clientY
    const r = el.getBoundingClientRect()
    origL = r.left; origT = r.top
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    // KEIN preventDefault hier — sonst bliebe der native click (Tap) aus.
  }
  const onClickH = (e) => {
    if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; return }  // war ein Drag
    onClick?.()
  }

  grip.addEventListener('pointerdown', onDown)
  grip.addEventListener('click', onClickH)
  window.addEventListener('resize', applySaved)

  return () => {
    grip.removeEventListener('pointerdown', onDown)
    grip.removeEventListener('click', onClickH)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    window.removeEventListener('resize', applySaved)
    try { ro?.disconnect() } catch {}
  }
}
