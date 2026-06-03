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
  queueMicrotask(async () => {
    const ajna = window.ajna
    if (!ajna) {
      console.error('[mobile] window.ajna nicht gesetzt — map.bundle.js fehlt?')
      return
    }

    // Standort-Berechtigung frueh anfordern, BEVOR GPSProvider den ersten
    // navigator.geolocation.watchPosition()-Call macht. Sonst wuerde der
    // WebView entweder einen Permission-Mangel-Error werfen oder im besten
    // Fall einen verspaeteten Permission-Prompt zeigen. Auf Desktop-Browser
    // ist das ein No-Op (Capacitor.isNativePlatform() === false), dort
    // managt der Browser den Permission-Flow selbst beim ersten Aufruf.
    await ensureLocationPermissionIfNative()

    const shell = new MobileShell({
      ajna,
      getUI: () => window.ajnaUI || null
    })
    shell.init()
    window.ajnaMobile = shell   // Console-Debug-Hook
  })
})

async function ensureLocationPermissionIfNative() {
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (!Capacitor?.isNativePlatform?.()) return

    const { Geolocation } = await import('@capacitor/geolocation')
    const status = await Geolocation.checkPermissions()
    if (status.location === 'granted' || status.coarseLocation === 'granted') {
      console.log('[mobile] Standort-Permission bereits erteilt:', status)
      return
    }

    const result = await Geolocation.requestPermissions({ permissions: ['location'] })
    console.log('[mobile] Standort-Permission angefragt:', result)
  } catch (err) {
    console.warn('[mobile] Permission-Flow fehlgeschlagen:', err?.message || err)
  }
}
