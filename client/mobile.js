// Mobile-Entry: laeuft ZUSAETZLICH zu map.bundle.js und legt die Bottom-Tab-
// Shell um die existierende Map. Reihenfolge im HTML: map.bundle.js vor
// mobile.bundle.js — dadurch ist beim DOMContentLoaded-Callback hier window.ajna
// und window.ajnaUI bereits gesetzt.

import { MobileShell } from "./core/MobileShell.js"

window.addEventListener('DOMContentLoaded', () => {
  // map.bundle.js init() ist async (await editorUI.init()). Wir verzoegern
  // unser Settings-Render um einen Microtask, damit die in map.js angelegten
  // Modul-Konstanten (Dialoge, AgentFilters, etc.) auf window.ajnaUI sicher
  // verfuegbar sind.
  queueMicrotask(() => {
    const ajna = window.ajna
    if (!ajna) {
      console.error('[mobile] window.ajna nicht gesetzt — map.bundle.js fehlt?')
      return
    }

    const shell = new MobileShell({
      ajna,
      getUI: () => window.ajnaUI || null
    })
    shell.init()
    window.ajnaMobile = shell   // Console-Debug-Hook
  })
})
