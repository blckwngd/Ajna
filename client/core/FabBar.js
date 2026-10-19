// FabBar — the floating buttons (inventory, filter, quests, minimap, log) as
// ONE set that can be hidden, shown and reached by keyboard.
//
// WHY THIS EXISTS. Four panels each grew their own floating button, each with
// its own CSS class, its own drag key and its own `setVisible`. Nothing knew
// about the others, so "get them out of my way for a moment" was not a thing
// anyone could do — and in AR they sit right where you want to look.
//
// WHY A WINDOW GLOBAL, not a module singleton: same reason as AccessoryHub.
// The views are separate webpack bundles, so a module-level instance would be
// bundled INTO each one and map.bundle.js would get a different bar than
// mobile.bundle.js on the same page. On a separate page a fresh bar is correct.
//
// HIDING IS DONE WITH A CLASS, NOT WITH style.display — and that is not a
// matter of taste. Minimap and QuestPanel already write `fab.style.display`
// themselves; if this module wrote the same property, whoever ran last would
// win and a hidden button could pop back on its own. One body class plus
// `!important` beats an inline style, so the two mechanisms cannot fight:
//
//     body.ajna-fabs-off .ajna-fab { display: none !important }
//
// A new floating button therefore needs exactly one thing from this file —
// to register. It gets the class, the key, the handle and the hiding for free.

import { makeDraggable } from './draggable.js'
import { t } from './i18n.js'

const KEY = '__ajnaFabBar'
const STORE_VISIBLE = 'ajna.fabs.visible'
const STORE_HANDLE = 'ajna.fabs.handle'

/** Marker on every registered button — the hiding rule hangs off this. */
export const FAB_CLASS = 'ajna-fab'
/** On <body> while the buttons are hidden. */
export const OFF_CLASS = 'ajna-fabs-off'
/** Hides and shows everything. „H" wie Hide. */
export const TOGGLE_KEY = 'h'

/**
 * @typedef {object} FabEntry
 * @property {string} id        stable name, e.g. 'inventory'
 * @property {HTMLElement} el   the button
 * @property {string} label     German, for the title and the key overview
 * @property {string} [hotkey]  single character, lower case
 * @property {() => void} [toggle]  what the key does; defaults to a click
 * @property {() => void} [close]   called when everything is hidden
 */

export function getFabBar() {
  const existing = typeof window !== 'undefined' ? window[KEY] : null
  if (existing) return existing
  const bar = new FabBar()
  if (typeof window !== 'undefined') window[KEY] = bar
  return bar
}

export class FabBar {
  constructor() {
    /** @type {Map<string, FabEntry>} */
    this.entries = new Map()
    this._handle = null
    this._handleDrag = null
    this._keyListener = null
    this._visible = readFlag(STORE_VISIBLE, true)
    this._handleEnabled = readFlag(STORE_HANDLE, true)
    this._listeners = new Set()
    this._injectStyles()
  }

  // ── Anmeldung ──────────────────────────────────────────────────────────

  /**
   * Register a floating button. Returns the unregister function.
   *
   * Registering twice under the same id replaces the entry — a view that
   * rebuilds its button (Minimap does, on dock/undock) must not leave a dead
   * element behind that a key press would still try to click.
   *
   * @param {FabEntry} entry
   * @returns {() => void}
   */
  register(entry) {
    if (!entry?.id || !entry?.el) return () => {}
    entry.el.classList.add(FAB_CLASS)
    if (entry.label && !entry.el.title) {
      entry.el.title = entry.hotkey ? `${entry.label} (${entry.hotkey.toUpperCase()})` : entry.label
    }
    this.entries.set(entry.id, entry)
    this._installKeys()
    this._ensureHandle()
    this._apply()
    this._emit()
    return () => {
      if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id)
      this._emit()
    }
  }

  /**
   * Build a plain launcher button and register it — for a dialog that has no
   * panel class of its own. Saves repeating the button + makeDraggable dance
   * a fifth time.
   *
   * @param {{id: string, label: string, emoji: string, hotkey?: string,
   *          onClick: () => void, parent?: HTMLElement, posKey?: string}} opts
   * @returns {{ el: HTMLElement, dispose: () => void }}
   */
  createLauncher({ id, label, emoji, hotkey, onClick, parent = null, posKey = null }) {
    const host = parent || document.body
    const el = document.createElement('button')
    el.type = 'button'
    el.className = `ajna-fab-launcher ajna-fab-${id}`
    el.title = hotkey ? `${label} (${hotkey.toUpperCase()})` : label
    el.setAttribute('aria-label', label)
    el.innerHTML = `<span aria-hidden="true">${emoji}</span>`
    host.appendChild(el)

    const drag = makeDraggable(el, { key: posKey || `ajna.fab.${id}.pos`, onClick })
    const unregister = this.register({ id, el, label, hotkey, toggle: onClick })

    return {
      el,
      dispose: () => {
        try { unregister() } catch {}
        try { drag?.() } catch {}
        el.remove()
      },
    }
  }

  // ── Ein- und Ausblenden ────────────────────────────────────────────────

  isVisible() { return this._visible }

  setVisible(on) {
    const next = !!on
    if (next === this._visible) return
    this._visible = next
    writeFlag(STORE_VISIBLE, next)
    // AUCH DIE OFFENEN FENSTER ZU. Wer die Knöpfe wegräumt, will freie Sicht —
    // ein offenes Inventar stört dabei mehr als sein Knopf.
    if (!next) for (const e of this.entries.values()) { try { e.close?.() } catch {} }
    this._apply()
    this._emit()
  }

  toggleVisible() { this.setVisible(!this._visible) }

  /** Der Randgriff selbst — abschaltbar, für wer ihn nicht mag. */
  isHandleEnabled() { return this._handleEnabled }

  setHandleEnabled(on) {
    this._handleEnabled = !!on
    writeFlag(STORE_HANDLE, this._handleEnabled)
    this._ensureHandle()
    this._apply()
    this._emit()
  }

  /** Für die Einstellungen: auf Änderungen hören. */
  onChange(fn) {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  _emit() {
    for (const fn of this._listeners) { try { fn(this) } catch {} }
  }

  _apply() {
    const body = document.body
    if (!body) return
    body.classList.toggle(OFF_CLASS, !this._visible)
    if (this._handle) {
      this._handle.classList.toggle('off', !this._visible)
      this._handle.style.display = this._handleEnabled ? '' : 'none'
      this._handle.title = (this._visible ? t('Knöpfe ausblenden') : t('Knöpfe einblenden'))
        + ` (${TOGGLE_KEY.toUpperCase()})`
      this._handle.setAttribute('aria-pressed', String(!this._visible))
    }
  }

  // ── Der Randgriff ──────────────────────────────────────────────────────

  _ensureHandle() {
    if (!this._handleEnabled) return
    if (this._handle?.isConnected) return
    if (typeof document === 'undefined' || !document.body) return
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'ajna-fab-handle'
    el.setAttribute('aria-label', t('Schwebende Knöpfe ein- oder ausblenden'))
    // Drei Striche, kein Text — der Griff soll gelesen werden können, ohne
    // etwas zu bedeuten, und in jeder Sprache gleich aussehen.
    el.innerHTML = '<span aria-hidden="true"></span>'
    document.body.appendChild(el)
    this._handle = el
    this._handleDrag = makeDraggable(el, {
      key: 'ajna.fabs.handle.pos',
      onClick: () => this.toggleVisible(),
    })
  }

  // ── Tasten ─────────────────────────────────────────────────────────────

  /** Was welche Taste tut — für eine Übersicht in den Einstellungen. */
  hotkeys() {
    const list = [...this.entries.values()]
      .filter(e => e.hotkey)
      .map(e => ({ key: e.hotkey.toUpperCase(), label: e.label }))
    list.sort((a, b) => a.key.localeCompare(b.key))
    return [...list, { key: TOGGLE_KEY.toUpperCase(), label: t('alle aus- und einblenden') }]
  }

  _installKeys() {
    if (this._keyListener || typeof document === 'undefined') return
    this._keyListener = (ev) => {
      if (!shouldHandleKey(ev)) return
      const key = String(ev.key || '').toLowerCase()
      if (key === TOGGLE_KEY) {
        ev.preventDefault()
        this.toggleVisible()
        return
      }
      // EINE AUSGEBLENDETE LEISTE REAGIERT NICHT. Sonst öffnete „I" ein
      // Inventar, dessen Knopf gerade unsichtbar ist — und niemand wüsste,
      // woher das Fenster kommt.
      if (!this._visible) return
      for (const e of this.entries.values()) {
        if (e.hotkey && e.hotkey.toLowerCase() === key) {
          ev.preventDefault()
          try { (e.toggle || (() => e.el.click()))() } catch (err) {
            console.warn('[fabbar]', e.id, err?.message || err)
          }
          return
        }
      }
    }
    document.addEventListener('keydown', this._keyListener)
  }

  dispose() {
    if (this._keyListener) document.removeEventListener('keydown', this._keyListener)
    this._keyListener = null
    try { this._handleDrag?.() } catch {}
    this._handle?.remove()
    this._handle = null
    this.entries.clear()
    document.body?.classList.remove(OFF_CLASS)
    if (typeof window !== 'undefined' && window[KEY] === this) delete window[KEY]
  }

  _injectStyles() {
    if (typeof document === 'undefined') return
    if (document.getElementById('ajna-fabbar-styles')) return
    const style = document.createElement('style')
    style.id = 'ajna-fabbar-styles'
    style.textContent = `
      /* !important, damit eine Panel-eigene style.display-Zuweisung einen
         ausgeblendeten Knopf nicht zurückholt. Siehe Kopf dieser Datei. */
      body.${OFF_CLASS} .${FAB_CLASS} { display: none !important; }

      .ajna-fab-launcher {
        position: fixed; right: 12px; bottom: 150px; z-index: 1200;
        width: 44px; height: 44px; border-radius: 50%;
        border: 1px solid rgba(255,255,255,0.25);
        background: rgba(20,22,28,0.82); color: #fff;
        font-size: 20px; line-height: 1; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 2px 10px rgba(0,0,0,0.4);
        -webkit-tap-highlight-color: transparent;
      }
      .ajna-fab-launcher:hover { background: rgba(32,36,46,0.92); }
      .ajna-fab-launcher:active { transform: scale(0.94); }

      /* Der Griff bleibt als EINZIGES stehen, wenn alles aus ist — und ist
         deshalb absichtlich nicht Teil von .${FAB_CLASS}. */
      .ajna-fab-handle {
        position: fixed; right: 0; bottom: 96px; z-index: 1201;
        width: 22px; height: 30px; padding: 0;
        border: none; border-radius: 6px 0 0 6px;
        background: rgba(20,22,28,0.35); cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        -webkit-tap-highlight-color: transparent;
        transition: background 120ms ease, opacity 120ms ease;
        opacity: 0.55;
      }
      .ajna-fab-handle:hover { opacity: 1; background: rgba(28,32,40,0.7); }
      .ajna-fab-handle > span {
        width: 3px; height: 16px; border-radius: 2px;
        background: rgba(255,255,255,0.75);
        box-shadow: 4px 0 0 rgba(255,255,255,0.35), -4px 0 0 rgba(255,255,255,0.35);
      }
      /* Ausgeblendet ist der Griff deutlicher — er ist dann der einzige Weg
         zurück und darf nicht zum Suchbild werden. */
      .ajna-fab-handle.off { opacity: 0.8; background: rgba(20,22,28,0.55); }
    `
    document.head.appendChild(style)
  }
}

/**
 * Darf diese Taste als Kürzel gelten?
 *
 * Nein, sobald jemand tippt oder eine Sondertaste hält — „f" in einem
 * Suchfeld darf keinen Dialog öffnen, und Strg-F gehört dem Browser.
 * Exportiert, weil genau diese Regel die ist, die man testen will.
 */
export function shouldHandleKey(ev) {
  if (!ev || ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return false
  if (ev.isComposing || ev.repeat) return false
  const el = ev.target
  // KEIN ZUGRIFF AUF `document` HIER. Die Prüfung braucht ihn nicht — `document`
  // und `<body>` fallen ohnehin durch die Tag-Liste unten — und mit ihm wäre
  // diese Regel nur im Browser prüfbar. Ein Test hat genau das aufgedeckt.
  if (!el) return true
  const tag = String(el.tagName || '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return false
  if (el.isContentEditable) return false
  // Ein Element mit eigener Tastenbedienung (Schieberegler, Liste) behält sie.
  if (typeof el.closest === 'function' && el.closest('[data-keys="own"]')) return false
  return true
}

function readFlag(key, fallback) {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch { return fallback }
}

function writeFlag(key, on) {
  try { localStorage.setItem(key, on ? '1' : '0') } catch {}
}
