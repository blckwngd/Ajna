// QuestEditor — Auftrag schreiben und ändern.
//
// HIER STEHT DER GANZE AUFTRAG. Text für die Liste, Frist, Belohnung,
// Wiederholbarkeit, geforderte Gegenstände, Abnahmeverfahren, Nachweis,
// Karma-Bedingung, Sichtbarkeit.
//
// Das war einmal geteilt: Der Objekt-Editor führte „Aufgabe", „Prüfung",
// „Wiederholbar", Forderungen und Belohnung ein zweites Mal. Zwei Formulare für
// eine Sache sind nicht nur überladen — das dortige Speichern baute `state.call`
// aus seinen Feldern NEU AUF und warf dabei alles weg, was es nicht kannte
// (Kurztext, Ort, Frist, Nachweis, Karma, Prüfgruppe). Jetzt gibt es dort nur
// noch den Knopf hierher.
//
// VOKABULAR (vorher uneinheitlich benutzt):
//   Bearbeiter — wer den Auftrag übernimmt und ausführt
//   Abnahme    — die Prüfung des gemeldeten Abschlusses
//   Prüfer     — wer diese Abnahme vornimmt
// „Abnehmer" kommt bewusst nicht mehr vor: das Wort wurde für beides benutzt.
//
// Warum ein eigenes Fenster und nicht mehr Felder im Editor: Ein Auftrag ist ein
// Vorgang mit Lebenslauf, kein Objekt mit ein paar Feldern mehr. Was man ändern
// darf, hängt am Stand — bei einem angenommenen Auftrag darf die Aufgabe nicht
// mehr umgeschrieben und die Belohnung nicht gekürzt werden. Ein generisches
// Formular kann das nicht wissen.
//
// Das Layout spiegelt bewusst die Detailansicht aus QuestPanel: Wer schreibt,
// sieht dasselbe Gerüst, das der Spieler später liest.
//
// `onSave`/`onPublish`/`onWithdraw` sind die Nähte nach aussen und dürfen
// Versprechen zurückgeben — das Fenster schliesst erst, wenn der Server
// zugestimmt hat. Übersetzt wird in core/questMapping.js.

import { KARMA_WAHL, KARMA_PRO_STUFE, KARMA_GUTSCHRIFT } from './karma.js'

const STYLE_ID = 'ajna-questedit-style'

/** Abnahmeverfahren — wie wird geprüft, dass die Aufgabe erledigt ist? */
export const ABNAHME = [
  { key: 'uebergabe',  label: 'Übergabe an die Figur',     hinweis: 'Der Server prüft die geforderten Gegenstände.' },
  { key: 'stichprobe', label: 'Stichprobe (Auftraggeber)',  hinweis: 'Du siehst dir einen Teil der Einreichungen an.' },
  { key: 'pruefgruppe',label: 'Prüfgruppe',                 hinweis: 'Eine benannte Gruppe nimmt ab.' },
  { key: 'schwarm',    label: 'Schwarm — x von y',          hinweis: 'Andere Spieler bestätigen vor Ort.' },
]

/**
 * Was der Bearbeiter beim Melden beilegen muss. Jede Zeile erklärt sich selbst —
 * „Vor Ort bestätigen" allein ließ offen, WER dort bestätigt.
 */
export const NACHWEIS = [
  { key: 'foto', label: 'Vorher-/Nachher-Foto',
    hinweis: 'Zwei Bilder vom selben Blickwinkel. Für die Abnahme durch Menschen, kein Maschinenbeweis.' },
  { key: 'vorOrt', label: 'Anwesenheit am Einsatzort',
    hinweis: 'Der Bearbeiter meldet sich am Ort. Wo eine NFC-Marke oder ein Beacon hängt, ist das belastbar — sonst zählt nur die GPS-Angabe des Geräts, und die ist nicht fälschungssicher.' },
  { key: 'gegenstand', label: 'Geforderten Gegenstand dabeihaben',
    hinweis: 'Der Server prüft beim Abschluss das Inventar. Die Gattung legst du unten unter „Geforderte Gegenstände" fest.' },
]

/**
 * Nachweisarten, die es im Formular schon gibt, aber noch nicht im Ablauf.
 * Wird nur angezeigt, wenn die Art auch gewählt ist — als Warnung an den, der
 * sie gerade in seinen Auftrag schreibt.
 */
export const OHNE_FUNKTION = {
  foto: 'Noch nicht implementiert — Bilder lassen sich derzeit nicht hochladen.',
}

export const SICHTBARKEIT = [
  { key: 'privat', label: 'privat — nur ich' },
  { key: 'gruppe', label: 'meine Gruppe' },
  { key: 'region', label: 'öffentlich in der Region' },
]

/** Karma-Bedingung: 0 = keine. Siehe core/karma.js. */
export { KARMA_WAHL, KARMA_PRO_STUFE } from './karma.js'

const FRISTEN = [
  { ms: 0,                 label: 'keine Frist' },
  { ms: 6 * 3600_000,      label: '6 Stunden' },
  { ms: 24 * 3600_000,     label: '1 Tag' },
  { ms: 3 * 86400_000,     label: '3 Tage' },
  { ms: 7 * 86400_000,     label: '7 Tage' },
  { ms: 14 * 86400_000,    label: '14 Tage' },
]

/**
 * Was darf bei diesem Stand noch geändert werden?
 *
 * Die Regel dahinter: Sobald jemand mitarbeitet, ist die Ausschreibung eine
 * Zusage. Aufgabe und Belohnung sind dann bindend — verlängern darf man immer,
 * kürzen nie.
 *
 * @param {string} status
 * @returns {{gesperrt: string[], hinweis: string|null, schreibbar: boolean}}
 */
export function sperrenFuer(status) {
  if (status === 'erledigt' || status === 'abgelaufen') {
    return { gesperrt: ['*'], schreibbar: false, hinweis: 'Abgeschlossen — nur noch zum Nachlesen.' }
  }
  if (status === 'angenommen' || status === 'eingereicht' || status === 'pruefung') {
    return {
      gesperrt: ['text', 'belohnung', 'abnahme', 'nachweis', 'karma', 'sichtbarkeit'],
      schreibbar: true,
      hinweis: 'Jemand arbeitet daran. Änderbar ist nur noch die Frist — und nur nach oben.',
    }
  }
  if (status === 'offen' || status === 'angeboten') {
    return {
      gesperrt: [], schreibbar: true,
      hinweis: 'Veröffentlicht. Die Belohnung lässt sich erhöhen, nicht kürzen.',
    }
  }
  return { gesperrt: [], schreibbar: true, hinweis: null }   // Entwurf
}

/**
 * Wann ein zunächst nur bei der Figur angebotener Auftrag zusätzlich in die
 * Regionsliste wandert. `-1` heißt: gar nicht — er bleibt für immer etwas, das
 * man nur im Gespräch bekommt.
 */
export const ANBIETEN = [
  { h: 0,  label: 'sofort' },
  { h: 6,  label: 'erst nach 6 Stunden' },
  { h: 24, label: 'erst nach 1 Tag' },
  { h: 72, label: 'erst nach 3 Tagen' },
  { h: -1, label: 'nie — nur bei der Figur' },
]

/** Leerer Auftrag. */
export const LEER_AUFTRAG = () => ({
  id: null, status: 'entwurf', meine: true,
  titel: '', kurz: '', text: '', ort: '',
  fristMs: 0, frist: null,
  belohnung: { anzahl: 1, was: '', steigt: 0 },
  abnahme: 'stichprobe', schwarmZahl: 3, pruefgruppe: '',
  nachweis: [], karma: 0, sichtbarkeit: 'region', sichtbarGruppe: '',
  anbietenNachH: 0,
  wiederholbar: false, vorrat: 1, forderungen: [],
  server: null,
})

/**
 * Wie viel insgesamt hinterlegt wird.
 *
 * VOKABULAR: „Belohnung" ist, was EIN Bearbeiter bekommt. „Vorrat" ist, wie
 * viel dafür insgesamt gebunden wird. Bei einem einmaligen Auftrag sind das
 * dieselben Stücke, deshalb steht das Feld nur bei „wiederholbar" — vorher hieß
 * es „Belohnung: 2 / je Durchlauf: 1", was genau andersherum klang.
 */
export function vorratVon(q) {
  const pro = Math.max(0, Number(q?.belohnung?.anzahl) || 0)
  if (!q?.wiederholbar) return pro
  return Math.max(pro, Number(q?.vorrat) || pro)
}

/** Wie oft der Auftrag mit diesem Vorrat erledigt werden kann. */
export function durchlaeufeVon(q) {
  const pro = Math.max(1, Number(q?.belohnung?.anzahl) || 1)
  return Math.max(1, Math.floor(vorratVon(q) / pro))
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Formularinhalt prüfen. Gibt die Liste der Beanstandungen zurück — leer heißt
 * in Ordnung.
 * @param {object} q
 * @returns {string[]}
 */
export function pruefeAuftrag(q) {
  const fehler = []
  if (!String(q?.titel || '').trim()) fehler.push('Ein Titel fehlt.')
  if (String(q?.titel || '').length > 80) fehler.push('Der Titel ist länger als 80 Zeichen.')
  if (!String(q?.text || '').trim()) fehler.push('Die Aufgabe ist leer — sonst weiß niemand, was zu tun ist.')
  const n = Number(q?.belohnung?.anzahl)
  if (!Number.isFinite(n) || n < 0) fehler.push('Die Belohnung muss eine Zahl ab 0 sein.')
  if (q?.abnahme === 'schwarm') {
    const s = Number(q?.schwarmZahl)
    if (!Number.isFinite(s) || s < 1 || s > 9) fehler.push('Beim Schwarm sind 1 bis 9 Bestätigungen sinnvoll.')
  }
  // Ohne benannte Gruppe könnte niemand ausser dem Aussteller abnehmen — der
  // Auftrag wäre dann eine Stichprobe unter falschem Namen.
  if (q?.abnahme === 'pruefgruppe' && !String(q?.pruefgruppe || '').trim()) {
    fehler.push('Wähle die Gruppe, die abnehmen soll.')
  }
  if (q?.sichtbarkeit === 'gruppe' && !String(q?.sichtbarGruppe || '').trim()) {
    fehler.push('Wähle die Gruppe, die den Auftrag sehen soll.')
  }
  if (q?.sichtbarkeit === 'region' && !String(q?.kurz || '').trim()) {
    fehler.push('Für die Regionsliste braucht es eine Kurzbeschreibung.')
  }
  // Eine Forderung ohne Gattung träfe JEDEN Gegenstand — der Server lehnt sie
  // beim Veröffentlichen ab, und das ist der unangenehmere Zeitpunkt.
  if ((q?.forderungen || []).some(f => !String(f?.name || '').trim())) {
    fehler.push('Jede Forderung braucht eine Gattung — sonst zählt jeder beliebige Gegenstand.')
  }
  if (q?.wiederholbar) {
    const v = Number(q?.vorrat)
    if (!Number.isFinite(v) || v < 1) fehler.push('Der Vorrat muss mindestens 1 sein.')
    else if (v < n) {
      fehler.push('Der Vorrat kann nicht kleiner sein als die Belohnung für einen Durchlauf.')
    }
  }
  return fehler
}

export class QuestEditor {
  /**
   * @param {{
   *   parent?: HTMLElement,
   *   inventar?: Array<{was:string, vorrat:number}>,
   *   onSave?: (quest: object) => void,
   *   onPublish?: (quest: object) => void,
   *   onWithdraw?: (quest: object) => void,
   * }} opts
   */
  constructor({ parent = document.body, inventar = null, gruppen = null, server = null,
                onSave = null, onPublish = null, onWithdraw = null, onServerChanged = null } = {}) {
    this.parent = parent
    // Verbundene Server, für die Wahl im Kopf. Ein einzelner Server blendet
    // das Badge aus — dann gibt es nichts zu entscheiden.
    this.server = Array.isArray(server) ? server : []
    this.onServerChanged = onServerChanged
    // Kein Platzhalter-Bestand: Ein erfundenes Inventar verdeckt genau den
    // Fall, in dem wirklich nichts da ist.
    this.inventar = Array.isArray(inventar) ? inventar : []
    this.gruppen = Array.isArray(gruppen) ? gruppen : []
    this.onSave = onSave
    this.onPublish = onPublish
    this.onWithdraw = onWithdraw
    this._q = null
    this._injectStyles()
  }

  /**
   * Fenster öffnen.
   * @param {object|null} quest  null = neuer Entwurf
   */
  open(quest = null, { veroeffentlichen = true, position = null } = {}) {
    this.close()
    this._q = { ...LEER_AUFTRAG(), ...(quest || {}) }
    this._q.belohnung = { ...LEER_AUFTRAG().belohnung, ...(quest?.belohnung || {}) }
    this._q.nachweis = Array.isArray(this._q.nachweis) ? [...this._q.nachweis] : []
    this._q.forderungen = Array.isArray(this._q.forderungen) ? [...this._q.forderungen] : []
    // Stelle, an der der Auftrag entstehen soll (Kontextmenü). Nur für neue
    // Aufträge — ein bestehender liegt schon irgendwo.
    if (position && !this._q.id) this._q.position = position
    // Aus dem Objekt-Editor heraus wird nur bearbeitet. Ausschreiben bindet die
    // Treuhand und gehört an die Stelle, an der man den Auftrag auch anlegt.
    this._veroeffentlichen = veroeffentlichen !== false
    const ov = document.createElement('div')
    ov.className = 'ajna-qe-overlay'
    ov.innerHTML = `<div class="ajna-qe" role="dialog" aria-modal="true" aria-label="Auftrag bearbeiten">
      <header>
        <h3>${this._q.id ? 'Auftrag bearbeiten' : 'Neuer Auftrag'}</h3>
        <span class="qe-serverwahl" data-role="serverwahl"></span>
        <button class="qe-close" type="button" aria-label="Schließen">×</button>
      </header>
      <div class="qe-body" data-role="body"></div>
      <div class="qe-fuss">
        <div class="qe-fehler" data-role="fehler" hidden></div>
        <div class="qe-aktionen" data-role="aktionen"></div>
      </div>
    </div>`
    ov.addEventListener('click', e => { if (e.target === ov) this.close() })
    ov.querySelector('.qe-close').addEventListener('click', () => this.close())
    this.parent.appendChild(ov)
    this._ov = ov
    this._body = ov.querySelector('[data-role="body"]')
    this._fehlerEl = ov.querySelector('[data-role="fehler"]')
    this._aktionenEl = ov.querySelector('[data-role="aktionen"]')
    this._serverEl = ov.querySelector('[data-role="serverwahl"]')
    this._renderServer()
    this._render()
  }

  close() {
    this._ov?.remove()
    this._ov = this._body = this._fehlerEl = this._aktionenEl = this._serverEl = null
    this._q = null
  }

  destroy() { this.close() }

  /** Aktueller Formularstand (für Tests und Aufrufer). */
  get quest() { return this._q }

  // ── Zeichnen ───────────────────────────────────────────────────────────

  _render() {
    if (!this._body) return
    const q = this._q
    const sp = sperrenFuer(q.status)
    const aus = (feld) => sp.gesperrt.includes('*') || sp.gesperrt.includes(feld) ? ' disabled' : ''

    this._body.innerHTML = `
      ${sp.hinweis ? `<div class="qe-hinweis">${esc(sp.hinweis)}</div>` : ''}

      <div class="qe-abschnitt">Text</div>
      <label>Titel
        <input type="text" data-f="titel" maxlength="80" value="${esc(q.titel)}"
               placeholder="Müll sammeln am Rheinufer"${aus('text')}>
      </label>
      <label>Kurz — eine Zeile für die Liste
        <input type="text" data-f="kurz" maxlength="120" value="${esc(q.kurz)}"
               placeholder="Uferweg zwischen Brücke und Bootshaus, ein Sack reicht."${aus('text')}>
      </label>
      <label>Aufgabe
        <textarea data-f="text" rows="4" placeholder="Was genau ist zu tun? Wo liegt Werkzeug?"${aus('text')}>${esc(q.text)}</textarea>
      </label>
      <label>Ort — Beschreibung für die Liste
        <input type="text" data-f="ort" maxlength="80" value="${esc(q.ort)}"
               placeholder="Rheinufer, Höhe Bootshaus"${aus('text')}>
      </label>

      <div class="qe-abschnitt">Frist und Belohnung</div>
      <label>Frist
        <select data-f="fristMs">
          ${FRISTEN.map(f => `<option value="${f.ms}"${Number(q.fristMs) === f.ms ? ' selected' : ''}>${esc(f.label)}</option>`).join('')}
        </select>
      </label>
      <div class="qe-zeile">
        <label>Belohnung — was der Bearbeiter bekommt
          <span class="qe-paar">
            <input type="number" data-f="belohnung.anzahl" min="0" max="99" value="${esc(q.belohnung.anzahl)}"${aus('belohnung')}>
            <select data-f="belohnung.was"${aus('belohnung')}>
              ${this._inventarWahl(q)}
            </select>
          </span>
        </label>
        <label>Steigt je Tag, solange niemand übernimmt
          <input type="number" data-f="belohnung.steigt" min="0" max="9" value="${esc(q.belohnung.steigt || 0)}"${aus('belohnung')}>
        </label>
      </div>
      <div class="qe-fussnote">Wird beim Veröffentlichen aus deinem Inventar treuhänderisch
        gebunden. Bindung und Auszahlung macht der Server.</div>
      <label class="qe-haken-zeile">
        <input type="checkbox" data-f="wiederholbar"${q.wiederholbar ? ' checked' : ''}${aus('belohnung')}>
        <span><span class="qe-haken-titel">Wiederholbar</span>
        <span class="qe-haken-hinweis">Mehrere Spieler können den Auftrag nacheinander erledigen.</span></span>
      </label>
      ${q.wiederholbar ? `<label>Vorrat — wie viel insgesamt hinterlegt wird
        <input type="number" data-f="vorrat" min="1" max="99" value="${esc(vorratVon(q))}"${aus('belohnung')}>
      </label>
      <div class="qe-fussnote">${esc(this._vorratSatz(q))}</div>` : ''}

      <div class="qe-abschnitt">Abnahme</div>
      <label>Verfahren
        <select data-f="abnahme"${aus('abnahme')}>
          ${ABNAHME.map(a => `<option value="${a.key}"${a.key === q.abnahme ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}
        </select>
      </label>
      <div class="qe-fussnote">${esc(ABNAHME.find(a => a.key === q.abnahme)?.hinweis || '')}</div>
      ${q.abnahme === 'schwarm' ? `<label>Nötige Bestätigungen
        <input type="number" data-f="schwarmZahl" min="1" max="9" value="${esc(q.schwarmZahl)}"${aus('abnahme')}>
      </label>` : ''}
      ${q.abnahme === 'pruefgruppe' ? `<label>Gruppe, die abnimmt
        ${this._gruppenWahl('pruefgruppe', q.pruefgruppe, aus('abnahme'))}
      </label>` : ''}
      <div class="qe-feldname">Nachweis</div>
      <div class="qe-haken">
        ${NACHWEIS.map(n => {
          const an = q.nachweis.includes(n.key)
          return `<label class="qe-haken-zeile">
          <input type="checkbox" data-n="${n.key}"${an ? ' checked' : ''}${aus('nachweis')}>
          <span><span class="qe-haken-titel">${esc(n.label)}</span>
          <span class="qe-haken-hinweis">${esc(n.hinweis)}</span>
          ${an && OHNE_FUNKTION[n.key] ? `<span class="qe-haken-offen">${esc(OHNE_FUNKTION[n.key])}</span>` : ''}
          </span></label>`
        }).join('')}
      </div>
      ${q.nachweis.includes('gegenstand') || q.abnahme === 'uebergabe' ? `
      <div class="qe-feldname">Geforderte Gegenstände</div>
      <div class="qe-fussnote">Gattung und Anzahl — der Server sucht sie beim Abschluss im
        Inventar des Bearbeiters. Leer heisst: nichts abgeben.</div>
      <div class="qe-forderungen">
        ${(q.forderungen || []).map((f, i) => `<span class="qe-forderung">
          <input type="number" data-forderung="${i}" data-teil="anzahl" min="1" max="99" value="${esc(f.anzahl)}"${aus('abnahme')}>
          <input type="text" data-forderung="${i}" data-teil="name" value="${esc(f.name)}"
                 placeholder="Wolfsfell" maxlength="60"${aus('abnahme')}>
          <button type="button" class="qe-weg" data-forderung-weg="${i}" aria-label="Entfernen"${aus('abnahme')}>×</button>
        </span>`).join('')}
      </div>
      <button type="button" class="qe-btn qe-klein" data-a="forderung-neu"${aus('abnahme')}>+ Forderung</button>
      ` : ''}
      <label>Nötiges Karma des Bearbeiters
        <select data-f="karma"${aus('karma')}>
          ${KARMA_WAHL.map(v => `<option value="${v.stufe}"${v.stufe === Number(q.karma || 0) ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}
        </select>
      </label>
      <div class="qe-fussnote">${KARMA_PRO_STUFE} Punkte je Stufe, Stufe 0 bis 5.
        ${KARMA_GUTSCHRIFT.map(g => `${esc(g.grund)}: +${g.punkte}`).join('. ')}.</div>

      <div class="qe-abschnitt">Sichtbarkeit</div>
      <label>Wer sieht den Auftrag
        <select data-f="sichtbarkeit"${aus('sichtbarkeit')}>
          ${SICHTBARKEIT.map(v => `<option value="${v.key}"${v.key === q.sichtbarkeit ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}
        </select>
      </label>
      ${q.sichtbarkeit === 'gruppe' ? `<label>Welche Gruppe
        ${this._gruppenWahl('sichtbarGruppe', q.sichtbarGruppe, aus('sichtbarkeit'))}
      </label>` : ''}
      <label>Ab wann steht der Auftrag auch in der Regionsliste
        <select data-f="anbietenNachH"${aus('sichtbarkeit')}>
          ${ANBIETEN.map(a => `<option value="${a.h}"${Number(q.anbietenNachH || 0) === a.h ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}
        </select>
      </label>
      <div class="qe-fussnote">Vergibt eine Figur den Auftrag, ist er zunächst nur im Gespräch
        mit ihr zu haben. Nimmt ihn dort niemand an, erscheint er nach der eingestellten
        Wartezeit zusätzlich in der Regionsliste, dort mit dem Zustand „angeboten".
        „Sofort" heißt: gleich in beiden. „Nie" heißt: nur im Gespräch, dauerhaft.</div>`

    this._body.querySelectorAll('[data-f]').forEach(el => {
      el.addEventListener('input', () => this._lese())
      el.addEventListener('change', () => { this._lese(); this._render() })
    })
    // Neu zeichnen, nicht nur lesen: an einem Haken hängt ein Hinweis, der
    // erscheinen und verschwinden muss (siehe OHNE_FUNKTION), und an
    // „Gegenstand dabeihaben" die Forderungsliste.
    this._body.querySelectorAll('[data-n]').forEach(el =>
      el.addEventListener('change', () => { this._lese(); this._render() }))

    this._body.querySelectorAll('[data-forderung]').forEach(el =>
      el.addEventListener('input', () => this._lese()))
    this._body.querySelectorAll('[data-forderung-weg]').forEach(el =>
      el.addEventListener('click', () => {
        this._lese()
        this._q.forderungen.splice(Number(el.dataset.forderungWeg), 1)
        this._render()
      }))
    this._body.querySelector('[data-a="forderung-neu"]')?.addEventListener('click', () => {
      this._lese()
      this._q.forderungen = [...(this._q.forderungen || []), { name: '', anzahl: 1 }]
      this._render()
    })

    this._renderAktionen(sp)
  }

  /**
   * Auf welchem Server der Auftrag entsteht.
   *
   * WARUM ÜBERHAUPT EINE WAHL: Ein Auftrag liegt auf genau einem Server — dort
   * hängt seine Treuhand, dort wird abgenommen, dort zählt das Karma. Wer
   * mehrere Server verbunden hat, schreibt aber nicht immer auf demselben aus:
   * Der Auftrag fürs Vereinsgelände gehört auf den Vereinsserver, nicht auf den
   * zuletzt benutzten. Vorgabe ist der Standardserver.
   *
   * Ein bestehender Auftrag lässt sich NICHT verschieben: Das wäre kein
   * Umzug, sondern ein neuer Auftrag anderswo — mitsamt neuer Treuhand.
   */
  _renderServer() {
    if (!this._serverEl) return
    const mehrere = (this.server || []).length > 1
    if (!mehrere) { this._serverEl.hidden = true; return }
    this._serverEl.hidden = false

    const aktiv = this._aktiverServer()
    const fest = !!this._q.id
    this._serverEl.innerHTML = `
      <button type="button" class="qe-badge" data-role="badge"${fest ? ' disabled' : ''}
              title="${fest ? 'Ein bestehender Auftrag bleibt auf seinem Server.' : 'Server wählen'}">
        ${esc(aktiv?.label || aktiv?.id || '?')}${fest ? '' : ' ▾'}
      </button>
      <div class="qe-serverliste" data-role="liste" hidden>
        ${this.server.map(sv => `<button type="button" data-sv="${esc(sv.id)}"
          ${sv.id === aktiv?.id ? 'class="on"' : ''}>${esc(sv.label || sv.id)}${sv.isDefault ? ' · Standard' : ''}</button>`).join('')}
      </div>`
    if (fest) return

    const liste = this._serverEl.querySelector('[data-role="liste"]')
    this._serverEl.querySelector('[data-role="badge"]').addEventListener('click', () => {
      liste.hidden = !liste.hidden
    })
    this._serverEl.querySelectorAll('[data-sv]').forEach(b =>
      b.addEventListener('click', () => {
        this._lese()
        this._q.server = b.dataset.sv
        // Das Inventar hängt am Server — die bisherige Belohnung gibt es dort
        // vielleicht gar nicht. Der Aufrufer liefert den neuen Bestand nach.
        this.onServerChanged?.(b.dataset.sv)
        liste.hidden = true
        this._renderServer()
        this._render()
      }))
  }

  _aktiverServer() {
    const liste = this.server || []
    return liste.find(s => s.id === this._q?.server)
      || liste.find(s => s.isDefault)
      || liste[0]
      || null
  }

  /**
   * Belohnungs-Gattungen aus dem Inventar. Ein leeres Inventar sagt das auch —
   * eine leere Auswahlliste sieht sonst nach einem Ladefehler aus.
   */
  _inventarWahl(q) {
    if (!this.inventar.length) {
      return `<option value="">nichts im Inventar auf diesem Server</option>`
    }
    return this.inventar
      .map(i => `<option value="${esc(i.was)}"${i.was === q.belohnung.was ? ' selected' : ''}>`
        + `${esc(i.was)} (${i.vorrat} im Inventar)</option>`)
      .join('')
  }

  /** Was der eingestellte Vorrat bedeutet — in Durchläufen, nicht in Stück. */
  _vorratSatz(q) {
    const pro = Math.max(1, Number(q.belohnung.anzahl) || 1)
    const vorrat = vorratVon(q)
    const mal = durchlaeufeVon(q)
    const rest = vorrat - mal * pro
    const bestand = this.inventar.find(i => i.was === q.belohnung.was)?.vorrat ?? 0
    const knapp = vorrat > bestand
      ? ` Im Inventar liegen nur ${bestand}.`
      : ''
    return `Reicht für ${mal}× erledigen${rest > 0 ? ` (${rest} bleibt übrig)` : ''}.${knapp}`
  }

  /**
   * Auswahlliste der eigenen Gruppen. Gibt es keine, steht das da — statt
   * einer leeren Liste, die wie ein Ladefehler aussieht.
   */
  _gruppenWahl(feld, wert, gesperrt) {
    if (!this.gruppen.length) {
      return `<select data-f="${feld}" disabled><option>keine Gruppe vorhanden</option></select>`
    }
    const opts = this.gruppen
      .map(g => `<option value="${esc(g.id)}"${String(g.id) === String(wert || '') ? ' selected' : ''}>${esc(g.name)}</option>`)
      .join('')
    return `<select data-f="${feld}"${gesperrt}><option value="">— wählen —</option>${opts}</select>`
  }

  _renderAktionen(sp) {
    const q = this._q
    const knoepfe = []
    if (sp.schreibbar) knoepfe.push({ k: 'save', l: 'Speichern' })
    if (q.status === 'entwurf' && this._veroeffentlichen !== false) {
      knoepfe.push({ k: 'publish', l: 'Veröffentlichen', p: true })
    }
    if (q.status === 'offen' || q.status === 'angeboten') knoepfe.push({ k: 'withdraw', l: 'Zurückziehen' })
    knoepfe.push({ k: 'cancel', l: 'Schließen' })
    this._aktionenEl.innerHTML = knoepfe
      .map(b => `<button type="button" class="qe-btn${b.p ? ' primaer' : ''}" data-a="${b.k}">${esc(b.l)}</button>`)
      .join('')
    this._aktionenEl.querySelectorAll('.qe-btn').forEach(b =>
      b.addEventListener('click', () => this._aktion(b.dataset.a)))
  }

  // ── Formular ↔ Objekt ──────────────────────────────────────────────────

  /** Formular in `this._q` übernehmen. */
  _lese() {
    if (!this._body) return this._q
    const q = this._q
    for (const el of this._body.querySelectorAll('[data-f]')) {
      const pfad = el.dataset.f
      let wert = el.value
      if (el.type === 'checkbox') wert = el.checked
      else if (el.type === 'number' || pfad === 'fristMs' || pfad === 'anbietenNachH') wert = Number(wert) || 0
      if (pfad.includes('.')) {
        const [a, b] = pfad.split('.')
        q[a] = { ...(q[a] || {}) }
        q[a][b] = wert
      } else {
        q[pfad] = wert
      }
    }
    q.nachweis = [...this._body.querySelectorAll('[data-n]')]
      .filter(el => el.checked).map(el => el.dataset.n)

    // Forderungen liegen als Liste vor, nicht als einzelne Felder — deshalb
    // getrennt eingesammelt. Leere Zeilen bleiben erhalten, solange das Fenster
    // offen ist; wegzuwerfen was jemand gerade tippt, wäre unhöflich.
    const forderungen = []
    for (const el of this._body.querySelectorAll('[data-forderung]')) {
      const i = Number(el.dataset.forderung)
      forderungen[i] = forderungen[i] || { name: '', anzahl: 1 }
      if (el.dataset.teil === 'anzahl') forderungen[i].anzahl = Math.max(1, Number(el.value) || 1)
      else forderungen[i].name = el.value
    }
    if (forderungen.length) q.forderungen = forderungen.filter(Boolean)
    // Frist als Zeitstempel mitführen — die Liste zeigt Restzeit, nicht Dauer.
    q.frist = q.fristMs ? Date.now() + Number(q.fristMs) : null

    // Den ANGEZEIGTEN Server festschreiben. Ist der Standardserver gerade
    // getrennt, zeigt das Badge einen anderen — ohne diese Zeile ginge der
    // Auftrag trotzdem an den Standard, also woanders hin als angekündigt.
    if (!q.id) {
      const sv = this._aktiverServer()
      if (sv) q.server = sv.id
    }
    return q
  }

  _zeigeFehler(liste) {
    if (!this._fehlerEl) return
    this._fehlerEl.hidden = !liste.length
    this._fehlerEl.innerHTML = liste.map(f => `<div>${esc(f)}</div>`).join('')
  }

  /**
   * Knopf gedrückt.
   *
   * Das Fenster schließt ERST, wenn der Server zugestimmt hat. „Veröffentlichen"
   * kann scheitern, weil die Belohnung nicht mehr im Inventar liegt oder schon
   * an einem anderen Auftrag hängt — ein Fenster, das sich trotzdem schließt,
   * behauptet einen Erfolg, den es nicht gab.
   */
  async _aktion(key) {
    if (key === 'cancel') { this.close(); return }
    const q = this._lese()

    if (key === 'withdraw') {
      await this._ausfuehren(this.onWithdraw, q,
        `Auftrag „${q.titel || 'ohne Titel'}" zurückgezogen`)
      return
    }

    const fehler = pruefeAuftrag(q)
    if (fehler.length) { this._zeigeFehler(fehler); return }
    this._zeigeFehler([])

    if (key === 'publish') {
      q.status = 'offen'
      await this._ausfuehren(this.onPublish, q, `Auftrag „${q.titel}" veröffentlicht`)
    } else {
      await this._ausfuehren(this.onSave, q, `Auftrag „${q.titel}" gespeichert`)
    }
  }

  async _ausfuehren(handler, q, meldung) {
    if (!handler) { this._melde(meldung, handler); this.close(); return }
    const knoepfe = [...(this._aktionenEl?.querySelectorAll('.qe-btn') || [])]
    knoepfe.forEach(b => { b.disabled = true })
    try {
      await handler(q)
      this.close()
    } catch (err) {
      this._zeigeFehler([err?.message || String(err)])
      knoepfe.forEach(b => { b.disabled = false })
    }
  }

  // Ohne angeschlossene Logik bliebe der Klick wirkungslos und sähe nach einem
  // stillen Fehlschlag aus — deshalb wenigstens eine Zeile im Verlauf.
  _melde(text, angeschlossen) {
    if (angeschlossen) return
    try { window.ajnaLog?.push(`${text} (noch ohne Wirkung)`, 'system') } catch {}
  }

  // ── CSS ────────────────────────────────────────────────────────────────

  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const s = document.createElement('style')
    s.id = STYLE_ID
    s.textContent = `
    .ajna-qe-overlay{position:fixed;inset:0;z-index:6200;background:rgba(0,0,0,.5);
      display:flex;align-items:flex-end;justify-content:center}
    .ajna-qe{width:100%;max-width:560px;max-height:min(88vh,760px);display:flex;flex-direction:column;
      background:rgba(18,18,22,.98);color:#eaeaea;border:1px solid #34343e;border-bottom:none;
      border-radius:14px 14px 0 0;box-shadow:0 -8px 40px rgba(0,0,0,.55);
      padding-bottom:calc(var(--safe-bottom,env(safe-area-inset-bottom,0px)))}
    .ajna-qe header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2b2b33}
    .ajna-qe header h3{margin:0;font:600 15px system-ui,sans-serif;flex:1 1 auto}
    .ajna-qe header button{background:none;border:none;color:#b8b8c0;font-size:20px;cursor:pointer;padding:0 6px}
    .ajna-qe header button:hover{color:#fff}

    .ajna-qe .qe-body{overflow-y:auto;padding:10px 12px 14px;flex:1;-webkit-overflow-scrolling:touch}
    .ajna-qe .qe-abschnitt{margin:14px 0 8px;font:600 11px system-ui,sans-serif;letter-spacing:.08em;
      text-transform:uppercase;color:#f1c40f}
    .ajna-qe .qe-abschnitt:first-child{margin-top:2px}
    .ajna-qe .qe-hinweis{margin:2px 0 6px;padding:8px 10px;border-radius:8px;
      background:rgba(197,139,43,.14);border:1px solid rgba(197,139,43,.4);
      font:12px system-ui,sans-serif;color:#e5c890}
    .ajna-qe label{display:block;margin:0 0 9px;font:11px system-ui,sans-serif;color:#9b9ba6}
    .ajna-qe .qe-feldname{margin:0 0 5px;font:11px system-ui,sans-serif;color:#9b9ba6}
    .ajna-qe input[type=text],.ajna-qe input[type=number],.ajna-qe select,.ajna-qe textarea{
      display:block;width:100%;margin-top:3px;background:#0f1115;color:#eaeaea;
      border:1px solid #33343e;border-radius:8px;padding:8px 10px;
      font:13px system-ui,sans-serif;box-sizing:border-box}
    .ajna-qe textarea{resize:vertical;line-height:1.45}
    .ajna-qe input:focus,.ajna-qe select:focus,.ajna-qe textarea:focus{
      outline:1px solid #2c5d8f;border-color:#2c5d8f}
    .ajna-qe input:disabled,.ajna-qe select:disabled,.ajna-qe textarea:disabled{
      opacity:.45;cursor:not-allowed}
    .ajna-qe .qe-zeile{display:flex;gap:10px}
    .ajna-qe .qe-zeile label{flex:1 1 0}
    .ajna-qe .qe-paar{display:flex;gap:6px;margin-top:3px}
    .ajna-qe .qe-paar input{width:72px;flex:0 0 auto;margin-top:0}
    .ajna-qe .qe-paar select{flex:1 1 auto;margin-top:0}
    .ajna-qe .qe-fussnote{margin:-4px 0 10px;font:11px/1.45 system-ui,sans-serif;color:#7f8796}
    .ajna-qe .qe-haken{margin-bottom:10px}
    .ajna-qe .qe-haken-zeile{display:flex;align-items:center;gap:8px;margin:0 0 5px;
      font:12px system-ui,sans-serif;color:#d2d2da}
    .ajna-qe .qe-haken-zeile{align-items:flex-start}
    .ajna-qe .qe-haken-zeile input{width:auto;margin:2px 0 0}
    .ajna-qe .qe-haken-titel{display:block}
    .ajna-qe .qe-haken-hinweis{display:block;margin-top:2px;font:11px/1.45 system-ui,sans-serif;color:#7f8796}
    .ajna-qe .qe-haken-offen{display:block;margin-top:3px;font:11px/1.45 system-ui,sans-serif;
      color:#c9a227}
    .ajna-qe .qe-forderungen{display:flex;flex-direction:column;gap:5px;margin-bottom:6px}
    .ajna-qe .qe-forderung{display:flex;gap:6px;align-items:center}
    .ajna-qe .qe-forderung input[type=number]{width:64px;flex:0 0 auto}
    .ajna-qe .qe-forderung input[type=text]{flex:1 1 auto}
    .ajna-qe .qe-weg{flex:0 0 auto;width:26px;height:26px;padding:0;border-radius:6px;
      background:#2a2a32;border:1px solid #3a3a44;color:#b8b8c0;cursor:pointer;font-size:15px;line-height:1}
    .ajna-qe .qe-weg:hover{background:#3a2a2a;color:#e08a6b}
    .ajna-qe .qe-btn.qe-klein{padding:3px 10px;font-size:12px;margin-bottom:12px}
    .ajna-qe .qe-serverwahl{position:relative;flex:0 0 auto}
    .ajna-qe .qe-serverwahl[hidden]{display:none}
    .ajna-qe .qe-badge{background:#2a2a32;border:1px solid #3a3a44;border-radius:6px;
      color:#c8c8d0;font:11px system-ui,sans-serif;padding:3px 8px;cursor:pointer;white-space:nowrap}
    .ajna-qe .qe-badge:hover:not(:disabled){background:#33343e;color:#fff}
    .ajna-qe .qe-badge:disabled{cursor:default;opacity:.6}
    .ajna-qe .qe-serverliste{position:absolute;right:0;top:calc(100% + 4px);z-index:5;
      min-width:170px;background:#1c1c22;border:1px solid #3a3a44;border-radius:8px;
      padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:2px}
    .ajna-qe .qe-serverliste[hidden]{display:none}
    .ajna-qe .qe-serverliste button{background:none;border:none;text-align:left;color:#c8c8d0;
      font:12px system-ui,sans-serif;padding:6px 8px;border-radius:5px;cursor:pointer;width:100%}
    .ajna-qe .qe-serverliste button:hover{background:#2a2a32;color:#fff}
    .ajna-qe .qe-serverliste button.on{color:#fff;background:#2c5d8f}

    .ajna-qe .qe-fuss{border-top:1px solid #2b2b33;padding:10px 12px;background:rgba(24,24,30,.6)}
    .ajna-qe .qe-fehler{margin-bottom:8px;padding:8px 10px;border-radius:8px;
      background:rgba(224,83,59,.14);border:1px solid rgba(224,83,59,.45);
      font:12px/1.5 system-ui,sans-serif;color:#f0a893}
    .ajna-qe .qe-fehler[hidden]{display:none}
    .ajna-qe .qe-aktionen{display:flex;gap:8px}
    .ajna-qe .qe-btn{flex:1 1 auto;min-height:40px;border-radius:9px;border:1px solid #3a3a44;
      background:#26262e;color:#e2e2e8;font:600 13px system-ui,sans-serif;cursor:pointer;padding:0 14px}
    .ajna-qe .qe-btn:hover{background:#30303a}
    .ajna-qe .qe-btn.primaer{background:#2c5d8f;border-color:#3a78b6;color:#fff}
    .ajna-qe .qe-btn.primaer:hover{background:#356da6}

    @media (max-width:480px){
      .ajna-qe .qe-zeile{flex-direction:column;gap:0}
      .ajna-qe .qe-btn{font-size:12px;min-height:38px}
    }`
    document.head.appendChild(s)
  }
}
