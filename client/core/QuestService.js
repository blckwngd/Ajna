// QuestService — die Auftragsliste und alles, was man mit ihr tut.
//
// Zwischen Fenster und Server: Das Panel zeigt an, der AjnaManager spricht,
// hier steht, WAS bei welchem Knopf geschieht und woher die Liste kommt.
// Ohne diese Schicht läge die Ablauflogik in der MobileShell — zwischen
// Tab-Umschaltung und Zauberstab-Verbindung, wo sie niemand vermutet.
//
// GRUNDSATZ: Der Server entscheidet, dieser Dienst fragt. Ob ich einen Auftrag
// annehmen darf, ob mein Karma reicht, ob die Belohnung gedeckt ist — all das
// wird serverseitig geprüft. Was hier steht, ist Bequemlichkeit für die
// Oberfläche, keine zweite Regelquelle. Eine Ablehnung wird deshalb
// weitergereicht und nicht geschluckt: Das Fenster soll sie zeigen.
//
// ZWEI ABFRAGEN, NICHT EINE: Die Regionsliste ist auf einen Umkreis begrenzt —
// sonst zöge jeder Blick alle Aufträge der Welt. Eigene Ausschreibungen und
// Entwürfe müssen aber auffindbar bleiben, auch wenn man gerade woanders ist.
// Deshalb zusätzlich `mine=1` ohne Ort.

import {
  listeZuAnsicht, zuFormular, callZustandAus, publishPayloadAus,
  inventarAus, waehleBelohnung, benoetigterVorrat,
} from './questMapping.js'

/** Wie weit die Regionsliste reicht (Meter). */
export const RADIUS_M = 3000

/**
 * Aussehen eines neu angelegten Auftrags.
 *
 * Der Auftrags-Editor fragt bewusst nicht danach: Wer eine Aufgabe
 * ausschreibt, denkt an die Aufgabe. Ohne Vorgabe stünde der Auftrag als
 * namenlose Kiste in der Welt — mit dieser hier ist er als Aushang erkennbar,
 * und wer die Extrameile gehen will, ändert ihn im Objekt-Editor.
 */
export const AUFTRAG_AUSSEHEN = { emoji: '📣', color: '#c58b2b', scale: 1 }

export class QuestService {
  /**
   * @param {{
   *   ajna: import('./AjnaManager.js').AjnaManager,
   *   getPosition?: () => ({lat:number, lon:number}|null),
   *   radius?: number,
   * }} opts
   */
  constructor({ ajna, getPosition = null, radius = RADIUS_M } = {}) {
    this.ajna = ajna
    this.getPosition = getPosition
    this.radius = radius
  }

  get meineId() { return this.ajna?.currentUser?.()?.id || '' }

  // ── Lesen ──────────────────────────────────────────────────────────────

  /**
   * Aufträge holen und in die Anzeigeform bringen.
   * @returns {Promise<{quests: object[], karma: object, fehler: object[]}>}
   */
  async laden() {
    const pos = this._position()
    const [region, meine] = await Promise.all([
      this.ajna.questsNear({ ...(pos || {}), radius: this.radius }),
      this.ajna.questsNear({ mine: true, radius: this.radius }),
    ])

    // Zusammenlegen: Ein eigener Auftrag in der Nähe steht in beiden Antworten.
    // Der regionale Satz gewinnt — nur er trägt die Entfernung.
    const nachId = new Map()
    for (const q of meine.quests) nachId.set(q.id, q)
    for (const q of region.quests) nachId.set(q.id, q)

    return {
      quests: listeZuAnsicht([...nachId.values()], this.meineId),
      karma: { ...meine.karma, ...region.karma },
      fehler: [...region.fehler, ...meine.fehler],
    }
  }

  _position() {
    try {
      const p = this.getPosition?.()
      if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) return { lat: p.lat, lon: p.lon }
    } catch { /* ohne Ort geht es auch — dann ohne Entfernung */ }
    return null
  }

  // ── Handeln ────────────────────────────────────────────────────────────

  /**
   * Knopf aus der Detailansicht ausführen.
   *
   * Fehler werden bewusst NICHT abgefangen: „schon vergeben", „Karma reicht
   * nicht", „Nachweis unvollständig" sind Antworten des Servers, die der
   * Spieler lesen soll. Der Panel zeigt sie an der Stelle, an der er geklickt
   * hat.
   *
   * @param {object} q      Anzeige-Auftrag (aus questMapping)
   * @param {string} aktion accept | submit | abandon | confirm | reject
   * @param {object} [opts] {proof, note}
   */
  async aktion(q, aktion, opts = {}) {
    const id = q?.id
    if (!id) throw new Error('Auftrag ohne Kennung')

    if (aktion === 'accept') return this.ajna.acceptQuest(id)

    if (aktion === 'submit') return this.ajna.completeQuest(id, opts.proof || null)

    // Aufgeben: Der Auftrag geht zurück in den Umlauf. `quest/cancel` ist etwas
    // anderes — das zieht die AUSSCHREIBUNG zurück und darf nur der Aussteller.
    if (aktion === 'abandon') return this.ajna.abandonQuest(id)

    if (aktion === 'confirm' || aktion === 'reject') {
      const ja = aktion === 'confirm'
      // Beim Schwarm ist es eine Stimme, sonst eine Entscheidung. Beides ist
      // „bestätigen" aus Sicht des Prüfers, aber es sind verschiedene Routen.
      if (q?.roh?.verify === 'crowd') {
        return this.ajna.confirmQuest(id, ja ? 'ok' : 'nein', opts.note || '')
      }
      return ja
        ? this.ajna.approveQuest(id)
        : this.ajna.rejectQuest(id, { reason: opts.note || 'abgelehnt' })
    }

    throw new Error(`Unbekannte Aktion: ${aktion}`)
  }

  /**
   * Was beim „Erledigt melden" beigelegt werden muss.
   * @returns {{noetig: string[], ort: boolean, foto: boolean, gegenstand: boolean}}
   */
  nachweisBedarf(q) {
    const n = Array.isArray(q?.roh?.nachweis) ? q.roh.nachweis : []
    return {
      noetig: n,
      ort: n.includes('vorOrt'),
      foto: n.includes('foto'),
      gegenstand: n.includes('gegenstand'),
    }
  }

  /** Nachweis-Rumpf aus dem, was der Client weiß. */
  nachweisBauen({ note = '' } = {}) {
    const proof = {}
    if (note) proof.note = note
    const p = this._position()
    if (p) proof.at = { lat: p.lat, lon: p.lon }
    return proof
  }

  // ── Schreiben (Editor) ─────────────────────────────────────────────────

  /** Eigene Gruppen für Prüfgruppe und Sichtbarkeit. */
  async gruppen() {
    try {
      const list = await this.ajna.listGroups()
      return (list || []).map(g => ({ id: g.id, name: g.name || g.id }))
    } catch { return [] }
  }

  /**
   * Getragene Gegenstände als Auswahl für die Belohnung.
   *
   * `serverId` grenzt auf einen Server ein. Das ist keine Bequemlichkeit,
   * sondern eine Grenze der Sache: Die Treuhand wird in EINER Transaktion des
   * ausschreibenden Servers gebunden und ausgezahlt. Ein Server kann einen
   * Gegenstand, der auf einem anderen liegt, weder sperren noch übergeben.
   *
   * @param {string|null} callId    Auftrag, dessen eigene Treuhand mitzählen darf
   * @param {string|null} serverId  Server, auf dem ausgeschrieben wird
   */
  inventar(callId = null, serverId = null) {
    const alle = this.ajna.getObjects?.() || []
    return inventarAus(alle, this.meineId, { callId: this._roh(callId), serverId })
  }

  /**
   * Server, auf denen sich ausschreiben lässt.
   *
   * Angemeldet REICHT NICHT — ein Server kann eingeloggt und trotzdem getrennt
   * sein (Sitzung im Speicher, Verbindung weg). Ihn dann als Ziel anzubieten
   * hieße, einen Auftrag anzulegen, der beim ersten Schreibversuch scheitert;
   * schlimmer noch: das Anlegen könnte durchgehen und die Treuhand nicht.
   */
  serverListe() {
    try {
      return (this.ajna.getServers?.() || [])
        .filter(s => s.isLoggedIn && s.isConnected && !s.isDisconnected)
        .map(s => ({ id: s.id, label: s.label || s.url, isDefault: !!s.isDefault }))
    } catch { return [] }
  }

  /** Anzeige-Auftrag in das Editor-Formular, samt Sichtbarkeit aus den Rechten. */
  async formularFuer(v) {
    if (!v) return null
    const sicht = await this._sichtbarkeitVon(v.id)
    return zuFormular(v, sicht)
  }

  async _sichtbarkeitVon(id) {
    try {
      const aces = await this.ajna.listPermissions(id)
      for (const a of aces || []) {
        if (a.subject_type === 'group') return { sichtbarkeit: 'gruppe', sichtbarGruppe: a.subject }
        if (a.subject_type === 'authenticated' || a.subject_type === 'everyone') {
          return { sichtbarkeit: 'region', sichtbarGruppe: '' }
        }
      }
    } catch { /* keine Auskunft → unveränderte Vorgabe */ }
    return { sichtbarkeit: 'privat', sichtbarGruppe: '' }
  }

  /**
   * Auftrag anlegen oder ändern; auf Wunsch gleich ausschreiben.
   *
   * Reihenfolge ist Absicht:
   *   1. Objekt anlegen/ändern — die Beschreibung gehört dem Aussteller.
   *   2. Sichtbarkeit setzen — sonst könnte niemand den Auftrag sehen, den
   *      Schritt 3 gerade ausschreibt.
   *   3. Ausschreiben — bindet die Belohnung treuhänderisch. Erst hier wird
   *      geprüft, ob die Gegenstände wirklich da und frei sind, und erst hier
   *      kann es zu Recht scheitern.
   *
   * @param {object} formular Stand aus dem QuestEditor
   * @param {{publish?: boolean}} [opts]
   */
  async speichern(formular, { publish = false } = {}) {
    const f = formular || {}
    // Die im Kontextmenü angeklickte Stelle geht vor: Sie ist eine Aussage
    // („dort soll der Auftrag hin"), die eigene Position nur ein Rückfall.
    const pos = (f.position && Number.isFinite(f.position.lat)) ? f.position : this._position()
    const vorhanden = f.id ? this._objekt(f.id) : null
    const vorher = vorhanden?.state?.call || null

    const state = { ...(vorhanden?.state || {}), call: callZustandAus(f, { vorher }) }
    const daten = { name: String(f.titel || '').trim(), type: 'call', state }

    let id = f.id
    if (id) {
      await this.ajna.updateObject(id, daten)
    } else {
      if (!pos) throw new Error('Ohne bekannte Position lässt sich kein Auftrag anlegen.')
      // Ein getrennter Server nimmt nichts entgegen. Das hier zu sagen ist
      // freundlicher, als den Netzwerkfehler durchzureichen.
      if (!this.serverListe().length) {
        throw new Error('Kein verbundener Server — der Auftrag kann nirgends angelegt werden.')
      }
      daten.lat = pos.lat
      daten.lon = pos.lon
      daten.altitude = 0
      // Aussehen wird hier NICHT gefragt. Wer einen Auftrag ausschreibt, hat
      // einen Text im Kopf, keine Meinung zu glTF-Dateien — also eine
      // brauchbare Vorgabe setzen und im Objekt-Editor änderbar lassen.
      daten.appearance = { ...AUFTRAG_AUSSEHEN }
      daten.description = String(f.kurz || '').trim()
      // Ohne Angabe der Standardserver — die Wahl im Kopf des Fensters geht vor.
      const rec = await this.ajna.createObject(daten, { serverId: f.server || undefined })
      id = rec?.id
      if (!id) throw new Error('Der Auftrag wurde nicht angelegt.')
    }

    await this._sichtbarkeitSetzen(id, f)
    if (!publish) return { id, published: false }

    // Belohnung: der Editor wählt eine Gattung und eine Anzahl, der Server will
    // konkrete Stücke. Fehlt etwas, ist das hier zu sagen — nicht erst als
    // Serverfehler mit Datensatz-Kennungen darin.
    //
    // Gebunden wird der VORRAT, nicht die Belohnung eines Durchlaufs: Bei einem
    // wiederholbaren Auftrag müssen alle Stücke von Anfang an hinterlegt sein,
    // sonst stünde die letzte Erledigung ohne Deckung da.
    const aufServer = this._serverVon(id)
    const bestand = this.inventar(id, aufServer)
    const menge = benoetigterVorrat(f)
    const { ids, fehlt } = waehleBelohnung(bestand, f.belohnung?.was, menge)
    if (fehlt > 0) {
      throw new Error(`Es fehlen ${fehlt}× ${f.belohnung?.was || 'Belohnung'} in deinem Inventar auf diesem Server.`)
    }
    if (!ids.length) throw new Error('Ohne Belohnung lässt sich kein Auftrag ausschreiben.')

    await this.ajna.publishQuest(id, publishPayloadAus(f, ids))
    return { id, published: true }
  }

  /** Ausschreibung zurückziehen — die Treuhand wird wieder frei. */
  async zurueckziehen(formular) {
    if (!formular?.id) throw new Error('Auftrag ohne Kennung')
    return this.ajna.cancelQuest(formular.id)
  }

  /**
   * Sichtbarkeit als Rechte setzen.
   *
   * „Region" heißt `authenticated`: jeder Angemeldete darf ihn SEHEN. Annehmen
   * ist etwas anderes und hängt am Karma. Alte Einträge werden entfernt, sonst
   * bliebe eine Gruppe berechtigt, die längst nicht mehr gemeint ist.
   */
  async _sichtbarkeitSetzen(id, f) {
    const soll = f?.sichtbarkeit || 'region'
    let alt = []
    try { alt = await this.ajna.listPermissions(id) || [] } catch { alt = [] }

    const behalten = []
    for (const a of alt) {
      const passt = (soll === 'region' && a.subject_type === 'authenticated')
        || (soll === 'gruppe' && a.subject_type === 'group' && String(a.subject) === String(f.sichtbarGruppe || ''))
      if (passt) { behalten.push(a); continue }
      // Nur die von der Sichtbarkeit verwalteten Einträge anfassen. Ein von
      // Hand vergebenes Einzelrecht darf ein Speichern nicht wegräumen.
      if (a.subject_type === 'authenticated' || a.subject_type === 'group') {
        try { await this.ajna.removePermission(a.id) } catch { /* schon weg */ }
      }
    }
    if (soll === 'privat' || behalten.length) return
    if (soll === 'gruppe' && !f.sichtbarGruppe) return
    try {
      await this.ajna.addPermission(id, {
        subject_type: soll === 'gruppe' ? 'group' : 'authenticated',
        subject: soll === 'gruppe' ? String(f.sichtbarGruppe) : '',
        rights: ['view'],
        interact_actions: [],
      })
    } catch (err) {
      throw new Error(`Sichtbarkeit konnte nicht gesetzt werden: ${err?.message || err}`)
    }
  }

  // ── Kleinkram ──────────────────────────────────────────────────────────

  _objekt(id) {
    try { return this.ajna.getObjectById?.(id) || null } catch { return null }
  }

  _roh(id) {
    if (!id) return null
    const i = String(id).indexOf(':')
    return i < 0 ? String(id) : String(id).slice(i + 1)
  }

  /** Server-Kennung aus einer zusammengesetzten Objekt-ID. */
  _serverVon(id) {
    const i = String(id || '').indexOf(':')
    return i < 0 ? null : String(id).slice(0, i)
  }
}
