// AimSession — pointing on the go, wired into the app.
//
// Builds the DeviceManager with what the app provides (position, visible
// objects, interaction, speech, toast) and registers the devices that exist
// here: the phone always, keys always, the native remote and watches in the
// app, the wand when the accessory hub has one.
//
// One per page, like the accessory hub (window global — the views are
// separate bundles).

import { DeviceManager } from './DeviceManager.js'
import { phoneDevice, keysDevice, remoteDevice, nusDevice, wandDevice, aimPlugin } from './devices.js'

const KEY = '__ajnaAimSession'
const WATCHES = 'ajna.aim.watches'     // advertised names of watches the player added

/**
 * @param {object} o
 * @param {object} o.ajna        AjnaManager
 * @param {object} [o.hub]       accessory hub (wand, audio, positionSource)
 * @param {(text:string) => void} [o.notify]
 */
export function getAimSession({ ajna, hub = null, notify = () => {} } = {}) {
  if (window[KEY]) return window[KEY]
  const getPosition = () => hub?.positionSource?.getWorldPosition?.() || window.ajnaGeo?.position || null
  const visible = (o) => (window.agentFilters?.matches ? window.agentFilters.matches(o) : true)

  let plugin = null
  aimPlugin().then(box => { plugin = box.plugin })
  const vibrate = (pattern) => {
    if (plugin) { plugin.vibrate({ pattern }).catch(() => {}); return }
    try { navigator.vibrate?.(pattern) } catch {}
  }

  const manager = new DeviceManager({
    aimDeps: {
      getOrigin: getPosition,
      getObjects: () => (ajna?.getObjects?.() || []).filter(o => !o.carried_by && visible(o)),
      interact: (id, action) => ajna.interact(id, action),
    },
    speak: (text) => hub?.audio?.speak ? hub.audio.speak(text) : notify(text),
    vibrate,
    notify,
    getPosition,
  })

  manager.register(phoneDevice())
  manager.register(keysDevice())
  const wd = wandDevice(hub?.wand)
  if (wd) manager.register(wd)
  remoteDevice().then(d => { if (d) manager.register(d) })

  const session = {
    manager,
    /** Add a watch by its advertised BLE name; remembered for next time. */
    async addWatch(name) {
      const n = String(name || '').trim()
      if (!n) return null
      const d = await nusDevice({ name: n })
      if (!d) { notify('Uhren gehen nur in der App'); return null }
      manager.register(d)
      const list = loadWatches()
      if (!list.includes(n)) { list.push(n); saveWatches(list) }
      return d
    },
    async removeWatch(name) {
      const id = `nus:${name}`
      const d = manager.devices.get(id)
      manager.unregister(id)
      try { await d?.disconnect?.() } catch {}
      saveWatches(loadWatches().filter(x => x !== name))
    },
    watches: () => loadWatches(),
    plugin: () => plugin,
  }

  // Reconnect remembered watches.
  for (const n of loadWatches()) session.addWatch(n).catch(() => {})
  // Silence detection for the pointing source.
  setInterval(() => manager.tick(), 1000)

  window[KEY] = session
  return session
}

function loadWatches() { try { return JSON.parse(localStorage.getItem(WATCHES) || '[]') } catch { return [] } }
function saveWatches(list) { try { localStorage.setItem(WATCHES, JSON.stringify(list)) } catch {} }
