// Sprachausgabe (TTS) für Spielereignisse: Anvisieren, Interaktion, Erzeugen.
//
// Reine Text-Ableitung aus dem gecachten Record; die eigentliche Ausgabe macht
// WandAudioFeedback (native TTS / Web-Speech). Alles ist über den „Audio
// aktiviert"-Schalter gegated (WandAudioFeedback.isEnabled() → audio.enabled).
//
// Gewünschte Beispiele:
//   Anvisieren:  "NPC Klaus"
//   Untersuchen: spricht die zurückgegebene Beschreibung (die "Antwort")
//   Angriff:     "Angriff - NPC getötet"
//   Erzeugen:    "Neues Objekt erzeugt: Monster Grimmroth"

import { TYPE_LABEL } from './SpawnHere.js'
import { talkResponse } from './InteractionReply.js'

const typeLabel = record => TYPE_LABEL[record?.type] || record?.type || 'Objekt'
const nameOf = record => record?.name || record?.id || 'Objekt'

// Macht einen Text TTS-tauglich: Emoji/Symbole raus, Whitespace zusammenfassen,
// auf `max` Zeichen kürzen (mit … am Ende). Lange Antworten wie examine-
// Beschreibungen würden die Ausgabe sonst sprengen.
export function forSpeech(text, max = 100) {
  if (!text) return ''
  let s = String(text)
    .replace(/[\p{Extended_Pictographic}️‍]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…'
  return s
}

/** Anvisieren/Fokus: "<Typ> <Name>" → "NPC Klaus". */
export function announceTargetText(record) {
  if (!record) return null
  return `${typeLabel(record)} ${nameOf(record)}`.trim()
}

/**
 * Interaktion: informative Aktionen (examine/talk) sprechen die zurückgegebene
 * Antwort (Beschreibung/Dialog/Hinweis); Effekt-Aktionen (attack/feed/…) ihr
 * Ergebnis. Wird vom Announcer noch auf 100 Zeichen gekürzt.
 */
export function announceInteractionText(record, action) {
  const t = typeLabel(record)
  const name = nameOf(record)
  switch (String(action || '').toLowerCase()) {
    case 'examine': case 'lesen': case 'read':
      return record?.description || record?.state?.hint || record?.state?.dialog || `Ein ${t}.`
    case 'talk': case 'sprechen':
      return talkResponse(record)
    case 'attack': case 'angreifen':
      return `Angriff - ${t} getötet`
    case 'feed': case 'füttern':
      return `Füttern - ${t} gefüttert`
    case 'collect': case 'einsammeln':
      return `${name} eingesammelt`
    default:
      return `${action} - ${name}`
  }
}

/** Erzeugen: "Neues Objekt erzeugt: <Typ> <Name>". */
export function announceCreateText(record) {
  if (!record) return null
  return `Neues Objekt erzeugt: ${typeLabel(record)} ${nameOf(record)}`
}

/**
 * Typ-bewusste Ansagen über die geteilte Audio-Instanz, gegated über den
 * „Audio aktiviert"-Schalter. Hält das zuletzt angesagte Ziel, damit das
 * Halten des Fokus nicht wiederholt spricht. Alle Texte werden TTS-tauglich
 * gemacht und auf 100 Zeichen gekürzt (forSpeech).
 */
export class Announcer {
  constructor({ audio, ajna }) {
    this.audio = audio
    this.ajna = ajna
    this._lastTargetId = null
  }

  _on() { return !!this.audio?.enabled }

  _rec(recordOrId) {
    return typeof recordOrId === 'string'
      ? (this.ajna?.getObjectById?.(recordOrId) || null)
      : (recordOrId || null)
  }

  /** Anvisieren/Fokus. Übergib null bei Fokusverlust (setzt nur zurück). */
  target(recordOrId) {
    const rec = this._rec(recordOrId)
    const id = rec?.id || (typeof recordOrId === 'string' ? recordOrId : null)
    if (id === this._lastTargetId) return
    this._lastTargetId = id
    if (!id || !this._on()) return
    const text = forSpeech(announceTargetText(rec))
    if (text) this.audio.speak(text)        // unterbrechend (latest wins)
  }

  /** Objekt gesperrt/gewählt (Knopf 2). null = Auswahl aufgehoben. */
  selected(recordOrId) {
    if (!this._on()) return
    const rec = this._rec(recordOrId)
    const text = rec ? forSpeech(`${announceTargetText(rec)} gewählt`) : 'Auswahl aufgehoben'
    if (text) this.audio.speak(text)
  }

  /** Interaktion (Trigger oder eingehende Reaktion) — Antwort wird gesprochen. */
  interaction(recordOrId, action) {
    if (!this._on()) return
    const text = forSpeech(announceInteractionText(this._rec(recordOrId), action))
    if (text) this.audio.speak(text)
  }

  /** Neues Objekt erzeugt. */
  created(record) {
    if (!this._on()) return
    const text = forSpeech(announceCreateText(record))
    if (text) this.audio.announce(text)     // eingereiht (nicht abwürgen)
  }
}
