// backButton — the Android back key closes the topmost open window.
//
// Every window that closes on a click beside it registers here (klickDaneben
// does that for all of them), so the back key needs no list of its own.
// The native side (MainActivity) asks `window.__ajnaBack()` first and only
// leaves the page when nothing was open.
//
// The registry lives on `window`: the views are separate bundles, each with
// its own copy of this module.

const KEY = '__ajnaClosables'

function registry() {
  if (typeof window === 'undefined') return null
  if (!window[KEY]) {
    window[KEY] = []
    window.__ajnaBack = () => closeTopmost()
  }
  return window[KEY]
}

/**
 * @param {HTMLElement} el  the element that is visible while the window is open
 * @param {() => void} close
 * @returns {() => void} unregister
 */
export function registerClosable(el, close) {
  const list = registry()
  if (!list || !el || typeof close !== 'function') return () => {}
  const entry = { el, close }
  list.push(entry)
  return () => {
    const i = list.indexOf(entry)
    if (i >= 0) list.splice(i, 1)
  }
}

function isOpen(el) {
  if (!el.isConnected || el.hidden) return false
  if (el.getClientRects().length === 0) return false
  return getComputedStyle(el).visibility !== 'hidden'
}

function zIndex(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const z = parseInt(getComputedStyle(n).zIndex, 10)
    if (Number.isFinite(z)) return z
  }
  return 0
}

/**
 * Close the open window that lies on top: highest z-index, then later in the
 * document. Removed windows drop out of the registry on the way.
 * @returns {boolean} whether one was closed
 */
export function closeTopmost() {
  const list = registry()
  if (!list) return false
  for (let i = list.length - 1; i >= 0; i--) if (!list[i].el.isConnected) list.splice(i, 1)
  let top = null
  for (const entry of list) {
    if (!isOpen(entry.el)) continue
    if (!top) { top = entry; continue }
    const dz = zIndex(entry.el) - zIndex(top.el)
    const later = top.el.compareDocumentPosition(entry.el) & Node.DOCUMENT_POSITION_FOLLOWING
    if (dz > 0 || (dz === 0 && later)) top = entry
  }
  if (!top) return false
  try { top.close() } catch (err) { console.warn('[back]', err?.message || err) }
  return true
}
