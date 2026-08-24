// PresenceService — andere Spieler sehen, und selbst gesehen werden.
//
// EIN SPIELER IST EIN OBJEKT. Kein zweiter Weg neben den Objekten: Damit gelten
// dieselben Rechte, dieselbe Realtime-Verteilung und dieselbe Darstellung wie
// für alles andere in der Welt. Eine Anwesenheit erscheint dadurch ohne
// Zusatzarbeit in AR, im Freiflug und auf der Minimap.
//
// PRIVATSPHÄRE IST DIE ERSTE FRAGE, NICHT DIE LETZTE
//
// Angelegt wird eine Anwesenheit NUR bei Stufe „Genau" — und zwar pro Server,
// wie alle Standort-Freigaben. Die Begründung ist nicht Bequemlichkeit:
//
//   • „Verborgen" heißt verborgen. Keine Anwesenheit.
//   • „Gegend" liefert absichtlich eine auf ~100 m gerundete Position. Eine
//     Figur, die um ein Raster springt, behauptet eine Genauigkeit, die die
//     Stufe gerade verweigert — und wäre für andere irreführend statt schützend.
//   • „Nähe" meldet Objekt-IDs statt Koordinaten. Daraus lässt sich keine Figur
//     zeichnen, ohne genau die Koordinate zu rekonstruieren, die zurückgehalten
//     wird.
//
// Wer gesehen werden will, hebt die Stufe für diesen Server — bewusst und
// sichtbar. Die Anwesenheit verschwindet sofort, wenn die Stufe wieder sinkt.
//
// WER DARF SIE SEHEN: nichts ohne Zutun. Die Sichtbarkeit wird als gewöhnliche
// Berechtigung gesetzt (`authenticated`, view). Ohne diesen Eintrag sieht die
// Anwesenheit niemand außer dem Besitzer — das ist die sichere Vorgabe.
//
// WAS DER SERVER EINSTEMPELT: Name und Karma (siehe `stampeAnwesenheit` in
// pb_hooks/main.pb.js). Der Client schreibt sie NICHT — ein selbst gesetzter
// Name wäre eine Verkleidung, ein selbst gesetztes Karma eine Behauptung.

import { privacy } from './PrivacyPolicy.js'

/** Objekt-Typ der Anwesenheiten. */
export const PRESENCE_TYPE = 'player'

/** Wie oft die eigene Position höchstens geschrieben wird (ms). */
export const SCHREIB_MS = 5_000

/** Ab welcher Bewegung ausserhalb des Takts geschrieben wird (Meter). */
export const BEWEGUNG_M = 5

/**
 * Ab wann eine fremde Anwesenheit als veraltet gilt (ms).
 *
 * Wer die App schliesst, kann seine Anwesenheit nicht mehr aufräumen — ohne
 * diese Grenze bliebe ein Gespenst stehen, und zwar an der letzten bekannten
 * Stelle, was schlimmer ist als gar nichts anzuzeigen.
 */
export const VERALTET_MS = 3 * 60_000

/** Aussehen der Platzhalter-Figur. */
export const PRESENCE_AUSSEHEN = {
  emoji: '🧍',
  color: '#4a9d5f',
  // Die Beschriftung ist der eigentliche Inhalt: Es geht um die PERSON, nicht
  // um ihr Modell. Deshalb ein Platzhalter und ein gut lesbares Schild.
  // `{state.name}` und `{karma}` stempelt der Server ein — der Client kann sie
  // nicht setzen, sonst wäre beides eine Behauptung.
  label: '{state.name} {karma}',
}

const abstandM = (a, b) => {
  if (!a || !b) return Infinity
  const R = 6371000
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLon = (b.lon - a.lon) * Math.PI / 180
  const m = Math.cos(a.lat * Math.PI / 180)
  return Math.sqrt((dLat * R) ** 2 + (dLon * R * m) ** 2)
}

export class PresenceService {
  /**
   * @param {{
   *   ajna: import('./AjnaManager.js').AjnaManager,
   *   getPosition?: () => ({lat:number, lon:number, altitude?:number}|null),
   *   getHeading?: () => number|null,
   * }} opts
   */
  constructor({ ajna, getPosition = null, getHeading = null } = {}) {
    this.ajna = ajna
    this.getPosition = getPosition
    this.getHeading = getHeading
    this._eigene = new Map()      // serverId → { id, lat, lon }
    this._timer = null
    this._laeuft = false
    this._offPrivacy = null
  }

  get meineId() { return this.ajna?.currentUser?.()?.id || '' }

  start() {
    if (this._laeuft) return
    this._laeuft = true
    this._timer = setInterval(() => { this.tick() }, SCHREIB_MS)
    // Sinkt die Stufe, muss die Anwesenheit SOFORT weg — nicht erst beim
    // nächsten Takt. Eine Freigabe zurückzunehmen darf nicht warten.
    try { this._offPrivacy = privacy.onChange?.(() => this.tick()) || null } catch {}
    this.tick()
  }

  async stop() {
    this._laeuft = false
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    try { this._offPrivacy?.() } catch {}
    this._offPrivacy = null
    await this.entferneAlle()
  }

  /**
   * Einmal nachziehen: auf jedem Server anlegen, aktualisieren oder entfernen.
   * Fehler einzelner Server bleiben bei diesem Server — eine unerreichbare
   * Instanz darf die Anwesenheit auf den anderen nicht kippen.
   */
  async tick() {
    if (!this.meineId) return
    const pos = this._position()
    for (const s of this._server()) {
      const erlaubt = pos && privacy.allows(s.id, 'exact')
      try {
        if (erlaubt) await this._sicherstellen(s.id, pos)
        else await this._entfernen(s.id)
      } catch (err) {
        console.warn(`[presence] ${s.id}: ${err?.message || err}`)
      }
    }
  }

  _position() {
    try {
      const p = this.getPosition?.()
      if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) return p
    } catch {}
    return null
  }

  _server() {
    try {
      return (this.ajna.getServers?.() || [])
        .filter(s => s.isLoggedIn && s.isConnected && !s.isDisconnected)
    } catch { return [] }
  }

  async _sicherstellen(serverId, pos) {
    const bekannt = this._eigene.get(serverId)
    if (bekannt) {
      // Nicht bei jedem Takt schreiben: Ein Standbild erzeugte sonst alle fünf
      // Sekunden eine Realtime-Nachricht an alle Betrachter.
      if (abstandM(bekannt, pos) < BEWEGUNG_M && Date.now() - (bekannt.t || 0) < 30_000) return
      await this.ajna.updateObject(bekannt.id, this._daten(pos))
      this._eigene.set(serverId, { ...bekannt, lat: pos.lat, lon: pos.lon, t: Date.now() })
      return
    }

    // Vorhandene Anwesenheit wiederverwenden — sonst sammelt jeder Neustart
    // eine weitere Leiche an.
    const vorhanden = this._meineAuf(serverId)
    if (vorhanden) {
      await this.ajna.updateObject(vorhanden.id, this._daten(pos))
      this._eigene.set(serverId, { id: vorhanden.id, lat: pos.lat, lon: pos.lon, t: Date.now() })
      return
    }

    const rec = await this.ajna.createObject({
      name: 'Anwesenheit',
      type: PRESENCE_TYPE,
      ...this._daten(pos),
      appearance: { ...PRESENCE_AUSSEHEN },
    }, { serverId })
    if (!rec?.id) return
    this._eigene.set(serverId, { id: rec.id, lat: pos.lat, lon: pos.lon, t: Date.now() })
    await this._sichtbarMachen(rec.id)
  }

  _daten(pos) {
    const kurs = Number(this.getHeading?.())
    const d = {
      lat: pos.lat,
      lon: pos.lon,
      altitude: 0,
      // `realtime` — die Anwesenheit ist genau der Fall, für den es gedacht ist.
      state: { realtime: true, presence: true },
    }
    if (Number.isFinite(kurs)) d.rotation = { x: 0, y: kurs, z: 0 }
    return d
  }

  /** Eigene Anwesenheit auf einem Server, falls sie noch im Bestand liegt. */
  _meineAuf(serverId) {
    try {
      return (this.ajna.getObjects?.() || []).find(o =>
        o?.type === PRESENCE_TYPE
        && String(o.owner || '') === this.meineId
        && String(o._origin || '') === String(serverId)) || null
    } catch { return null }
  }

  async _sichtbarMachen(id) {
    try {
      await this.ajna.addPermission(id, {
        subject_type: 'authenticated', subject: '',
        rights: ['view'], interact_actions: [],
      })
    } catch (err) {
      console.warn('[presence] Sichtbarkeit:', err?.message || err)
    }
  }

  async _entfernen(serverId) {
    const bekannt = this._eigene.get(serverId) || this._meineAuf(serverId)
    if (!bekannt?.id) return
    this._eigene.delete(serverId)
    try { await this.ajna.deleteObject(bekannt.id) } catch { /* schon weg */ }
  }

  async entferneAlle() {
    const ids = [...new Set([
      ...[...this._eigene.values()].map(e => e.id),
      ...(this.ajna.getObjects?.() || [])
        .filter(o => o?.type === PRESENCE_TYPE && String(o.owner || '') === this.meineId)
        .map(o => o.id),
    ])]
    this._eigene.clear()
    for (const id of ids) {
      try { await this.ajna.deleteObject(id) } catch {}
    }
  }
}

/**
 * Ist das eine Anwesenheit, die ich anzeigen soll?
 *
 * Die eigene gehört NICHT dazu: In AR stünde sie im eigenen Kopf, und im
 * Freiflug verdeckt sie die Stelle, auf die man gerade schaut. Veraltete
 * ebenfalls nicht — siehe VERALTET_MS.
 *
 * @param {object} rec        Objekt-Datensatz
 * @param {string} meineId    eigenes Konto
 * @param {number} [jetzt]
 */
export function zeigeAnwesenheit(rec, meineId, jetzt = Date.now()) {
  if (!rec || rec.type !== PRESENCE_TYPE) return false
  if (String(rec.owner || '') === String(meineId || '')) return false
  const stempel = Date.parse(rec.state?.seenAt || rec.updated || '')
  if (!Number.isFinite(stempel)) return true      // ohne Stempel nicht verstecken
  return (jetzt - stempel) <= VERALTET_MS
}

/** Beschriftung einer fremden Anwesenheit: Name, darunter Karma als Sterne. */
export function anwesenheitsText(rec) {
  const name = String(rec?.state?.name || '').trim() || 'Unbekannt'
  const stufe = Math.max(0, Math.min(5, Number(rec?.state?.karma) || 0))
  return { name, stufe, sterne: '★'.repeat(stufe) + '☆'.repeat(5 - stufe) }
}
