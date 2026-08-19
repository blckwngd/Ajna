#!/usr/bin/env node
//
// tests/run-ui.mjs — Zustandslogik von UI-Bausteinen, OHNE laufenden Stack.
//
//   npm run test:ui
//
// Warum ein handgeschriebener DOM-Stub statt jsdom: für eine Handvoll Prüfungen
// eine Abhängigkeit ins Projekt zu holen (jsdom zieht ~30 Pakete) lohnt nicht.
// Der Stub deckt genau die DOM-Teile ab, die InfoHint anfasst.
//
// GRENZE: das hier prüft ZUSTAND (auf/zu, welcher Text, wer schließt wen), NICHT
// Aussehen oder Positionierung — Pixel kann nur ein echter Browser beurteilen.
// Wenn der Stub bricht, weil das Modul eine neue DOM-API benutzt: Stub erweitern,
// nicht den Test löschen.

// ── Minimaler DOM-Stub ───────────────────────────────────────────────────
const listeners = new Map()
const mkEl = (tag = 'div') => ({
  tagName: tag, children: [], style: {}, attrs: {}, _text: '', isConnected: false,
  classList: { _s: new Set(), add(c) { this._s.add(c) }, contains(c) { return this._s.has(c) } },
  set className(v) { this._cls = v }, get className() { return this._cls || '' },
  // Wie im echten DOM: textContent liefert auch den Text der Kinder. Ohne das
  // sieht ein Test einen zusammengesetzten Tooltip als leer.
  set textContent(v) { this._text = v; this.children = [] },
  get textContent() { return this._text + this.children.map(c => c.textContent ?? '').join('') },
  setAttribute(k, v) { this.attrs[k] = v }, getAttribute(k) { return this.attrs[k] },
  appendChild(c) { this.children.push(c); c.parent = this; c.isConnected = this.isConnected; return c },
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this) },
  contains(n) { return n === this || this.children.some(c => c.contains?.(n)) },
  addEventListener(t, fn) { (this._l ||= {})[t] = fn }, removeEventListener() {},
  getBoundingClientRect: () => ({ left: 100, top: 100, bottom: 120, right: 120 }),
  offsetWidth: 200, offsetHeight: 80,
})
const body = mkEl('body'); body.isConnected = true
const head = mkEl('head'); head.isConnected = true
globalThis.document = {
  body, head,
  createElement: mkEl,
  getElementById: () => null,
  querySelector: () => null,
  addEventListener: (t, fn, cap) => listeners.set(t + (cap ? ':cap' : ''), fn),
  removeEventListener: (t, fn, cap) => listeners.delete(t + (cap ? ':cap' : '')),
}
globalThis.window = { innerWidth: 400, innerHeight: 800, addEventListener() {}, removeEventListener() {} }
globalThis.requestAnimationFrame = fn => setTimeout(fn, 1)
globalThis.cancelAnimationFrame = id => clearTimeout(id)
const _store = new Map()
globalThis.localStorage = {
  getItem: k => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => _store.set(k, String(v)),
  removeItem: k => _store.delete(k),
}

// ── Prüfungen ────────────────────────────────────────────────────────────
const { infoHint, closeInfoHint } = await import('../client/core/InfoHint.js')

const results = []
const check = (name, cond) => {
  results.push({ name, ok: !!cond })
  console.log(`   ${cond ? '✅' : '❌'} ${name}`)
}
const popCount = () => body.children.filter(e => e.className === 'ajna-info-pop').length
const ev = target => ({ target, preventDefault() {}, stopPropagation() {} })
const tick = () => new Promise(r => setTimeout(r, 8))

console.log('\n── InfoHint: Popup-Zustandslogik')

let dyn = 'erste Fassung'
const btn1 = infoHint(() => dyn, { title: () => 'Titel A' })
const btn2 = infoHint('zweiter Text')
body.appendChild(btn1); body.appendChild(btn2)

btn1._l.click(ev(btn1))
check('Klick oeffnet das Popup', popCount() === 1)
check('aria-expanded wird gesetzt', btn1.getAttribute('aria-expanded') === 'true')

// Der Text darf eine Funktion sein — sie MUSS bei jedem Oeffnen neu laufen,
// sonst zeigt das Popup einen veralteten Stand (z. B. die alte Stufe).
btn1._l.click(ev(btn1))
dyn = 'zweite Fassung'
btn1._l.click(ev(btn1))
const pop = body.children.find(e => e.className === 'ajna-info-pop')
check('zweiter Klick schliesst, dritter oeffnet wieder', popCount() === 1)
check('Text wird bei jedem Oeffnen neu ausgewertet', pop.children.some(ch => ch.textContent === 'zweite Fassung'))
check('Titel ebenfalls dynamisch', pop.children.some(ch => ch.textContent === 'Titel A'))

await tick()
listeners.get('pointerdown:cap')(ev(btn2))
check('Fremdklick schliesst das offene Popup', popCount() === 0)
btn2._l.click(ev(btn2))
check('anderes Icon oeffnet danach', popCount() === 1)

await tick()
const pop2 = body.children.find(e => e.className === 'ajna-info-pop')
listeners.get('pointerdown:cap')(ev(pop2.children[0]))
check('Klick INS Popup schliesst nicht (Text markierbar)', popCount() === 1)

listeners.get('keydown:cap')({ key: 'Escape' })
check('Escape schliesst', popCount() === 0)

btn1._l.click(ev(btn1)); btn2._l.click(ev(btn2))
check('nie zwei Popups gleichzeitig', popCount() === 1)

// Der Fall, der ohne Sicherheitsnetz stehenbleibt: MobileShell._renderSettings
// ersetzt bei jedem Wand-/UWB-Event das ganze innerHTML.
btn2.remove()
await tick(); await tick()
check('Popup verschwindet mit seinem Button (Panel-Neuaufbau)', popCount() === 0)

body.appendChild(btn1); btn1.isConnected = true
btn1._l.click(ev(btn1))
closeInfoHint()
check('closeInfoHint() schliesst von aussen', popCount() === 0)
check('aria-expanded wird zurueckgesetzt', btn1.getAttribute('aria-expanded') === 'false')

// ── Privatsphäre: welche Position darf an eine Interaktion? ──────────────
// Sicherheitsrelevant: positionFor entscheidet, ob EXAKTE Koordinaten das Gerät
// verlassen („Drache rufen"). Ein Fehler hier ist ein stilles Datenleck, das man
// im UI nicht sieht — deshalb fest verdrahtet geprüft.
console.log('\n── PrivacyPolicy: Position für Interaktionen')
const { privacy } = await import('../client/core/PrivacyPolicy.js')
const POS = { lat: 50.446789, lon: 7.597123 }

privacy.setLevel('srvA', 'exact')
const exact = privacy.positionFor('srvA', POS)
check('Stufe „Genau" → exakte Koordinaten', exact.lat === POS.lat && exact.lon === POS.lon)
check('Stufe „Genau" markiert precise=true', exact.precise === true)

for (const lvl of ['area', 'proximity']) {
  privacy.setLevel('srvB', lvl)
  const p = privacy.positionFor('srvB', POS)
  const moved = Math.hypot((p.lat - POS.lat) * 111320, (p.lon - POS.lon) * 111320 * Math.cos(POS.lat * Math.PI / 180))
  check(`Stufe „${privacy.label(lvl)}" vergröbert (${moved.toFixed(0)} m verschoben, precise=false)`,
    p.precise === false && (p.lat !== POS.lat || p.lon !== POS.lon) && moved <= 75)
}

privacy.setLevel('srvC', 'off')
check('Stufe „Verborgen" → null (keine Koordinaten)', privacy.positionFor('srvC', POS) === null)
check('ohne Position → null', privacy.positionFor('srvA', null) === null)
check('unvollständige Position → null', privacy.positionFor('srvA', { lat: 50 }) === null)

// Rasterung muss STABIL sein: zwei Aufrufe derselben Position dürfen nicht
// unterschiedlich streuen, sonst liesse sich die echte Lage herausmitteln.
privacy.setLevel('srvD', 'area')
const f1 = privacy.positionFor('srvD', POS), f2 = privacy.positionFor('srvD', POS)
check('Vergröberung ist deterministisch (kein Herausmitteln)', f1.lat === f2.lat && f1.lon === f2.lon)

// ── Chatfenster: mitlaufen oder in Ruhe lassen ───────────────────────────
// Die Regel, um die es geht: neue Zeilen holen die Ansicht nach unten — ausser
// der Leser ist selbst hochgescrollt, um etwas nachzulesen. Ein Fenster, das
// einem beim Lesen wegspringt, ist schlimmer als eines, das nicht nachzieht.
//
// Geprüft wird die Entscheidung, nicht das Rendern: eine Instanz ohne
// Konstruktor (der bräuchte das ganze Overlay), dafür mit einer nachgebauten
// Liste, deren Masse wir frei setzen können.
console.log('\n── MessageLogPanel: Scrollverhalten')
const { MessageLogPanel } = await import('../client/core/MessageLogPanel.js')

const liste = (scrollTop, scrollHeight = 1000, clientHeight = 300) =>
  ({ scrollTop, scrollHeight, clientHeight })
const panel = Object.create(MessageLogPanel.prototype)
panel._stickToBottom = true

panel._listEl = liste(700)          // 1000 - 700 - 300 = 0 → ganz unten
check('ganz unten gilt als unten', panel._istUnten() === true)
panel._listEl = liste(680)          // 20 px Abstand — innerhalb der Toleranz
check('20 px über dem Rand gilt noch als unten', panel._istUnten() === true)
panel._listEl = liste(500)          // 200 px Abstand — der Leser liest oben
check('200 px über dem Rand gilt als „liest nach"', panel._istUnten() === false)

// Neue Zeile, während der Leser unten steht → Ansicht zieht nach.
panel._listEl = liste(700)
panel._stickToBottom = true
panel._scrollToBottom()
check('haftend: neue Zeile zieht ans Ende', panel._listEl.scrollTop === 1000)

// Neue Zeile, während der Leser oben liest → Position bleibt.
panel._listEl = liste(120)
panel._stickToBottom = false
panel._scrollIfSticking()
check('nicht haftend: Position bleibt, wo sie ist', panel._listEl.scrollTop === 120)

// Zurück nach unten gescrollt → haftet wieder.
panel._listEl = liste(700)
panel._stickToBottom = panel._istUnten()
panel._listEl = liste(0, 1400)
panel._scrollIfSticking()
check('wieder unten angekommen → haftet erneut', panel._listEl.scrollTop === 1400)

// Ohne Liste (Fenster zu) darf nichts krachen.
panel._listEl = null
panel._scrollToBottom()
check('geschlossenes Fenster: kein Fehler', panel._istUnten() === true)

// ── Minimap: welche Objekte bekommen ein Symbol? ─────────────────────────
// Die Minimap ist wenige Zentimeter gross und laeuft im Bildtakt ueber der
// 3D-Ansicht. Zeichnete sie alles, was der Server kennt, kostete sie auf einem
// WLAN-reichen Server Bildrate. Geprueft wird deshalb die Auswahl (Umkreis,
// Inhaltsfilter, Obergrenze) und dass bewegte Objekte nachgefuehrt statt neu
// gebaut werden — ein neu gebauter Marker verliert seinen offenen Tooltip.
console.log('\n── Minimap: Objekt-Symbole')
const { Minimap } = await import('../client/core/Minimap.js')

const fakeL = {
  divIcon: (o) => ({ _icon: o }),
  marker: (ll, opts) => ({
    _ll: { lat: ll[0], lng: ll[1] }, _opts: opts, _tip: null, _setz: 0, _icons: 0,
    getLatLng() { return this._ll },
    setLatLng(x) { this._ll = { lat: x[0], lng: x[1] }; this._setz++ },
    bindTooltip(c, o) { this._tip = c; this._tipOpts = o; return this },
    setTooltipContent(c) { this._tip = c },
    setIcon() { this._icons++ },
  }),
}
globalThis.window.L = fakeL

const mkMini = (objekte, filters = null) => {
  const mm = Object.create(Minimap.prototype)
  mm.getObjects = () => objekte
  mm.filters = filters
  mm._markers = new Map()
  mm._objSyncAt = 0
  mm._radiusM = () => 250          // 250 m sichtbarer Radius
  const geleg = new Set()
  mm._objLayer = { addLayer: (l) => geleg.add(l), removeLayer: (l) => geleg.delete(l) }
  mm._gelegt = geleg
  return mm
}
// ~111 m je 0.001° Breite
const obj = (id, dLat, extra = {}) =>
  ({ id, name: 'Nr ' + id, type: 'npc', lat: 50 + dLat, lon: 7, ...extra })
const MITTE = { lat: 50, lon: 7 }

const m1 = mkMini([obj('a', 0), obj('b', 0.001), obj('fern', 0.02)])
m1._syncObjects(MITTE, true)
check('Objekte im Umkreis bekommen ein Symbol', m1._markers.size === 2)
check('weit entferntes Objekt wird nicht gezeichnet', !m1._markers.has('fern'))
check('Symbol ist ein DivIcon ohne Beschriftung',
  /ajna-mm-glyph/.test(m1._markers.get('a')._opts.icon._icon.html))
const tipA = m1._markers.get('a')._tip
check('Name haengt als Tooltip daran', /^Nr a/.test(tipA.textContent))
check('Objekt-ID steht ebenfalls im Tooltip', tipA.textContent.includes('a'))
check('Servername standardmaessig NICHT im Tooltip',
  !/testserver/i.test(tipA.textContent))
check('kein Klick-/Kontextmenue verdrahtet',
  Object.keys(m1._markers.get('a')).every(k => !/^on/i.test(k)))

// Getragenes Objekt ist im Inventar, nicht in der Welt.
const m2 = mkMini([obj('a', 0), obj('imBeutel', 0, { carried_by: 'u1' })])
m2._syncObjects(MITTE, true)
check('getragenes Objekt erscheint nicht', m2._markers.size === 1)

// Inhaltsfilter des Spielers gilt auch hier.
const m3 = mkMini([obj('a', 0), obj('b', 0)], { matches: (o) => o.id !== 'b' })
m3._syncObjects(MITTE, true)
check('ausgeblendete Quelle erscheint nicht', m3._markers.size === 1 && !m3._markers.has('b'))

// Obergrenze: die naechsten gewinnen.
const viele = Array.from({ length: 400 }, (_, i) => obj('o' + i, i * 0.000005))
const m4 = mkMini(viele)
m4._syncObjects(MITTE, true)
check('Obergrenze greift (250 Marker)', m4._markers.size === 250)
check('die naechsten Objekte gewinnen', m4._markers.has('o0') && !m4._markers.has('o399'))

// Live: bewegtes Objekt wird nachgefuehrt, nicht neu gebaut.
const bewegt = [obj('x', 0)]
const m5 = mkMini(bewegt)
m5._syncObjects(MITTE, true)
const marker = m5._markers.get('x')
bewegt[0] = obj('x', 0.0005)               // ~55 m weiter
m5._syncObjects(MITTE, true)
check('bewegtes Objekt: Marker bleibt derselbe', m5._markers.get('x') === marker)
check('bewegtes Objekt: Position wurde nachgefuehrt', marker._setz === 1)
bewegt[0] = obj('x', 0.0005)               // unveraendert
m5._syncObjects(MITTE, true)
check('unbewegtes Objekt: kein zweites setLatLng', marker._setz === 1)

// Verschwundenes Objekt: Marker weg.
bewegt.length = 0
m5._syncObjects(MITTE, true)
check('verschwundenes Objekt: Marker entfernt', m5._markers.size === 0)

// Taktbremse: ohne force passiert zwischen zwei Bildern nichts.
const m6 = mkMini([obj('a', 0)])
m6._syncObjects(MITTE, true)
m6._objSyncAt = (typeof performance !== 'undefined' ? performance.now() : Date.now())
const vorher = m6._markers.size
m6.getObjects = () => [obj('a', 0), obj('neu', 0)]
m6._syncObjects(MITTE, false)
check('Taktbremse: kein Abgleich im selben Moment', m6._markers.size === vorher)
m6._syncObjects(MITTE, true)
check('mit force wird sofort abgeglichen', m6._markers.size === 2)

// ── Minimap: Zoom folgt der Flughoehe ────────────────────────────────────
// Gewuenscht: aus der Hoehe ergibt sich der abgedeckte Radius; zoomt der Nutzer
// selbst, gilt sein ABSTAND zur automatischen Stufe weiter — nicht die absolute
// Stufe. Sonst waere die Handeinstellung beim naechsten Steigen wieder weg.
console.log('\n── Minimap: Zoom nach Flughoehe')

const fakeMap = (zoom = 17, paneY = 150, lat = 50) => ({
  _z: zoom, _gesetzt: [],
  getSize: () => ({ x: paneY, y: paneY }),
  getZoom() { return this._z },
  setZoom(z) { this._z = z; this._gesetzt.push(z) },
  getCenter: () => ({ lat }),
  distance: () => 55,
  containerPointToLatLng: () => ({ lat, lng: 7 }),
})
const mkZoom = (zoom = 17) => {
  const mm = Object.create(Minimap.prototype)
  mm._map = fakeMap(zoom)
  mm._zoom = zoom
  mm._zoomOffset = 0
  mm._autoZooming = false
  mm._lastHoehe = null
  mm._objLayer = null
  mm.getObjects = null
  return mm
}

const z0 = mkZoom()
const amBoden = z0._autoZoomFor(0, 50)
const auf100 = z0._autoZoomFor(100, 50)
const auf1000 = z0._autoZoomFor(1000, 50)
check(`am Boden bleibt es beim bisherigen Ausschnitt (${amBoden})`, amBoden === 17)
check(`100 m Hoehe zoomt heraus (${auf100})`, auf100 < amBoden && auf100 >= 15)
check(`1000 m Hoehe zoomt weiter heraus (${auf1000})`, auf1000 < auf100)
check('unter der Kartengroesse null statt Unsinn', mkZoom()._autoZoomFor.call({ _map: null }, 100, 50) === null)

// Steigen zieht die Karte auf.
const z1 = mkZoom()
z1._folgeHoehe({ lat: 50, hoehe: 0 }, true)
const nachBoden = z1._map.getZoom()
z1._folgeHoehe({ lat: 50, hoehe: 300 }, false)
check('Steigen zoomt heraus', z1._map.getZoom() < nachBoden)
z1._folgeHoehe({ lat: 50, hoehe: 0 }, false)
check('Sinken zoomt wieder heran', z1._map.getZoom() === nachBoden)

// Winzige Hoehenaenderung darf nicht zappeln.
const z2 = mkZoom()
z2._folgeHoehe({ lat: 50, hoehe: 100 }, true)
const zoomVorher = z2._map._gesetzt.length
z2._folgeHoehe({ lat: 50, hoehe: 101 }, false)
check('1 m Hoehenaenderung loest kein Zoomen aus', z2._map._gesetzt.length === zoomVorher)

// Handeinstellung: der ABSTAND bleibt, nicht die Stufe.
const z3 = mkZoom()
z3._folgeHoehe({ lat: 50, hoehe: 0 }, true)
z3._zoomOffset = -2                       // Nutzer hat zweimal herausgezoomt
z3._lastHoehe = null
z3._folgeHoehe({ lat: 50, hoehe: 0 }, true)
check('Handeinstellung wirkt am Boden', z3._map.getZoom() === amBoden - 2)
z3._folgeHoehe({ lat: 50, hoehe: 300 }, false)
check('Handeinstellung bleibt beim Steigen erhalten',
  z3._map.getZoom() === Math.max(12, z3._autoZoomFor(300, 50) - 2))

// Ohne Hoehenangabe (Objekte-Tab, nur GPS) bleibt die Stufe unangetastet.
const z4 = mkZoom(19)
z4._folgeHoehe({ lat: 50 }, true)
check('ohne Hoehenangabe kein Auto-Zoom', z4._map.getZoom() === 19 && z4._map._gesetzt.length === 0)

const failed = results.filter(r => !r.ok)
console.log(`\n${'═'.repeat(60)}`)
console.log(`UI: ${results.length - failed.length} bestanden, ${failed.length} fehlgeschlagen`)
if (failed.length) {
  console.log('\nFehlgeschlagen:')
  for (const f of failed) console.log('  ❌ ' + f.name)
  process.exit(1)
}
console.log('✅ alles grün')
