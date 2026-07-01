// AccessoryHub — ONE shared client-session layer: WandManager + UwbManager +
// WandAudioFeedback + the GPS/UWB FusedPositionSource. So map and AR agree on
// position, share one BLE connection per node, and apply the same filter.
//
// Why a window-global singleton (not a module-level one): the views are separate
// webpack bundles. A module-level singleton in core/ is bundled INTO each bundle,
// so map.bundle.js and mobile.bundle.js would each get their own copy — not
// shared. Stashing the hub on `window` (like the existing `window.ajna`) makes
// all bundles on the SAME page reuse one instance. On a separate page
// (index-ar.html) a fresh hub is created, which is correct.
//
// The hub owns the cross-cutting wiring (audio cues on the shared wand, ray
// origin + position fallback from the shared positioning, filter-visibility).
// View-specific bits (scene highlight, name lookup) are attached by each view.

import { WandManager } from './WandManager.js'
import { UwbManager } from './UwbManager.js'
import { WandAudioFeedback } from './WandAudioFeedback.js'
import { Announcer } from './Announce.js'
import { createSttEngine } from './SttEngine.js'
import { VoiceCommandManager } from './VoiceCommandManager.js'
import { loadVoiceCommands, loadLightCommands, matchVoiceCommand } from './voiceCommands.js'
import { GPSProvider } from './GPSProvider.js'
import { FusedPositionSource } from './FusedPositionSource.js'
import { PositionFilter } from './PositionFilter.js'
import { wmm } from './geomag/WorldMagneticModel.js'

const KEY = '__ajnaAccessoryHub'
const perfNow = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()

/**
 * @param {{ajna: import('./AjnaManager.js').AjnaManager}} opts
 * @returns {{ ajna, wand: WandManager, uwb: UwbManager, audio: WandAudioFeedback,
 *            gps: GPSProvider, positionSource: FusedPositionSource }}
 */
export function getAccessoryHub({ ajna } = {}) {
  const existing = window[KEY]
  if (existing) {
    if (ajna && !existing.ajna) existing.ajna = ajna
    return existing
  }

  // UWB positioning model: A (onboard engine) by default, B (own multilateration)
  // if selected/persisted. Switchable at runtime via uwb.setMode().
  let uwbMode = 'onboard'
  try { if (localStorage.getItem('ajna_uwb_model') === 'ranging') uwbMode = 'ranging' } catch {}
  // Active PANS network (shared anchor set). null = use every anchor.
  let uwbNetwork = null
  try { uwbNetwork = localStorage.getItem('ajna_uwb_network') || null } catch {}
  const uwb = new UwbManager({ ajna, mode: uwbMode, network: uwbNetwork })
  const gps = new GPSProvider()
  // Single position truth: UWB ('viewer' role) overrides GPS when fresh.
  const positionSource = new FusedPositionSource(gps, uwb.roleSource('viewer'))
  const wand = new WandManager({ ajna })
  const audio = new WandAudioFeedback()
  // Typ-bewusste Ansagen (Name+Typ, Aktion+Ergebnis, Erzeugen) für ALLE Views
  // — auch ohne Wand (Gaze/Tap/Spawn nutzen denselben Announcer).
  const announcer = new Announcer({ audio, ajna })

  // Optional last-resort position getter a view can register (e.g. the map's
  // live window.ajnaGeo position) for when neither UWB nor the hub's own GPS
  // have a fix yet. Set via hub.setPositionFallback(fn).
  let positionFallback = null

  // IMU/UWB fusion for the wand's own tag: the wand carries an IMU (BNO085), so
  // fuse its world-ENU linear acceleration (high rate) with the wand-origin UWB
  // fix (low rate, noisy) into a smooth, higher-rate origin with dead-reckoning
  // across UWB gaps and χ² outlier rejection. Only the moving tag has an IMU;
  // the viewer tag (no IMU stream) keeps using raw UWB.
  const originFilter = new PositionFilter()
  uwb.onPosition('wand-origin', (p) => originFilter.update(p))
  wand.onOrientation((o) => { if (o?.accel) originFilter.predict(o.accel) })
  uwb.onStatusChange((connected) => { if (!connected) originFilter.reset() })

  // Ray origin for pointing: fused wand tag (if a recent fix exists), then the
  // raw wand/viewer UWB tag, then the shared fused position (UWB-or-GPS),
  // finally the view-provided fallback.
  wand.getOrigin = () => {
    const f = originFilter.position()
    if (f && (perfNow() - f.t) < 2000) return f
    return uwb.positionFor('wand-origin') || uwb.positionFor('viewer')
      || positionSource.getWorldPosition() || positionFallback?.() || null
  }

  // Only target objects the active filter shows (shared filter via window.agentFilters,
  // localStorage-backed). A view may override wand.isVisible with its own instance.
  wand.isVisible = (o) => (window.agentFilters?.matches ? window.agentFilters.matches(o) : true)

  // Audio cues live on the shared wand (one place → no double TTS). Anvisieren
  // spricht "<Typ> <Name>" über den Announcer; Fokusverlust behält den dezenten
  // Ton (audio.onTargetChange(null)). Interaktionen sprechen "<Aktion> - <Ergebnis>".
  wand.onTarget((t) => { if (t?.id) announcer.target(t.id); else audio.onTargetChange(null) })
  wand.onInteraction((i) => announcer.interaction(i?.id, i?.action))
  // Lock confirmation (Button 2 released): speak "<obj> gewählt" — the primary
  // screen-off feedback for "which object am I about to act on".
  wand.onLock((o) => announcer.selected(o?.id || null))

  // Push-to-talk voice commands: holding a button STILL opens an offline STT
  // engine (native plugin on the phone, Web Speech in a browser). Audio + STT
  // stay on-device (privacy); only the resulting action leaves. Two managers
  // share ONE engine (the wand guarantees a single PTT hold at a time):
  //   • Button 3 → command on the LOCKED object (interact)
  //   • Button 1 → wand light effect (light command)
  const sttEngine = createSttEngine({ lang: 'de-DE' })
  const announceVoice = (t) => { if (audio.enabled) audio.speak(t) }   // gated feedback
  // STT lifecycle/errors → Debug-Log (one place; the engine is shared). Reveals
  // "bereit/Stimme erkannt/Sprechpause" and errors like "Offline-Sprachpaket fehlt".
  sttEngine.onStatus?.((m) => wand.log(`🎤 ${m}`))

  const lockedActions = () => {
    const id = wand.getLockedTarget?.()?.id
    const rec = id ? ajna?.getObjectById?.(id) : null
    if (Array.isArray(rec?.actions) && rec.actions.length) return rec.actions
    if (Array.isArray(rec?.state?.actions)) return rec.state.actions
    return []
  }

  const voiceObject = new VoiceCommandManager({
    wand, engine: sttEngine, button: 3, announce: announceVoice,
    notReadyMsg: 'Kein Objekt gewählt',
    canStart: () => !!wand.getLockedTarget?.(),
    match: (t) => matchVoiceCommand(t, loadVoiceCommands(), lockedActions())?.action ?? null,
    dispatch: (action) => wand.voiceInteract(action, { via: 'voice' })
  })

  const voiceLight = new VoiceCommandManager({
    wand, engine: sttEngine, button: 1, announce: announceVoice,
    match: (t) => matchVoiceCommand(t, loadLightCommands(), [])?.action ?? null,
    dispatch: (id) => wand.sendCommand({ cmd: 'light', id })
  })
  // Debug announcer (audio + debug both on): speak state changes and raw input
  // events to learn the wand by ear. The '*' subscriber only observes — it never
  // consumes, so it does not affect forwarding.
  wand.onState((name) => audio.announceState(name))
  wand.on('*', (e) => audio.announceEvent(e))

  // System status announcements (debug-gated, each fired once on transition so
  // they don't chatter): GPS fix, server up/down, login/logout, wand & UWB
  // connect/lose, UWB network (first fix), pointing-mode change.
  let _gpsAnnounced = false
  positionSource.onPosition((p) => {
    if (!_gpsAnnounced && p && p.source === 'gps' && Number.isFinite(p.lat)) {
      _gpsAnnounced = true
      audio.announceSystem('gps_fix')
    }
  })
  ajna?.onAuthChanged?.((user) => audio.announceSystem(user ? 'login' : 'logout'))
  wand.onStatusChange((connected) => audio.announceSystem(connected ? 'wand_up' : 'wand_down'))
  wand.onPointingModeChange((mode) => audio.announceMode(mode))
  let _uwbNet = false
  uwb.onStatusChange((connected) => {
    audio.announceSystem(connected ? 'uwb_node_up' : 'uwb_node_down')
    if (!connected) _uwbNet = false
  })
  uwb.onPosition('viewer', () => {
    if (!_uwbNet) { _uwbNet = true; audio.announceSystem('uwb_net') }
  })
  // Server realtime connection has no event → poll the aggregate state and
  // announce only on an actual change (seeded silently on the first tick).
  let _serverUp = null
  setInterval(() => {
    const up = (ajna?.getServers?.() || []).some(s => s.isConnected)
    if (_serverUp === null) { _serverUp = up; return }
    if (up !== _serverUp) { _serverUp = up; audio.announceSystem(up ? 'server_up' : 'server_down') }
  }, 1500)

  // Auto-declination: map the wand's magnetic-north orientation to TRUE north
  // from the on-device position via the World Magnetic Model (WMM2025, offline).
  // Recompute only when the position moved enough (declination varies slowly).
  let _declLat = null, _declLon = null
  positionSource.onPosition((p) => {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return
    if (_declLat !== null && Math.abs(p.lat - _declLat) < 0.02 && Math.abs(p.lon - _declLon) < 0.02) return
    _declLat = p.lat; _declLon = p.lon
    try {
      const decl = wmm.declination(p.lat, p.lon, (p.altitude || 0) / 1000)
      wand.setDeclinationDeg(decl)
    } catch (e) { console.warn('[hub] declination failed', e?.message || e) }
  })

  const hub = {
    ajna, wand, uwb, audio, announcer, gps, positionSource, originFilter,
    sttEngine, voiceObject, voiceLight,
    /** Register a last-resort position getter for wand ray origin. */
    setPositionFallback(fn) { positionFallback = typeof fn === 'function' ? fn : null }
  }
  window[KEY] = hub
  return hub
}
