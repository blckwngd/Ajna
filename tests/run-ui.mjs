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

import { readFileSync } from 'node:fs'

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
check('Name haengt als Tooltip daran', tipA.textContent === 'Nr a')
check('Objekt-ID standardmaessig NICHT im Tooltip', !tipA.textContent.includes('obj'))
check('Servername standardmaessig NICHT im Tooltip', !/testserver/i.test(tipA.textContent))
// Mit Schalter erscheint die ID.
localStorage.setItem('ajna.minimap.tooltipId', '1')
const mitId = mkMini([obj('a', 0)])
mitId._syncObjects(MITTE, true)
check('mit Schalter steht die Objekt-ID im Tooltip',
  mitId._markers.get('a')._tip.textContent.includes('a'))
localStorage.removeItem('ajna.minimap.tooltipId')
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

// ── World-Director: Ortswechsel erkennen ─────────────────────────────────
// Die Regel entscheidet, ob der teure Reconcile sofort laufen muss. Zu locker
// → er laeuft dauernd; zu streng → die Figuren bleiben nach dem ersten echten
// GPS-Fix am alten Ort stehen.
console.log('\n── World-Director: Sprung-Wächter')
{
  const R = 6371000, rad = d => d * Math.PI / 180
  const hav = (aLat, aLon, bLat, bLon) => {
    const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon)
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(a))
  }
  // Dieselbe Regel wie im Director (agents/world-director.mjs).
  const weitBewegt = (alt, neu, grenze) => {
    if (!alt || !neu) return false
    if (alt.length !== neu.length) return true
    return neu.some(n => !alt.some(a => hav(a.lat, a.lon, n.lat, n.lon) <= grenze))
  }
  const A = [{ lat: 50.4513, lon: 7.5363 }]
  const nahebei = [{ lat: 50.4515, lon: 7.5365 }]          // ~26 m
  const woanders = [{ lat: 50.3939, lon: 7.5116 }]         // ~6,6 km

  check('Schlendern loest keinen Sofort-Reconcile aus', weitBewegt(A, nahebei, 400) === false)
  check('Ortswechsel loest ihn aus', weitBewegt(A, woanders, 400) === true)
  check('zusaetzlicher Spieler loest ihn aus', weitBewegt(A, [...A, ...woanders], 400) === true)
  check('weggefallener Spieler loest ihn aus', weitBewegt([...A, ...woanders], A, 400) === true)
  check('ohne Vorwissen kein Reconcile', weitBewegt(null, woanders, 400) === false)
  check('gleiche Lage in anderer Reihenfolge ist kein Wechsel',
    weitBewegt([...A, ...woanders], [...woanders, ...A], 400) === false)
}

// ── GPSProvider: Startpunkt über Neustarts ───────────────────────────────
// Beim Hard-Reload steht noch kein Fix an. Womit die Szene startet, entscheidet
// darüber, wo Ursprung, Kulisse und Interessensbereich zuerst hinzeigen — ein
// falscher Startpunkt lässt beim ersten echten Fix alles um Kilometer springen.
console.log('\n── GPSProvider: gemerkter Startpunkt')
// Node liefert ein eigenes `navigator` ohne Geolocation und ohne Setter —
// deshalb die Eigenschaft ergänzen statt das Objekt zu ersetzen.
if (!('geolocation' in globalThis.navigator)) {
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    value: { watchPosition: () => 1, clearWatch: () => {} }, configurable: true,
  })
}
const { GPSProvider } = await import('../client/core/GPSProvider.js')

const K_MODE = 'ajna.gps.dummyMode', K_DUMMY = 'ajna.gps.dummyPosition', K_LAST = 'ajna.gps.lastKnown'
const lagerLeeren = () => { for (const k of [K_MODE, K_DUMMY, K_LAST]) localStorage.removeItem(k) }
const DUMMY = { lat: 50.4513, lon: 7.5363, altitude: 0 }
const ZULETZT = { lat: 50.3939, lon: 7.5116, altitude: 0, t: 1 }

lagerLeeren()
check('ohne alles kein Startpunkt', new GPSProvider()._startPosition() === null)

lagerLeeren()
localStorage.setItem(K_DUMMY, JSON.stringify(DUMMY))
localStorage.setItem(K_LAST, JSON.stringify(ZULETZT))
const g1 = new GPSProvider()
check('ohne Dummy-Modus gewinnt die zuletzt gesehene echte Position',
  g1._startPosition().lat === ZULETZT.lat && g1._startPosition().source === 'last')

lagerLeeren()
localStorage.setItem(K_MODE, 'true')
localStorage.setItem(K_DUMMY, JSON.stringify(DUMMY))
localStorage.setItem(K_LAST, JSON.stringify(ZULETZT))
const g2 = new GPSProvider()
check('im Dummy-Modus gewinnt die Handeinstellung',
  g2._startPosition().lat === DUMMY.lat && g2._startPosition().source === 'dummy')

lagerLeeren()
localStorage.setItem(K_DUMMY, JSON.stringify(DUMMY))
const g3 = new GPSProvider()
check('ohne gemerkte Position dient der Dummy als Startpunkt', g3._startPosition().lat === DUMMY.lat)
// Die Karte benutzt den öffentlichen Weg — beide müssen dasselbe liefern,
// sonst beginnen Karte und 3D-Ansicht an verschiedenen Orten.
check('getStartPosition() entspricht der internen Regel',
  JSON.stringify(g3.getStartPosition()) === JSON.stringify(g3._startPosition()))

lagerLeeren()
localStorage.setItem(K_LAST, JSON.stringify({ lat: 'quatsch', lon: null }))
check('unbrauchbarer Speicherinhalt wird verworfen', new GPSProvider()._startPosition() === null)

// Drosselung: nicht jeder Fix darf schreiben.
lagerLeeren()
const g4 = new GPSProvider()
g4._merkePosition({ latitude: 50.0, longitude: 7.0, altitude: 0 })
check('erster echter Fix wird sofort gemerkt', !!g4.lastKnown && g4.lastKnown.lat === 50.0)
const standAlt = g4.lastKnown
g4._merkePosition({ latitude: 50.00005, longitude: 7.0, altitude: 0 })   // ~5,6 m
check('kleine Bewegung kurz danach schreibt nicht erneut', g4.lastKnown === standAlt)
g4._merkePosition({ latitude: 50.0005, longitude: 7.0, altitude: 0 })    // ~56 m
check('größere Bewegung schreibt sofort', g4.lastKnown !== standAlt && g4.lastKnown.lat === 50.0005)
check('gemerkte Position liegt auch im Speicher',
  JSON.parse(localStorage.getItem(K_LAST)).lat === 50.0005)
g4.clearLastKnown()
check('clearLastKnown räumt beides weg', g4.lastKnown === null && !localStorage.getItem(K_LAST))
lagerLeeren()

// ── LabelLayer: Tafelgröße hängt an der Anzeige ──────────────────────────
// Babylon rechnet Schriftgrößen in TEXTUR-Pixeln, und die Textur ist so breit
// wie der Renderpuffer. Eine feste Pixelzahl fällt am Telefon deshalb viel
// größer aus als am Schreibtisch — genau das machte die Tafeln in Handy-AR
// erschlagend. Geprüft wird die Umrechnung, nicht das Zeichnen.
console.log('\n── LabelLayer: Tafelgröße je Anzeige')
{
  const REF = 1280, BASIS = 18, MIN = 9, MAX = 20, SCHMAL = 700
  // Dieselbe Regel wie in client/engine/LabelLayer.js.
  const fontFuer = (breite) =>
    Math.max(MIN, Math.min(MAX, Math.round(BASIS * breite / REF)))
  const tafelnFuer = (breite) => (breite < SCHMAL ? 10 : 25)

  const amTelefon = fontFuer(390)
  const amPult = fontFuer(1440)
  check(`Schreibtisch bleibt bei der Bezugsgröße (${fontFuer(1280)} px)`, fontFuer(1280) === 18)
  check(`Telefon wird kleiner (${amTelefon} px statt 18)`, amTelefon < 18 && amTelefon >= MIN)
  check(`breite Anzeige läuft nicht davon (${amPult} px)`, amPult <= MAX)
  check('winzige Textur bleibt lesbar', fontFuer(120) === MIN)
  // Entscheidend ist der BILDSCHIRMANTEIL: er soll sich zwischen Telefon und
  // Schreibtisch höchstens verdoppeln, vorher war es Faktor 3,7.
  const anteil = (px, breite) => px / breite
  const verhaeltnis = anteil(amTelefon, 390) / anteil(amPult, 1440)
  check(`Anteil am Bildschirm bleibt vergleichbar (Faktor ${verhaeltnis.toFixed(1)})`,
    verhaeltnis < 2.5)
  check('vorher war der Unterschied deutlich größer',
    anteil(18, 390) / anteil(18, 1440) > 3.5)

  check('Telefon zeigt weniger Tafeln gleichzeitig', tafelnFuer(390) === 10)
  check('Schreibtisch zeigt weiterhin viele', tafelnFuer(1440) === 25)
}

// ── QuestPanel: Einsortierung, Zaehler, Aktionen ─────────────────────────
// Der Panel ist ein kleines Ticketsystem: Derselbe Bestand landet je nach
// Zustand in einem von drei Reitern, und welche Knoepfe erscheinen, haengt
// ebenfalls am Zustand. Beides ist reine Zuordnung — genau das prueft sich hier
// ohne DOM.
console.log('\n── QuestPanel: Reiter und Aktionen')
const { QuestPanel, QUEST_STATES, QUEST_ACTIONS, fmtDistanz, fmtFrist, fmtBelohnung } =
  await import('../client/core/QuestPanel.js')

const mkQuest = (id, status, distanzM) => ({ id, status, distanzM, titel: id })
const qPanel = Object.create(QuestPanel.prototype)
qPanel._quests = [
  mkQuest('a', 'offen', 500), mkQuest('b', 'angeboten', 100),
  mkQuest('c', 'angenommen', 300), mkQuest('d', 'eingereicht', 50), mkQuest('e', 'abgelaufen', 900),
  mkQuest('f', 'pruefung', 700), mkQuest('g', 'pruefung', 200),
]

const ids = (tab) => qPanel.questsIn(tab).map(x => x.id).join('')
check('offen und angeboten stehen unter „Verfügbar"', ids('verfuegbar') === 'ba')
check('angenommen, eingereicht und abgelaufen unter „Aktiv"', ids('aktiv') === 'dce')
check('zu pruefende unter „Prüfen"', ids('pruefen') === 'gf')
check('naechstgelegene zuerst', qPanel.questsIn('verfuegbar')[0].id === 'b')
check('Zaehler am Auslöser = was auf mich wartet', qPanel.offeneP === 2)

// Unbekannter Zustand darf nichts verschlucken.
qPanel._quests = [mkQuest('x', 'quatsch', 10)]
check('unbekannter Zustand landet unter „Aktiv" statt zu verschwinden',
  qPanel.questsIn('aktiv').length === 1)

// Jeder Zustand hat einen Reiter und eine (evtl. leere) Aktionsliste.
const zustaende = Object.keys(QUEST_STATES)
check('jeder Zustand hat einen Reiter',
  zustaende.every(z => ['verfuegbar', 'aktiv', 'pruefen', 'meine'].includes(QUEST_STATES[z].tab)))
check('jeder Zustand hat definierte Aktionen',
  zustaende.every(z => Array.isArray(QUEST_ACTIONS[z])))
check('annehmbar ist nur, was verfügbar ist',
  ['offen', 'angeboten'].every(z => QUEST_ACTIONS[z].some(a => a.key === 'accept')) &&
  !QUEST_ACTIONS.angenommen.some(a => a.key === 'accept'))
check('geprueft wird mit Bestaetigen UND Ablehnen',
  QUEST_ACTIONS.pruefung.map(a => a.key).join() === 'confirm,reject')
check('was schon eingereicht ist, bietet keine Aktion', QUEST_ACTIONS.eingereicht.length === 0)

// Formatierer.
check('Entfernung unter 1 km in Metern', fmtDistanz(420) === '420 m')
check('Entfernung darueber in Kilometern', fmtDistanz(2100) === '2.1 km')
check('ohne Entfernung bleibt die Zeile leer', fmtDistanz(undefined) === '')
const jetzt = 1_000_000
check('Frist in Minuten', fmtFrist(jetzt + 25 * 60_000, jetzt) === '25 min')
check('Frist in Stunden', fmtFrist(jetzt + 5 * 3600_000, jetzt) === '5 h')
check('Frist in Tagen', fmtFrist(jetzt + 3 * 86400_000, jetzt) === '3 T')
check('verstrichene Frist wird benannt', fmtFrist(jetzt - 1000, jetzt) === 'abgelaufen')
check('ohne Frist bleibt die Zeile leer', fmtFrist(null) === '')
check('Belohnung mit Steigerung', fmtBelohnung({ belohnung: { anzahl: 3, was: 'Diamant', steigt: 1 } })
  === '3× Diamant · +1/Tag solange offen')
check('„Abnehmer" kommt in der Belohnungszeile nicht mehr vor',
  !/Abnehmer/.test(fmtBelohnung({ belohnung: { anzahl: 3, was: 'Diamant', steigt: 1 } })))
check('Belohnung ohne Steigerung', fmtBelohnung({ belohnung: { anzahl: 2, was: 'Diamant' } }) === '2× Diamant')
check('ohne Belohnung ehrlich benannt', fmtBelohnung({}) === 'ohne Belohnung')

// setQuests ersetzt den Bestand und raeumt eine offene Detailansicht auf.
const panel2 = Object.create(QuestPanel.prototype)
panel2._quests = [mkQuest('alt', 'offen', 1)]
panel2._detail = 'alt'
panel2._open = false
panel2._badgeEl = null
panel2.setQuests([mkQuest('neu', 'pruefung', 1)])
check('setQuests ersetzt den Bestand', panel2._quests.length === 1 && panel2._quests[0].id === 'neu')
check('Detailansicht eines verschwundenen Auftrags wird geschlossen', panel2._detail === null)

// Regression: der Sichtbarkeits-Aufruf stand einmal in _wireAccessories, wo das
// Panel noch gar nicht existierte — die Shell brach beim Start ab und der
// 3D-Reiter liess sich nicht mehr oeffnen. Aufträge sind jetzt in JEDER
// Ansicht erreichbar, also darf switchTo() sie gar nicht mehr umschalten.
{
  const quelle = readFileSync(new URL('../client/core/MobileShell.js', import.meta.url), 'utf8')
  const initTeil = quelle.slice(0, quelle.indexOf('this._questPanel = new QuestPanel'))
  check('kein Zugriff auf das Quest-Panel, bevor es existiert',
    !/_questPanel[?.]*\.setVisible/.test(initTeil))
  check('switchTo schaltet den Auftrags-Knopf nicht mehr um',
    !/switchTo[\s\S]{0,2000}_questPanel/.test(quelle.slice(quelle.indexOf('switchTo(tabId)'))))
}

// ── QuestEditor: Sperren und Pruefung ────────────────────────────────────
// Zwei Dinge entscheiden hier ueber Vertrauen: Was darf man aendern, nachdem
// jemand zugesagt hat — und was laesst sich veroeffentlichen. Eine Ausschreibung
// nachtraeglich zu kuerzen waere Wortbruch, ein Auftrag ohne Aufgabe unbrauchbar.
console.log('\n── QuestEditor: Sperren und Prüfung')
const { sperrenFuer, pruefeAuftrag, LEER_AUFTRAG, ABNAHME, NACHWEIS, SICHTBARKEIT } =
  await import('../client/core/QuestEditor.js')
const { karmaStufe, karmaFortschritt, karmaLabel, KARMA_WAHL, KARMA_PRO_STUFE, KARMA_MAX_STUFE } =
  await import('../client/core/karma.js')

const entwurf = sperrenFuer('entwurf')
check('Entwurf ist frei bearbeitbar', entwurf.gesperrt.length === 0 && entwurf.schreibbar)
const offen = sperrenFuer('offen')
check('veröffentlicht bleibt bearbeitbar', offen.gesperrt.length === 0 && !!offen.hinweis)
for (const st of ['angenommen', 'eingereicht', 'pruefung']) {
  const sp = sperrenFuer(st)
  check(`„${st}": Aufgabe und Belohnung gesperrt`,
    sp.gesperrt.includes('text') && sp.gesperrt.includes('belohnung'))
  check(`„${st}": Frist bleibt änderbar`, !sp.gesperrt.includes('fristMs') && sp.schreibbar)
}
for (const st of ['erledigt', 'abgelaufen']) {
  const sp = sperrenFuer(st)
  check(`„${st}": nur noch lesen`, sp.gesperrt.includes('*') && !sp.schreibbar)
}
check('jeder gesperrte Stand erklärt sich',
  ['angenommen', 'erledigt', 'offen'].every(st => typeof sperrenFuer(st).hinweis === 'string'))

const gut = { ...LEER_AUFTRAG(), titel: 'Müll sammeln', kurz: 'Uferweg', text: 'Einen Sack füllen.' }
check('vollständiger Auftrag wird angenommen', pruefeAuftrag(gut).length === 0)
check('ohne Titel abgelehnt', pruefeAuftrag({ ...gut, titel: '' }).length === 1)
check('ohne Aufgabe abgelehnt', pruefeAuftrag({ ...gut, text: '  ' }).length === 1)
check('überlanger Titel abgelehnt', pruefeAuftrag({ ...gut, titel: 'x'.repeat(81) }).length === 1)
check('negative Belohnung abgelehnt',
  pruefeAuftrag({ ...gut, belohnung: { anzahl: -1, was: 'Diamant' } }).length === 1)
check('Belohnung 0 ist erlaubt',
  pruefeAuftrag({ ...gut, belohnung: { anzahl: 0, was: 'Diamant' } }).length === 0)
check('Schwarm ohne sinnvolle Zahl abgelehnt',
  pruefeAuftrag({ ...gut, abnahme: 'schwarm', schwarmZahl: 0 }).length === 1)
check('Schwarm mit 3 Bestätigungen geht',
  pruefeAuftrag({ ...gut, abnahme: 'schwarm', schwarmZahl: 3 }).length === 0)
check('Regionsliste verlangt eine Kurzbeschreibung',
  pruefeAuftrag({ ...gut, kurz: '', sichtbarkeit: 'region' }).length === 1)
check('privat geht ohne Kurzbeschreibung',
  pruefeAuftrag({ ...gut, kurz: '', sichtbarkeit: 'privat' }).length === 0)
check('mehrere Mängel werden alle genannt',
  pruefeAuftrag({ ...LEER_AUFTRAG(), sichtbarkeit: 'region' }).length >= 3)

check('Abnahmeverfahren sind vollständig beschrieben',
  ABNAHME.every(a => a.key && a.label && a.hinweis))
check('Nachweisarten sind erklärt, nicht nur benannt',
  NACHWEIS.every(n => n.key && n.label && n.hinweis && n.hinweis.length > 30))
check('„Anwesenheit" sagt, wer bestätigt und wie belastbar das ist',
  /Bearbeiter/.test(NACHWEIS.find(n => n.key === 'vorOrt').hinweis) &&
  /nicht fälschungssicher/.test(NACHWEIS.find(n => n.key === 'vorOrt').hinweis))
check('Sichtbarkeit reicht von privat bis Region',
  SICHTBARKEIT.map(v => v.key).join() === 'privat,gruppe,region')
check('neuer Auftrag startet als Entwurf und gehört mir',
  LEER_AUFTRAG().status === 'entwurf' && LEER_AUFTRAG().meine === true)
check('neuer Auftrag stellt keine Karma-Bedingung', LEER_AUFTRAG().karma === 0)

// ── Karma ────────────────────────────────────────────────────────────────
// Zwei Eigenschaften sind Absicht und sollen so bleiben: Wer neu ist, steht bei
// 0 statt im Minus, und die Stufe deckelt bei 5 statt weiterzulaufen.
check('ohne Punkte Stufe 0', karmaStufe(0) === 0 && karmaStufe(undefined) === 0)
check('negative Punkte kippen nicht ins Minus', karmaStufe(-50) === 0)
check(`${KARMA_PRO_STUFE} Punkte sind Stufe 1`, karmaStufe(KARMA_PRO_STUFE) === 1)
check('knapp darunter noch Stufe 0', karmaStufe(KARMA_PRO_STUFE - 1) === 0)
check('Stufe deckelt bei 5', karmaStufe(9999) === KARMA_MAX_STUFE)
const f = karmaFortschritt(KARMA_PRO_STUFE + 5)
check('Fortschritt zeigt Stufe und Rest', f.stufe === 1 && f.inStufe === 5 && f.bisNaechste === 15)
check('Fortschritt in Prozent', f.prozent === 25)
check('auf der Höchststufe ist nichts mehr offen',
  karmaFortschritt(9999).max === true && karmaFortschritt(9999).bisNaechste === 0)
check('Beschriftung als Bedingung nennt „ab"', karmaLabel(3, { alsBedingung: true }) === 'ab Karma 3')
check('ohne Bedingung heißt es „egal"', /egal/.test(karmaLabel(0, { alsBedingung: true })))
check('Auswahlliste deckt 0 bis 5 ab',
  KARMA_WAHL.length === KARMA_MAX_STUFE + 1 && KARMA_WAHL[0].stufe === 0)

// Eigene Ausschreibungen gehören unter „Meine", nie unter „Verfügbar".
const qp2 = Object.create(QuestPanel.prototype)
qp2._quests = [
  { id: 'fremd', status: 'offen', distanzM: 1 },
  { id: 'eigen', status: 'offen', distanzM: 1, meine: true },
  { id: 'eigenEntwurf', status: 'entwurf', distanzM: 1, meine: true },
]
check('eigener Auftrag steht nicht unter „Verfügbar"',
  qp2.questsIn('verfuegbar').map(x => x.id).join() === 'fremd')
check('eigene Aufträge stehen unter „Meine"', qp2.questsIn('meine').length === 2)

// ── Karma-Anzeige: Sterne und Fortschritt ────────────────────────────────
// Die Anzeige soll die Rechnung offenlegen statt ein Gefuehl zu erzeugen:
// Stufe als Sterne, darunter Ist- und Zielpunktzahl.
console.log('\n── Karma-Anzeige')
{
  const { karmaSterne, renderKarma, KARMA_MAX_STUFE } = await import('../client/core/karma.js')
  check('keine Punkte: fuenf leere Sterne', karmaSterne(0) === '☆☆☆☆☆')
  check('Stufe 3 zeigt drei gefuellte', karmaSterne(3) === '★★★☆☆')
  check('Hoechststufe zeigt fuenf gefuellte', karmaSterne(KARMA_MAX_STUFE) === '★★★★★')
  check('Sterne sind immer fuenf', [0, 1, 2, 3, 4, 5, 9].every(n => [...karmaSterne(n)].length === 5))

  const box = document.createElement('div')
  renderKarma(box, 63)
  const txt = box.innerHTML
  check('Ist-Punktestand steht in der Anzeige', txt.includes('>63<'))
  check('Ziel der naechsten Stufe steht daneben', txt.includes('>80<'))
  check('Fortschritt als Balkenbreite', /width:15%/.test(txt))
  check('Restweg wird benannt', /17 Punkte bis Karma 4/.test(txt))
  check('und woher Karma kommt', /durch das Erledigen von Aufträgen auf diesem Server/.test(txt))
  const voll = document.createElement('div')
  renderKarma(voll, 200)
  check('auf der Hoechststufe kein Restweg', /Höchste Stufe/.test(voll.innerHTML))
  check('und der Balken ist voll', /width:100%/.test(voll.innerHTML))
}

// Regression: die Serverliste trug zuletzt fuenf Knoepfe und die
// Standort-Freigabe je Zeile. Beides liegt jetzt im Server-Profil.
{
  const sd = readFileSync(new URL('../client/core/ServerDialog.js', import.meta.url), 'utf8')
  check('Serverzeile hat keine Standort-Auswahl mehr', !/sd-privacy/.test(sd))
  check('Serverzeile hat keine Verwaltungsknöpfe mehr',
    !/sd-rename|sd-remove|sd-set-default/.test(sd))
  check('Serverzeile führt ins Profil', /sd-details/.test(sd))
  const sp = readFileSync(new URL('../client/core/ServerProfile.js', import.meta.url), 'utf8')
  check('Profil trägt Karma, Freigabe und Verwaltung',
    /renderKarma/.test(sp) && /privacy\.setLevel/.test(sp) &&
    /renameServer/.test(sp) && /removeServer/.test(sp))
}

// Karma wird an ZWEI Stellen gerechnet: im Browser-Modul und in der Goja-VM
// des Servers (pb_hooks/karma.js, ohne Bundler). Laufen die Konstanten
// auseinander, zeigte die Oberflaeche eine andere Stufe als der Server verlangt.
{
  const serverKarma = readFileSync(new URL('../pocketbase/pb_hooks/karma.js', import.meta.url), 'utf8')
  const zahl = (name) => {
    const m = serverKarma.match(new RegExp('const ' + name + ' = (' + '\\' + 'd+)'))
    return m ? Number(m[1]) : null
  }
  check(`Punkte je Stufe stimmen ueberein (${KARMA_PRO_STUFE})`, zahl('KARMA_PRO_STUFE') === KARMA_PRO_STUFE)
  check(`hoechste Stufe stimmt ueberein (${KARMA_MAX_STUFE})`, zahl('KARMA_MAX_STUFE') === KARMA_MAX_STUFE)
  check('Server schreibt Karma nur selbst gut',
    /karma_points/.test(readFileSync(new URL('../pocketbase/pb_hooks/main.pb.js', import.meta.url), 'utf8')))

  // Die Client-Tabelle ERKLAERT nur, ausgezahlt wird serverseitig. Eine
  // Beschriftung, die etwas verspricht, das der Server nicht gutschreibt, ist
  // schlimmer als gar keine — genau das war beim Stichproben-Bonus der Fall:
  // „+2" stand in der Tabelle und wurde nie gezahlt.
  const { KARMA_GUTSCHRIFT, KARMA_ABZUG } = await import('../client/core/karma.js')
  const g = Object.fromEntries(KARMA_GUTSCHRIFT.map(x => [x.grund, x.punkte]))
  check(`Abschluss stimmt ueberein (${zahl('PUNKTE_ABSCHLUSS')})`,
    zahl('PUNKTE_ABSCHLUSS') === g['Auftrag erledigt'])
  check(`Abnahme-Bonus stimmt ueberein (${zahl('PUNKTE_ABNAHME_BONUS')})`,
    zahl('PUNKTE_ABNAHME_BONUS') === g['Erledigung von jemandem abgenommen'])
  check(`Pruefer-Gutschrift stimmt ueberein (${zahl('PUNKTE_PRUEFER')})`,
    zahl('PUNKTE_PRUEFER') === g['Abnahme für andere übernommen'])
  check('der geprüfte Weg bleibt bei 5 Punkten',
    zahl('PUNKTE_ABSCHLUSS') + zahl('PUNKTE_ABNAHME_BONUS') === 5)
  check('eine abgelehnte Abnahme kostet nichts',
    !/karmaAendern\([^)]*-\d/.test(serverKarma)
    && !KARMA_ABZUG.some(a => /abgelehnt|Ablehnung/i.test(a.grund)))
  check('nur menschliche Abnahmewege bekommen den Bonus',
    /issuer[\s\S]{0,60}agent[\s\S]{0,60}group[\s\S]{0,60}crowd/.test(
      serverKarma.slice(serverKarma.indexOf('function menschlicheAbnahme'))))
}

// ── questMapping: Server-Auftrag ↔ Anzeige ───────────────────────────────
// Zwischen Server und Fenster liegt eine Übersetzung mit eigenen Regeln:
// derselbe Auftrag heisst für den Bearbeiter „wird geprüft" und für den Prüfer
// „zu prüfen". Genau solche Rollenfragen prüfen sich hier ohne Server.
console.log('\n── questMapping: Zustände und Zuordnung')
{
  const qm = await import('../client/core/questMapping.js')
  const ICH = 'u_ich', ANDER = 'u_ander'

  const rec = (extra = {}) => ({
    id: 'c1', name: 'Ufer säubern', owner: ANDER, status: 'open',
    published: true, verify: 'items', ...extra,
  })

  // ── Zustand hängt an der Rolle ─────────────────────────────────────────
  check('offener fremder Auftrag ist „offen"',
    qm.ansichtsStatus(rec(), ICH) === 'offen')
  check('nach Wartezeit gelistet heisst „angeboten"',
    qm.ansichtsStatus(rec({ angeboten: true }), ICH) === 'angeboten')
  check('von mir angenommen heisst „angenommen"',
    qm.ansichtsStatus(rec({ status: 'claimed', claimedBy: ICH }), ICH) === 'angenommen')
  check('eingereicht sieht der BEARBEITER als „wird geprüft"',
    qm.ansichtsStatus(rec({ status: 'pending', claimedBy: ICH }), ICH) === 'eingereicht')
  check('derselbe Auftrag ist für den PRÜFER „zu prüfen"',
    qm.ansichtsStatus(rec({ status: 'pending', claimedBy: ANDER, canVerify: true }), ICH) === 'pruefung')
  check('erledigt bleibt erledigt',
    qm.ansichtsStatus(rec({ status: 'done' }), ICH) === 'erledigt')
  check('abgelaufen bleibt abgelaufen',
    qm.ansichtsStatus(rec({ status: 'expired' }), ICH) === 'abgelaufen')
  check('nie veröffentlichter eigener Auftrag ist ein Entwurf',
    qm.ansichtsStatus(rec({ owner: ICH, mine: true, published: false }), ICH) === 'entwurf')
  check('veröffentlichter eigener Auftrag ist kein Entwurf',
    qm.ansichtsStatus(rec({ owner: ICH, mine: true, published: true }), ICH) === 'offen')

  // Der Aussteller nimmt bei der Stichprobe selbst ab — sein eigener Auftrag
  // muss dann unter „Prüfen" auftauchen, nicht nur unter „Meine".
  check('eigener Auftrag mit Einreichung steht auf „zu prüfen"',
    qm.ansichtsStatus(rec({ owner: ICH, mine: true, status: 'pending', claimedBy: ANDER, canVerify: true }), ICH) === 'pruefung')

  // ── Sichtbar ist nicht dasselbe wie relevant ───────────────────────────
  check('fremd angenommener Auftrag geht mich nichts an',
    qm.istRelevant(rec({ status: 'claimed', claimedBy: ANDER }), ICH) === false)
  check('… es sei denn, ich soll ihn abnehmen',
    qm.istRelevant(rec({ status: 'pending', claimedBy: ANDER, canVerify: true }), ICH) === true)
  check('eigene Aufträge immer', qm.istRelevant(rec({ owner: ICH }), ICH) === true)
  check('offene Aufträge immer', qm.istRelevant(rec(), ICH) === true)

  // ── Abnahmewege in beide Richtungen ────────────────────────────────────
  check('Stichprobe ist der Aussteller', qm.ABNAHME_ZU_VERIFY.stichprobe === 'issuer')
  check('Prüfgruppe ist eine Gruppe', qm.ABNAHME_ZU_VERIFY.pruefgruppe === 'group')
  check('Schwarm ist die Menge', qm.ABNAHME_ZU_VERIFY.schwarm === 'crowd')
  check('Übergabe prüft der Server', qm.ABNAHME_ZU_VERIFY.uebergabe === 'items')
  check('„agent" bleibt lesbar als Stichprobe', qm.VERIFY_ZU_ABNAHME.agent === 'stichprobe')
  check('„issuer" ebenso', qm.VERIFY_ZU_ABNAHME.issuer === 'stichprobe')
  for (const [k, v] of Object.entries(qm.ABNAHME_ZU_VERIFY)) {
    check(`Rückweg für „${k}" führt zurück`, qm.VERIFY_ZU_ABNAHME[v] === k)
  }

  check('Schwarm nennt den Stand',
    qm.pruefungText({ verify: 'crowd', votesNeeded: 3, votes: { ja: 2 } }) === 'Schwarm — 2 von 3 Bestätigungen')
  check('ohne Stimmen nennt er die Hürde',
    /3 Bestätigungen nötig/.test(qm.pruefungText({ verify: 'crowd', votesNeeded: 3 })))

  // ── Ganzer Datensatz ───────────────────────────────────────────────────
  const v = qm.zuAnsicht(rec({
    kurz: 'Ein Sack reicht.', task: 'Uferweg säubern', ort: 'Bootshaus',
    distanceM: 420, deadline: new Date(Date.now() + 3600_000).toISOString(),
    ownerName: 'Stadtreinigung', rewardParts: [{ was: 'Diamant', anzahl: 3 }],
    steigt: 1, nachweis: ['foto'], karmaRequired: 2, karmaOk: false,
  }), ICH)
  check('Titel kommt aus dem Objektnamen', v.titel === 'Ufer säubern')
  check('Kurztext und Aufgabe getrennt', v.kurz === 'Ein Sack reicht.' && v.text === 'Uferweg säubern')
  check('Aussteller mit Namen statt Konto-ID', v.quelle === 'Stadtreinigung')
  check('Frist als Zeitstempel', Number.isFinite(v.frist) && v.frist > Date.now())
  check('Belohnung mit Gattung', v.belohnung.teile[0].was === 'Diamant' && v.belohnung.anzahl === 3)
  check('Steigerung übernommen', v.belohnung.steigt === 1)
  check('Nachweis als Klartext', v.anforderungen.includes('Vorher-/Nachher-Foto'))
  check('Karma-Bedingung durchgereicht', v.karma === 2 && v.karmaOk === false)
  check('Rohsatz bleibt für die Aktionen erhalten', v.roh?.verify === 'items')

  check('geforderte Gegenstände stehen dabei, auch ohne Haken',
    qm.anforderungenAus([], 2).length === 1)

  const liste = qm.listeZuAnsicht([
    rec({ id: 'a' }),
    rec({ id: 'b', status: 'claimed', claimedBy: ANDER }),   // fremd belegt
    rec({ id: 'c', owner: ICH, mine: true }),
  ], ICH)
  check('Liste lässt Fremdbelegtes weg', liste.map(x => x.id).join() === 'a,c')

  // ── Editor-Richtung ────────────────────────────────────────────────────
  const f = qm.zuFormular(v, { jetzt: Date.now(), sichtbarkeit: 'gruppe', sichtbarGruppe: 'g1' })
  check('Frist wird als Restdauer angeboten', f.fristMs > 0 && f.fristMs <= 3600_000)
  check('Sichtbarkeit kommt von aussen', f.sichtbarkeit === 'gruppe' && f.sichtbarGruppe === 'g1')
  check('Verfahren rückübersetzt', f.abnahme === 'uebergabe')

  const c = qm.callZustandAus({
    text: 'Tun', kurz: 'kurz', ort: 'dort', karma: 3, nachweis: ['vorOrt'],
    abnahme: 'schwarm', schwarmZahl: 12, fristMs: 3600_000, anbietenNachH: 6,
    belohnung: { steigt: 2 },
  }, { jetzt: 1_000_000 })
  check('Aufgabe landet in task', c.task === 'Tun')
  check('Frist wird zum Zeitpunkt', c.deadline === new Date(1_000_000 + 3600_000).toISOString())
  check('Schwarmzahl bleibt im sinnvollen Bereich', c.schwarmZahl === 9)
  check('Wartezeit heisst: zunächst nicht listen', c.listed === false && c.anbietenNachH === 6)
  check('ohne Wartezeit sofort gelistet', qm.callZustandAus({ anbietenNachH: 0 }).listed === true)
  check('ohne Frist keine Frist im Datensatz', qm.callZustandAus({ fristMs: 0 }).deadline === undefined)
  check('Schwarmzahl nur beim Schwarm',
    qm.callZustandAus({ abnahme: 'stichprobe', schwarmZahl: 3 }).schwarmZahl === undefined)
  check('bestehende Felder bleiben erhalten',
    qm.callZustandAus({ text: 'neu' }, { vorher: { rewardItems: ['i1'] } }).rewardItems[0] === 'i1')

  const pl = qm.publishPayloadAus({ abnahme: 'pruefgruppe', pruefgruppe: 'g9' }, ['i1', 'i2'])
  check('Prüfgruppe geht als group hinaus', pl.verify === 'group' && pl.pruefgruppe === 'g9')
  check('Belohnungen als Kennungen', pl.rewardItems.join() === 'i1,i2')
  check('ohne Gruppe keine Gruppe im Rumpf',
    qm.publishPayloadAus({ abnahme: 'schwarm' }, ['i1']).pruefgruppe === undefined)

  // ── Inventar und Belohnungswahl ────────────────────────────────────────
  const objekte = [
    { id: 'i1', type: 'item', name: 'Diamant', carried_by: ICH, state: {} },
    { id: 'i2', type: 'item', name: 'Diamant', carried_by: ICH, state: {} },
    { id: 'i3', type: 'item', name: 'Diamant', carried_by: ICH, state: { escrow: { call: 'c9' } } },
    { id: 'i4', type: 'item', name: 'Talisman', carried_by: ICH, state: {} },
    { id: 'i5', type: 'item', name: 'Diamant', carried_by: ANDER, state: {} },
    { id: 'i6', type: 'npc', name: 'Diamant', carried_by: ICH, state: {} },
  ]
  const inv = qm.inventarAus(objekte, ICH)
  const diamant = inv.find(i => i.was === 'Diamant')
  check('gebundene und fremde Stücke zählen nicht mit', diamant.vorrat === 2)
  check('nur Gegenstände, keine Figuren', inv.length === 2)
  check('eigene Treuhand darf mitzählen',
    qm.inventarAus(objekte, ICH, { callId: 'c9' }).find(i => i.was === 'Diamant').vorrat === 3)

  check('Belohnung wird aus dem Bestand belegt',
    qm.waehleBelohnung(inv, 'Diamant', 2).ids.length === 2)
  check('fehlender Vorrat wird beziffert',
    qm.waehleBelohnung(inv, 'Diamant', 5).fehlt === 3)
  check('unbekannte Gattung fehlt vollständig',
    qm.waehleBelohnung(inv, 'Einhorn', 1).fehlt === 1)
}

// ── QuestPanel: Ladezustand und Prüfen-Reiter ────────────────────────────
console.log('\n── QuestPanel: Anbindung')
{
  const { QuestPanel } = await import('../client/core/QuestPanel.js')
  const p = Object.create(QuestPanel.prototype)
  p._quests = [
    { id: 'eigen', status: 'pruefung', meine: true, distanzM: 5 },
    { id: 'fremd', status: 'pruefung', meine: false, distanzM: 9 },
  ]
  check('eigener Auftrag mit Einreichung steht unter „Prüfen"',
    p.questsIn('pruefen').map(x => x.id).join() === 'eigen,fremd')
  check('und weiterhin unter „Meine"', p.questsIn('meine').length === 1)
  check('Zähler am Auslöser meldet beide', p.offeneP === 2)

  // Leere Liste heisst „nichts zu tun" — solange nichts geladen wurde, waere
  // das eine Behauptung ueber Daten, die es nicht gibt.
  p._quests = []
  p._tab = 'verfuegbar'
  p._laedt = true
  check('waehrend des Ladens sagt der Panel das auch', /geladen/.test(p._leerText()))
  p._laedt = false
  p._fehler = 'Netz weg'
  check('bei einem Fehler behauptet er nicht „nichts zu tun"', !/nichts zu tun/.test(p._leerText()))
  p._fehler = null
  p._gefuellt = false
  p.onReload = () => {}
  check('vor der ersten Antwort ebenso', !/nichts zu tun/.test(p._leerText()))
  p._gefuellt = true
  check('danach die normale Auskunft', /nichts zu tun/.test(p._leerText()))
}

// ── Auftrags-Anbindung: die Nähte sind wirklich verdrahtet ───────────────
// Der Panel meldete frueher nur in den Verlauf, dass eine Aktion folgenlos
// bleibt. Das darf nicht zurueckkommen, ohne dass es auffaellt.
console.log('\n── Aufträge: Anbindung verdrahtet')
{
  const shell = readFileSync(new URL('../client/core/MobileShell.js', import.meta.url), 'utf8')
  check('Panel bekommt eine Aktions-Naht', /onAction:\s*\(q, aktion, extra\)/.test(shell))
  check('Panel bekommt einen Lader', /onReload:\s*\(\)\s*=>\s*this\._questsLaden\(\)/.test(shell))
  check('Editor speichert wirklich', /onSave:\s*\(f\)\s*=>\s*this\._questSpeichern/.test(shell))
  check('Editor veröffentlicht wirklich', /onPublish:\s*\(f\)\s*=>\s*this\._questSpeichern\(f, true\)/.test(shell))
  check('kein Demo-Bestand mehr im Panel',
    !/DEMO\(\)/.test(readFileSync(new URL('../client/core/QuestPanel.js', import.meta.url), 'utf8')))

  const dienst = readFileSync(new URL('../client/core/QuestService.js', import.meta.url), 'utf8')
  check('Aufgeben nutzt den eigenen Weg, nicht die Ablehnung des Ausstellers',
    /abandon.*abandonQuest/s.test(dienst))
  check('Schwarm-Stimme geht auf die Bestätigungs-Route',
    /verify === 'crowd'[\s\S]{0,200}confirmQuest/.test(dienst))

  const hooks = readFileSync(new URL('../pocketbase/pb_hooks/main.pb.js', import.meta.url), 'utf8')
  check('Server kennt das Zurückgeben', /quest\/abandon/.test(hooks))
  check('und lässt eine laufende Abnahme nicht abbrechen',
    /under review/.test(hooks))
}

// ── Nachweis „Foto": Hinweis auf die fehlende Funktion ──────────────
// Der Bild-Upload gibt es noch nicht. Wer die Art trotzdem in seinen Auftrag
// schreibt, soll das erfahren — aber erst dann, nicht als Dauerwarnung.
console.log('\n── Nachweis: fehlende Funktion benannt')
{
  const { OHNE_FUNKTION, NACHWEIS } = await import('../client/core/QuestEditor.js')
  check('Foto ist als noch nicht umgesetzt vermerkt',
    /[Nn]icht implementiert/.test(OHNE_FUNKTION.foto || ''))
  check('die anderen Nachweisarten funktionieren',
    !OHNE_FUNKTION.vorOrt && !OHNE_FUNKTION.gegenstand)
  check('jeder Vermerk gehoert zu einer echten Nachweisart',
    Object.keys(OHNE_FUNKTION).every(k => NACHWEIS.some(n => n.key === k)))

  const quelle = readFileSync(new URL('../client/core/QuestEditor.js', import.meta.url), 'utf8')
  check('Hinweis erscheint nur bei gesetztem Haken',
    /an && OHNE_FUNKTION\[n\.key\]/.test(quelle))
  check('Haken zeichnet neu, sonst bliebe der Hinweis aus',
    /\[data-n\][\s\S]{0,160}this\._lese\(\); this\._render\(\)/.test(quelle))

  const panel = readFileSync(new URL('../client/core/QuestPanel.js', import.meta.url), 'utf8')
  check('auch der Bearbeiter erfaehrt es beim Melden',
    /nicht implementiert[\s\S]{0,80}hochladen/i.test(panel))
}

// ── Auftrag anlegen: ein Fenster statt zwei ──────────────────────────────
// „Aufgabe", „Prüfung", „Wiederholbar", Forderungen und Belohnung standen im
// Objekt-Editor UND im Auftrags-Fenster. Zwei Formulare für eine Sache sind
// nicht nur überladen: Das Speichern im Objekt-Editor baute `state.call` aus
// SEINEN Feldern neu auf und warf dabei alles weg, was es nicht kannte.
console.log('\n── Auftrag: nur noch ein Formular')
{
  const ed = readFileSync(new URL('../client/core/EditorUI.js', import.meta.url), 'utf8')
  for (const feld of ['callTask', 'callVerify', 'callRepeatable', 'callRewardPerRun',
                      'call-requires', 'call-reward-picker', 'call-publish']) {
    check(`„${feld}" steht nicht mehr im Objekt-Editor`, !ed.includes(feld))
  }
  check('der Knopf ins Auftrags-Fenster bleibt', /data-action="quest-editor"/.test(ed))
  check('Speichern fasst state.call nicht mehr an',
    /_mergeCallFields\(state\)[\s\S]{0,600}state\.call = owned/.test(ed))
  check('und baut ihn nicht mehr aus Formularfeldern neu auf',
    !/call\.task = /.test(ed) && !/call\.verify = /.test(ed))
}

// ── QuestEditor: Wiederholbarkeit und Forderungen ────────────────────────
console.log('\n── Auftrags-Editor: Wiederholbarkeit und Forderungen')
{
  const { pruefeAuftrag, LEER_AUFTRAG, QuestEditor } =
    await import('../client/core/QuestEditor.js')

  const gut = () => ({ ...LEER_AUFTRAG(), titel: 'T', text: 'A', kurz: 'K',
                       belohnung: { anzahl: 3, was: 'Diamant', steigt: 0 } })

  check('ein einfacher Auftrag geht durch', pruefeAuftrag(gut()).length === 0)
  check('Wiederholbar ohne Vorrat wird beanstandet',
    pruefeAuftrag({ ...gut(), wiederholbar: true, proDurchlauf: 4 })
      .some(f => /hinterlegt/.test(f)))
  check('passt der Vorrat, geht es durch',
    pruefeAuftrag({ ...gut(), wiederholbar: true, proDurchlauf: 3 }).length === 0)
  check('Forderung ohne Gattung wird beanstandet',
    pruefeAuftrag({ ...gut(), forderungen: [{ name: '  ', anzahl: 2 }] })
      .some(f => /Gattung/.test(f)))
  check('mit Gattung geht sie durch',
    pruefeAuftrag({ ...gut(), forderungen: [{ name: 'Wolfsfell', anzahl: 2 }] }).length === 0)

  // Veroeffentlichen bindet die Treuhand — aus dem Objekt-Editor heraus wird
  // nur bearbeitet.
  const knoepfe = (opts) => {
    const e = Object.create(QuestEditor.prototype)
    e._q = { ...LEER_AUFTRAG(), status: 'entwurf' }
    e._veroeffentlichen = opts.veroeffentlichen
    const gesammelt = []
    e._aktionenEl = {
      set innerHTML(html) { gesammelt.push(html) },
      querySelectorAll: () => [],
    }
    e._renderAktionen({ schreibbar: true, gesperrt: [] })
    return gesammelt.join('')
  }
  check('beim Anlegen gibt es „Veröffentlichen"',
    /Veröffentlichen/.test(knoepfe({ veroeffentlichen: true })))
  check('aus dem Objekt-Editor heraus nicht',
    !/Veröffentlichen/.test(knoepfe({ veroeffentlichen: false })))
  check('gespeichert wird in beiden Fällen',
    /Speichern/.test(knoepfe({ veroeffentlichen: false })))
}

// ── Kontextmenü: „Auftrag hier erzeugen" ─────────────────────────────────
// Bewusst NICHT über den World-Director wie Monster und Tier: Der Auftrag
// gehoert dem Spieler, sonst koennte der Aussteller ihn weder aendern noch
// abnehmen. Und bewusst direkt ins Auftrags-Fenster statt in den Objekt-Editor.
console.log('\n── Kontextmenü: Auftrag hier erzeugen')
{
  const { directorSpawnItems, questSpawnItem } = await import('../client/core/SpawnHere.js')

  const gesendet = []
  const eintraege = directorSpawnItems({
    ajna: { sendAgentCommand: async (...a) => { gesendet.push(a); return { delivered: 1 } } },
    position: { lat: 50.4, lon: 7.5 }, enabled: true,
  })
  const auftrag = eintraege.find(e => /Auftrag/.test(e.label))
  check('der Eintrag steht im Menü', !!auftrag)
  check('und heisst wie die anderen', auftrag.label === 'Auftrag hier erzeugen')
  check('Monster laeuft weiterhin über den Director',
    eintraege.some(e => e.label === 'Monster hier erzeugen'))

  // Der Auftrag darf NICHT beim Director landen.
  const vorher = gesendet.length
  const gerufen = []
  globalThis.window = globalThis.window || {}
  window.ajnaQuestEditor = (rec, pos) => gerufen.push({ rec, pos })
  auftrag.onClick()
  check('er geht nicht an den World-Director', gesendet.length === vorher)
  check('sondern öffnet das Auftrags-Fenster', gerufen.length === 1)
  check('ohne bestehenden Auftrag', gerufen[0].rec === null)
  check('mit der angeklickten Stelle',
    gerufen[0].pos.lat === 50.4 && gerufen[0].pos.lon === 7.5)

  // Ohne Fenster (z. B. Ansicht ohne Shell) darf nichts still passieren.
  delete window.ajnaQuestEditor
  const meldungen = []
  questSpawnItem({ position: { lat: 1, lon: 2 }, notify: m => meldungen.push(m) }).onClick()
  check('fehlt das Fenster, wird das gesagt', meldungen.length === 1)

  for (const datei of ['map.js', 'main.js']) {
    const q = readFileSync(new URL('../client/' + datei, import.meta.url), 'utf8')
    check(`${datei} bindet die Menüeinträge gemeinsam ein`, /directorSpawnItems\(/.test(q))
  }
}

// ── Forderungen: Hin- und Rückweg ────────────────────────────────────────
console.log('\n── Forderungen übersetzen')
{
  const qm = await import('../client/core/questMapping.js')
  const zeilen = [{ name: 'Wolfsfell', anzahl: 3 }, { name: '', anzahl: 1 }]
  const specs = qm.forderungenZu(zeilen)
  check('leere Zeilen fallen weg', specs.length === 1)
  check('als Gattung, nicht als Stück', specs[0].match.name === 'Wolfsfell' && specs[0].count === 3)
  check('und zurück', qm.forderungenAus(specs)[0].anzahl === 3)
  check('unbekannte Form ergibt nichts', qm.forderungenAus(null).length === 0)

  const body = qm.publishPayloadAus(
    { abnahme: 'uebergabe', forderungen: zeilen, wiederholbar: true, proDurchlauf: 2 }, ['i1'])
  check('Forderungen gehen ans Veröffentlichen', body.requires.length === 1)
  check('Wiederholbarkeit ebenfalls', body.repeatable === true && body.rewardPerRun === 2)
  check('ohne Wiederholbarkeit steht nichts im Rumpf',
    qm.publishPayloadAus({ abnahme: 'uebergabe' }, ['i1']).repeatable === undefined)

  // Ein Entwurf geht nie durch quest/publish — ohne diese Felder im Zustand
  // waere beides zwischen Speichern und Veröffentlichen wieder weg.
  const c = qm.callZustandAus({ forderungen: zeilen, wiederholbar: true, proDurchlauf: 2 })
  check('der Entwurf behält seine Forderungen', c.requires.length === 1)
  check('und seine Wiederholbarkeit', c.repeatable === true && c.rewardPerRun === 2)
  check('abgewählt verschwindet sie wieder',
    qm.callZustandAus({ wiederholbar: false }, { vorher: c }).repeatable === undefined)
}

const failed = results.filter(r => !r.ok)
console.log(`\n${'═'.repeat(60)}`)
console.log(`UI: ${results.length - failed.length} bestanden, ${failed.length} fehlgeschlagen`)
if (failed.length) {
  console.log('\nFehlgeschlagen:')
  for (const f of failed) console.log('  ❌ ' + f.name)
  process.exit(1)
}
console.log('✅ alles grün')
