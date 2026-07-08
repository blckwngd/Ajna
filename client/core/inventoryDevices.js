// Geräte-Kacheln fürs Inventar aus dem AccessoryHub (Wand/UWB).
//
// BLE-Geräte sind KEINE PocketBase-Objekte → synthetische Inventar-Einträge mit
// Verbindungsstatus + gerätespezifischen Aktionen. „Einstellungen" öffnet das
// bestehende Geräte-Modal der App-Shell (window.ajnaMobile), sofern die Shell
// läuft; im Standalone-Karten-/AR-Client entfällt der Button.

export function inventoryDevices(hub) {
  const list = []
  const shell = typeof window !== 'undefined' ? window.ajnaMobile : null

  const wand = hub?.wand
  if (wand) {
    const connected = !!wand.connected
    const actions = []
    if (shell?._openWandModal) actions.push({ label: '⚙️ Einstellungen', run: () => shell._openWandModal() })
    if (connected) {
      actions.push({ label: '💡 Licht-Effekt', run: () => { try { wand.sendCommand?.({ cmd: 'light', id: 12 }) } catch {} } })
      actions.push({ label: '🧭 Kalibrieren', run: () => { try { wand.calibrate?.('staff') } catch {} } })
    }
    list.push({ key: 'wand', name: 'Zauberstab', emoji: '🪄', connected, actions })
  }

  const uwb = hub?.uwb
  if (uwb) {
    const connected = ['viewer', 'wand-origin', 'wand-tip']
      .some(r => { try { return !!uwb.isConnected?.(r) } catch { return false } })
    const actions = []
    if (shell?._openUwbModal) actions.push({ label: '⚙️ Einstellungen', run: () => shell._openUwbModal() })
    list.push({ key: 'uwb', name: 'UWB', emoji: '📡', connected, actions })
  }
  return list
}
