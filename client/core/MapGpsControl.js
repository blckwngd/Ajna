// Eigenes GPS-Control fuer Leaflet — ersetzt leaflet-gps, das bei jedem
// Klick komplett zwischen Start/Stop wechselt. Wir wollen Apple-/Google-
// Maps-Verhalten:
//
//   • Erster Klick:  Ortung starten + Marker setzen + Follow ON.
//   • Weitere Klicks: nur Follow toggeln; Marker und Watch bleiben aktiv.
//
// Plus eine `.activate()`-Methode fuer die Mobile-Shell, die das auf
// Capacitor automatisch beim App-Start ausloest.
//
// Marker-Visuals via DivIcon — keine externe Asset-Datei noetig, das
// pulse-Aussehen ist reines CSS.

const STYLE_ID = 'ajnaMapGpsStyles'

const STATE = {
  IDLE:         'idle',          // Watch aus, kein Marker
  FOLLOWING:    'following',     // Watch an, Marker da, panTo bei Updates
  NOT_FOLLOWING:'not-following'  // Watch an, Marker da, Karte bleibt stehen
}

// opts.positionSource: optional shared FusedPositionSource (GPS+UWB). When given,
// the marker follows that single source (so map and AR agree, UWB-corrected)
// instead of Leaflet's own geolocation. opts.onActivate: called on first
// activation (e.g. to start the shared GPS provider).
export function setupMapGps(map, { onError, positionSource, onActivate } = {}) {
  injectStyles()

  let state = STATE.IDLE
  let watchActive = false
  let positionMarker = null
  let accuracyCircle = null
  let firstFix = true
  let posUnsub = null

  const control = createControl(handleClick)
  map.addControl(control)

  function handleClick() {
    if (state === STATE.IDLE) {
      // Erste Aktivierung: Watch starten, sobald der Fix da ist wird gepant
      // und der Marker erscheint. Follow ist sofort an.
      activate()
    } else if (state === STATE.FOLLOWING) {
      state = STATE.NOT_FOLLOWING
      updateButton()
    } else {
      // not-following → wieder follow + sofort auf die letzte Position panen.
      state = STATE.FOLLOWING
      if (positionMarker) {
        map.panTo(positionMarker.getLatLng())
      }
      updateButton()
    }
  }

  function activate() {
    if (watchActive) {
      // schon aktiv (z. B. extern), nur Follow-Status sicherstellen
      if (state !== STATE.FOLLOWING) {
        state = STATE.FOLLOWING
        if (positionMarker) map.panTo(positionMarker.getLatLng())
        updateButton()
      }
      return
    }
    if (positionSource) {
      // Drive the marker from the shared GPS/UWB source.
      onActivate?.()
      const seed = positionSource.getWorldPosition?.()
      if (seed && Number.isFinite(seed.lat)) applyFix(window.L.latLng(seed.lat, seed.lon), seed.accuracy ?? 5)
      posUnsub = positionSource.onPosition(p => {
        if (p && Number.isFinite(p.lat)) applyFix(window.L.latLng(p.lat, p.lon), p.accuracy ?? 5)
      })
    } else {
      map.locate({
        watch: true,
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 15000
      })
      map.on('locationfound', onLocationFound)
      map.on('locationerror', onLocationError)
    }
    watchActive = true
    state = STATE.FOLLOWING
    updateButton()
  }

  function onLocationFound(e) { applyFix(e.latlng, e.accuracy) }

  // Shared marker/accuracy/center/follow logic for both the Leaflet-locate and
  // the positionSource paths.
  function applyFix(latlng, accuracy) {
    if (!positionMarker) {
      positionMarker = window.L.marker(latlng, {
        icon: makeIcon(),
        keyboard: false,
        interactive: false
      }).addTo(map)
    } else {
      positionMarker.setLatLng(latlng)
    }
    if (accuracyCircle) {
      accuracyCircle.setLatLng(latlng).setRadius(accuracy)
    } else {
      accuracyCircle = window.L.circle(latlng, {
        radius: accuracy,
        color: '#2c5d8f', fillColor: '#2c5d8f',
        fillOpacity: 0.12, weight: 1, interactive: false
      }).addTo(map)
    }

    if (firstFix) {
      // Beim allerersten Fix zentrieren und etwas zoomen, falls die Karte
      // weltweit aussieht. Auf hohem Zoom (User hat schon manuell gezoomt)
      // nicht ungewollt rauszoomen — max() hält das hoehere Level.
      map.setView(latlng, Math.max(map.getZoom(), 16))
      firstFix = false
    } else if (state === STATE.FOLLOWING) {
      map.panTo(latlng)
    }
  }

  function onLocationError(e) {
    console.warn('[map-gps] locationerror:', e?.message || e?.code || e)
    onError?.(e)
    // Bei Permission-Denied wuerden wir hier sonst in einen "an"-Zustand
    // einrasten, der nie Updates liefert. Sauber zurueckdrehen.
    if (state !== STATE.IDLE) {
      deactivate()
    }
  }

  function deactivate() {
    if (watchActive) {
      if (posUnsub) { posUnsub(); posUnsub = null }
      else {
        map.stopLocate()
        map.off('locationfound', onLocationFound)
        map.off('locationerror', onLocationError)
      }
      watchActive = false
    }
    if (positionMarker) { positionMarker.remove(); positionMarker = null }
    if (accuracyCircle) { accuracyCircle.remove(); accuracyCircle = null }
    firstFix = true
    state = STATE.IDLE
    updateButton()
  }

  function updateButton() {
    const btn = control.getContainer()?.querySelector('.ajna-gps-btn')
    if (!btn) return
    btn.classList.toggle('is-following', state === STATE.FOLLOWING)
    btn.classList.toggle('is-located', state === STATE.NOT_FOLLOWING)
    btn.title = {
      [STATE.IDLE]:          'Ortung starten',
      [STATE.FOLLOWING]:     'Folgen-Modus AN — Klick: Folgen aus',
      [STATE.NOT_FOLLOWING]: 'Folgen-Modus AUS — Klick: zurück zu meiner Position'
    }[state]
  }

  return {
    activate,
    deactivate,
    isActive: () => watchActive,
    getState: () => state
  }
}

// ─── Leaflet-Control-Wrapper ─────────────────────────────────────────

function createControl(onClick) {
  const C = window.L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const container = window.L.DomUtil.create('div', 'leaflet-bar ajna-gps-container')
      const btn = window.L.DomUtil.create('a', 'ajna-gps-btn', container)
      btn.href = '#'
      btn.title = 'Ortung starten'
      btn.innerHTML = '◎'
      window.L.DomEvent.on(btn, 'click', e => {
        window.L.DomEvent.stop(e)
        onClick()
      })
      return container
    }
  })
  return new C()
}

function makeIcon() {
  return window.L.divIcon({
    className: 'ajna-gps-marker',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    html: '<div class="pulse"></div><div class="dot"></div>'
  })
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return
  const s = document.createElement('style')
  s.id = STYLE_ID
  s.textContent = `
    .ajna-gps-btn {
      display: flex; align-items: center; justify-content: center;
      width: 30px; height: 30px;
      font-size: 22px; line-height: 1;
      color: #555; text-decoration: none;
    }
    .ajna-gps-btn:hover { color: #2c5d8f; }
    .ajna-gps-btn.is-located {
      color: #2c5d8f;
    }
    .ajna-gps-btn.is-following {
      color: #ffffff;
      background: #2c5d8f;
    }
    .ajna-gps-btn.is-following:hover { background: #356da6; }

    .ajna-gps-marker { pointer-events: none; }
    .ajna-gps-marker .dot {
      position: absolute; left: 6px; top: 6px;
      width: 10px; height: 10px; border-radius: 50%;
      background: #2c5d8f;
      border: 2px solid #ffffff;
      box-shadow: 0 0 4px rgba(0,0,0,0.4);
    }
    .ajna-gps-marker .pulse {
      position: absolute; inset: 0;
      border-radius: 50%;
      background: #2c5d8f;
      opacity: 0.35;
      animation: ajnaGpsPulse 1.8s ease-out infinite;
    }
    @keyframes ajnaGpsPulse {
      0%   { transform: scale(0.5); opacity: 0.55; }
      100% { transform: scale(2.2); opacity: 0; }
    }
  `
  document.head.appendChild(s)
}
