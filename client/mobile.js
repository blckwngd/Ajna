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
    const isNative = await ensureLocationPermissionIfNative()

    // Auf Capacitor: GPS-Watch der Map automatisch beim Start aktivieren,
    // damit der User die Position sofort sieht ohne den GPS-Button suchen
    // zu muessen. Wenn die Map zum Zeitpunkt schon ready ist (sehr
    // wahrscheinlich nicht, weil mobile.js vor map.js' init() laeuft),
    // direkt aktivieren — sonst auf ajna:map-ready warten.
    if (isNative) wireMobileGpsAutoActivate()

    const shell = new MobileShell({
      ajna,
      getUI: () => window.ajnaUI || null
    })
    shell.init()
    window.ajnaMobile = shell   // Console-Debug-Hook
  })
})

function wireMobileGpsAutoActivate() {
  const tryActivate = (gpsControl, dummyMode) => {
    if (dummyMode) {
      console.log('[mobile] Dummy-Modus aktiv → Auto-GPS uebersprungen')
      return
    }
    if (!gpsControl) return
    console.log('[mobile] Auto-Activate Map-GPS auf Capacitor')
    gpsControl.activate()
  }

  if (window.ajnaGpsControl) {
    // Map war schon ready — direkt aktivieren
    tryActivate(window.ajnaGpsControl, false)
    return
  }
  window.addEventListener('ajna:map-ready', e => {
    tryActivate(e.detail?.gpsControl, e.detail?.dummyMode)
  }, { once: true })
}

/**
 * @returns {Promise<boolean>}  true, wenn wir auf einer Capacitor-Native-
 *   Plattform laufen (Android-WebView aktuell). Auf Browser false.
 */
async function ensureLocationPermissionIfNative() {
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (!Capacitor?.isNativePlatform?.()) return false

    const { Geolocation } = await import('@capacitor/geolocation')
    const status = await Geolocation.checkPermissions()
    if (status.location === 'granted' || status.coarseLocation === 'granted') {
      console.log('[mobile] Standort-Permission bereits erteilt:', status)
      return true
    }

    const result = await Geolocation.requestPermissions({ permissions: ['location'] })
    console.log('[mobile] Standort-Permission angefragt:', result)
    return true
  } catch (err) {
    console.warn('[mobile] Permission-Flow fehlgeschlagen:', err?.message || err)
    return false
  }
}
