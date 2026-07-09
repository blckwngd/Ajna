// InterestAreaDebug — Debug-Overlay für Interessensbereiche auf der Leaflet-Karte.
//
// Zeichnet togglebar drei Dinge und eine Status-Box:
//   • cyan (gestrichelt) = der EIGENE publizierte Bereich (client-seitig, aus
//     InterestArea.getLast()) + der letzte Publish-Grund (sharing-off /
//     not-logged-in / no-position / published / publish-failed) + die gesendeten
//     Quellen — so sieht man SOFORT, ob und womit der Client publisht.
//   • gelb  = alle aktiven Server-Bereiche (GET /interest-areas, anonymisiert).
//   • grün  = die für den Director gefilterten (source=world-director) — DAS ist,
//     was der World-Director tatsächlich sieht. Fehlt hier etwas, obwohl der
//     eigene Publish OK ist → die Quelle wird nicht mitgeschickt (Layer aus).
//
// Nur Fehlersuche. Die InterestArea-Instanz wird über einen Getter geholt, damit
// es sowohl im Desktop-Map-Client als auch in der Mobile-Shell funktioniert.

const REFRESH_MS = 4000

export class InterestAreaDebug {
  constructor({ map, ajna, getInterestArea, source = 'world-director' }) {
    this.map = map
    this.L = window.L
    this.ajna = ajna
    this.getInterestArea = getInterestArea || (() => window.ajnaInterestArea)
    this.source = source
    this.on = false
    this.layer = this.L.layerGroup()
    this._timer = null
    this._addControl()
    this._addStatusBox()
  }

  _addControl() {
    const L = this.L
    const Ctl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: () => {
        const b = L.DomUtil.create('button', 'ia-dbg-btn')
        b.type = 'button'
        b.title = 'Interessensbereiche anzeigen (Debug)'
        b.textContent = '📡 IA'
        b.style.cssText = 'background:#222;color:#fff;border:1px solid #555;padding:4px 8px;cursor:pointer;font:12px sans-serif;border-radius:4px'
        L.DomEvent.on(b, 'click', L.DomEvent.stop)
        L.DomEvent.on(b, 'click', () => this.toggle())
        this._btn = b
        return b
      }
    })
    this.map.addControl(new Ctl())
  }

  _addStatusBox() {
    const div = document.createElement('div')
    div.className = 'ia-dbg-status'
    div.style.cssText = 'position:absolute;bottom:12px;left:12px;z-index:1000;background:rgba(0,0,0,.82);color:#eee;font:11px/1.45 monospace;padding:8px 10px;border-radius:6px;max-width:360px;white-space:pre-wrap;display:none;pointer-events:none'
    this.map.getContainer().appendChild(div)
    this._status = div
  }

  toggle() { this.on ? this.stop() : this.start() }

  start() {
    this.on = true
    this.layer.addTo(this.map)
    this._status.style.display = 'block'
    if (this._btn) this._btn.style.background = '#0a7d55'
    this._refresh()
    this._timer = setInterval(() => this._refresh(), REFRESH_MS)
  }

  stop() {
    this.on = false
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    this.layer.remove()
    this._status.style.display = 'none'
    if (this._btn) this._btn.style.background = '#222'
  }

  _rect(bbox, color, dashed = false) {
    this.layer.addLayer(this.L.rectangle(
      [[bbox.latMin, bbox.lonMin], [bbox.latMax, bbox.lonMax]],
      { color, weight: 2, fillOpacity: 0.07, dashArray: dashed ? '5 4' : null }
    ))
  }

  async _refresh() {
    if (!this.on) return
    this.layer.clearLayers()
    const lines = []

    // 1) Eigener publizierter Bereich + Grund
    const ia = this.getInterestArea?.()
    const last = ia?.getLast?.()
    if (!ia) {
      lines.push('eigener Publish: (InterestArea nicht gefunden)')
    } else if (!last) {
      lines.push('eigener Publish: (noch kein Tick — ~60 s abwarten)')
    } else {
      const age = Math.round((Date.now() - last.at) / 1000)
      lines.push(`eigener Publish: ${last.ok ? '✅ OK' : '❌'} (${last.reason}, vor ${age}s)`)
      lines.push(`  sources: [${(last.sources || []).join(', ') || '—'}]`)
      if (last.error) lines.push(`  error: ${last.error}`)
      if (last.bbox) this._rect(last.bbox, '#22d3ee', true)
    }

    // 2) Server-Aggregat + 3) für den Director gefiltert
    try {
      const [all, src] = await Promise.all([
        this.ajna.fetchInterestAreas(),
        this.ajna.fetchInterestAreas(this.source)
      ])
      lines.push(`Server: ${all.length} Bereich(e) gesamt · ${src.length} für "${this.source}"`)
      if (last?.ok && src.length === 0) {
        lines.push(`  ⚠ Publish OK, aber 0 für "${this.source}" → Layer nicht eingeblendet?`)
      }
      for (const b of all) this._rect(b, '#eab308')
      for (const b of src) this._rect(b, '#22c55e')
    } catch (err) {
      lines.push(`Server-Fetch-Fehler: ${err?.message || err}`)
    }

    this._status.textContent = '📡 Interessensbereiche\n' + lines.join('\n') +
      '\n\ncyan=eigener · gelb=alle · grün=world-director'
  }
}
