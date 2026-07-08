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
// Generische Gesprächs-Antworten, falls ein NPC (noch) keine eigenen Dialoge
// hinterlegt hat — besser als die Objekt-Beschreibung ("Ein NPC.") als Antwort.
const GENERIC_TALK = [
  'Tag auch. Schönes Wetter heute, nicht?',
  'Bleib wachsam da draußen.',
  'Ich hab dir gerade nichts zu sagen.',
  'Hast du die Drachen am Himmel gesehen?',
  'Zieh weiter, Fremder.',
]
const randomOf = arr => arr[Math.floor(Math.random() * arr.length)]

/**
 * Gesprächs-Antwort: zufällig aus `state.dialogs` (Reihe von Antworten), sonst
 * das einzelne `state.dialog`, sonst eine generische Zeile. Bewusst NICHT die
 * Objekt-Beschreibung (die gehört zu "untersuchen"). Später ersetzt ein echtes
 * Dialog-System diese Auswahl.
 */
export function talkResponse(record) {
  const dialogs = record?.state?.dialogs
  if (Array.isArray(dialogs) && dialogs.length) return randomOf(dialogs)
  return record?.state?.dialog || randomOf(GENERIC_TALK)
}

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
      return talkResponse(record)
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
    // Aufnehmen = ins Inventar (carried_by), nicht mehr löschen. Der Server
    // prüft die Rechte (Owner oder portable); bei 403 bleibt es folgenlos.
    try { await ajna.pickup(record.id); return true }
    catch (err) { console.warn('[interact] Einsammeln (Inventar) fehlgeschlagen:', err?.message || err) }
  }
  return false
}
