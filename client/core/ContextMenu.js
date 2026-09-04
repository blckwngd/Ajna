// Wiederverwendbares Popover-Menü für Objekt-Aktionen.
// Item-Format:
//   { label, onClick, danger?, disabled? }    — klickbare Zeile
//   { separator: true }                       — Trennlinie
//   { sectionLabel: "..." }                   — Sub-Überschrift
//
// LANGE LISTEN, zwei Vorkehrungen:
//
// 1. DAS MENÜ PASST IMMER INS BILD. Es hatte keine Höhenbegrenzung. Ein
//    HomeAssistant-Controller bringt eine Zeile PRO GERÄT mit — bei vierzig
//    Einträgen wurde das Menü höher als das Telefon, die Einpassung rechnete
//    eine negative Obergrenze aus, und das Menü rutschte oben aus dem Bild.
//    Scrollen ging nicht: `position:fixed` ohne `overflow`. Jetzt deckelt eine
//    Höhe aus dem tatsächlich freien Platz, und der Inhalt scrollt darin.
//
// 2. AB EINER GEWISSEN LÄNGE HILFT SCROLLEN NICHT MEHR. Vierzig gleich
//    aussehende Zeilen durchzublättern ist kein Bedienen, sondern Suchen.
//    Darum blendet sich ab FILTER_AB ein Suchfeld ein. Es steht bewusst NICHT
//    immer da: Bei sechs Einträgen wäre es nur eine Hürde vor dem Ziel.
import { t } from './i18n.js'

/** Ab so vielen anklickbaren Zeilen bekommt das Menü ein Suchfeld. */
const FILTER_AB = 12

/** Sicherheitsabstand zum Rand des Bildschirms. */
const RAND = 8

/**
 * Wie viel vom Fenster das Menue hoechstens einnimmt.
 *
 * Nur „passt ins Bild" ist zu wenig: Bei vierzig Eintraegen fuellte es 853 von
 * 915 Pixeln und las sich wie eine eigene Seite statt wie ein Aufklapp-Menue.
 * Man sah nicht mehr, WORAUF man da geklickt hatte. Mit dem Suchfeld daneben
 * kostet der Deckel kaum etwas — gesucht wird ohnehin schneller als gescrollt.
 */
const ANTEIL_HOEHE = 0.7

export class ContextMenu {
  constructor() {
    this.el = null
    this._onDocClick = this._onDocClick.bind(this)
    this._onKey = this._onKey.bind(this)
    this._injectStyles()
  }

  _injectStyles() {
    if (document.getElementById('ajnaContextMenuStyles')) return
    const style = document.createElement('style')
    style.id = 'ajnaContextMenuStyles'
    style.textContent = `
      .ajna-context-menu {
        position: fixed;
        display: flex;
        flex-direction: column;
        background: rgba(18,18,22,0.96);
        color: #eaeaea;
        border: 1px solid #3a3a44;
        border-radius: 6px;
        box-shadow: 0 6px 24px rgba(0,0,0,0.5);
        font: 12px ui-monospace, Menlo, Consolas, monospace;
        z-index: 5000;
        min-width: 200px;
        max-width: 280px;
        padding: 4px 0;
        user-select: none;
      }
      /* Der Kopf bleibt stehen, nur die Liste laeuft. Sonst verliert man beim
         Scrollen die Auskunft, WELCHES Objekt man gerade bedient. */
      .ajna-context-menu .ctx-body {
        overflow-y: auto;
        overscroll-behavior: contain;   /* nicht die Seite dahinter mitscrollen */
        -webkit-overflow-scrolling: touch;
        min-height: 0;
      }
      .ajna-context-menu .ctx-filter {
        position: sticky; top: 0; z-index: 1;
        background: rgba(18,18,22,0.98);
        padding: 4px 10px 6px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      .ajna-context-menu .ctx-filter input {
        width: 100%; box-sizing: border-box;
        background: #15151b; color: #eaeaea;
        border: 1px solid #3a3a44; border-radius: 4px;
        padding: 6px 8px; font: inherit;
      }
      .ajna-context-menu .ctx-filter input:focus { outline: none; border-color: #2c5d8f; }
      .ajna-context-menu .ctx-leer {
        padding: 8px 14px; color: #888;
      }
      .ajna-context-menu .ctx-header {
        padding: 6px 12px 6px;
        font-size: 11px;
        color: #f1c40f;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        margin-bottom: 4px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ajna-context-menu .ctx-item {
        padding: 5px 14px;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ajna-context-menu .ctx-item:hover { background: #2c5d8f; }
      .ajna-context-menu .ctx-item.danger:hover { background: #8c3030; }
      .ajna-context-menu .ctx-item.disabled { color: #666; cursor: default; }
      .ajna-context-menu .ctx-item.disabled:hover { background: transparent; }
      .ajna-context-menu .ctx-separator {
        height: 1px;
        background: rgba(255,255,255,0.08);
        margin: 4px 0;
      }
      .ajna-context-menu .ctx-section-label {
        padding: 4px 14px 2px;
        font-size: 10px;
        color: #888;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
    `
    document.head.appendChild(style)
  }

  show({ x, y, title, items }) {
    this.hide()

    const el = document.createElement('div')
    el.className = 'ajna-context-menu'
    // Verhindert, dass ein Klick auf das Menü als "Außenklick" gewertet wird.
    el.addEventListener('click', ev => ev.stopPropagation())

    if (title) {
      const header = document.createElement('div')
      header.className = 'ctx-header'
      header.textContent = title
      el.appendChild(header)
    }

    // Alles unterhalb des Kopfes wandert in einen eigenen Kasten — nur der
    // scrollt, der Kopf bleibt stehen.
    const body = document.createElement('div')
    body.className = 'ctx-body'

    const zeilen = []   // { el, text } — für das Suchfeld
    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div')
        sep.className = 'ctx-separator'
        body.appendChild(sep)
        continue
      }
      if (item.sectionLabel) {
        const lbl = document.createElement('div')
        lbl.className = 'ctx-section-label'
        lbl.textContent = t(item.sectionLabel)
        body.appendChild(lbl)
        continue
      }
      const row = document.createElement('div')
      row.className = 'ctx-item'
      if (item.danger) row.classList.add('danger')
      if (item.disabled) row.classList.add('disabled')
      // ÜBERSETZT WIRD HIER, nicht bei jedem Aufrufer. Das Menü bekommt seine
      // Beschriftungen aus vier Quellen (Objekt-Aktionen, Auftrags-Aktionen,
      // Wikipedia-Link, Geräte-Katalog) — sie einzeln zu verpacken hiesse, es
      // an vier Stellen zu vergessen. Ein zusammengesetzter Text („Angreifen —
      // zu weit weg") findet keinen Eintrag und bleibt, wie er ist; das ist
      // der gewollte Rückfall.
      row.textContent = t(item.label)
      if (!item.disabled) {
        row.addEventListener('click', () => {
          this.hide()
          item.onClick?.()
        })
      }
      body.appendChild(row)
      // Gesucht wird im ANGEZEIGTEN Text — sonst fände man auf Englisch nur
      // mit den deutschen Wörtern etwas.
      zeilen.push({ el: row, text: row.textContent.toLowerCase() })
    }

    // Suchfeld nur bei langen Listen — siehe Kopf der Datei.
    if (zeilen.length >= FILTER_AB) {
      el.appendChild(this._baueFilter(body, zeilen))
    }
    el.appendChild(body)
    document.body.appendChild(el)

    // ── Einpassen ────────────────────────────────────────────────────────
    // Untere Steuerleisten (App-Tabbar + System-Navigation/Safe-Area) meiden,
    // sonst klemmt das Menü dahinter. Zone über dieselbe CSS-Berechnung messen
    // wie die Popups (Fallbacks greifen auf Standalone-Seiten ohne Shell-Vars).
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;left:-9999px;bottom:0;width:0;'
      + 'height:calc(var(--tabbar-height, 0px) + var(--safe-bottom, env(safe-area-inset-bottom, 0px)))'
    document.body.appendChild(probe)
    const bottomInset = probe.getBoundingClientRect().height
    probe.remove()

    // Zuerst deckeln, DANN messen: Ohne Deckel meldet ein langes Menü seine
    // volle Höhe, die Obergrenze unten wird negativ, und das Menü landet
    // oberhalb des Bildschirmrands — genau der gemeldete Fall.
    const platz = Math.min(
      window.innerHeight - bottomInset - 2 * RAND,
      Math.round(window.innerHeight * ANTEIL_HOEHE),
    )
    el.style.maxHeight = platz + 'px'

    const rect = el.getBoundingClientRect()
    const maxX = window.innerWidth - rect.width - RAND
    const maxY = window.innerHeight - bottomInset - rect.height - RAND
    const top = Math.min(Math.max(y, RAND), Math.max(RAND, maxY))
    el.style.left = Math.min(Math.max(x, RAND), Math.max(RAND, maxX)) + 'px'
    el.style.top  = top + 'px'
    // Nach dem Setzen noch einmal nachziehen: Wer weit unten getippt hat,
    // bekommt sonst ein Menü, das unten wieder hinausragt.
    el.style.maxHeight = Math.max(120, Math.min(
      window.innerHeight - bottomInset - top - RAND,
      Math.round(window.innerHeight * ANTEIL_HOEHE),
    )) + 'px'

    this.el = el

    // setTimeout, damit der aktuelle Click-Event (der das Menü gerade
    // geöffnet hat) das Listener-Setup nicht direkt auslöst.
    setTimeout(() => {
      document.addEventListener('click', this._onDocClick)
      document.addEventListener('keydown', this._onKey)
    }, 0)
  }

  /**
   * Suchfeld für lange Listen.
   *
   * Gefiltert wird über den sichtbaren Text — bei HomeAssistant steht dort
   * „Wohnzimmerlampe · light", man kann also nach dem Raum ODER nach der Art
   * suchen, ohne dass hier etwas über HomeAssistant wüsste.
   *
   * Trennlinien und Zwischenüberschriften verschwinden, sobald gefiltert wird:
   * Eine Überschrift über einer leeren Gruppe ist eine falsche Auskunft.
   */
  _baueFilter(body, zeilen) {
    const box = document.createElement('div')
    box.className = 'ctx-filter'
    const input = document.createElement('input')
    input.type = 'search'
    input.placeholder = t('Suchen …')
    input.setAttribute('aria-label', t('Aktionen durchsuchen'))
    box.appendChild(input)

    const leer = document.createElement('div')
    leer.className = 'ctx-leer'
    leer.textContent = t('Nichts gefunden.')
    leer.hidden = true
    body.appendChild(leer)

    const deko = () => body.querySelectorAll('.ctx-separator, .ctx-section-label')
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase()
      let treffer = 0
      for (const z of zeilen) {
        const passt = !q || z.text.includes(q)
        z.el.hidden = !passt
        if (passt) treffer++
      }
      for (const d of deko()) d.hidden = !!q
      leer.hidden = treffer > 0
      body.scrollTop = 0
    })
    // Tasten dürfen nicht nach draußen durchschlagen: Ein „e" im Suchfeld
    // sollte nicht die Szene bedienen.
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation()
      if (ev.key === 'Escape') this.hide()
    })
    // Auf dem Telefon NICHT von selbst fokussieren: Die Tastatur klappte sonst
    // über das halbe Menü, das man gerade lesen will.
    if (!('ontouchstart' in window)) setTimeout(() => input.focus(), 0)
    return box
  }

  _onDocClick(ev) {
    if (this.el && !this.el.contains(ev.target)) this.hide()
  }

  _onKey(ev) {
    if (ev.key === 'Escape') this.hide()
  }

  hide() {
    document.removeEventListener('click', this._onDocClick)
    document.removeEventListener('keydown', this._onKey)
    if (this.el) {
      this.el.remove()
      this.el = null
    }
  }
}
