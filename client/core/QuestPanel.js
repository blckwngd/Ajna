// QuestPanel — Aufträge in drei Reitern: verfügbar, aktiv, zu prüfen.
//
// Warum ein eigener Bereich und nicht das Objektmenü: Ein Auftrag hat einen
// Lebenslauf. Er wird ausgeschrieben, angenommen, bearbeitet, eingereicht,
// geprüft und abgeschlossen — und der Spieler muss ihn auch dann finden, wenn
// er gerade nicht davorsteht. Das ist ein kleines Ticketsystem, kein
// Kontextmenü.
//
// Die drei Reiter entsprechen den drei Rollen, die ein Spieler einnimmt:
//   Verfügbar  — was ich übernehmen KÖNNTE (Region + angebotene Objekt-Quests)
//   Aktiv      — was ich übernommen HABE, samt Stand
//   Prüfen     — was ICH bestätigen soll (Auftraggeber, Prüfgruppe, Schwarm)
//
// „Angeboten" ist ein eigener Zustand: Eine Quest, die ein NPC vergibt, ist
// zunächst NICHT gelistet (`listed: false`). Nimmt sie niemand zeitnah an,
// wandert sie zusätzlich in die Verfügbar-Liste — das Objekt bleibt, wo es ist,
// nur die Sichtbarkeit ändert sich.
//
// Der Panel kennt weder PocketBase noch die Treuhand — beides bleibt beim
// Server, der Panel zeigt nur an und fragt. `setQuests()` füllt ihn,
// `onAction` meldet, was der Spieler ausgelöst hat, `onReload` holt nach.
// Übersetzt wird in core/questMapping.js, nicht hier.

import { makeDraggable } from './draggable.js'
import { t } from './i18n.js'
import { klickDaneben } from './klickDaneben.js'
import { karmaLabel } from './karma.js'

const STYLE_ID = 'ajna-quest-style'
const KEY_TAB = 'ajna.quests.tab'

/**
 * Zustände eines Auftrags aus SICHT DES SPIELERS. Bewusst nicht identisch mit
 * dem Server-Status (`open/claimed/pending/done`): „angeboten" und „prüfung"
 * hängen daran, WER fragt, nicht am Datensatz allein.
 */
export const QUEST_STATES = {
  offen:      { label: 'Offen',        tab: 'verfuegbar', farbe: '#4a9d5f' },
  angeboten:  { label: 'Angeboten',    tab: 'verfuegbar', farbe: '#c58b2b' },
  angenommen: { label: 'Angenommen',   tab: 'aktiv',      farbe: '#2c5d8f' },
  eingereicht:{ label: 'Wird geprüft', tab: 'aktiv',      farbe: '#6b5ba8' },
  pruefung:   { label: 'Zu prüfen',    tab: 'pruefen',    farbe: '#a8562b' },
  // ABGESCHLOSSEN IST NICHT AKTIV. „Aktiv" ist die Liste dessen, woran man
  // gerade arbeitet — ein erledigter Auftrag stand dort und verstopfte sie,
  // ohne dass man etwas mit ihm tun konnte. Er bleibt unter „Meine" auffindbar,
  // wenn er einem gehört; dass er fertig ist, sagt eine Meldung im Verlauf
  // (siehe MobileShell._questStandMelden).
  erledigt:   { label: 'Erledigt',     tab: 'meine',      farbe: '#5a6068' },
  abgelaufen: { label: 'Abgelaufen',   tab: 'meine',      farbe: '#8a3b3b' },
  entwurf:    { label: 'Entwurf',      tab: 'meine',      farbe: '#5a6068' },
  // Ein noch nicht ausgeschriebener Auftrag, den sein Autor selbst durchspielen
  // darf. Bleibt unter „Meine" — dort sucht ihn, wer ihn geschrieben hat.
  probe:      { label: 'Probelauf',    tab: 'meine',      farbe: '#6b5ba8' },
}

const TABS = [
  { key: 'verfuegbar', label: 'Verfügbar' },
  { key: 'aktiv',      label: 'Aktiv' },
  { key: 'pruefen',    label: 'Prüfen' },
  { key: 'meine',      label: 'Meine' },
]

/**
 * „Nur vor Ort annehmen" — was in der Detailansicht dazu steht.
 *
 * `null`, wenn es hier nichts zu sagen gibt: Der Auftrag trägt keine Auflage,
 * oder Annehmen steht gerade gar nicht zur Wahl (eigener Auftrag, schon
 * angenommen, abgelaufen). Ein Hinweis auf eine Bedingung, die niemanden
 * betrifft, ist nur Text.
 *
 * Geprüft hat das der Auftrags-Dienst; hier wird nur formuliert.
 */
export function annehmbarkeit(q, aktionen = []) {
  const a = q?.annahme
  if (!a?.noetig) return null
  if (!aktionen.some(x => x.key === 'accept')) return null
  const weite = a.radiusM >= 1000
    ? `${(a.radiusM / 1000).toFixed(a.radiusM % 1000 ? 1 : 0)} km`
    : `${a.radiusM} m`
  if (a.ok) {
    return { ok: true, hinweis: t('Nur vor Ort annehmbar — du bist nah genug.') }
  }
  // Der Grund entscheidet, was zu tun ist: hingehen, die Freigabe ändern, oder
  // auf ein Positionssignal warten. Ein gemeinsamer Text für alle drei würde
  // zwei Dritteln der Fälle die falsche Anweisung geben.
  if (a.grund === 'zu-weit') {
    return { ok: false, hinweis: t('Nur vor Ort annehmbar — näher als {weite} heran.')
      .replace('{weite}', weite) }
  }
  return { ok: false, hinweis: a.text || t('Nur vor Ort annehmbar.') }
}

/** Aktionen je Zustand — was der Spieler hier tun kann. */
export const QUEST_ACTIONS = {
  offen:       [{ key: 'accept', label: 'Annehmen', primaer: true }],
  angeboten:   [{ key: 'accept', label: 'Annehmen', primaer: true }],
  angenommen:  [{ key: 'submit', label: 'Erledigt melden', primaer: true },
                { key: 'abandon', label: 'Aufgeben' }],
  eingereicht: [],
  pruefung:    [{ key: 'confirm', label: 'Bestätigen', primaer: true },
                { key: 'reject',  label: 'Ablehnen' }],
  erledigt:    [],
  abgelaufen:  [],
  // Entwürfe sind immer eigene Aufträge — dort greift „Bearbeiten" statt
  // dieser Liste (siehe _renderDetail).
  entwurf:     [],
  // Der Probelauf ist zum Ausprobieren da — also steht das Annehmen dort, ohne
  // Umweg über das Veröffentlichen. „Bearbeiten" kommt in _renderDetail dazu.
  probe:       [{ key: 'accept', label: 'Annehmen', primaer: true }],
}

// ── Formatierung ─────────────────────────────────────────────────────────

/** Entfernung menschenlesbar. */
export function fmtDistanz(m) {
  if (!Number.isFinite(m)) return ''
  return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`
}

/**
 * Verbleibende Zeit. Knapp, weil es in einer Zeile neben dem Titel steht.
 * @param {number} bisMs  Zeitstempel
 * @param {number} [jetzt]
 */
export function fmtFrist(bisMs, jetzt = Date.now()) {
  if (!Number.isFinite(bisMs)) return ''
  const s = Math.round((bisMs - jetzt) / 1000)
  // Auch die Einheiten laufen durch t(): Auf Englisch heisst der Tag „d",
  // und eine Zeile „3 T" neben „Deadline" ist genau die Mischung, die stört.
  if (s <= 0) return t('abgelaufen')
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} ${t('min')}`
  if (s < 86400) return `${Math.round(s / 3600)} ${t('h')}`
  return `${Math.round(s / 86400)} ${t('T')}`
}

/**
 * Belohnung als Zeile: Anzahl plus Hinweis auf Steigerung.
 *
 * Vokabular: „Abnehmer" hieß hier fälschlich der Bearbeiter — abgenommen wird
 * aber die fertige Arbeit. Deshalb „solange offen".
 */
export function fmtBelohnung(q) {
  // Ein Auftrag kann mehrere Gattungen hinterlegen („2× Diamant, 1× Talisman").
  // Steht nur eine Zahl da, wäre nicht erkennbar, was man eigentlich bekommt.
  const teile = Array.isArray(q?.belohnung?.teile) ? q.belohnung.teile.filter(x => x?.was) : []
  const basis = teile.length
    ? teile.map(x => `${Number(x.anzahl) || 0}× ${x.was}`).join(', ')
    : (() => {
        const n = Number(q?.belohnung?.anzahl) || 0
        const was = q?.belohnung?.was || t('Belohnung')
        return n ? `${n}× ${was}` : t('ohne Belohnung')
      })()
  const plus = Number(q?.belohnung?.steigt)
  return plus > 0
    ? `${basis} · ${t('+{n}/Tag solange offen').replace('{n}', plus)}`
    : basis
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export class QuestPanel {
  /**
   * @param {{
   *   parent?: HTMLElement,
   *   quests?: object[],                       Startbestand
   *   onAction?: (quest: object, aktion: string) => Promise<any>|any,
   *   onShowOnMap?: (quest: object) => void,
   *   onEdit?: (quest: object|null) => void,
   *   onReload?: () => Promise<any>|any,       „Aktualisieren" und Öffnen
   * }} opts
   */
  constructor({ parent = document.body, quests = null, onAction = null, onShowOnMap = null,
                onEdit = null, onReload = null, onNachweis = null, onBelege = null } = {}) {
    this.parent = parent
    this.onAction = onAction
    // Bilder ablegen, bevor gemeldet wird. Getrennt von onAction, weil es ein
    // anderer Weg ist: Dateifeld statt JSON-Route.
    this.onNachweis = onNachweis
    // Beweisbilder für die Abnahme nachladen.
    this.onBelege = onBelege
    this.onShowOnMap = onShowOnMap
    // Bearbeiten/Neu öffnet den QuestEditor — der Panel kennt ihn nicht selbst,
    // damit er ohne Editor benutzbar bleibt.
    this.onEdit = onEdit
    this.onReload = onReload
    this._quests = Array.isArray(quests) ? quests : []
    this._tab = (() => {
      try { const g = localStorage.getItem(KEY_TAB); return TABS.some(x => x.key === g) ? g : 'verfuegbar' }
      catch { return 'verfuegbar' }
    })()
    this._detail = null      // ID des aufgeklappten Auftrags
    this._open = false
    this._laedt = false
    this._fehler = null
    this._hinweis = null
    this._gefuellt = false   // hat je eine Antwort vorgelegen?
    this._injectStyles()
    this._buildLauncher()
  }

  // ── Daten ──────────────────────────────────────────────────────────────

  /** Bestand ersetzen — die Naht zur echten Quelle (siehe questMapping.js). */
  setQuests(liste) {
    this._quests = Array.isArray(liste) ? liste : []
    this._gefuellt = true
    if (this._detail && !this._quests.some(q => q.id === this._detail)) this._detail = null
    this._updateBadge()
    if (this._open) this._render()
  }

  /**
   * Lädt gerade / ist etwas schiefgegangen.
   *
   * Beides muss sichtbar sein: Eine leere Liste heißt „hier gibt es nichts zu
   * tun" — bei einem Netzfehler wäre das eine Falschaussage.
   */
  setLaden(an) {
    this._laedt = !!an
    if (an) this._fehler = null
    if (this._open) this._render()
  }

  setFehler(text) {
    this._fehler = text ? String(text) : null
    this._laedt = false
    if (this._open) this._render()
  }

  /**
   * Etwas fehlt in der Liste, aber nichts ist kaputt.
   *
   * Getrennt von `setFehler`, weil beides Verschiedenes bedeutet: Ein Fehler
   * heisst „versuch es nochmal", ein Hinweis heisst „so hast du es
   * eingestellt". Beides gleich rot anzuzeigen machte aus einer bewussten
   * Entscheidung eine Störung, der jemand hinterherjagt.
   */
  setHinweis(text) {
    this._hinweis = text ? String(text) : null
    if (this._open) this._render()
  }

  /** Nachladen anstoßen, falls ein Lader angeschlossen ist. */
  async reload() {
    if (!this.onReload || this._laedt) return
    this.setLaden(true)
    try { await this.onReload() } catch (err) { this.setFehler(err?.message || String(err)) }
    finally { this.setLaden(false) }
  }

  /**
   * Aufträge eines Reiters, nächstgelegene zuerst.
   *
   * Selbst ausgeschriebene Aufträge (`meine`) landen unter „Meine" — sonst
   * stünde die eigene Ausschreibung unter „Verfügbar" und sähe aus, als könnte
   * man sie selbst annehmen.
   *
   * AUSNAHME „Prüfen": Bei der Stichprobe nimmt der AUSSTELLER ab. Läge sein
   * eigener Auftrag nur unter „Meine", müsste er die Einreichung dort suchen —
   * und der Zähler am Auslöser bliebe stumm, obwohl etwas auf ihn wartet.
   */
  questsIn(tab) {
    // EIGENE AUFTRÄGE STANDEN NUR UNTER „MEINE" — nie unter „Aktiv".
    //
    // Das war richtig, solange niemand seinen eigenen Auftrag spielen konnte.
    // Seit es den Probelauf gibt, verschwand ein selbst angenommener Auftrag
    // aus dem Reiter, in dem man ihn sucht: „Aktiv" ist die Liste dessen,
    // woran man ARBEITET. Deshalb entscheidet jetzt nicht mehr der Besitz,
    // sondern ob ich ihn gerade halte.
    const arbeiteDran = (q) => q.meine === true && q.bearbeiteIch === true
    const passt = tab === 'meine'
      ? (q) => q.meine === true && !arbeiteDran(q)
      : tab === 'pruefen'
        ? (q) => q.status === 'pruefung'
        : (q) => (q.meine !== true || arbeiteDran(q))
          && (QUEST_STATES[q.status]?.tab || 'aktiv') === tab
    return this._quests.filter(passt)
      .sort((a, b) => (a.distanzM ?? Infinity) - (b.distanzM ?? Infinity))
  }

  /** Was auf dem Auslöser steht: Aufträge, die auf MICH warten. */
  get offeneP() { return this.questsIn('pruefen').length }

  // ── Auslöser ───────────────────────────────────────────────────────────

  _buildLauncher() {
    const b = document.createElement('button')
    b.className = 'ajna-quest-launcher'
    b.type = 'button'
    b.title = 'Aufträge'
    b.innerHTML = `<span aria-hidden="true">📜</span><span class="qp-badge" hidden></span>`
    this.parent.appendChild(b)
    this.fab = b
    this._badgeEl = b.querySelector('.qp-badge')
    this._fabDrag = makeDraggable(b, { key: 'ajna.quests.fab', onClick: () => this.toggle() })
    this._updateBadge()
  }

  _updateBadge() {
    if (!this._badgeEl) return
    const n = this.offeneP
    this._badgeEl.textContent = n > 99 ? '99+' : String(n)
    this._badgeEl.hidden = n === 0
  }

  /**
   * Auslöser ein-/ausblenden. Wird derzeit nicht gebraucht — Aufträge sind in
   * jeder Ansicht erreichbar. Bleibt für den Fall, dass eine Ansicht den
   * schwebenden Knopf einmal doch nicht verträgt (z. B. immersives XR).
   */
  setVisible(on) {
    this._hidden = !on
    if (this.fab) this.fab.style.display = on ? '' : 'none'
    if (!on) this.close()
  }

  // ── Fenster ────────────────────────────────────────────────────────────

  toggle() { this._open ? this.close() : this.open() }

  /**
   * Einen bestimmten Auftrag aufschlagen — für den Weg von der Karte hierher.
   *
   * Öffnet das Fenster, falls es zu ist, und zeigt die Detailansicht. Steht der
   * Auftrag noch nicht in der Liste (gerade erst angelegt), wird nachgeladen
   * und danach aufgeschlagen; sonst landete man auf einer leeren Ansicht.
   */
  async zeigeAuftrag(id) {
    if (!id) return
    if (!this._open) this.open()
    if (!this._quests.some(q => q.id === id) && this.onReload) {
      try { await this.onReload() } catch { /* dann eben die Liste */ }
    }
    this._detail = id
    this._render()
  }

  open() {
    if (this._open || this._hidden) return
    this._open = true
    const ov = document.createElement('div')
    ov.className = 'ajna-quest-overlay'
    ov.innerHTML = `
      <div class="ajna-quest" role="dialog" aria-modal="true" aria-label="${esc(t('Aufträge'))}">
        <header>
          <button class="qp-back" type="button" aria-label="${esc(t('Zurück'))}" hidden>‹</button>
          <h3 data-role="titel">${esc(t('Aufträge'))}</h3>
          <button class="qp-reload" type="button" aria-label="${esc(t('Aktualisieren'))}" title="${esc(t('Aktualisieren'))}">⟳</button>
          <button class="qp-close" type="button" aria-label="${esc(t('Schließen'))}">×</button>
        </header>
        <div class="qp-tabs" role="tablist" data-role="tabs"></div>
        <div class="qp-body" data-role="body"></div>
      </div>`
    klickDaneben(ov, () => this.close())
    ov.querySelector('.qp-close').addEventListener('click', () => this.close())
    ov.querySelector('.qp-back').addEventListener('click', () => { this._detail = null; this._render() })
    const rl = ov.querySelector('.qp-reload')
    rl.hidden = !this.onReload
    rl.addEventListener('click', () => this.reload())
    this.parent.appendChild(ov)
    this._overlay = ov
    this._tabsEl = ov.querySelector('[data-role="tabs"]')
    this._bodyEl = ov.querySelector('[data-role="body"]')
    this._titelEl = ov.querySelector('[data-role="titel"]')
    this._backEl = ov.querySelector('.qp-back')
    this._render()
    // Beim Öffnen frisch holen: Zwischen zwei Blicken auf die Liste kann
    // jemand einen Auftrag angenommen haben.
    this.reload()
  }

  close() {
    this._open = false
    this._detail = null
    this._overlay?.remove()
    this._overlay = this._tabsEl = this._bodyEl = this._titelEl = this._backEl = null
  }

  destroy() {
    try { this._fabDrag?.() } catch {}
    this.fab?.remove()
    this._overlay?.remove()
    this.fab = this._overlay = null
  }

  _setTab(key) {
    this._tab = key
    this._detail = null
    try { localStorage.setItem(KEY_TAB, key) } catch {}
    this._render()
  }

  // ── Zeichnen ───────────────────────────────────────────────────────────

  _render() {
    if (!this._bodyEl) return
    const detail = this._detail ? this._quests.find(q => q.id === this._detail) : null
    this._backEl.hidden = !detail
    this._titelEl.textContent = detail ? t('Auftrag') : t('Aufträge')
    this._tabsEl.hidden = !!detail
    if (detail) { this._renderDetail(detail); return }

    this._tabsEl.innerHTML = TABS.map(reiter => {
      const n = this.questsIn(reiter.key).length
      return `<button type="button" role="tab" data-tab="${reiter.key}"${reiter.key === this._tab ? ' class="on"' : ''}>`
        + `${esc(t(reiter.label))}${n ? ` <span class="qp-count">${n}</span>` : ''}</button>`
    }).join('')
    this._tabsEl.querySelectorAll('button').forEach(b =>
      b.addEventListener('click', () => this._setTab(b.dataset.tab)))

    const liste = this.questsIn(this._tab)
    const neuKnopf = (this._tab === 'meine' && this.onEdit)
      ? `<button type="button" class="qp-btn primaer qp-neu" data-a="neu">+ ${esc(t('Neuer Auftrag'))}</button>` : ''
    const banner = (this._fehler
      ? `<div class="qp-fehler">${esc(this._fehler)}</div>`
      : (this._laedt ? `<div class="qp-laedt">${esc(t('Aufträge werden geladen …'))}</div>` : ''))
      // Der Hinweis steht AUCH bei gefüllter Liste: Mit mehreren Servern fehlen
      // sonst still die Aufträge eines einzelnen, und die Liste sieht
      // vollständig aus.
      + (this._hinweis ? `<div class="qp-hinweis">${esc(this._hinweis)}</div>` : '')
    this._bodyEl.innerHTML = banner + neuKnopf
      + (liste.length
        ? liste.map(q => this._zeileHtml(q)).join('')
        : `<div class="qp-leer">${esc(this._leerText())}</div>`)
    this._bodyEl.querySelector('.qp-neu')?.addEventListener('click', () => this.onEdit?.(null))
    this._bodyEl.querySelectorAll('.qp-row').forEach(el =>
      el.addEventListener('click', () => { this._detail = el.dataset.id; this._render() }))
  }

  _leerText() {
    // Solange nie eine Antwort da war, ist „nichts zu tun" eine Behauptung
    // über Daten, die es noch gar nicht gibt.
    if (this._laedt) return t('Aufträge werden geladen …')
    if (this._fehler) return t('Die Liste konnte nicht geladen werden.')
    // „Hier gibt es nichts zu tun" wäre eine Falschaussage, wenn wir gar nicht
    // gefragt haben.
    if (this._hinweis && this._tab === 'verfuegbar') return t('Keine Aufträge in der Nähe abrufbar.')
    if (!this._gefuellt && this.onReload) return t('Noch nichts geladen.')
    if (this._tab === 'verfuegbar') return t('Hier gibt es gerade nichts zu tun.')
    if (this._tab === 'aktiv') return t('Du hast keinen Auftrag angenommen.')
    if (this._tab === 'meine') return t('Du hast noch keinen Auftrag ausgeschrieben.')
    return t('Nichts zu prüfen.')
  }

  _zeileHtml(q) {
    const st = QUEST_STATES[q.status] || QUEST_STATES.offen
    const frist = fmtFrist(q.frist)
    const dist = fmtDistanz(q.distanzM)
    return `<div class="qp-row" data-id="${esc(q.id)}">
      <div class="qp-row-kopf">
        <span class="qp-titel">${esc(q.titel)}</span>
        <span class="qp-status" style="background:${st.farbe}">${esc(t(st.label))}</span>
      </div>
      <div class="qp-kurz">${esc(q.kurz || '')}</div>
      <div class="qp-meta">
        ${dist ? `<span>📍 ${esc(dist)}</span>` : ''}
        ${frist ? `<span${frist === 'abgelaufen' ? ' class="qp-warn"' : ''}>⏳ ${esc(frist)}</span>` : ''}
        <span>💎 ${esc(fmtBelohnung(q))}</span>
      </div>
    </div>`
  }

  _renderDetail(q) {
    const st = QUEST_STATES[q.status] || QUEST_STATES.offen
    const frist = fmtFrist(q.frist)
    // Beim eigenen Auftrag bearbeitet man ihn, statt ihn anzunehmen.
    // Beim EIGENEN Auftrag kommt „Bearbeiten" dazu — es ersetzt die anderen
    // Knoepfe aber nicht mehr.
    //
    // Der Server erlaubt das Durchspielen des eigenen Auftrags ausdruecklich
    // (tests/quests/self.mjs): annehmen, melden, abnehmen. Nur die Oberflaeche
    // hat es verborgen, und damit war der Weg fuer den haeufigsten Fall
    // versperrt — wer eine Aufgabe schreibt, will sie zuerst selbst ausprobieren.
    // Zu holen ist dabei nichts: Gegenstaende wandern von mir zu mir, und Karma
    // gibt es fuer den eigenen Auftrag nicht (pb_hooks/karma.js).
    // Beim eigenen Auftrag stehen die Spielknoepfe nur, wenn der Server sie
    // auch zulaesst: als Probelauf oder mit Superuser-Recht. Sonst liefe
    // „Annehmen" in ein 403 — ein Knopf, der nichts tut, ist schlimmer als
    // keiner.
    // `darfSpielen`, NICHT `darfAnnehmen`: Letzteres wird falsch, sobald der
    // Auftrag vergeben ist — auch an mich selbst. Damit verschwanden nach dem
    // Annehmen alle Knoepfe, „Erledigt melden" eingeschlossen.
    const spielbar = !q.meine || q.darfSpielen !== false
    const aktionen = [
      ...(q.meine && this.onEdit ? [{ key: 'edit', label: 'Bearbeiten', primaer: !q.status || q.status === 'entwurf' }] : []),
      ...(spielbar ? (QUEST_ACTIONS[q.status] || []) : []),
    ]
    const anf = (q.anforderungen || []).map(a => `<li>${esc(a)}</li>`).join('')
    // „Nur vor Ort annehmen": Der Hinweis steht auch dann da, wenn es GEHT —
    // sonst erführe man von der Auflage erst, wenn sie einen aussperrt, und
    // hielte den ausgegrauten Knopf für einen Fehler.
    const vorOrt = annehmbarkeit(q, aktionen)
    this._bodyEl.innerHTML = `
      <div class="qp-detail">
        <div class="qp-row-kopf">
          <span class="qp-titel gross">${esc(q.titel)}</span>
          <span class="qp-status" style="background:${st.farbe}">${esc(t(st.label))}</span>
        </div>
        <div class="qp-von">${esc(t('von'))} ${esc(q.quelle || t('unbekannt'))}${q.einreicher ? ` · ${esc(t('eingereicht von'))} ${esc(q.einreicher)}` : ''}</div>
        <p class="qp-text">${esc(q.text || q.kurz || '')}</p>
        <dl class="qp-fakten">
          <dt>${esc(t('Ort'))}</dt><dd>${esc(q.ort || '—')}${q.distanzM != null ? ` · ${esc(fmtDistanz(q.distanzM))} ${esc(t('entfernt'))}` : ''}</dd>
          <dt>${esc(t('Belohnung'))}</dt><dd>${esc(fmtBelohnung(q))}</dd>
          ${frist ? `<dt>${esc(t('Frist'))}</dt><dd${frist === 'abgelaufen' ? ' class="qp-warn"' : ''}>${esc(frist)}</dd>` : ''}
          <dt>${esc(t('Bestätigung'))}</dt><dd>${esc(q.pruefung || '—')}</dd>
          ${Number(q.karma) > 0 ? `<dt>${esc(t('Voraussetzung'))}</dt><dd>${esc(karmaLabel(q.karma, { alsBedingung: true }))}</dd>` : ''}
        </dl>
        ${anf ? `<div class="qp-anf"><span>${esc(t('Zu erledigen'))}</span><ul>${anf}</ul></div>` : ''}
        ${this._nachweisHtml(q)}
        ${q.karmaOk === false ? `<div class="qp-hinweis">${esc(t('Dein Karma reicht für diesen Auftrag noch nicht.'))}</div>` : ''}
        ${vorOrt ? `<div class="qp-hinweis${vorOrt.ok ? '' : ' qp-warn'}">${esc(vorOrt.hinweis)}</div>` : ''}
        <div class="qp-fehler" data-role="aktionsfehler" hidden></div>
        <div class="qp-aktionen">
          ${this.onShowOnMap ? `<button type="button" class="qp-btn" data-a="map">${esc(t('Auf Karte'))}</button>` : ''}
          ${aktionen.map(a => {
            const sperre = a.key === 'accept' && vorOrt && !vorOrt.ok
            return `<button type="button" class="qp-btn${a.primaer ? ' primaer' : ''}"`
              + ` data-a="${esc(a.key)}"${sperre ? ' disabled' : ''}>${esc(t(a.label))}</button>`
          }).join('')}
        </div>
      </div>`
    this._bodyEl.querySelectorAll('.qp-btn').forEach(b =>
      b.addEventListener('click', () => this._aktion(q, b.dataset.a)))
  }

  /** Was der Bearbeiter eingereicht hat — der Prüfer soll etwas in der Hand haben. */
  _nachweisHtml(q) {
    const p = q.nachweisEingereicht
    if (!p) return ''
    const bilder = Array.isArray(p.photos) ? p.photos.length : 0
    const teile = []
    if (p.note) teile.push(`<div class="qp-notiz">„${esc(p.note)}"</div>`)
    if (bilder) teile.push(`<div>${bilder} ${bilder === 1 ? 'Bild' : 'Bilder'} beigelegt</div>`)
    if (p.at && Number.isFinite(Number(p.at.lat))) {
      teile.push(`<div>Gemeldet bei ${Number(p.at.lat).toFixed(5)}, ${Number(p.at.lon).toFixed(5)}</div>`)
    }
    if (!teile.length) return ''
    return `<div class="qp-anf qp-eingereicht"><span>${esc(t('Eingereicht'))}</span>${teile.join('')}</div>`
  }

  /**
   * Meldeformular: was der Bearbeiter beim Abschluss beilegt.
   *
   * Die Position steuert das Gerät bei, den Rest der Mensch. Was der Auftrag
   * verlangt, steht darüber — der Server prüft es gleich noch einmal und
   * benennt Lücken einzeln.
   */
  _meldeFormular(q) {
    const anf = (q.anforderungen || []).map(a => `<li>${esc(a)}</li>`).join('')
    this._bodyEl.innerHTML = `
      <div class="qp-detail">
        <div class="qp-row-kopf"><span class="qp-titel gross">${esc(q.titel)}</span></div>
        <div class="qp-von">${esc(t('Erledigt melden'))}</div>
        ${anf ? `<div class="qp-anf"><span>${esc(t('Beizulegen'))}</span><ul>${anf}</ul></div>` : ''}
        <label class="qp-feld">${esc(t('Was hast du getan?'))}
          <textarea data-role="notiz" rows="3" placeholder="${esc(t('Kurz beschreiben, was erledigt ist.'))}"></textarea>
        </label>
        ${q.melden?.noetig && !q.melden.ok
          ? `<div class="qp-hinweis qp-warn">${esc(q.melden.text)}</div>` : ''}
        ${(q.roh?.nachweis || []).includes('foto') ? `
        <label class="qp-feld">${esc(t('Bilder (bis zu drei)'))}
          <input type="file" data-role="bilder" accept="image/*" capture="environment" multiple>
        </label>
        <div class="qp-hinweis">${esc(t('Ein Vorher-Bild hilft bei der Abnahme, ist aber nicht nötig. Standort und Aufnahmezeit werden vor dem Senden aus den Bildern entfernt.'))}</div>
        <div class="qp-bildstand" data-role="bildstand" hidden></div>` : ''}
        <div class="qp-fehler" data-role="aktionsfehler" hidden></div>
        <div class="qp-aktionen">
          <button type="button" class="qp-btn" data-z="zurueck">${esc(t('Zurück'))}</button>
          <button type="button" class="qp-btn primaer" data-z="senden">${esc(t('Absenden'))}</button>
        </div>
      </div>`
    this._bodyEl.querySelector('[data-z="zurueck"]').addEventListener('click', () => this._render())
    const senden = this._bodyEl.querySelector('[data-z="senden"]')
    senden.addEventListener('click', async () => {
      const note = this._bodyEl.querySelector('[data-role="notiz"]')?.value?.trim() || ''
      const auswahl = this._bodyEl.querySelector('[data-role="bilder"]')
      const stand = this._bodyEl.querySelector('[data-role="bildstand"]')
      const dateien = auswahl?.files ? Array.from(auswahl.files) : []

      // Bilder ZUERST ablegen: Erst danach hat die Meldung eine Kennung, auf die
      // sie sich berufen kann. Scheitert das Hochladen, ist der Auftrag noch
      // unangetastet — besser als eine Meldung ohne den verlangten Nachweis.
      let proofId = ''
      if (dateien.length) {
        senden.disabled = true
        if (stand) { stand.hidden = false; stand.textContent = t('Bilder werden vorbereitet …') }
        try {
          const r = await this.onNachweis?.(q, dateien, { notiz: note })
          proofId = r?.proofId || ''
          if (stand) {
            stand.textContent = r?.uebersprungen
              ? t('{n} Bild(er) gesendet, {zuviel} zu viel — es gehen höchstens {max}.',
                  { n: r.anzahl, zuviel: r.uebersprungen, max: r.max })
              : t('{n} Bild(er) gesendet.', { n: r?.anzahl || 0 })
          }
        } catch (err) {
          senden.disabled = false
          if (stand) { stand.hidden = false; stand.textContent = err?.message || t('Bilder konnten nicht gesendet werden.') }
          return
        }
        senden.disabled = false
      }
      this._aktion(q, 'submit', { note, proofId })
    })
  }

  /**
   * Begründung zur Abnahme. Bei einer Ablehnung ist sie das Einzige, woran der
   * Bearbeiter erkennt, was nachzubessern ist.
   */
  _stimmFormular(q, key) {
    const ablehnung = key === 'reject'
    this._bodyEl.innerHTML = `
      <div class="qp-detail">
        <div class="qp-row-kopf"><span class="qp-titel gross">${esc(q.titel)}</span></div>
        <div class="qp-von">${esc(t(ablehnung ? 'Ablehnen' : 'Bestätigen'))}</div>
        ${this._nachweisHtml(q)}
        <div class="qp-belege" data-role="belege"></div>
        <label class="qp-feld">${esc(t(ablehnung ? 'Warum reicht das nicht?' : 'Anmerkung (freiwillig)'))}
          <textarea data-role="notiz" rows="3"></textarea>
        </label>
        <div class="qp-fehler" data-role="aktionsfehler" hidden></div>
        <div class="qp-aktionen">
          <button type="button" class="qp-btn" data-z="zurueck">${esc(t('Zurück'))}</button>
          <button type="button" class="qp-btn primaer" data-z="senden">${esc(t(ablehnung ? 'Ablehnen' : 'Bestätigen'))}</button>
        </div>
      </div>`
    this._bodyEl.querySelector('[data-z="zurueck"]').addEventListener('click', () => this._render())
    this._bodyEl.querySelector('[data-z="senden"]').addEventListener('click', () => {
      const note = this._bodyEl.querySelector('[data-role="notiz"]')?.value?.trim() || ''
      this._aktion(q, key, { note })
    })
    this._zeigeBelege(q)
  }

  /**
   * Beweisbilder nachladen und anzeigen. Nachgeladen, weil sie hinter einer
   * eigenen Berechtigung liegen — nur Melder und Aussteller sehen sie, und ein
   * Fehlschlag darf das Abnahme-Formular nicht blockieren.
   */
  async _zeigeBelege(q) {
    const ziel = this._bodyEl?.querySelector('[data-role="belege"]')
    if (!ziel || !this.onBelege) return
    let belege = []
    try { belege = await this.onBelege(q) } catch { return }
    const bilder = belege.flatMap(b => b.bilder || [])
    if (!bilder.length) return
    ziel.innerHTML = `<div class="qp-belege-kopf">${esc(t('Beigelegte Bilder'))}</div>
      <div class="qp-belege-reihe">${bilder.map(b =>
        `<a href="${esc(b.gross)}" target="_blank" rel="noopener noreferrer">
           <img src="${esc(b.klein)}" alt="${esc(t('Beweisbild'))}" loading="lazy">
         </a>`).join('')}</div>`
  }

  /**
   * Aktion auslösen.
   *
   * Der Panel schließt die Detailansicht ERST, wenn die Aktion durch ist. Eine
   * abgelehnte Annahme („schon vergeben", „Karma reicht nicht") muss dort
   * stehen bleiben, wo sie ausgelöst wurde — sonst sieht ein Fehlschlag aus wie
   * ein Erfolg.
   */
  async _aktion(q, key, extra = null) {
    if (key === 'map') { this.onShowOnMap?.(q); return }
    if (key === 'edit') { this.onEdit?.(q); return }
    // Verlangt der Auftrag einen Nachweis, wird er vorher erhoben — sonst
    // schickte der Knopf eine Meldung los, die der Server zu Recht ablehnt.
    if (key === 'submit' && !extra
        && ((q.anforderungen || []).length || (q.roh?.nachweis || []).length)) {
      this._meldeFormular(q)
      return
    }
    if ((key === 'reject' || (key === 'confirm' && q.roh?.verify === 'crowd')) && !extra) {
      this._stimmFormular(q, key)
      return
    }
    if (!this.onAction) {
      try { window.ajnaLog?.push(`Auftrag „${q.titel}": ${key} (nicht angeschlossen)`, 'system') } catch {}
      return
    }
    const fehlerEl = this._bodyEl?.querySelector('[data-role="aktionsfehler"]')
    const knoepfe = [...(this._bodyEl?.querySelectorAll('.qp-btn') || [])]
    knoepfe.forEach(b => { b.disabled = true })
    if (fehlerEl) fehlerEl.hidden = true
    try {
      await this.onAction(q, key, extra || undefined)
      this._detail = null
      this._render()
    } catch (err) {
      const text = err?.message || String(err)
      console.warn('[quests] Aktion:', text)
      if (fehlerEl) { fehlerEl.textContent = text; fehlerEl.hidden = false }
      knoepfe.forEach(b => { b.disabled = false })
    }
  }

  // ── CSS ────────────────────────────────────────────────────────────────

  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const s = document.createElement('style')
    s.id = STYLE_ID
    s.textContent = `
    /* Auslöser — Reihe der schwebenden Knöpfe: 🎒 +16, 💬 +80, 🧭 +144, 📜 +208 */
    .ajna-quest-launcher{position:fixed;right:18px;
      bottom:calc(var(--tabbar-height,0px) + var(--safe-bottom,env(safe-area-inset-bottom,0px)) + 208px);
      z-index:5500;width:44px;height:44px;border-radius:50%;border:1px solid #3a3a44;
      background:rgba(24,24,30,.92);color:#eaeaea;font-size:20px;line-height:1;cursor:pointer;
      box-shadow:0 6px 22px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
    .ajna-quest-launcher:active{transform:scale(.96)}
    .ajna-quest-launcher .qp-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;
      padding:0 4px;border-radius:9px;background:#e0533b;color:#fff;
      font:600 11px system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
    .ajna-quest-launcher .qp-badge[hidden]{display:none}

    .ajna-quest-overlay{position:fixed;inset:0;z-index:6100;background:rgba(0,0,0,.45);
      display:flex;align-items:flex-end;justify-content:center}
    .ajna-quest{width:100%;max-width:560px;max-height:min(76vh,620px);display:flex;flex-direction:column;
      background:rgba(18,18,22,.98);color:#eaeaea;border:1px solid #34343e;border-bottom:none;
      border-radius:14px 14px 0 0;box-shadow:0 -8px 40px rgba(0,0,0,.5);
      padding-bottom:calc(var(--safe-bottom,env(safe-area-inset-bottom,0px)))}
    .ajna-quest header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2b2b33}
    .ajna-quest header h3{margin:0;font:600 15px system-ui,sans-serif;flex:1 1 auto}
    .ajna-quest header button{background:none;border:none;color:#b8b8c0;font-size:20px;
      line-height:1;cursor:pointer;padding:0 6px}
    .ajna-quest header button:hover{color:#fff}
    .ajna-quest header .qp-back[hidden]{display:none}

    .ajna-quest .qp-tabs{display:flex;gap:2px;padding:8px 10px 0;border-bottom:1px solid #2b2b33}
    .ajna-quest .qp-tabs[hidden]{display:none}
    .ajna-quest .qp-tabs button{flex:1 1 0;background:none;border:none;border-bottom:2px solid transparent;
      color:#9b9ba6;font:13px system-ui,sans-serif;padding:8px 4px 7px;cursor:pointer;
      display:flex;align-items:center;justify-content:center;gap:6px}
    .ajna-quest .qp-tabs button.on{color:#fff;border-bottom-color:#2c5d8f}
    .ajna-quest .qp-count{min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:#33343e;
      color:#d6d9e0;font:600 10px/17px system-ui,sans-serif;text-align:center}
    .ajna-quest .qp-tabs button.on .qp-count{background:#2c5d8f;color:#fff}

    .ajna-quest .qp-body{overflow-y:auto;padding:8px 10px 12px;flex:1;-webkit-overflow-scrolling:touch}
    .ajna-quest .qp-leer{opacity:.55;font:13px system-ui,sans-serif;text-align:center;padding:32px 0}
    .ajna-quest .qp-neu{width:100%;margin:2px 0 8px}
    .ajna-quest .qp-laedt{font:12px system-ui,sans-serif;color:#8b8b96;padding:4px 2px 8px}
    .ajna-quest .qp-fehler{font:12px system-ui,sans-serif;color:#e08a6b;padding:6px 8px;margin:2px 0 8px;
      border-radius:7px;background:rgba(224,138,107,.1);border:1px solid rgba(224,138,107,.3)}
    .ajna-quest .qp-fehler[hidden]{display:none}
    .ajna-quest .qp-hinweis{font:12px system-ui,sans-serif;color:#c9a227;padding:6px 8px;margin-bottom:10px;
      border-radius:7px;background:rgba(201,162,39,.1)}
    .ajna-quest .qp-eingereicht{background:rgba(255,255,255,.04);border-radius:8px;padding:8px 10px}
    .ajna-quest .qp-eingereicht div{margin-top:3px;color:#c8c8d0}
    .ajna-quest .qp-notiz{font-style:italic}
    .ajna-quest .qp-reload[hidden]{display:none}
    .ajna-quest .qp-belege{margin-bottom:10px}
    .ajna-quest .qp-belege:empty{display:none}
    .ajna-quest .qp-belege-kopf{font:12px system-ui,sans-serif;color:#9aa0a6;margin-bottom:5px}
    .ajna-quest .qp-belege-reihe{display:flex;gap:6px;flex-wrap:wrap}
    .ajna-quest .qp-belege-reihe img{width:96px;height:72px;object-fit:cover;border-radius:6px;
      display:block;background:rgba(255,255,255,.06)}
    .ajna-quest .qp-bildstand{font:12px system-ui,sans-serif;color:#9aa0a6;margin:-4px 0 10px}
    .ajna-quest .qp-bildstand[hidden]{display:none}
    .ajna-quest input[type=file]{font:13px system-ui,sans-serif;color:#c8c8d0;width:100%}
    .ajna-quest .qp-feld{display:block;font:12px system-ui,sans-serif;color:#9b9ba6;margin-bottom:12px}
    .ajna-quest .qp-feld textarea{display:block;width:100%;margin-top:5px;box-sizing:border-box;
      background:#16161b;border:1px solid #33343e;border-radius:7px;color:#e6e6ea;
      font:13px system-ui,sans-serif;padding:7px 9px;resize:vertical}
    .ajna-quest .qp-feld textarea:focus{outline:none;border-color:#2c5d8f}

    .ajna-quest .qp-row{padding:9px 10px;margin:5px 0;border-radius:9px;cursor:pointer;
      background:rgba(255,255,255,.035);border:1px solid #2b2b33}
    .ajna-quest .qp-row:hover{background:rgba(255,255,255,.07);border-color:#3a3a44}
    .ajna-quest .qp-row-kopf{display:flex;align-items:baseline;gap:8px}
    .ajna-quest .qp-titel{font:600 14px system-ui,sans-serif;flex:1 1 auto}
    .ajna-quest .qp-titel.gross{font-size:16px}
    .ajna-quest .qp-status{flex:0 0 auto;border-radius:5px;padding:2px 7px;color:#fff;
      font:600 10px system-ui,sans-serif;white-space:nowrap}
    .ajna-quest .qp-kurz{margin-top:3px;font:12px system-ui,sans-serif;color:#a8a8b4}
    .ajna-quest .qp-meta{margin-top:6px;display:flex;flex-wrap:wrap;gap:10px;
      font:11px system-ui,sans-serif;color:#8b8b96}
    .ajna-quest .qp-warn{color:#e08a6b}

    .ajna-quest .qp-detail{padding:4px 2px}
    .ajna-quest .qp-von{margin-top:4px;font:11px system-ui,sans-serif;color:#8b8b96}
    .ajna-quest .qp-text{margin:10px 0 12px;font:13px/1.5 system-ui,sans-serif;color:#d2d2da}
    .ajna-quest .qp-fakten{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;margin:0 0 12px;
      font:12px system-ui,sans-serif}
    .ajna-quest .qp-fakten dt{color:#8b8b96}
    .ajna-quest .qp-fakten dd{margin:0;color:#e2e2e8}
    .ajna-quest .qp-anf{margin-bottom:14px;font:12px system-ui,sans-serif}
    .ajna-quest .qp-anf span{color:#8b8b96}
    .ajna-quest .qp-anf ul{margin:4px 0 0;padding-left:18px;color:#d2d2da}
    .ajna-quest .qp-aktionen{display:flex;flex-wrap:wrap;gap:8px}
    .ajna-quest .qp-btn{flex:1 1 auto;min-height:40px;border-radius:9px;border:1px solid #3a3a44;
      background:#26262e;color:#e2e2e8;font:600 13px system-ui,sans-serif;cursor:pointer;padding:0 14px}
    .ajna-quest .qp-btn:hover{background:#30303a}
    .ajna-quest .qp-btn.primaer{background:#2c5d8f;border-color:#3a78b6;color:#fff}
    .ajna-quest .qp-btn.primaer:hover{background:#356da6}

    @media (max-width:480px){
      .ajna-quest .qp-titel{font-size:13px}
      .ajna-quest .qp-text{font-size:12px}
      .ajna-quest .qp-btn{font-size:12px;min-height:38px}
    }`
    document.head.appendChild(s)
  }
}
