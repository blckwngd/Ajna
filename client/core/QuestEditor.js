// QuestEditor — Auftrag schreiben und ändern.
//
// ABGRENZUNG zum Auftrags-Abschnitt im normalen Editor (EditorUI, `#callFields`):
// Dort steht die MECHANIK — geforderte Gegenstände, Belohnung aus dem Inventar,
// Treuhand binden, wiederholbar. Das ist an die Server-Routen angeschlossen und
// bleibt vorerst dort.
// Hier steht der VORGANG: Text für die Liste, Frist, Abnahmeverfahren,
// Nachweis, Karma-Bedingung, Sichtbarkeit. Also alles, was entscheidet, WER den
// Auftrag sieht, WANN er verfällt und WORAN man erkennt, dass er erledigt ist.
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

/** Leerer Auftrag. */
export const LEER_AUFTRAG = () => ({
  id: null, status: 'entwurf', meine: true,
  titel: '', kurz: '', text: '', ort: '',
  fristMs: 0, frist: null,
  belohnung: { anzahl: 1, was: 'Diamant', steigt: 0 },
  abnahme: 'stichprobe', schwarmZahl: 3, pruefgruppe: '',
  nachweis: ['foto'], karma: 0, sichtbarkeit: 'region', sichtbarGruppe: '',
  anbietenNachH: 0,
})

// Demo-Inventar für die Belohnungsauswahl. Ersetzt später der echte Bestand.
const DEMO_INVENTAR = [
  { was: 'Diamant', vorrat: 12 },
  { was: 'Talisman', vorrat: 3 },
  { was: 'Kompass', vorrat: 1 },
]

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
  constructor({ parent = document.body, inventar = null, gruppen = null,
                onSave = null, onPublish = null, onWithdraw = null } = {}) {
    this.parent = parent
    this.inventar = Array.isArray(inventar) ? inventar : DEMO_INVENTAR
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
  open(quest = null) {
    this.close()
    this._q = { ...LEER_AUFTRAG(), ...(quest || {}) }
    this._q.belohnung = { ...LEER_AUFTRAG().belohnung, ...(quest?.belohnung || {}) }
    this._q.nachweis = Array.isArray(this._q.nachweis) ? [...this._q.nachweis] : []
    const ov = document.createElement('div')
    ov.className = 'ajna-qe-overlay'
    ov.innerHTML = `<div class="ajna-qe" role="dialog" aria-modal="true" aria-label="Auftrag bearbeiten">
      <header>
        <h3>${this._q.id ? 'Auftrag bearbeiten' : 'Neuer Auftrag'}</h3>
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
    this._render()
  }

  close() {
    this._ov?.remove()
    this._ov = this._body = this._fehlerEl = this._aktionenEl = null
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
        <label>Belohnung
          <span class="qe-paar">
            <input type="number" data-f="belohnung.anzahl" min="0" max="99" value="${esc(q.belohnung.anzahl)}"${aus('belohnung')}>
            <select data-f="belohnung.was"${aus('belohnung')}>
              ${this.inventar.map(i => `<option value="${esc(i.was)}"${i.was === q.belohnung.was ? ' selected' : ''}>${esc(i.was)} (${i.vorrat} im Inventar)</option>`).join('')}
            </select>
          </span>
        </label>
        <label>Steigt je Tag, solange niemand übernimmt
          <input type="number" data-f="belohnung.steigt" min="0" max="9" value="${esc(q.belohnung.steigt || 0)}"${aus('belohnung')}>
        </label>
      </div>
      <div class="qe-fussnote">Die Belohnung wird beim Veröffentlichen aus deinem Inventar
        treuhänderisch gebunden. Bindung und Auszahlung macht der Server.</div>

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
      <label>Nötiges Karma des Bearbeiters
        <select data-f="karma"${aus('karma')}>
          ${KARMA_WAHL.map(v => `<option value="${v.stufe}"${v.stufe === Number(q.karma || 0) ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}
        </select>
      </label>
      <div class="qe-fussnote">Karma zeigt, wie verlässlich sich jemand bei Aufträgen gezeigt hat:
        ${KARMA_PRO_STUFE} Punkte je Stufe, Stufe 1 bis 5. Gutgeschrieben wird für bestätigte
        Abschlüsse (${esc(KARMA_GUTSCHRIFT[0].punkte)} Punkte), abgezogen nur bei nachgewiesenen
        Verstößen oder wiederholten begründeten Beschwerden. Wer neu ist, hat Karma 0 —
        das ist kein Makel, sondern ein noch leeres Konto.</div>

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
          <option value="0"${!Number(q.anbietenNachH) ? ' selected' : ''}>sofort</option>
          <option value="6"${Number(q.anbietenNachH) === 6 ? ' selected' : ''}>erst nach 6 Stunden</option>
          <option value="24"${Number(q.anbietenNachH) === 24 ? ' selected' : ''}>erst nach 1 Tag</option>
          <option value="72"${Number(q.anbietenNachH) === 72 ? ' selected' : ''}>erst nach 3 Tagen</option>
        </select>
      </label>
      <div class="qe-fussnote">Vergibt eine Figur den Auftrag, ist er zunächst nur im Gespräch
        mit ihr zu haben — wer nicht mit ihr redet, erfährt nichts davon. Nimmt ihn dort
        niemand an, erscheint er nach der eingestellten Wartezeit zusätzlich in der Liste
        für die Region, dort mit dem Zustand „angeboten". „Sofort" heißt: gleich in beiden.</div>`

    this._body.querySelectorAll('[data-f]').forEach(el => {
      el.addEventListener('input', () => this._lese())
      el.addEventListener('change', () => { this._lese(); this._render() })
    })
    // Neu zeichnen, nicht nur lesen: an einem Haken hängt ein Hinweis, der
    // erscheinen und verschwinden muss (siehe OHNE_FUNKTION).
    this._body.querySelectorAll('[data-n]').forEach(el =>
      el.addEventListener('change', () => { this._lese(); this._render() }))

    this._renderAktionen(sp)
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
    if (q.status === 'entwurf') knoepfe.push({ k: 'publish', l: 'Veröffentlichen', p: true })
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
      if (el.type === 'number' || pfad === 'fristMs' || pfad === 'anbietenNachH') wert = Number(wert) || 0
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
    // Frist als Zeitstempel mitführen — die Liste zeigt Restzeit, nicht Dauer.
    q.frist = q.fristMs ? Date.now() + Number(q.fristMs) : null
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
