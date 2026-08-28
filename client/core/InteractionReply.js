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
 * Objekt-Beschreibung (die gehört zu "untersuchen").
 *
 * NICHT MEHR der Hauptweg: „Sprechen" öffnet seit dem Chat-Umbau ein echtes
 * Gespräch (Parley, siehe wiki/Dialoge.md). Diese Einzeiler bleiben als
 * Rückfallebene für Clients ohne Chatfenster und für Figuren, deren Besitzer
 * nicht antwortet.
 */
export function talkResponse(record) {
  const dialogs = record?.state?.dialogs
  if (Array.isArray(dialogs) && dialogs.length) return randomOf(dialogs)
  return record?.state?.dialog || randomOf(GENERIC_TALK)
}

import { TYPE_LABEL } from './SpawnHere.js'
import { inSprache } from './Sprachwahl.js'
import { t } from './i18n.js'

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
  parts.push(c.task ? String(c.task) : t('Ein Auftrag ohne Beschreibung.'))
  const rewards = Array.isArray(c.rewardItems) ? c.rewardItems.length : 0
  const req = describeRequires(c)
  if (req.length) parts.push('Gefordert: ' + req.join(', '))
  if (c.repeatable) {
    // Der hinterlegte Vorrat sagt, wie oft der Auftrag noch spielbar ist.
    const perRun = Math.max(1, Number(c.rewardPerRun) || 1)
    parts.push(t('Belohnung: {pro} pro Durchlauf · wiederholbar, noch {rest}× möglich',
        { pro: perRun, rest: Math.floor(rewards / perRun) }))
  } else {
    parts.push(rewards
      ? `Belohnung: ${rewards} Gegenstand${rewards > 1 ? '/Gegenstände' : ''}`
      : t('Noch keine Belohnung hinterlegt'))
  }
  parts.push('Status: ' + (CALL_STATUS_TEXT[c.status] || 'offen'))
  return parts.join(' · ')
}

/**
 * Verlaufs-Zeile zu einer Interaktion — MIT Objekt-ID.
 *
 * Der Toast zeigt nur, was ein Spieler sehen will: Name und Antwort. Für die
 * Fehlersuche fehlt genau das Entscheidende — WELCHES Objekt es war. Bei
 * gleichnamigen Figuren („Papagei", „Soldat") ist ohne Kennung nicht
 * feststellbar, welche gemeint ist, und ein Blick in die Datenbank scheitert
 * daran zuerst.
 *
 * Deshalb steht sie hier im Verlauf: dort ist sie lesbar, kopierbar und
 * überdauert das Wegblenden des Toasts.
 */
export function interaktionsZeile(record, action, text) {
  const name = record?.name || 'Objekt'
  const id = record?.id ? ` [${record.id}]` : ''
  const was = String(action || '').toLowerCase()
  return `${name}${id} · ${was}: ${text}`
}

/**
 * Interaktion in den Verlauf schreiben — über `window.ajnaLog`, NICHT über den
 * importierten `messageLog`.
 *
 * DIE FALLE: Der Client besteht aus vier Webpack-Bündeln (ar, map, agent,
 * mobile). Jedes bekommt seine EIGENE Modulinstanz des Verlaufs. Wer aus
 * `map.js` in den importierten `messageLog` schreibt, schreibt in den Verlauf
 * des Karten-Bündels — das Fenster gehört aber der Shell und liest ihren
 * eigenen. Die Zeilen landen nirgends sichtbar, ohne dass etwas fehlschlägt.
 *
 * `window.ajnaLog` ist die eine geteilte Instanz. Der Toast macht es seit jeher
 * so; hier stand es nur nicht, und ich bin prompt hineingelaufen.
 */
export function protokolliereInteraktion(record, action, text) {
  try { window.ajnaLog?.push(interaktionsZeile(record, action, text), 'interact') } catch {}
}

export function interactionReply(record, action, name) {
  const label = name || record?.name || record?.id || 'das Objekt'
  switch (String(action || '').toLowerCase()) {
    case 'examine':
    case 'read':
    case 'lesen':
      if (record?.type === 'call') return callExamineText(record)
      // Ein Feld darf eine Zeichenkette ODER eine Sprachkarte sein — kein Agent
      // MUSS übersetzen, wer mag, kann (siehe core/Sprachwahl.js).
      return inSprache(record?.description) || inSprache(record?.state?.hint)
        || inSprache(record?.state?.dialog)
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
        // Ein wiederholbarer Auftrag steht nach dem Durchlauf wieder auf "open" —
        // dann sagen wir, wie oft er noch geht, statt "erledigt" zu behaupten.
        const msg = isAccept
          ? `Auftrag „${nm}" angenommen`
          : res?.status === 'pending'
            ? `Auftrag „${nm}": Abschluss eingereicht — wird geprüft`
            : res?.status === 'open'
              ? `Auftrag „${nm}": Belohnung erhalten — noch ${res.rewardsLeft ?? '?'} im Vorrat`
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
