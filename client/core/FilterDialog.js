// Modal — pro registriertem Agent eine Sektion, in der der Spieler die
// gewünschten Layer per Checkbox aktiviert. Die Auswahl wird persistiert
// (localStorage via AgentFilters) und triggert via dessen Listener ein
// Re-Render in AR + Karte.
//
// Default-Verhalten: ist für eine Quelle noch keine Auswahl gesetzt,
// gilt "alles sichtbar" (kein Checkbox-State persistiert).
// Sobald der User INTERAGIERT (Häkchen setzt oder entfernt), persistieren
// wir die Auswahl explizit — auch "leeres Array" = "ausgeblendet".

const STYLE_ID = 'ajnaFilterDialogStyles'

export class FilterDialog {
  /**
   * @param {{ajna: import('./AjnaManager.js').AjnaManager, filters: import('./AgentFilters.js').AgentFilters}} opts
   */
  constructor({ ajna, filters } = {}) {
    this.ajna = ajna
    this.filters = filters
    this._backdrop = null
    this._injectStyles()
  }

  async open() {
    if (!this.ajna?.isLoggedIn()) {
      console.warn('FilterDialog: nicht eingeloggt')
      return
    }
    try {
      await this.filters.refreshManifests()
    } catch (err) {
      console.warn('[filter-dialog] manifest refresh:', err?.message || err)
    }
    this._mount()
    this._render()
  }

  close() {
    this._backdrop?.remove()
    this._backdrop = null
  }

  // ───────────────────────────────────────────────────────────────────

  _mount() {
    if (this._backdrop) return
    const bd = document.createElement('div')
    bd.className = 'ajna-filter-backdrop'
    bd.addEventListener('click', e => { if (e.target === bd) this.close() })

    const dlg = document.createElement('div')
    dlg.className = 'ajna-filter-dialog'
    dlg.innerHTML = `
      <div class="filter-head">
        <h3>Inhalte filtern</h3>
        <button class="filter-close" title="Schließen">✕</button>
      </div>
      <p class="filter-desc">
        Für jeden Agent kannst du auswählen, welche Layer du sehen willst.
        Solange keine Auswahl getroffen ist, gilt <em>alles sichtbar</em>.
        Änderungen wirken sofort und werden im Browser gespeichert.
      </p>
      <div class="filter-list" data-role="list"></div>
      <div class="filter-actions">
        <button class="filter-close-btn">Schließen</button>
      </div>
    `
    bd.appendChild(dlg)
    document.body.appendChild(bd)
    this._backdrop = bd

    dlg.querySelector('.filter-close').addEventListener('click', () => this.close())
    dlg.querySelector('.filter-close-btn').addEventListener('click', () => this.close())
  }

  _render() {
    const bd = this._backdrop
    if (!bd) return
    const list = bd.querySelector('[data-role="list"]')
    list.innerHTML = ''

    const sources = this.filters.getSources()
    if (sources.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'filter-empty'
      empty.textContent = 'Keine Agents haben sich registriert. Starte einen Bridge-Agent (z. B. npm run poi), damit Filter-Optionen erscheinen.'
      list.appendChild(empty)
      return
    }

    for (const src of sources) {
      list.appendChild(this._renderSource(src))
    }
  }

  _renderSource(src) {
    const card = document.createElement('div')
    card.className = 'filter-card'

    const header = document.createElement('div')
    header.className = 'filter-card-head'
    const title = document.createElement('strong')
    title.textContent = src.agent_name || src.source
    header.appendChild(title)
    const meta = document.createElement('span')
    meta.className = 'filter-card-meta'
    meta.textContent = src.source
    header.appendChild(meta)
    card.appendChild(header)

    if (src.description) {
      const desc = document.createElement('div')
      desc.className = 'filter-card-desc'
      desc.textContent = src.description
      card.appendChild(desc)
    }

    const layersWrap = document.createElement('div')
    layersWrap.className = 'filter-layers'

    const selected = this.filters.getSelection(src.source)
    const layers = src.layers || []
    if (layers.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'filter-empty-inline'
      empty.textContent = '(keine Layer angeboten)'
      layersWrap.appendChild(empty)
    }

    for (const layer of layers) {
      const id = `filter-${src.source}-${layer.key}`
      const row = document.createElement('label')
      row.className = 'filter-layer'
      row.htmlFor = id

      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.id = id
      // checked, wenn (selected undefined → default alles sichtbar = alles checked)
      //              oder (selected enthält diesen key)
      cb.checked = (selected === undefined) || (Array.isArray(selected) && selected.includes(layer.key))
      cb.addEventListener('change', () => this._handleToggle(src, layer.key))

      const lbl = document.createElement('span')
      lbl.textContent = layer.label || layer.key

      row.appendChild(cb)
      row.appendChild(lbl)
      layersWrap.appendChild(row)
    }

    card.appendChild(layersWrap)

    // "Zurücksetzen"-Button für die Card — entfernt die Custom-Auswahl,
    // fällt zurück auf Default = alles sichtbar.
    if (selected !== undefined) {
      const reset = document.createElement('button')
      reset.className = 'filter-reset'
      reset.textContent = 'Zurücksetzen (alles anzeigen)'
      reset.addEventListener('click', () => {
        this.filters.clearSelection(src.source)
        this._render()
      })
      card.appendChild(reset)
    }

    return card
  }

  _handleToggle(src, layerKey) {
    const current = this.filters.getSelection(src.source)
    const allKeys = (src.layers || []).map(l => l.key)

    // Wenn noch nichts gesetzt war (selected === undefined), startet der
    // User mit allen aktiv. Toggle = von "alle" auf "alle ohne diesen Key"
    // umschalten, indem wir explizit die anderen Keys als Liste speichern.
    let next
    if (current === undefined) {
      next = allKeys.filter(k => k !== layerKey)
    } else if (current.includes(layerKey)) {
      next = current.filter(k => k !== layerKey)
    } else {
      next = [...current, layerKey]
    }

    this.filters.setSelection(src.source, next)
    // Card neu rendern (Reset-Button erscheint/verschwindet je nach Setzungs-Status).
    this._render()
  }

  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = `
      .ajna-filter-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.55);
        z-index: 4300;
        display: flex; align-items: center; justify-content: center;
      }
      .ajna-filter-dialog {
        background: rgba(18,18,22,0.98);
        color: #eaeaea;
        border: 1px solid #3a3a44;
        border-radius: 8px;
        box-shadow: 0 12px 48px rgba(0,0,0,0.6);
        font: 12px ui-monospace, Menlo, Consolas, monospace;
        width: 580px; max-width: 92vw;
        max-height: 88vh; overflow: auto;
        padding: 16px 18px;
      }
      .ajna-filter-dialog .filter-head {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 8px;
      }
      .ajna-filter-dialog h3 {
        margin: 0;
        font-size: 13px; color: #f1c40f;
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      .ajna-filter-dialog .filter-close {
        background: transparent; color: #aab;
        border: 1px solid #3a3a44; border-radius: 4px;
        padding: 2px 8px; cursor: pointer;
      }
      .ajna-filter-dialog .filter-close:hover { color: #fff; }
      .ajna-filter-dialog .filter-desc {
        margin: 0 0 12px;
        font-size: 11px; color: #aab; line-height: 1.5;
      }
      .ajna-filter-dialog .filter-empty {
        font-size: 11px; color: #777; font-style: italic;
        padding: 12px; text-align: center;
      }
      .ajna-filter-dialog .filter-empty-inline {
        font-size: 11px; color: #777; font-style: italic;
      }

      .ajna-filter-dialog .filter-card {
        background: #15151a;
        border-radius: 4px;
        padding: 10px 12px;
        margin-bottom: 8px;
        border-left: 3px solid #2c5d8f;
      }
      .ajna-filter-dialog .filter-card-head {
        display: flex; align-items: baseline; gap: 8px;
        margin-bottom: 4px;
      }
      .ajna-filter-dialog .filter-card-head strong {
        font-size: 13px; color: #eaeaea;
      }
      .ajna-filter-dialog .filter-card-meta {
        font-size: 10px; color: #888;
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      .ajna-filter-dialog .filter-card-desc {
        font-size: 11px; color: #aab; margin-bottom: 8px;
      }

      .ajna-filter-dialog .filter-layers {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 4px 16px;
      }
      .ajna-filter-dialog .filter-layer {
        display: flex; align-items: center; gap: 6px;
        cursor: pointer;
        padding: 2px 0;
      }
      .ajna-filter-dialog .filter-layer:hover { color: #f1c40f; }

      .ajna-filter-dialog .filter-reset {
        margin-top: 8px;
        background: transparent; color: #aab;
        border: 1px solid #3a3a44; border-radius: 4px;
        padding: 3px 10px; cursor: pointer;
        font: inherit; font-size: 11px;
      }
      .ajna-filter-dialog .filter-reset:hover { color: #fff; }

      .ajna-filter-dialog .filter-actions {
        display: flex; justify-content: flex-end;
        margin-top: 12px;
      }
      .ajna-filter-dialog .filter-close-btn {
        background: #2c5d8f; color: #fff;
        border: none; border-radius: 4px;
        padding: 5px 14px; cursor: pointer;
        font: inherit;
      }
      .ajna-filter-dialog .filter-close-btn:hover { background: #356da6; }
    `
    document.head.appendChild(style)
  }
}
