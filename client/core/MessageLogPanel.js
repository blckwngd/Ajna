// MessageLogPanel — das Chat-/Verlaufsfenster. Ein schwebender Auslöser (💬 mit
// Ungelesen-Zähler) öffnet ein scrollbares Fenster mit dem Nachrichtenverlauf
// aus MessageLog. Zwei Filter: „Verlauf" (nur Spieler-relevantes: Dialoge,
// Aktionen, System) und „Alle" (inkl. UWB/Debug zum Nachvollziehen von Fehlern).
//
// Body-Overlay + eigener Auslöser → funktioniert in jeder View, ohne dass die
// jeweilige View etwas beisteuern muss. Der Verlauf selbst ist persistent
// (MessageLog/localStorage), das Fenster ist nur die Ansicht.

import { messageLog, CATS } from './MessageLog.js'
import { makeDraggable } from './draggable.js'
import { Toast } from './Toast.js'

const FILTER_KEY = 'ajna.msglog.filter'   // 'player' | 'all'
// Abstand zum unteren Rand, bis zu dem die Liste noch als „unten" gilt. Etwas
// Spiel, damit ein Rundungsfehler oder ein kurzer Wisch nicht schon als
// „liest weiter oben nach" zählt.
const BOTTOM_TOLERANZ = 48
const STYLE_ID = 'ajna-msglog-style'

const fmtTime = (t) => { try { return new Date(t).toTimeString().slice(0, 5) } catch { return '' } }

export class MessageLogPanel {
  constructor({ parent = document.body, ajna = null, toast = null } = {}) {
    this.parent = parent
    this.ajna = ajna
    // Eingehende Sätze laufen zusätzlich als Toast über den Bildschirm — sonst
    // stünde die Antwort einer Figur nur im geschlossenen Verlaufsfenster.
    // Der Toast-Container ist seitenweit geteilt, eine eigene Instanz stapelt
    // sich also sauber mit den übrigen.
    this._toast = toast || new Toast()
    this._partner = null
    this._choices = null
    this._choiceMode = 'choice'
    this._open = false
    this._unread = 0
    // Haftet die Liste am unteren Rand? Solange ja, holt jede neue Zeile die
    // Ansicht nach unten. Scrollt der Leser selbst hoch, um etwas nachzulesen,
    // schaltet das ab — nichts ist ärgerlicher als ein Fenster, das einem beim
    // Lesen wegspringt.
    this._stickToBottom = true
    this._filter = (() => { try { return localStorage.getItem(FILTER_KEY) === 'all' ? 'all' : 'player' } catch { return 'player' } })()
    this._injectStyles()
    this._buildLauncher()
    // Live: Badge hochzählen (geschlossen) bzw. Liste ergänzen (offen).
    this._unsub = messageLog.onChange((entry) => this._onLog(entry))
    this._subscribeChat()
  }

  /**
   * Eingehende Nachrichten in den Verlauf schreiben. Läuft unabhängig vom
   * Gesprächsmodus — wer angesprochen wird, soll es auch sehen, wenn das
   * Fenster geschlossen ist (der Zähler am Knopf springt dann an).
   */
  async _subscribeChat() {
    if (!this.ajna?.onChat) return
    const abo = async () => {
      try { this._chatOff?.() } catch {}
      this._chatOff = null
      if (!this.ajna.isLoggedIn?.()) return
      try {
        this._chatOff = await this.ajna.onChat((m) => this._onChat(m))
      } catch (err) { console.warn('[chat] Abo fehlgeschlagen:', err?.message || err) }
    }
    abo()
    // Nach Anmeldung neu abonnieren: das Thema hängt an der eigenen Konto-ID,
    // vor dem Login gibt es keine.
    this.ajna.onAuthChanged?.(() => abo())
  }

  _onChat(m) {
    const name = this._nameFor(m)

    // Gehört die Nachricht zu einer Figur, mit der gerade kein Gespräch läuft,
    // dann ist SIE jetzt das Gegenüber. Ohne das bliebe die Eingabezeile
    // verborgen, sobald „Sprechen" aus einer View kam, die den Chat nicht
    // selbst öffnet (AR- und Kartenansicht) — und im Verlauf stünde die
    // Konto-ID statt des Namens.
    if (m.object && this._partner?.objectId !== m.object) {
      this.talkTo({ userId: m.from, name, objectId: m.object, serverId: m._origin || null },
                  { open: false })
    }

    messageLog.push(`${name}: ${m.text}`, 'dialog')
    // `log: false` — die Zeile steht schon als Gespräch im Verlauf.
    // Antippen öffnet das Gespräch — der Toast ist der Weg hinein, nicht nur
    // eine Meldung. Das Fenster drängt sich dafür nicht mehr selbst auf.
    try { this._toast?.show(m.text, { title: name, log: false, onClick: () => this.open() }) } catch {}

    // Auswahlantworten nur übernehmen, wenn sie vom aktuellen Partner kommen —
    // sonst überschriebe eine fremde Nachricht die Knöpfe des Gesprächs.
    if (this._partner?.userId === m.from) {
      this.setChoices(m.meta?.choices || null, m.meta?.input || 'choice')
    }
  }

  /**
   * Anzeigename des Absenders. Bevorzugt die FIGUR (steckt als `object` in der
   * Nachricht), denn geschrieben hat zwar deren Besitzer-Konto, gesprochen hat
   * aber die Figur. Erst danach der laufende Gesprächspartner, zuletzt die
   * rohe Konto-ID.
   */
  _nameFor(m) {
    if (m?.object) {
      try {
        const obj = this.ajna?.getObjectById?.(m.object)
        if (obj?.name) return obj.name
      } catch { /* Objekt (noch) nicht im Zwischenspeicher */ }
    }
    const p = this._partner
    if (p && p.userId === m?.from && p.name) return p.name
    return m?.from || 'Jemand'
  }

  destroy() {
    try { this._unsub?.() } catch {}
    try { this._chatOff?.() } catch {}
    try { this._dragCleanup?.() } catch {}
    this._launcher?.remove()
    this._overlay?.remove()
    this._launcher = this._overlay = null
  }

  _visible(entry) { return this._filter === 'all' || CATS[entry.cat]?.player }

  _onLog(entry) {
    // Leeren (auch aus dem Debug-Protokoll heraus, also evtl. bei geschlossenem
    // Fenster): Zähler MUSS mit zurückgesetzt werden, sonst zeigt er Ungelesenes
    // zu einem leeren Verlauf an.
    if (entry === null) {
      this._unread = 0
      this._updateBadge()
      if (this._open) this._renderList()
      return
    }
    if (this._open) {
      if (this._visible(entry)) this._appendRow(entry)
    } else if (this._visible(entry)) {
      this._unread++
      this._updateBadge()
    }
  }

  // ── Auslöser (schwebender Button) ────────────────────────────────────
  _buildLauncher() {
    const btn = document.createElement('button')
    btn.className = 'ajna-msglog-launcher'
    btn.type = 'button'
    btn.setAttribute('aria-label', 'Verlauf')
    btn.innerHTML = '<span class="mlg-ico">💬</span><span class="mlg-badge" hidden>0</span>'
    this.parent.appendChild(btn)
    this._launcher = btn
    this._badge = btn.querySelector('.mlg-badge')
    // Verschiebbar (Position gemerkt); Tap ohne Bewegung öffnet/schließt.
    this._dragCleanup = makeDraggable(btn, { key: 'ajna.msglog.pos', onClick: () => this.toggle() })
  }

  _updateBadge() {
    if (!this._badge) return
    if (this._unread > 0) { this._badge.hidden = false; this._badge.textContent = this._unread > 99 ? '99+' : String(this._unread) }
    else this._badge.hidden = true
  }

  // ── Fenster ──────────────────────────────────────────────────────────
  toggle() { this._open ? this.close() : this.open() }

  open() {
    if (this._open) return
    this._open = true
    this._unread = 0
    this._updateBadge()
    const ov = document.createElement('div')
    ov.className = 'ajna-msglog-overlay'
    ov.innerHTML = `
      <div class="ajna-msglog" role="dialog" aria-modal="true" aria-label="Verlauf">
        <header>
          <h3>Verlauf</h3>
          <div class="mlg-filter" role="group">
            <button type="button" data-f="player" class="${this._filter === 'player' ? 'on' : ''}">Verlauf</button>
            <button type="button" data-f="all" class="${this._filter === 'all' ? 'on' : ''}">Alle</button>
          </div>
          <button class="mlg-clear" type="button" title="Verlauf leeren">Leeren</button>
          <button class="mlg-close" type="button" aria-label="Schließen">×</button>
        </header>
        <div class="mlg-list" data-role="list"></div>
        <div class="mlg-hinweis" data-role="hinweis">Zum Schreiben eine Figur antippen → „Sprechen“.</div>
        <form class="mlg-compose" data-role="compose" hidden>
          <div class="mlg-choices" data-role="choices" hidden></div>
          <div class="mlg-inputrow">
            <input type="text" data-role="input" autocomplete="off"
                   placeholder="Nachricht …" maxlength="2000">
            <button type="submit" title="Senden">➤</button>
          </div>
        </form>
      </div>`
    ov.addEventListener('click', e => { if (e.target === ov) this.close() })
    ov.querySelector('.mlg-close').addEventListener('click', () => this.close())
    ov.querySelector('.mlg-clear').addEventListener('click', () => {
      if (window.confirm('Verlauf wirklich leeren?')) messageLog.clear()
    })
    ov.querySelectorAll('.mlg-filter button').forEach(b =>
      b.addEventListener('click', () => this._setFilter(b.dataset.f, ov)))
    this.parent.appendChild(ov)
    this._overlay = ov
    this._listEl = ov.querySelector('[data-role="list"]')
    this._composeEl = ov.querySelector('[data-role="compose"]')
    this._inputEl = ov.querySelector('[data-role="input"]')
    this._choicesEl = ov.querySelector('[data-role="choices"]')
    this._hinweisEl = ov.querySelector('[data-role="hinweis"]')
    this._composeEl.addEventListener('submit', (ev) => {
      ev.preventDefault()
      const t = this._inputEl.value.trim()
      if (!t) return
      this._inputEl.value = ''
      this._send(t)
    })
    // Öffnen heißt: das Neueste sehen wollen. Egal, wo die Liste beim letzten
    // Schließen stand.
    this._stickToBottom = true
    this._listEl.addEventListener('scroll', () => { this._stickToBottom = this._istUnten() },
                                  { passive: true })

    this._syncCompose()
    this._renderList()
    this._scrollToBottom()
    if (this._partner) setTimeout(() => this._inputEl?.focus(), 50)
  }

  close() {
    this._open = false
    this._overlay?.remove()
    this._overlay = this._listEl = null
    this._composeEl = this._inputEl = this._choicesEl = this._hinweisEl = null
  }

  // ── Gesprächsmodus ───────────────────────────────────────────────────
  //
  // Das Verlaufsfenster ist zugleich der Chat. Ohne Gesprächspartner bleibt es
  // reine Anzeige wie bisher; `talkTo()` schaltet es in einen Privatchat.
  //
  // Der Transport ist nutzer-zu-nutzer (`ajna.sendChat`), nicht objektgebunden —
  // damit trägt dieselbe Bahn später Direktnachrichten und einen Weltchat.
  // Beim Ansprechen einer FIGUR geht die Nachricht an deren Konto; das Objekt
  // reist als Kontext mit, sonst wüsste der Agent nicht, welche seiner Figuren
  // gemeint ist.

  /**
   * In einen Privatchat wechseln.
   * @param {{userId: string, name?: string, objectId?: string, serverId?: string}|null} partner
   *        null beendet das Gespräch und schaltet zurück auf reine Anzeige.
   * @param {{open?: boolean}} [opts]  Fenster gleich aufmachen (Vorgabe: ja)
   */
  talkTo(partner, { open = true } = {}) {
    this._partner = partner || null
    this._choices = null
    // `open: false` für Gespräche, die von selbst anfangen (eine Figur meldet
    // sich): Fenster nicht aufreißen, der Toast und der Zähler am Auslöser
    // sagen es schon. Wer „Sprechen" antippt, will es dagegen sofort sehen.
    if (partner && open) this.open()
    this._syncCompose()
    if (partner) {
      messageLog.push(`— Gespräch mit ${partner.name || 'Unbekannt'} —`, 'dialog')
      if (open) setTimeout(() => this._inputEl?.focus(), 50)
    }
  }

  /** Aktueller Gesprächspartner oder null. */
  get partner() { return this._partner || null }

  /**
   * Auswahlantworten anbieten (Parley liefert sie, wenn an einer Stelle nur
   * feste Eingaben möglich sind). `null` schaltet zurück auf freie Eingabe.
   * @param {Array<{label:string, send?:string, value?:string}>|null} choices
   * @param {'choice'|'auto'|'text'} [modus]  ob daneben noch frei getippt werden darf
   */
  setChoices(choices, modus = 'choice') {
    this._choices = Array.isArray(choices) && choices.length ? choices : null
    // „choice" = nur die Knöpfe, „auto"/„text" = Knöpfe UND Eingabefeld.
    this._choiceMode = modus === 'choice' ? 'choice' : 'auto'
    this._syncCompose()
  }

  _syncCompose() {
    if (!this._composeEl) return
    const an = !!this._partner
    this._composeEl.hidden = !an
    const kopf = this._overlay?.querySelector('h3')
    if (kopf) kopf.textContent = an ? (this._partner.name || 'Gespräch') : 'Verlauf'

    // Auswahl statt Freitext: Knöpfe zeigen, Eingabezeile ausblenden.
    const zeile = this._composeEl.querySelector('.mlg-inputrow')
    if (this._choices) {
      this._choicesEl.hidden = false
      this._choicesEl.textContent = ''
      for (const c of this._choices) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'mlg-choice'
        const wert = c.send ?? c.value ?? c.label
        b.textContent = c.label || wert
        b.addEventListener('click', () => {
          this.setChoices(null)
          // Gesendet wird der MUSTER-Wert, nicht die Beschriftung — sonst
          // greift die Regel nicht, die den Knopf erzeugt hat.
          this._send(wert, c.label)
        })
        this._choicesEl.appendChild(b)
      }
      if (zeile) zeile.hidden = this._choiceMode === 'choice'
    } else {
      this._choicesEl.hidden = true
      this._choicesEl.textContent = ''
      if (zeile) zeile.hidden = false
    }
    if (this._hinweisEl) this._hinweisEl.hidden = an
    // Knöpfe und Eingabezeile nehmen der Liste Höhe weg — was eben noch unten
    // stand, wäre sonst wieder aus dem Bild.
    this._scrollIfSticking()
  }

  async _send(text, anzeige = null) {
    const p = this._partner
    if (!p) return
    // Wer selbst schreibt, will die eigene Zeile sehen — auch wenn er vorher
    // hochgescrollt hatte.
    this._stickToBottom = true
    messageLog.push(`Du: ${anzeige || text}`, 'dialog')
    try {
      const r = await this.ajna?.sendChat?.(p.userId, {
        text, object: p.objectId || null, serverId: p.serverId || null,
      })
      // delivered === 0 heißt: niemand hört zu. Das dem Spieler sagen, sonst
      // wartet er auf eine Antwort, die nie kommt.
      if (r && r.delivered === 0) {
        messageLog.push(`${p.name || 'Er'} antwortet nicht — niemand ist da.`, 'system')
      }
    } catch (err) {
      messageLog.push(`Nachricht nicht zugestellt: ${err?.message || err}`, 'system')
    }
  }

  _setFilter(f, ov) {
    this._filter = f === 'all' ? 'all' : 'player'
    try { localStorage.setItem(FILTER_KEY, this._filter) } catch {}
    ov.querySelectorAll('.mlg-filter button').forEach(b => b.classList.toggle('on', b.dataset.f === this._filter))
    // Umschalten baut die Liste neu auf — die alte Scrollposition passt danach
    // zu nichts mehr. Also ans Ende, wie beim Öffnen.
    this._stickToBottom = true
    this._renderList()
  }

  _rowHtml(entry) {
    const c = CATS[entry.cat] || CATS.system
    return `<div class="mlg-row mlg-${entry.cat}">`
      + `<span class="mlg-t">${fmtTime(entry.t)}</span>`
      + `<span class="mlg-i">${c.icon}</span>`
      + `<span class="mlg-x"></span>`
      + `</div>`
  }

  // ── Scrollverhalten ────────────────────────────────────────────────────

  /** Steht die Liste (nahe genug) am unteren Rand? */
  _istUnten() {
    const el = this._listEl
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_TOLERANZ
  }

  /**
   * Ans Ende springen und zweimal über requestAnimationFrame nachfassen: Höhe
   * und Zeilenumbrüche stehen erst nach dem Layout fest, und Auswahlknöpfe
   * können die Liste unmittelbar danach noch verkürzen. Ein einzelnes Setzen
   * direkt nach dem Einfügen kommt in dem Fall zu früh.
   *
   * Jeder Nachschlag prüft `_stickToBottom` erneut — wischt der Leser genau in
   * diesen zwei Bildern nach oben, bleibt er oben.
   */
  _scrollToBottom() {
    const ans_ende = () => {
      if (!this._listEl) return false
      this._listEl.scrollTop = this._listEl.scrollHeight
      return true
    }
    if (!ans_ende()) return
    requestAnimationFrame(() => {
      if (!this._stickToBottom || !ans_ende()) return
      requestAnimationFrame(() => { if (this._stickToBottom) ans_ende() })
    })
  }

  /** Nur nachziehen, wenn der Leser nicht gerade oben etwas nachliest. */
  _scrollIfSticking() { if (this._stickToBottom) this._scrollToBottom() }

  // Text als textContent setzen (kein HTML-Injection über Nachrichteninhalte).
  _appendRow(entry) {
    if (!this._listEl) return
    const tmp = document.createElement('div')
    tmp.innerHTML = this._rowHtml(entry)
    const row = tmp.firstElementChild
    row.querySelector('.mlg-x').textContent = entry.text
    this._listEl.appendChild(row)
    this._scrollIfSticking()
  }

  _renderList() {
    if (!this._listEl) return
    const rows = messageLog.entries(e => this._visible(e))
    if (!rows.length) {
      this._listEl.innerHTML = '<div class="mlg-empty">Noch keine Einträge.</div>'
      return
    }
    this._listEl.innerHTML = rows.map(e => this._rowHtml(e)).join('')
    // Texte sicher als textContent nachtragen (Reihenfolge = rows).
    const xs = this._listEl.querySelectorAll('.mlg-x')
    rows.forEach((e, i) => { if (xs[i]) xs[i].textContent = e.text })
    this._scrollIfSticking()
  }

  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const css = `
    .ajna-msglog-launcher{position:fixed;right:18px;bottom:calc(var(--tabbar-height,0px) + var(--safe-bottom,env(safe-area-inset-bottom,0px)) + 80px);z-index:5500;
      width:48px;height:48px;border-radius:50%;border:1px solid #3a3a44;background:rgba(24,24,30,.92);color:#eaeaea;
      font-size:22px;line-height:1;cursor:pointer;box-shadow:0 6px 22px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
    .ajna-msglog-launcher .mlg-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;
      background:#e0533b;color:#fff;font:600 11px system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
    /* Höhere Spezifität als die Basisregel — sonst überstimmt display:flex das
       hidden-Attribut und der Zähler bliebe mit veralteter Zahl stehen. */
    .ajna-msglog-launcher .mlg-badge[hidden]{display:none}
    .ajna-msglog .mlg-compose{border-top:1px solid #2b2b33;padding:8px 10px;
      display:flex;flex-direction:column;gap:8px;background:rgba(24,24,30,.6)}
    .ajna-msglog .mlg-compose[hidden]{display:none}
    .ajna-msglog .mlg-inputrow{display:flex;gap:8px}
    .ajna-msglog .mlg-inputrow[hidden]{display:none}
    .ajna-msglog .mlg-inputrow input{flex:1;min-width:0;background:#0f1115;color:#eaeaea;
      border:1px solid #34343e;border-radius:8px;padding:10px 12px;font:inherit;font-size:15px}
    .ajna-msglog .mlg-inputrow input:focus{outline:1px solid #2c5d8f;border-color:#2c5d8f}
    .ajna-msglog .mlg-inputrow button{background:#2c5d8f;color:#fff;border:none;border-radius:8px;
      padding:0 16px;font-size:16px;cursor:pointer}
    .ajna-msglog .mlg-inputrow button:active{background:#356da6}
    .ajna-msglog .mlg-hinweis{padding:8px 12px;border-top:1px solid #2b2b33;
      background:rgba(24,24,30,.6);color:#8b8b96;font:12px system-ui,sans-serif}
    .ajna-msglog .mlg-hinweis[hidden]{display:none}
    .ajna-msglog .mlg-choices{display:flex;flex-wrap:wrap;gap:6px}
    .ajna-msglog .mlg-choices[hidden]{display:none}
    .ajna-msglog .mlg-choice{background:rgba(44,93,143,.25);color:#dbe6f2;
      border:1px solid #3a78b6;border-radius:999px;padding:8px 14px;
      font:inherit;font-size:14px;cursor:pointer;text-align:left}
    .ajna-msglog .mlg-choice:active{background:rgba(44,93,143,.5)}
    .ajna-msglog-overlay{position:fixed;inset:0;z-index:6100;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center}
    .ajna-msglog{width:100%;max-width:560px;max-height:min(70vh,560px);display:flex;flex-direction:column;
      background:rgba(18,18,22,.98);color:#eaeaea;border:1px solid #34343e;border-bottom:none;border-radius:14px 14px 0 0;
      box-shadow:0 -8px 40px rgba(0,0,0,.5);padding-bottom:calc(var(--safe-bottom,env(safe-area-inset-bottom,0px)))}
    .ajna-msglog header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2b2b33}
    .ajna-msglog header h3{margin:0;font:600 15px system-ui,sans-serif;flex:0 0 auto}
    .ajna-msglog .mlg-filter{margin-left:auto;display:flex;border:1px solid #3a3a44;border-radius:8px;overflow:hidden}
    .ajna-msglog .mlg-filter button{background:none;border:none;color:#b8b8c0;font:12px system-ui,sans-serif;padding:4px 10px;cursor:pointer}
    .ajna-msglog .mlg-filter button.on{background:#33343e;color:#fff}
    .ajna-msglog .mlg-clear{background:none;border:1px solid #3a3a44;color:#c9c9d0;border-radius:8px;font:12px system-ui,sans-serif;padding:4px 10px;cursor:pointer}
    .ajna-msglog .mlg-close{background:none;border:none;color:#c9c9d0;font-size:22px;line-height:1;cursor:pointer;padding:0 4px}
    .ajna-msglog .mlg-list{overflow-y:auto;padding:8px 12px;flex:1;-webkit-overflow-scrolling:touch}
    .ajna-msglog .mlg-empty{opacity:.55;font:13px system-ui,sans-serif;text-align:center;padding:24px 0}
    .ajna-msglog .mlg-row{display:flex;gap:8px;align-items:baseline;padding:5px 8px;margin:3px 0;border-radius:8px;
      border-left:3px solid #444;background:rgba(255,255,255,.03);font:13px system-ui,sans-serif}
    .ajna-msglog .mlg-row .mlg-t{color:#7d7d88;font:11px ui-monospace,Menlo,Consolas,monospace;flex:0 0 auto}
    .ajna-msglog .mlg-row .mlg-i{flex:0 0 auto}
    .ajna-msglog .mlg-row .mlg-x{flex:1;word-break:break-word;white-space:pre-wrap}
    .ajna-msglog .mlg-dialog{border-left-color:#5b8dd6}
    .ajna-msglog .mlg-interact{border-left-color:#c79be0}
    .ajna-msglog .mlg-system{border-left-color:#6fae7a}
    .ajna-msglog .mlg-uwb{border-left-color:#d6a95b}
    .ajna-msglog .mlg-debug{border-left-color:#666;opacity:.85}
    .ajna-msglog .mlg-debug .mlg-x{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}`
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = css
    document.head.appendChild(el)
  }
}
