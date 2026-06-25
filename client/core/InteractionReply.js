// Clientseitige Wirkung einer Interaktion.
//
// Der Server (interact-Hook) macht nur einen ephemeren Broadcast
// ({action,source,ts}) nach Permission-Check — KEIN State-Change. Was der
// Spieler tatsächlich SIEHT/erlebt, wird hier aus dem gecachten Record
// abgeleitet. So bekommen die objekt-definierten Aktionen (state.actions:
// talk/examine/attack/feed/…) eine sichtbare Reaktion, ohne dass der Viewer
// objektspezifisches Wissen braucht.
//
// AR (main.js) und Map (map.js) teilen sich diese Logik, damit Antworten
// überall identisch sind.

/**
 * Flavor-/Antwort-Text für eine Aktion auf einem Objekt.
 * @param {object} record  PocketBase-Record (gecacht)
 * @param {string} action  Aktions-Key (aus state.actions)
 * @param {string} [name]  Anzeigename (überschreibt record.name)
 * @returns {string}
 */
export function interactionReply(record, action, name) {
  const label = name || record?.name || record?.id || 'das Objekt'
  switch (String(action || '').toLowerCase()) {
    case 'examine':
    case 'read':
    case 'lesen':
      return record?.description || record?.state?.hint || record?.state?.dialog
          || `Nichts Besonderes an ${label}.`
    case 'talk':
    case 'sprechen':
      return record?.state?.dialog || record?.description || `${label} nickt dir freundlich zu.`
    case 'attack':
    case 'angreifen':
      return `Du greifst ${label} an! 💥`
    case 'feed':
    case 'füttern':
      return `${label} freut sich über das Futter. 🍎`
    case 'collect':
    case 'einsammeln':
      return `${label} eingesammelt.`
    default:
      return `${action} → ${label}`
  }
}

/** Aktionen, die das Objekt clientseitig entfernen (Demo-Spielregel). */
export function isCollectAction(action) {
  const a = String(action || '').toLowerCase()
  return a === 'collect' || a === 'einsammeln'
}

/**
 * Nebenwirkung einer Interaktion ausführen (z. B. "Einsammeln" → Objekt löschen).
 * Fehler (z. B. 403 mangels Rechten) werden geschluckt — die Aktion bleibt dann
 * folgenlos, was der Spieler über das ausbleibende Verschwinden sieht.
 * @returns {Promise<boolean>} true, wenn das Objekt entfernt wurde.
 */
export async function applyInteractionSideEffect(ajna, record, action) {
  if (isCollectAction(action) && record?.id) {
    try { await ajna.deleteObject(record.id); return true }
    catch (err) { console.warn('[interact] Einsammeln/Löschen fehlgeschlagen:', err?.message || err) }
  }
  return false
}
