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

import { TYPE_LABEL } from './SpawnHere.js'

const CALL_STATUS_TEXT = {
  open: 'offen', claimed: 'angenommen', pending: 'wird geprüft',
  done: 'erledigt', cancelled: 'abgebrochen'
}

/**
 * Forderungen eines Auftrags lesbar: ["3× Wolfsfell", "1× Tier"] — aus den
 * Gattungs-Angaben (state.call.requires) plus evtl. konkret benannten Instanzen.
 * @returns {string[]}
 */
export function describeRequires(call) {
  const out = []
  const specs = Array.isArray(call?.requires) ? call.requires : []
  for (const s of specs) {
    const m = (s && s.match) || {}
    const what = m.name || (m.tag ? '#' + m.tag : '') || TYPE_LABEL[m.type] || m.type || 'Gegenstand'
    const n = Number(s?.count) || 1
    out.push(`${n > 1 ? n + '× ' : ''}${what}`)
  }
  const inst = Array.isArray(call?.requiresItems) ? call.requiresItems.length : 0
  if (inst) out.push(`${inst}× ein bestimmtes Objekt`)
  return out
}

/**
 * Untersuchen-Text für einen Auftrag: die AUFGABE ist der Inhalt — ohne das
 * bekäme der Spieler sie nie zu sehen. Dazu Belohnung/Forderung/Status, soweit
 * vorhanden. Wird von Toast (interactionReply) UND Ansage (Announce) genutzt,
 * damit beide dasselbe sagen.
 */
export function callExamineText(record) {
  const c = record?.state?.call || {}
  const parts = []
  parts.push(c.task ? String(c.task) : 'Ein Auftrag ohne Beschreibung.')
  const rewards = Array.isArray(c.rewardItems) ? c.rewardItems.length : 0
  const req = describeRequires(c)
  if (req.length) parts.push('Gefordert: ' + req.join(', '))
  parts.push(rewards
    ? `Belohnung: ${rewards} Gegenstand${rewards > 1 ? '/Gegenstände' : ''}`
    : 'Noch keine Belohnung hinterlegt')
  parts.push('Status: ' + (CALL_STATUS_TEXT[c.status] || 'offen'))
  return parts.join(' · ')
}

export function interactionReply(record, action, name) {
  const label = name || record?.name || record?.id || 'das Objekt'
  switch (String(action || '').toLowerCase()) {
    case 'examine':
    case 'read':
    case 'lesen':
      if (record?.type === 'call') return callExamineText(record)
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
    case 'accept':
    case 'annehmen':
      return `Auftrag angenommen: ${label}`
    case 'complete':
    case 'erledigt':
    case 'erledigen':
      return `Auftrag erledigt: ${label}`
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
 * Nebenwirkung einer Interaktion ausführen (Einsammeln → Inventar, Auftrag →
 * annehmen/abschließen).
 *
 * Rückgabe sagt dem Aufrufer, ob er Erfolg melden darf:
 *   { handled: true,  ok: false, error } → der Server hat abgelehnt: KEINE
 *     Erfolgsmeldung zeigen, sondern den Grund.
 *   { handled: true,  ok: true, status? } → Wirkung ist eingetreten.
 *   { handled: false, ok: true }          → Aktion hat keine Nebenwirkung
 *     (talk/examine/…): normales Reply-Feedback.
 *
 * @returns {Promise<{handled:boolean, ok:boolean, error?:string, status?:string}>}
 */
export async function applyInteractionSideEffect(ajna, record, action) {
  if (isCollectAction(action) && record?.id) {
    // Aufnehmen = ins Inventar (carried_by), nicht mehr löschen. Der Server
    // prüft die Rechte (Owner oder portable).
    try { await ajna.pickup(record.id); return { handled: true, ok: true } }
    catch (err) {
      const detail = err?.response?.error || err?.message || String(err)
      console.warn('[interact] Einsammeln (Inventar) fehlgeschlagen:', detail)
      return { handled: true, ok: false, error: detail }
    }
  }

  // Auftrag (Call): Lebenszyklus offen → angenommen → erledigt läuft über die
  // SERVER-Routen. Wichtig: Belohnungen sind echte, treuhänderisch gebundene
  // Items aus dem Inventar des Ausstellers — der Abschluss ist ein atomarer
  // Tausch, den nur der Server ausführen darf (fremder Besitz). Deshalb hier
  // KEIN eigener State-Write mehr.
  if (record?.type === 'call' && record?.id) {
    const a = String(action || '').toLowerCase()
    const isAccept = a === 'accept' || a === 'annehmen'
    const isComplete = a === 'complete' || a === 'erledigt' || a === 'erledigen'
    if (isAccept || isComplete) {
      const nm = record.name || record.id
      try {
        const res = await (isAccept ? ajna.acceptQuest(record.id) : ajna.completeQuest(record.id))
        // Bei verify:'agent' zahlt der Server nicht sofort aus — der Auftrag geht
        // auf 'pending' und der Aussteller-Agent entscheidet mit eigener Logik.
        const msg = isAccept
          ? `Auftrag „${nm}" angenommen`
          : res?.status === 'pending'
            ? `Auftrag „${nm}": Abschluss eingereicht — wird geprüft`
            : `Auftrag „${nm}" erledigt — Belohnung erhalten`
        try { window.ajnaLog?.push(msg, 'interact') } catch {}
        return { handled: true, ok: true, status: res?.status, message: msg }
      } catch (err) {
        // Der Server lehnt begründet ab (Belohnung nicht mehr gedeckt, fremd
        // beansprucht, gefordertes Item fehlt …) — das gehört sichtbar in den
        // Verlauf UND in die Rückmeldung, nicht nur in die Konsole.
        const detail = String(err?.response?.error || err?.message || err)
        console.warn('[quest] ' + a + ' fehlgeschlagen:', detail)
        try { window.ajnaLog?.push(`Auftrag „${nm}" nicht möglich: ${detail}`, 'system') } catch {}
        return { handled: true, ok: false, error: detail }
      }
    }
  }
  return { handled: false, ok: true }
}
