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
  check(`„${st}": Aufgabe gesperrt`, sp.gesperrt.includes('text'))
  // Erhoehen darf man immer — die Belohnung bleibt darum offen, das KUERZEN
  // weist der Server ab. Sie hier zu sperren nahm dem Aussteller die einzige
  // Moeglichkeit, einen zaeh laufenden Auftrag attraktiver zu machen.
  check(`„${st}": Belohnung bleibt erhoehbar`, !sp.gesperrt.includes('belohnung'))
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
  /GPS/.test(NACHWEIS.find(n => n.key === 'vorOrt').hinweis))
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
  // WAS ZAEHLT ALS INVENTAR: allein `carried_by`. Hier stand einmal zusaetzlich
  // `type === 'item'` — und damit fiel fast alles heraus, was man wirklich
  // traegt: Ein Diamant hat `type: 'diamond'`. Im Editor stand dann eine
  // einzige Gattung zur Wahl, obwohl das Inventar voll war.
  const objekte = [
    { id: 'i1', type: 'diamond', name: 'Diamant', carried_by: ICH, _origin: 'heim', state: {} },
    { id: 'i2', type: 'diamond', name: 'Diamant', carried_by: ICH, _origin: 'heim', state: {} },
    { id: 'i3', type: 'diamond', name: 'Diamant', carried_by: ICH, _origin: 'heim', state: { escrow: { call: 'c9' } } },
    { id: 'i4', type: 'item',    name: 'Talisman', carried_by: ICH, _origin: 'heim', state: {} },
    { id: 'i5', type: 'diamond', name: 'Diamant', carried_by: ANDER, _origin: 'heim', state: {} },
    { id: 'i6', type: 'item',    name: 'Kompass', carried_by: ICH, _origin: 'verein', state: {} },
  ]
  const inv = qm.inventarAus(objekte, ICH)
  const diamant = inv.find(i => i.was === 'Diamant')
  check('ein Diamant zaehlt zum Inventar, obwohl sein Typ nicht „item" ist', !!diamant)
  check('gebundene und fremde Stücke zählen nicht mit', diamant.vorrat === 2)
  check('alle getragenen Gattungen stehen zur Wahl', inv.length === 3)
  check('eigene Treuhand darf mitzählen',
    qm.inventarAus(objekte, ICH, { callId: 'c9' }).find(i => i.was === 'Diamant').vorrat === 3)

  // Treuhand und Tausch sind eine Transaktion EINES Servers — Gegenstaende von
  // anderswo kann er weder sperren noch uebergeben.
  const nurHeim = qm.inventarAus(objekte, ICH, { serverId: 'heim' })
  check('auf einen Server eingegrenzt fehlt Fremdes', !nurHeim.some(i => i.was === 'Kompass'))
  check('und das Eigene bleibt', nurHeim.length === 2)

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
// ── Foto-Beweis: bis zu drei Bilder, „Vorher" freiwillig ────────────────
// Als „Vorher/Nachher" gedacht war es eine Falle: Ein sauber erledigter Auftrag
// scheiterte daran, dass jemand vergessen hat, VORHER zu fotografieren.
console.log('\n── Foto-Beweis')
{
  const { OHNE_FUNKTION, NACHWEIS } = await import('../client/core/QuestEditor.js')
  check('Foto gilt nicht mehr als unfertig', !OHNE_FUNKTION.foto)
  check('die anderen Nachweisarten ebenfalls nicht',
    !OHNE_FUNKTION.vorOrt && !OHNE_FUNKTION.gegenstand)
  const foto = NACHWEIS.find(n => n.key === 'foto')
  check('drei Bilder sind angesagt', /drei/.test(foto.hinweis))
  check('und „Vorher" ist ausdruecklich keine Pflicht', /nicht Pflicht/.test(foto.hinweis))

  const { MAX_BILDER, passeGroesseAn } = await import('../client/core/BildAufbereitung.js')
  check('mehr als drei nimmt der Client gar nicht erst an', MAX_BILDER === 3)
  // Kleinere Bilder NICHT aufblasen — das braechte Dateigroesse ohne Bildinhalt.
  const klein = passeGroesseAn(800, 600, 1600)
  check('kleine Bilder bleiben, wie sie sind', klein.width === 800 && klein.height === 600)
  const gross = passeGroesseAn(4000, 3000, 1600)
  check('grosse werden auf die lange Kante gebracht', gross.width === 1600 && gross.height === 1200)
  const hoch = passeGroesseAn(3000, 4000, 1600)
  check('auch hochkant', hoch.height === 1600 && hoch.width === 1200)

  const ba = readFileSync(new URL('../client/core/BildAufbereitung.js', import.meta.url), 'utf8')
  // EXIF traegt die GPS-Koordinate. Ein Beweisfoto darf nicht liefern, was die
  // Standort-Stufe gerade zurueckhaelt.
  check('neu kodieren statt Metadaten putzen', /toBlob\([\s\S]{0,120}image\/jpeg/.test(ba))
  // Ohne das laege jedes hochkant aufgenommene Bild quer, sobald EXIF fehlt.
  check('die Ausrichtung wird vorher angewandt', /imageOrientation: 'from-image'/.test(ba))

  const panel = readFileSync(new URL('../client/core/QuestPanel.js', import.meta.url), 'utf8')
  check('das Meldeformular nimmt Bilder entgegen', /data-role="bilder"/.test(panel))
  check('und sagt, dass Metadaten entfernt werden', /Aufnahmezeit werden vor dem Senden/.test(panel))
  // Ein Auftrag, der NUR ein Foto verlangt, sprang bisher am Formular vorbei.
  check('auch ein reiner Foto-Auftrag oeffnet das Formular',
    /\(q\.roh\?\.nachweis \|\| \[\]\)\.length/.test(panel))
  check('der Pruefer bekommt die Bilder zu sehen', /_zeigeBelege\(q\)/.test(panel))

  const m = readFileSync(new URL('../pocketbase/pb_hooks/main.pb.js', import.meta.url), 'utf8')
  // Sonst koennte jemand die Kennung einer FREMDEN Einreichung mitschicken.
  check('der Server prueft, wem der Beleg gehoert', /proof_foreign/.test(m))
  check('und zu welchem Auftrag er gehoert', /proof_other_call/.test(m))
  check('ein leerer Beleg zaehlt nicht', /proof_empty/.test(m))
}

// ── Aufraeumen: Logs und Beweisbilder ───────────────────────────────────
// Gemessen: 949.489 Logzeilen in 898 MB, daneben 1,1 MB echte Daten.
console.log('\n── Aufräumen')
{
  const m = readFileSync(new URL('../pocketbase/pb_hooks/main.pb.js', import.meta.url), 'utf8')
  check('Beweisbilder werden aufgeraeumt', /cronAdd\("proof_cleanup"/.test(m))
  check('mit Schonzeit nach der Abnahme', /proof\.graceHours/.test(m))
  check('und einer harten Obergrenze', /proof\.maxAgeDays/.test(m))
  // SQLite gibt geloeschten Platz nicht von selbst zurueck.
  check('die Logdatei wird auch verdichtet', /cronAdd\("aux_vacuum"/.test(m))

  const mig = readFileSync(new URL('../pocketbase/pb_migrations/1787700000_log_retention.js', import.meta.url), 'utf8')
  check('es gibt eine Aufbewahrungsfrist', /logs\.maxDays = TAGE/.test(mig))
}

// ── Mehrsprachigkeit: t() ist nie Pflicht ───────────────────────────────
console.log('\n── Mehrsprachigkeit')
{
  const { t, einsetzen } = await import('../client/core/i18n.js')
  // Der deutsche Satz IST der Schluessel — eine nicht uebersetzte Stelle ist
  // kein Fehler, sondern einfach Deutsch.
  check('ohne Katalog kommt der Satz selbst zurueck', t('Erledigt melden') === 'Erledigt melden')
  check('Platzhalter werden eingesetzt',
    einsetzen('{n} Punkte bis Karma {stufe}.', { n: 4, stufe: 3 }) === '4 Punkte bis Karma 3.')
  check('unbekannte Platzhalter bleiben sichtbar stehen',
    einsetzen('{a} und {b}', { a: 'x' }) === 'x und {b}')

  const { inSprache, istSprachkarte, zuSprachkarte } = await import('../client/core/Sprachwahl.js')
  check('ein Text darf einfach ein Text sein', inSprache('Ein alter Brunnen.') === 'Ein alter Brunnen.')
  check('eine Sprachkarte wird erkannt', istSprachkarte({ de: 'a', en: 'b' }))
  // Sonst wuerde {lat, lon} als Sprachkarte durchgehen.
  check('eine Koordinate NICHT', !istSprachkarte({ lat: 1, lon: 2 }))
  check('die gewuenschte Sprache gewinnt', inSprache({ de: 'Brunnen', en: 'Well' }, 'en') === 'Well')
  check('Region faellt auf die Sprache zurueck', inSprache({ de: 'Brunnen' }, 'de-AT') === 'Brunnen')
  // Lieber ein fremdsprachiger Satz als ein leeres Feld.
  check('sonst irgendetwas statt nichts', inSprache({ fr: 'Puits' }, 'en') === 'Puits')
  check('Eigennamen koennen sprachunabhaengig sein', inSprache({ '*': 'Ajna' }, 'en') === 'Ajna')
  check('aus Text wird eine Karte, ohne die Herkunft zu verlieren',
    zuSprachkarte('Hallo').de === 'Hallo' && zuSprachkarte('Hallo')._quelle === 'de')

  const ir = readFileSync(new URL('../client/core/InteractionReply.js', import.meta.url), 'utf8')
  check('Beschreibungen laufen durch die Sprachwahl', /inSprache\(record\?\.description\)/.test(ir))
}

// ── Konfiguration in der Datenbank ──────────────────────────────────────
console.log('\n── Konfiguration')
{
  const k = readFileSync(new URL('../agents/lib/konfig.mjs', import.meta.url), 'utf8')
  // Eine frische Installation muss aus der .env allein laufen.
  check('die .env ist die Vorgabe, die Datenbank uebersteuert',
    k.includes('if (this._werte.has(voll))') && k.includes('const e = process.env[envName]'))
  check('Geheimnisse bleiben der Env vorbehalten', /VERBOTEN = \/\(pass\|secret\|token\|key/.test(k))
  // Ein Agent, der ohne DB-Einstellungen nicht startet, waere ein Rueckschritt.
  check('ohne Datenbank laeuft es weiter', /es gilt die \.env/.test(k))
  check('Aenderungen wirken ohne Neustart', /collection\('settings'\)\.subscribe/.test(k))

  const mig = readFileSync(new URL('../pocketbase/pb_migrations/1787500000_settings.js', import.meta.url), 'utf8')
  check('schreiben darf nur die Verwaltung', /createRule: null/.test(mig))
  check('lesen duerfen angemeldete Konten', /listRule: '@request\.auth\.id != ""'/.test(mig))
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
  check('Vorrat kleiner als die Belohnung wird beanstandet',
    pruefeAuftrag({ ...gut(), wiederholbar: true, vorrat: 2 })
      .some(f => /Vorrat/.test(f)))
  check('passt der Vorrat, geht es durch',
    pruefeAuftrag({ ...gut(), wiederholbar: true, vorrat: 9 }).length === 0)
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
    { abnahme: 'uebergabe', forderungen: zeilen, wiederholbar: true,
      belohnung: { anzahl: 2 }, vorrat: 6 }, ['i1'])
  check('Forderungen gehen ans Veröffentlichen', body.requires.length === 1)
  check('Wiederholbarkeit ebenfalls', body.repeatable === true && body.rewardPerRun === 2)
  check('ohne Wiederholbarkeit steht nichts im Rumpf',
    qm.publishPayloadAus({ abnahme: 'uebergabe' }, ['i1']).repeatable === undefined)

  // Ein Entwurf geht nie durch quest/publish — ohne diese Felder im Zustand
  // waere beides zwischen Speichern und Veröffentlichen wieder weg.
  const c = qm.callZustandAus({ forderungen: zeilen, wiederholbar: true,
                                belohnung: { anzahl: 2 }, vorrat: 6 })
  check('der Entwurf behält seine Forderungen', c.requires.length === 1)
  check('und seine Wiederholbarkeit', c.repeatable === true && c.rewardPerRun === 2)
  check('abgewählt verschwindet sie wieder',
    qm.callZustandAus({ wiederholbar: false }, { vorher: c }).repeatable === undefined)
}

// ── Belohnung vs. Vorrat ─────────────────────────────────────────────────
// Vorher hiess es „Belohnung: 2" und „Belohnung je Durchlauf: 1" — das las
// sich, als koenne die Quest zweimal abgeschlossen werden, sagte aber
// woertlich etwas anderes. Jetzt: „Belohnung" ist, was EINER bekommt,
// „Vorrat" ist, wie viel insgesamt gebunden wird.
console.log('\n── Belohnung und Vorrat')
{
  const { vorratVon, durchlaeufeVon, LEER_AUFTRAG } = await import('../client/core/QuestEditor.js')
  const qm = await import('../client/core/questMapping.js')

  const einmal = { ...LEER_AUFTRAG(), belohnung: { anzahl: 3, was: 'Diamant', steigt: 0 } }
  check('einmalig: Vorrat ist die Belohnung', vorratVon(einmal) === 3)
  check('und reicht für einen Durchlauf', durchlaeufeVon(einmal) === 1)

  const mehrfach = { ...einmal, wiederholbar: true, vorrat: 9 }
  check('wiederholbar: Vorrat steht für sich', vorratVon(mehrfach) === 9)
  check('3× Belohnung aus 9 Vorrat = 3 Durchläufe', durchlaeufeVon(mehrfach) === 3)
  check('ein zu kleiner Vorrat faellt nie unter die Belohnung',
    vorratVon({ ...einmal, wiederholbar: true, vorrat: 1 }) === 3)

  check('gebunden wird der Vorrat, nicht die Belohnung',
    qm.benoetigterVorrat(mehrfach) === 9)
  check('einmalig gebunden wird genau die Belohnung',
    qm.benoetigterVorrat(einmal) === 3)

  // Die Liste darf nicht den ganzen Vorrat als Belohnung ausweisen — sonst
  // verspricht sie das Dreifache dessen, was ausgezahlt wird.
  const v = qm.zuAnsicht({
    id: 'c1', name: 'T', owner: 'x', status: 'open', published: true,
    rewardParts: [{ was: 'Diamant', anzahl: 9 }], rewards: 9,
    repeatable: true, rewardPerRun: 3,
  }, 'ich')
  check('die Liste zeigt, was EINER bekommt', v.belohnung.anzahl === 3)
  check('und kennt den Vorrat daneben', v.belohnung.vorrat === 9)
  const f = qm.zuFormular(v)
  check('das Formular trennt beides ebenso',
    f.belohnung.anzahl === 3 && f.vorrat === 9 && f.wiederholbar === true)
}

// ── Regionsliste: „nie" ──────────────────────────────────────────────────
// `listed: false` ohne Wartezeit ist auf dem Server derselbe Zustand wie
// „noch nicht so weit" — im Formular aber eine ganz andere Aussage.
console.log('\n── Regionsliste: nie')
{
  const { ANBIETEN } = await import('../client/core/QuestEditor.js')
  const qm = await import('../client/core/questMapping.js')

  check('„nie" steht zur Wahl', ANBIETEN.some(a => a.h === -1 && /nie/i.test(a.label)))
  check('„sofort" ebenfalls', ANBIETEN.some(a => a.h === 0))

  const nie = qm.callZustandAus({ anbietenNachH: -1 })
  check('nie: nicht gelistet', nie.listed === false)
  check('nie: keine Wartezeit, die das aendert', nie.anbietenNachH === undefined)

  const spaeter = qm.callZustandAus({ anbietenNachH: 6 })
  check('spaeter: nicht gelistet, aber mit Wartezeit',
    spaeter.listed === false && spaeter.anbietenNachH === 6)
  check('sofort: gelistet', qm.callZustandAus({ anbietenNachH: 0 }).listed === true)

  // Rueckweg: aus dem Serverzustand muss wieder „nie" werden.
  const zurueck = (roh) => qm.zuFormular({ roh }).anbietenNachH
  check('nie kommt als nie zurueck', zurueck({ listed: false }) === -1)
  check('Wartezeit kommt als Wartezeit zurueck', zurueck({ listed: false, anbietenNachH: 6 }) === 6)
  check('gelistet kommt als sofort zurueck', zurueck({ listed: true }) === 0)
}

// ── Server-Wahl beim Anlegen ─────────────────────────────────────────────
// Ein Auftrag liegt auf genau EINEM Server: dort haengt seine Treuhand, dort
// wird abgenommen, dort zaehlt das Karma. Wer mehrere verbunden hat, schreibt
// aber nicht immer auf demselben aus.
console.log('\n── Server-Wahl im Auftrags-Fenster')
{
  const { QuestEditor, LEER_AUFTRAG } = await import('../client/core/QuestEditor.js')
  const mk = (q, server) => {
    const e = Object.create(QuestEditor.prototype)
    e._q = { ...LEER_AUFTRAG(), ...q }
    e.server = server
    return e
  }
  const server = [
    { id: 'heim', label: 'Heim', isDefault: true },
    { id: 'verein', label: 'Verein', isDefault: false },
  ]
  check('ohne Wahl gilt der Standardserver',
    mk({}, server)._aktiverServer().id === 'heim')
  check('eine Wahl gilt', mk({ server: 'verein' }, server)._aktiverServer().id === 'verein')
  check('ein unbekannter Server faellt auf den Standard zurueck',
    mk({ server: 'weg' }, server)._aktiverServer().id === 'heim')
  check('ohne Server gibt es nichts zu waehlen', mk({}, [])._aktiverServer() === null)

  // Ein einzelner Server blendet das Badge aus — dann gibt es keine Entscheidung.
  const eins = mk({}, [server[0]])
  let versteckt = null
  eins._serverEl = { set hidden(v) { versteckt = v }, get hidden() { return versteckt } }
  eins._renderServer()
  check('bei einem Server bleibt das Badge weg', versteckt === true)

  // Ein bestehender Auftrag laesst sich nicht verschieben: das waere kein
  // Umzug, sondern ein neuer Auftrag mitsamt neuer Treuhand.
  const fest = mk({ id: 'heim:abc' }, server)
  let html = ''
  fest._serverEl = { set hidden(v) {}, get hidden() { return false },
                     set innerHTML(h) { html = h },
                     querySelector: () => null, querySelectorAll: () => [] }
  fest._renderServer()
  check('ein bestehender Auftrag zeigt seinen Server unveraenderlich', /disabled/.test(html))
  check('mit Begruendung im Titel', /bleibt auf seinem Server/.test(html))

  const dienst = readFileSync(new URL('../client/core/QuestService.js', import.meta.url), 'utf8')
  check('angelegt wird auf dem gewaehlten Server',
    /createObject\(daten, \{ serverId: f\.server/.test(dienst))
  check('das Inventar ist auf den Server begrenzt',
    /inventar\(callId = null, serverId = null\)/.test(dienst))
  // Angemeldet reicht NICHT: Ein Server kann eingeloggt und trotzdem getrennt
  // sein. Ihn als Ziel anzubieten hiesse, einen Auftrag anzulegen, der beim
  // ersten Schreibversuch scheitert.
  check('nur VERBUNDENE Server stehen zur Wahl',
    /filter\(s => s\.isLoggedIn && s\.isConnected && !s\.isDisconnected\)/.test(dienst))
  check('und ohne verbundenen Server sagt das Speichern es',
    /Kein verbundener Server/.test(dienst))
}

// ── Modelle sitzen auf dem Boden ─────────────────────────────────────────
// Ein gerufener Drache landete sichtbar UNTER dem Gelaende. Die Position
// stimmte — der Modell-Ursprung liegt nur nicht an den Fuessen.
console.log('\n── Modelle aufsetzen')
{
  const src = readFileSync(new URL('../client/engine/GameObject.js', import.meta.url), 'utf8')
  check('es gibt einen Aufsetz-Schritt', /#seatModel\(importRoot\)/.test(src))
  check('er laeuft NACH der Groessen-Normierung',
    src.indexOf('#normalizeModelSize(importRoot, url)') < src.indexOf('#seatModel(importRoot)'))
  check('gemessen wird die ganze Hierarchie, nicht ein Mesh',
    /#seatModel[\s\S]{0,600}getHierarchyBoundingVectors\(true\)/.test(src))
  check('winzige Korrekturen bleiben aus',
    /#seatModel[\s\S]{0,1200}Math\.abs\(unten\) < 0\.01/.test(src))
  // Die Höhe wird beim Aufsetzen gleich mitgemessen — die Gangart skaliert
  // damit die Schrittlänge, der Perf-Pass die Animations-Distanz.
  check('und die Figurenhöhe fällt dabei ab',
    /#seatModel[\s\S]{0,600}this\._hoeheM = hoehe/.test(src))

  // Die Modelle selbst: Fuss-Ursprung darf sich nicht veraendern, ein
  // mittiger Ursprung ist genau der Fall, den der Schritt abfaengt.
  const { readFileSync: rf, existsSync } = await import('node:fs')
  const glbY = (datei) => {
    const p = new URL('../client/models/' + datei, import.meta.url)
    if (!existsSync(p)) return null
    const b = rf(p)
    if (b.readUInt32LE(0) !== 0x46546C67) return null
    let off = 12, j = null
    while (off < b.length) {
      const len = b.readUInt32LE(off), typ = b.readUInt32LE(off + 4)
      if (typ === 0x4E4F534A) { j = JSON.parse(b.slice(off + 8, off + 8 + len).toString('utf8')); break }
      off += 8 + len
    }
    if (!j) return null
    let min = Infinity, max = -Infinity
    for (const m of j.meshes || []) for (const pr of m.primitives || []) {
      const a = j.accessors[pr.attributes.POSITION]
      if (a?.min && a?.max) { min = Math.min(min, a.min[1]); max = Math.max(max, a.max[1]) }
    }
    return Number.isFinite(min) ? { min, max } : null
  }
  const drache = glbY('Dragon.glb')
  if (drache) {
    check('Dragon.glb hat seinen Ursprung NICHT an den Fuessen', drache.min < -0.01)
  } else {
    check('Dragon.glb lesbar', false, 'Modell fehlt')
  }
}

// ── Animations-Distanz ───────────────────────────────────────────────────
// War fest auf 150 m verdrahtet und nur ueber die Konsole erreichbar. Ein
// Drache ist auf 300 m noch bildfuellend, ein Fuchs dort ein Punkt.
console.log('\n── Animations-Distanz')
{
  const { RANGE_DEFS, animRadiusFuer } = await import('../client/core/renderRange.js')
  check('es gibt einen eigenen Regler', !!RANGE_DEFS.anim)
  check('mit sinnvoller Vorgabe', RANGE_DEFS.anim.def === 150)
  check('und „unbegrenzt" am Anschlag', RANGE_DEFS.anim.unbegrenzt === true)
  check('er ist NICHT die Objekt-Sichtweite', RANGE_DEFS.anim.key !== RANGE_DEFS.objects.key)

  check('Menschengroesse bleibt bei der Einstellung', animRadiusFuer(150, 1.8) === 150)
  check('ein Drache wird weiter animiert', animRadiusFuer(150, 12) > 150 * 5)
  check('ein Fuchs nicht kleiner als die Einstellung', animRadiusFuer(150, 0.6) === 150)
  check('die Streckung ist gedeckelt', animRadiusFuer(150, 500) === 150 * 8)
  check('unbegrenzt bleibt unbegrenzt', animRadiusFuer(Infinity, 12) === Infinity)
  check('ohne Hoehenangabe die blanke Einstellung', animRadiusFuer(150, NaN) === 150)

  const shell = readFileSync(new URL('../client/core/MobileShell.js', import.meta.url), 'utf8')
  check('der Regler steht in den Einstellungen', /reichweite\('anim'\)/.test(shell))
  const main = readFileSync(new URL('../client/main.js', import.meta.url), 'utf8')
  check('der LOD-Pass nutzt ihn', /animRadiusFuer\(animBasis, figurHoehe\(go\)\)/.test(main))
  check('und nicht mehr die feste Zahl', !/animRadiusM: 150/.test(main))
}

// ── Anwesenheit: Privatsphaere zuerst ────────────────────────────────────
console.log('\n── Anwesenheit anderer Spieler')
{
  const ps = await import('../client/core/PresenceService.js')
  const ICH = 'u_ich', ANDER = 'u_ander'
  const jetzt = 1_000_000_000

  const rec = (o = {}) => ({
    id: 'p1', type: 'player', owner: ANDER,
    state: { presence: true, name: 'Ada', karma: 3, seenAt: new Date(jetzt - 1000).toISOString() },
    ...o,
  })

  check('fremde Anwesenheit wird gezeigt', ps.zeigeAnwesenheit(rec(), ICH, jetzt) === true)
  check('die EIGENE nicht — sie staende im eigenen Kopf',
    ps.zeigeAnwesenheit(rec({ owner: ICH }), ICH, jetzt) === false)
  check('ein Gespenst verschwindet',
    ps.zeigeAnwesenheit(rec({ state: { seenAt: new Date(jetzt - 10 * 60_000).toISOString() } }), ICH, jetzt) === false)
  check('kurz vor der Grenze noch sichtbar',
    ps.zeigeAnwesenheit(rec({ state: { seenAt: new Date(jetzt - ps.VERALTET_MS + 5000).toISOString() } }), ICH, jetzt) === true)
  check('ohne Stempel wird nicht versteckt',
    ps.zeigeAnwesenheit(rec({ state: {} }), ICH, jetzt) === true)
  check('andere Objekttypen gehen das nichts an',
    ps.zeigeAnwesenheit({ type: 'npc', owner: ANDER }, ICH, jetzt) === false)

  const t = ps.anwesenheitsText(rec())
  check('Name kommt aus dem state, nicht aus dem Objektnamen', t.name === 'Ada')
  check('Karma als Sterne', t.sterne === '★★★☆☆')
  check('ohne Namen bleibt es lesbar', ps.anwesenheitsText({ state: {} }).name === 'Unbekannt')

  // Die Stufe „Genau" ist die Bedingung — nicht „irgendeine Freigabe".
  const src = readFileSync(new URL('../client/core/PresenceService.js', import.meta.url), 'utf8')
  check('angelegt wird nur bei Stufe „Genau"', /privacy\.allows\(s\.id, 'exact'\)/.test(src))
  check('sonst wird sie entfernt', /else await this\._entfernen\(s\.id\)/.test(src))
  check('eine Stufenaenderung wirkt sofort', /privacy\.onChange/.test(src))
  // Vorgabe ist die engere Wahl. Sichtbarkeit erweitert man bewusst — und die
  // Einstellung liegt geraetelokal je Server, wie die Standort-Stufe selbst.
  check('Vorgabe ist „nur Angemeldete"', /return 'authenticated'/.test(src))
  check('das Publikum ist waehlbar', /subject_type: publikum\.fuer\(serverId\)/.test(src))
  check('und wird je Server gemerkt', /ajna\.presence\.audience\./.test(src))
  check('Name und Karma schreibt der Client NICHT',
    !/state:\s*\{[^}]*name:/.test(src) && !/state:\s*\{[^}]*karma:/.test(src))

  const hooks = readFileSync(new URL('../pocketbase/pb_hooks/main.pb.js', import.meta.url), 'utf8')
  check('der Server stempelt die Identitaet ein', /stampeAnwesenheit/.test(hooks))
  check('und ueberschreibt den Besitzer', /istSuper\) e\.record\.set\("owner", uid\)/.test(hooks))
  check('Karma kommt aus der Server-Rechnung', /st\.karma = karmaStufe\(karmaPunkte/.test(hooks))
  check('mit Zeitstempel gegen Gespenster', /st\.seenAt = /.test(hooks))

  // Beschriftung: Karma als Sterne, aber kein Schild „0" fuer Neulinge.
  const { resolveLabel } = await import('../client/core/Appearance.js')
  const label = (k) => resolveLabel('{state.name} {karma}', { state: { name: 'Ada', karma: k } })
  check('Karma erscheint als Sterne im Schild', label(3).trim() === 'Ada ★★★☆☆')
  check('Karma 0 traegt kein Schild', label(0).trim() === 'Ada')

  // In beiden 3D-Wegen ausgeblendet bzw. gezeigt.
  const main = readFileSync(new URL('../client/main.js', import.meta.url), 'utf8')
  check('die Freiflug-Ansicht filtert Anwesenheiten', /zeigeAnwesenheit\(o, _ich\)/.test(main))
  check('und startet den Dienst ausserhalb der Shell', /presence\?\.start\(\)/.test(main))
  check('beim Verlassen wird aufgeraeumt', /pagehide[\s\S]{0,80}presence\?\.stop\(\)/.test(main))
  // In der Shell laeuft die Karte auch ohne je geladenes AR-Buendel — dort
  // gehoert die Anwesenheit der Shell, sonst waere man sichtbar fuer alle,
  // aber selbst unsichtbar. Zwei Schreiber waeren der andere Fehler.
  const shell = readFileSync(new URL('../client/core/MobileShell.js', import.meta.url), 'utf8')
  check('die Shell pflegt sie selbst', /this\.presence = new PresenceService/.test(shell))
  check('und das AR-Buendel haelt sich dann heraus',
    /document\.querySelector\('\.shell-tabbar'\) \? null : new PresenceService/.test(main))
  const mapQuelle = readFileSync(new URL('../client/map.js', import.meta.url), 'utf8')
  check('der Karten-Client pflegt sie ebenfalls', /new PresenceService\(/.test(mapQuelle))
  const map = readFileSync(new URL('../client/map.js', import.meta.url), 'utf8')
  check('die Karte zeigt sie ebenfalls', /PRESENCE_TYPE/.test(map))
}

// ── Weiche Korrektur statt Sprung ────────────────────────────────────────
// Solange ein Objekt vorausgerechnet wird, laeuft die Anzeige von der Wahrheit
// weg. Trifft ein neuer Plan ein, sprang die Figur bisher auf die neue Rechnung
// — bei 500-ms-Takten unsichtbar, seit die Agents nur noch an Wegknicken
// melden aber ein deutliches Zucken.
console.log('\n── PositionSmoother: weiche Korrektur')
{
  const { PositionSmoother } = await import('../client/core/PositionSmoother.js')

  const mitPlan = (lat, lon, v, trk, t) => ({
    lat, lon, altitude: 0, rotation: { x: 0, y: 0, z: 0 },
    state: { motion: { v, trk, lat0: lat, lon0: lon, alt0: 0, vrate: 0, t: Date.now() } },
  })
  const distM = (a, b) => Math.hypot(
    (a.lat - b.lat) * 111320,
    (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180))

  {
    const sm = new PositionSmoother()
    sm.feed(mitPlan(50, 7, 5, 90), 0)
    const vorher = sm.sample(2000)          // 2 s vorausgerechnet

    // Ein neuer Plan, der die Figur 3 m weiter hinten sieht — genau der Fall,
    // der bisher zuckte.
    const versetzt = mitPlan(50, 7 + (10 - 3) / (111320 * Math.cos(50 * Math.PI / 180)), 5, 90)
    sm.feed(versetzt, 2000)

    const sofort = sm.sample(2000)
    check('im Moment des Eintreffens springt nichts',
      distM(vorher, sofort) < 0.2, distM(vorher, sofort).toFixed(2) + ' m')

    const mitten = sm.sample(2350)
    check('der Versatz wird abgebaut, nicht gehalten',
      distM(mitten, sm.sample(2350)) < 0.01)

    // Die Korrektur laeuft nie schneller als ein Schritt — sonst waere sie
    // selbst der Ruck, den sie verhindern soll.
    let maxTempo = 0
    let vor = sm.sample(2000)
    for (let t = 2050; t <= 5000; t += 50) {
      const jetzt = sm.sample(t)
      const gefahren = distM(vor, jetzt) / 0.05
      // 5 m/s Grundtempo des Plans plus Korrektur — die Korrektur allein
      // darf 1,2 m/s nicht überschreiten.
      if (gefahren - 5 > maxTempo) maxTempo = gefahren - 5
      vor = jetzt
    }
    check('die Korrektur bleibt langsamer als ein Schritt', maxTempo <= 1.4,
      maxTempo.toFixed(2) + ' m/s obendrauf')

    // Nach der Korrekturzeit steht die Figur wieder exakt auf dem Plan.
    const spaet = sm.sample(6000)
    const rein = { lat: versetzt.state.motion.lat0, lon: versetzt.state.motion.lon0 }
    const gerechnet = {
      lat: rein.lat,
      lon: rein.lon + (5 * 4.0) / (111320 * Math.cos(50 * Math.PI / 180)),
    }
    check('danach folgt sie wieder genau dem Plan',
      distM(spaet, gerechnet) < 0.6, distM(spaet, gerechnet).toFixed(2) + ' m')
  }

  // Grosse Spruenge sind KEIN Drift, sondern ein Ortswechsel (Editor,
  // Neuplanung). Die weichzuzeichnen hiesse, die Figur sekundenlang quer durch
  // die Welt gleiten zu lassen.
  {
    const sm = new PositionSmoother()
    sm.feed(mitPlan(50, 7, 5, 90), 0)
    const vorher = sm.sample(1000)
    sm.feed(mitPlan(50.01, 7, 5, 90), 1000)      // ~1,1 km weiter
    const nachher = sm.sample(1000)
    check('ein Ortswechsel wird gesprungen, nicht geglättet',
      distM(vorher, nachher) > 500, Math.round(distM(vorher, nachher)) + ' m')
  }

  // Ohne Plan (reine Interpolation) darf sich nichts ändern.
  {
    const sm = new PositionSmoother()
    sm.feed({ lat: 50, lon: 7, altitude: 0, rotation: { x: 0, y: 0, z: 0 } }, 0)
    sm.feed({ lat: 50.0001, lon: 7, altitude: 0, rotation: { x: 0, y: 0, z: 0 } }, 500)
    const p = sm.sample(700)
    check('Objekte ohne Plan bleiben unberührt', p && Number.isFinite(p.lat))
  }
}

// ── Gangart nur am Boden ─────────────────────────────────────────────────
// Drache und Wyvern bringen einen Gehzyklus mit — fuer den Fall, dass sie
// gelandet sind. Solange der Agent „fliegen" meldet, zuckten sie im Gehtakt
// durch die Luft.
console.log('\n── Gangart: nur am Boden')
{
  const src = readFileSync(new URL('../client/engine/GameObject.js', import.meta.url), 'utf8')
  check('es gibt eine Liste der Bodenzustände', /const BODEN_ANIM = new Set\(\["idle", "walk", "run"\]\)/.test(src))
  check('fliegen gehört NICHT dazu', !/BODEN_ANIM = new Set\(\[[^\]]*"fly"/.test(src))
  check('der Wunsch des Agents wird getrennt gemerkt', /this\._agentAnim = data\.animation_state/.test(src))
  check('und die Gangart hält sich bei Flug heraus',
    /#pflegeGangart[\s\S]{0,900}!BODEN_ANIM\.has\(String\(this\._agentAnim\)[\s\S]{0,40}\) return/.test(src))
  check('zusätzlich über die Höhe abgesichert',
    /#pflegeGangart[\s\S]{0,1600}snap\.altitude \?\? 0\) > FLIEGT_AB_M\) return/.test(src))
  check('die Höhengrenze liegt über Kopfhöhe', /const FLIEGT_AB_M = 3/.test(src))
}

// ── Interaktions-Protokoll: Zeile und geteilter Verlauf ──────────────────
// Untersucht man ein Objekt, soll das Ergebnis MIT Objekt-ID im Verlauf
// stehen — bei gleichnamigen Figuren („Papagei", „Soldat") ist ohne Kennung
// nicht feststellbar, welche gemeint war.
console.log('\n── Interaktions-Protokoll')
{
  const { interaktionsZeile, protokolliereInteraktion } =
    await import('../client/core/InteractionReply.js')

  const rec = { id: 'default:abc123', name: 'Papagei Julie', type: 'animal' }
  const zeile = interaktionsZeile(rec, 'examine', 'Ein Papagei.')
  check('der Name steht drin', /Papagei Julie/.test(zeile))
  check('die VOLLE Objekt-ID steht drin', zeile.includes('default:abc123'), zeile)
  check('die Aktion steht drin', /examine/.test(zeile))
  check('und die Antwort', /Ein Papagei\./.test(zeile))
  check('ohne ID bleibt es lesbar',
    !/\[\]/.test(interaktionsZeile({ name: 'X' }, 'examine', 'y')))
  check('ohne Namen ebenso', /Objekt/.test(interaktionsZeile({ id: 'i1' }, 'examine', 'y')))

  // DIE FALLE: Der Client besteht aus vier Webpack-Bündeln, jedes mit einer
  // EIGENEN Modulinstanz des Verlaufs. Wer den importierten `messageLog`
  // benutzt, schreibt in den Verlauf SEINES Bündels — das Fenster gehört der
  // Shell und liest ihren eigenen. Die Zeilen landen nirgends sichtbar, ohne
  // dass etwas fehlschlägt. Geteilt wird über `window.ajnaLog`.
  const gesammelt = []
  globalThis.window = globalThis.window || {}
  const vorher = window.ajnaLog
  window.ajnaLog = { push: (text, cat) => gesammelt.push({ text, cat }) }
  protokolliereInteraktion(rec, 'talk', 'Hallo!')
  check('geschrieben wird in den GETEILTEN Verlauf', gesammelt.length === 1)
  check('mit Objekt-ID', gesammelt[0]?.text.includes('default:abc123'))
  check('als Aktion einsortiert', gesammelt[0]?.cat === 'interact')

  // Fehlt der Verlauf (eigenständige Seite ohne Shell), darf nichts brechen.
  window.ajnaLog = undefined
  let geworfen = false
  try { protokolliereInteraktion(rec, 'examine', 'x') } catch { geworfen = true }
  check('ohne Verlauf passiert einfach nichts', !geworfen)
  window.ajnaLog = vorher

  // „interact" muss im Standard-Filter des Fensters sichtbar sein — sonst
  // stünde die Zeile zwar im Verlauf, aber niemand sähe sie.
  const { CATS } = await import('../client/core/MessageLog.js')
  check('Aktionen sind im Verlauf sichtbar', CATS.interact?.player === true)

  // Kein Aufrufer darf am geteilten Verlauf vorbeischreiben.
  for (const datei of ['../client/map.js', '../client/main.js', '../client/core/MobileShell.js']) {
    const q = readFileSync(new URL(datei, import.meta.url), 'utf8')
    const name = datei.split('/').pop()
    check(`${name} nutzt den gemeinsamen Weg`, /protokolliereInteraktion\(/.test(q))
    check(`${name} schreibt nicht am Bündel vorbei`,
      !/messageLog\.push\(interaktionsZeile/.test(q))
  }
}

// ── Toast: anklickbar, laenger, kein aufdraengendes Fenster ─────────────
console.log('\n── Toast als Weg ins Gespräch')
{
  const t = readFileSync(new URL('../client/core/Toast.js', import.meta.url), 'utf8')
  check('Anzeigedauer auf 8 Sekunden', /DEFAULT_TIMEOUT = 8000/.test(t))
  check('der Toast ist anklickbar', /el\.classList\.add\('klickbar'\)/.test(t))
  check('und per Tastatur bedienbar', /Enter' \|\| e\.key === ' '/.test(t))
  check('er oeffnet den Verlauf', /window\.ajnaLogPanel\?\.open\(\)/.test(t))
  check('ein eigener Klick-Haken geht vor', /onClick \? onClick\(\)/.test(t))
  check('als klickbar erkennbar', /klickbar \{ cursor: pointer/.test(t))

  const shell = readFileSync(new URL('../client/core/MobileShell.js', import.meta.url), 'utf8')
  // „Sprechen" legte den Verlauf sofort ueber die Szene — genau dann, wenn man
  // die Figur ansieht. Jetzt kommt nur der Toast.
  check('„Sprechen" reisst das Fenster nicht mehr auf', /talkTo\(\{[\s\S]{0,220}\}, \{ open: false \}\)/.test(shell))
  check('stattdessen ein Hinweis zum Antippen', /Antippen zum Antworten/.test(shell))
  check('das Panel ist buendeluebergreifend erreichbar', /window\.ajnaLogPanel = this\._logPanel/.test(shell))
  check('und wird beim Abraeumen entfernt', /delete window\.ajnaLogPanel/.test(shell))

  const panel = readFileSync(new URL('../client/core/MessageLogPanel.js', import.meta.url), 'utf8')
  check('Antworten der Figur fuehren ebenfalls ins Gespraech',
    /onClick: \(\) => this\.open\(\)/.test(panel))
}

// ── Aktions-Reichweite (max_distance) und Privatsphaere ──────────────────
// Eine Aktion kann `max_distance` tragen. Naehe laesst sich aber nur pruefen,
// wenn der Standort ueberhaupt freigegeben ist — daraus folgt die noetige
// Stufe, aus der Sache heraus statt willkuerlich.
console.log('\n── Aktions-Reichweite')
{
  const r = await import('../client/core/aktionsReichweite.js')

  const ohne = { key: 'examine', label: 'Untersuchen' }
  const nah = { key: 'attack', label: 'Angreifen', max_distance: 30 }
  const weit = { key: 'lesen', label: 'Lesen', max_distance: 800 }

  check('ohne max_distance keine Anforderung', r.noetigeStufe(ohne) === 'off')
  check('0 zaehlt wie ohne', r.noetigeStufe({ max_distance: 0 }) === 'off')
  check('Unsinn zaehlt wie ohne', r.noetigeStufe({ max_distance: 'viel' }) === 'off')
  // Eine auf 100 m gerundete Position kann eine 30-m-Frage nicht beantworten.
  check('kurze Reichweite verlangt „Nähe"', r.noetigeStufe(nah) === 'proximity')
  check('grosse Reichweite genuegt „Gegend"', r.noetigeStufe(weit) === 'area')

  check('bei „Verborgen" gesperrt', !r.aktionErlaubt(nah, 'off').ok)
  check('bei „Gegend" fuer 30 m noch gesperrt', !r.aktionErlaubt(nah, 'area').ok)
  check('bei „Nähe" frei', r.aktionErlaubt(nah, 'proximity').ok)
  check('bei „Genau" ebenfalls', r.aktionErlaubt(nah, 'exact').ok)
  check('eine Aktion ohne Reichweite ist immer frei', r.aktionErlaubt(ohne, 'off').ok)

  // Ein ausgegrauter Knopf ohne Erklaerung ist eine Sackgasse.
  const abgelehnt = r.aktionErlaubt(nah, 'area')
  check('die Ablehnung sagt, was zu tun ist', /Standort-Freigabe/.test(abgelehnt.text))
  check('und nennt die noetige Stufe', abgelehnt.noetig === 'proximity')

  // Entfernung, wenn bekannt.
  check('zu weit wird abgelehnt', !r.aktionErlaubt(nah, 'exact', 200).ok)
  check('mit Zahlen in der Begruendung', /200 m/.test(r.aktionErlaubt(nah, 'exact', 200).text))
  check('in Reichweite geht es', r.aktionErlaubt(nah, 'exact', 12).ok)
  // Bei „Naehe" gibt es GAR KEINE Koordinaten — fehlende Entfernung darf
  // deshalb nicht als Ablehnung gelten.
  check('ohne gemessene Entfernung wird nicht abgelehnt',
    r.aktionErlaubt(nah, 'proximity', null).ok)

  // ── Agent-Seite ────────────────────────────────────────────────────────
  const ziel = { lat: 50.4466, lon: 7.5971 }
  const noerdlich = (m) => ({ lat: ziel.lat + m / 111320, lon: ziel.lon })

  check('Naehe-Meldung genuegt und braucht keine Koordinate',
    r.naheGenug({ aktion: nah, ziel, absender: null, istNah: true }).ok)
  check('ohne alles wird abgelehnt',
    r.naheGenug({ aktion: nah, ziel, absender: null }).grund === 'keine-position')
  check('nahe Position geht durch',
    r.naheGenug({ aktion: nah, ziel, absender: noerdlich(10) }).ok)
  check('ferne Position nicht',
    !r.naheGenug({ aktion: nah, ziel, absender: noerdlich(5000) }).ok)
  check('ohne Reichweite ist alles erlaubt',
    r.naheGenug({ aktion: ohne, ziel, absender: noerdlich(9000) }).ok)
  // Wer auf 100 m gerundet meldet, laege sonst systematisch daneben.
  check('bei grosser Reichweite gibt es Kulanz fuer die Rundung',
    r.naheGenug({ aktion: weit, ziel, absender: noerdlich(880) }).ok)
  check('unbegrenzt ist sie aber nicht',
    !r.naheGenug({ aktion: weit, ziel, absender: noerdlich(1500) }).ok)

  check('Abstand wird gemessen',
    Math.abs(r.abstandM(50.4466, 7.5971, 50.4475, 7.5971) - 100) < 3,
    r.abstandM(50.4466, 7.5971, 50.4475, 7.5971).toFixed(0) + ' m')

  // Der Client muss abbrechen, statt eine Aktion ins Leere zu senden.
  const oa = readFileSync(new URL('../client/core/ObjectActions.js', import.meta.url), 'utf8')
  check('der Client prueft die Reichweite vorher', /aktionErlaubt\(aktion, stufe, d\)/.test(oa))
  check('und schickt die Position mit, damit der Agent pruefen kann',
    /privacy\.positionFor\(record\?\._origin/.test(oa))
}

// ── Trefferpunkte-Balken in der Beschriftung ─────────────────────────────
{
  const { resolveLabel } = await import('../client/core/Appearance.js')
  const bar = (ist, max) => resolveLabel('{hp}', { state: { hp: { ist, max } } })
  check('unverletzt steht nichts da', bar(30, 30) === '')
  check('verletzt kommt die Zahl', bar(15, 30) === '15/30', bar(15, 30))
  check('ohne Angabe steht nichts da', resolveLabel('{hp}', { state: {} }) === '')

  // Der ÜBLICHE Weg ist der farbige Balken — er braucht keine Beschriftung und
  // erscheint nur bei Verletzung. Sonst haetten alle Gegner dauerhaft ihren
  // Namen im Bild, weil eine Tafel noetig waere.
  const ll = readFileSync(new URL('../client/engine/LabelLayer.js', import.meta.url), 'utf8')
  check('der Balken ist ein eigenes Element', /GUI\.Rectangle\(`hpbg_/.test(ll))
  check('gruen, gelb, rot', /#4caf50[\s\S]{0,160}#e0b020[\s\S]{0,160}#d84a3a/.test(ll))
  check('nur bei Verletzung sichtbar', /ist < max && dist <= HP_SICHT_M/.test(ll))
  check('und nur in der Naehe', /HP_SICHT_M = \d+/.test(ll))
  check('schmal', Number((ll.match(/HP_HOEHE_PX = (\d+)/) || [])[1]) <= 8)

  const lc = readFileSync(new URL('../client/engine/components/LabelComponent.js', import.meta.url), 'utf8')
  check('Trefferpunkte allein genuegen zum Anmelden', /labelOf\(this\.record\) \|\| hatHp/.test(lc))

  const prof = readFileSync(new URL('../agents/world-director.profiles.mjs', import.meta.url), 'utf8')
  check('Gegner tragen KEINE Dauer-Beschriftung', !/out\.label = '\{name\} \{hp\}'/.test(prof))
}


// ── Kampf: Route abbrechen, Beute wirklich ablegen ───────────────────────
// Drei Fehler derselben Familie: Der Director hielt die Figur nur INTERN an,
// legte die Beute an der zuletzt GESCHRIEBENEN Position ab und ordnete sie
// keiner Manifest-Schicht zu — sichtbar wurde davon nichts.
console.log('\n── Kampf: Halt, Beute, Sichtbarkeit')
{
  const wd = readFileSync(new URL('../agents/world-director.mjs', import.meta.url), 'utf8')

  check('ein Treffer bricht die Route ab', /r\.tot[\s\S]{0,400}halteAn\(c, \{ bis: Date\.now\(\) \+ KAMPF_HALT_MS/.test(wd))
  check('und dauert laenger als ein Gespraech',
    /WD_KAMPF_HALT_S \|\| '(\d+)'/.test(wd) &&
    Number(wd.match(/WD_KAMPF_HALT_S \|\| '(\d+)'/)[1]) > Number(wd.match(/WD_ATTEND_S \|\| '(\d+)'/)[1]))
  // Ohne Halt-Plan laeuft die Figur beim Betrachter weiter — die
  // Vorausrechnung kennt nur Kurs und Tempo, kein Ziel.
  check('der Stillstand wird auch geschrieben', /motion: planFuer\(c\)\.haltAn\(/.test(wd))
  check('der Gefallene plant nichts mehr', /c\.gefallen = true/.test(wd) && /c\.tot \|\| c\.gefallen\) continue/.test(wd))
  check('er sieht seinen Angreifer an', /blickAuf: at/.test(wd))
  // hp landen im baseState, sonst wirft der naechste Bewegungs-Schreibvorgang
  // sie weg und der Gegner steht wieder bei voller Gesundheit da.
  check('Trefferpunkte ueberleben den naechsten Schreibvorgang',
    wd.includes('if (zusatz) c.baseState = { ...c.baseState, ...zusatz }') &&
    wd.includes('zusatz: { hp: r.hp }'))
  check('Beute faellt an die LIVE-Position', /destPoint\(c\.lat \?\? obj\.lat, c\.lon \?\? obj\.lon/.test(wd))
  check('und die Reichweite wird auch dagegen geprueft', /lat: c\.lat \?\? obj\.lat, lon: c\.lon \?\? obj\.lon/.test(wd))
  // addPermission scheiterte still: Der afterCreate-Hook hat die ACE schon.
  check('die Rechte werden gesetzt, nicht doppelt angelegt', /ensureAce\(rec\.id, \['collect', 'examine'\]\)/.test(wd))
  check('auch ein Gespraech haelt sichtbar an', /wegBehalten: true/.test(wd))
  check('dabei bleibt der Weg erhalten', /if \(wegBehalten && c\.path\) patch\.state\.walk_path = c\.path/.test(wd))
  // Zwei gleichzeitige Schreibvorgaenge auf denselben Datensatz brechen
  // einander ab — ausgerechnet der Halt darf nicht der verlorene sein.
  check('Halt und Bewegungs-Tick schreiben nicht gleichzeitig', /for \(let i = 0; c\.busy && i < 30/.test(wd))

  // „hit" ist eine Geste, kein Zustand: Der Client kehrt danach nicht von
  // selbst zu „steht" zurueck — der Getroffene liefe sonst auf der Stelle.
  check('nach dem Zucken steht er', wd.includes("setzeAnim(c, 'idle')\n      schreibeAnimFalls(c)"))
  check('walk_path faellt beim Abbrechen weg', wd.includes('else delete patch.state.walk_path'))
  check('Weg und Bewegung gehoeren nicht zur Identitaet der Figur',
    wd.includes('const { walk_path, motion, ...rest } = state || {}'))

  check('Fundstuecke sind aufnehmbar', /TRAGBAR = new Set\(\['item', 'diamond'\]\)/.test(wd))
  check('auch die schon liegenden', /if \(tragbar\) next\.portable = true/.test(wd))
  check('und untersuchbar', /item:   \{ count: 2, actions: \[\{ key: 'examine'/.test(wd))

  const { beuteObjekt } = await import('../agents/lib/kampf.mjs')
  const b = beuteObjekt('Knochensplitter', { lat: 50.4, lon: 7.5 })
  check('Beute ist tragbar', b.state.portable === true)
  check('Beute traegt ihren Namen im Bild', b.appearance.label === 'Knochensplitter')
  // Ein Agent-Objekt ohne passende Schicht blendet der Inhaltsfilter aus,
  // sobald der Spieler dort einmal etwas ausgewaehlt hat.
  check('Beute ist einer Schicht zugeordnet', b.state.archetype === 'item')

  const af = readFileSync(new URL('../client/core/AgentFilters.js', import.meta.url), 'utf8')
  check('was zu keiner Schicht passt, verschwindet nicht still',
    /return !manifest\.layers\.some\(l => l\.predicate && matchesPredicate\(record, l\.predicate\)\)/.test(af))
}


// ── Gallertwesen, Einmal-Animationen, Spawn-Rückmeldung ─────────────────
console.log('\n── Gallert, Tod, Spawn-Hinweis')
{
  const prof = await import('../agents/world-director.profiles.mjs')
  const a = prof.profileAppearance('MawGooey.glb', 'abc-123')
  const b = prof.profileAppearance('MawGooey.glb', 'abc-123')
  const c = prof.profileAppearance('MawGooey.glb', 'xyz-999')
  check('Gallertwesen bekommen eine Farbe', /^#[0-9a-f]{6}$/i.test(a.color || ''), a.color)
  check('und sind durchscheinend', a.opacity > 0 && a.opacity < 1, String(a.opacity))
  // Zufall waere hier falsch: Die Profil-Heilung rechnet dieselbe appearance
  // bei jedem Boot neu aus — die Figur bekaeme jedes Mal eine andere Farbe.
  check('dieselbe Saat ergibt dieselbe Farbe', a.color === b.color)
  check('verschiedene Figuren sehen verschieden aus',
    ['abc-123', 'xyz-999', 'q-1', 'q-2', 'q-3', 'q-4'].map(s => prof.profileAppearance('Slime.glb', s).color)
      .filter((v, i, arr) => arr.indexOf(v) === i).length > 1)
  check('Pferde bleiben unbehelligt', !prof.profileAppearance('Horse.glb', 'x').color)
  check('auch verschiedene Saaten fuer dasselbe Modell', c.opacity === a.opacity)

  const go = readFileSync(new URL('../client/engine/GameObject.js', import.meta.url), 'utf8')
  // In der Schleife faellt MawGooey immer wieder in sich zusammen.
  check('Treffer und Tod laufen EINMAL', go.includes('next.start(!einmalig, this._animSpeed)'))
  check('und die Entfernungs-Pause nimmt sie nicht in die Schleife',
    readFileSync(new URL('../client/main.js', import.meta.url), 'utf8').includes('g.play(!go._animEinmalig)'))
  // Ein durchsichtiges Auge in einem durchsichtigen Koerper ist kein Auge mehr.
  check('Augen bleiben deckend', /AUGEN_MATERIAL = \/\(eye\|auge\|pupil\|iris\)\/i/.test(go))
  check('und ungefaerbt', (go.match(/AUGEN_MATERIAL\.test/g) || []).length === 2)

  const mj = readFileSync(new URL('../client/main.js', import.meta.url), 'utf8')
  // Die zwischengespeicherte Auswahl kannte ein neues Objekt nicht — es
  // erschien erst, wenn der Spieler 15 m gelaufen war.
  check('ein neues Objekt loest die Auswahl neu aus', mj.includes('const neuDabei = !bekannt || list.some(o => !bekannt.has(o.id))'))
  check('der Platzhalter erscheint beim Anfordern', mj.includes('angefordert: stelle => _spawnFunken?.zeige(stelle)'))
  check('und verschwindet, wenn das Objekt da ist', mj.includes("if (action === 'create') _spawnFunken?.quittiere(rec.lat, rec.lon)"))

  const sh = readFileSync(new URL('../client/core/SpawnHere.js', import.meta.url), 'utf8')
  // Ohne laufenden Director entstuende sonst eine Wolke an einer Stelle, an
  // der nie etwas erscheint.
  const zeilen = sh.split('\n')
  const iNein = zeilen.findIndex(z => z.includes('der World-Director läuft nicht'))
  const iWolke = zeilen.findIndex(z => z.includes('angefordert?.('))
  check('keine Wolke ohne Empfaenger',
    iNein >= 0 && iWolke > iNein && zeilen.slice(iNein, iWolke).some(z => z.trim() === 'else {'))
}


// ── Zwischenspeicher für fremde Quellen ─────────────────────────────────
// WiGLE ist einmal STILL ausgefallen: keine Fehlermeldung, nur keine
// Ergebnisse mehr. Overpass, Wikipedia, Commons und Movebank liefen im
// selben Muster weiter.
console.log('\n── Quellcache: POI und Movebank')
{
  const poi = readFileSync(new URL('../agents/poi-bridge.mjs', import.meta.url), 'utf8')
  check('die POI-Brücke speichert zwischen', /new Quellcache\('poi'/.test(poi))
  check('Overpass-Antworten', /cache\.hole\(\s*`pois:/.test(poi))
  check('Wikipedia-Artikel', /cache\.hole\(\s*`wiki:/.test(poi))
  check('und Commons-Fotos', /cache\.hole\(\s*`commons:/.test(poi))
  // Ein Schlüssel, der sich bei jedem Schritt des Spielers ändert, trifft nie.
  check('Schlüssel und Abfrage liegen auf demselben Raster',
    /lat: raster\(lat\), lon: raster\(lon\)/.test(poi))

  const mb = readFileSync(new URL('../agents/movebank-bridge.mjs', import.meta.url), 'utf8')
  check('Movebank speichert den Studien-Katalog', /cache\.hole\('studien'/.test(mb))
  check('und die Aktualitäts-Probe je Studie', /cache\.hole\(`probe:\$\{c\.id\}`/.test(mb))
  // Ein Lauf aus dem Zwischenspeicher braucht die Schonpause nicht.
  check('die Schonpause gilt nur echten Abfragen', /if \(gefragt\) await sleep\(REQ_DELAY_MS\)/.test(mb))
  // Bewegte Echtzeitdaten NICHT zwischenspeichern: ein alter Fix ist keine
  // Position, sondern ein Irrtum.
  check('die Live-Positionen bleiben ungecacht',
    !/cache\.hole[\s\S]{0,80}fetchStudy\(st\.id\)/.test(mb))
  for (const f of ['adsb-bridge.mjs', 'ais-bridge.mjs']) {
    const q = readFileSync(new URL('../agents/' + f, import.meta.url), 'utf8')
    check(`${f} bleibt bewusst ohne Zwischenspeicher`, !/Quellcache/.test(q))
  }
}

// ── Auftrag: Belohnung steigt, und kürzen ist verboten ──────────────────
console.log('\n── Auftrag: Steigerung und Zusage')
{
  const q = readFileSync(new URL('../pocketbase/pb_hooks/quests.js', import.meta.url), 'utf8')
  // Die Einstellung wurde gespeichert und angezeigt — und nie angewandt.
  check('die Steigerung wirkt jetzt', /steigt \* gelaufen/.test(q))
  check('sie zählt die abgeschlossenen Durchläufe', /Number\(callData\.completions\)/.test(q))
  // Sonst bliebe der Auftrag offen und der nächste Spieler liefe ins 409.
  check('der Status prüft den NÄCHSTEN Bedarf', /naechsterBedarf = swap\.perRun \+/.test(q))

  const m = readFileSync(new URL('../pocketbase/pb_hooks/main.pb.js', import.meta.url), 'utf8')
  check('kürzen weist der Server ab', /the reward may be raised, not reduced/.test(m))
  check('aber nur, solange jemand mitarbeitet', /status === "claimed" \|\| cVorher\.status === "pending"/.test(m))

  const { durchlaeufeVon } = await import('../client/core/QuestEditor.js')
  const auftrag = (vorrat, pro, steigt) => ({
    wiederholbar: true, vorrat, belohnung: { anzahl: pro, steigt },
  })
  check('ohne Steigerung wird geteilt', durchlaeufeVon(auftrag(6, 2, 0)) === 3)
  // 1 + 2 + 3 = 6 → drei Durchläufe; der vierte kostete 4 und passt nicht mehr.
  check('mit Steigerung wird aufsummiert', durchlaeufeVon(auftrag(6, 1, 1)) === 3,
    String(durchlaeufeVon(auftrag(6, 1, 1))))
  check('und eine Division wäre falsch gewesen', durchlaeufeVon(auftrag(6, 1, 1)) !== 6)
}


// ── Sprachkatalog: was übersetzt ist, muss auch passen ──────────────────
// Der deutsche Satz ist der Schlüssel. Das macht Einträge billig — und genau
// deshalb braucht es eine Prüfung, die verhindert, dass sie stillschweigend
// kaputtgehen.
console.log('\n── Sprachkatalog')
{
  const { texte } = await import('../client/lang/en.js')
  const schluessel = Object.keys(texte)
  check('es gibt einen englischen Katalog', schluessel.length > 100, schluessel.length + ' Einträge')
  check('keine leeren Übersetzungen', schluessel.every(k => String(texte[k]).trim().length > 0))
  // Ein einzelnes Wort darf in beiden Sprachen gleich lauten („Audio") — ein
  // ganzer Satz fast nie. Der ist dann vergessen worden, nicht geprüft.
  const unbearbeitet = schluessel.filter(k =>
    texte[k] === k && !k.startsWith('fehler.') && k.trim().split(/s+/).length > 2)
  check('kein ganzer Satz blieb unübersetzt stehen', unbearbeitet.length === 0, unbearbeitet.join(' | '))

  // Ein verlorener Platzhalter zeigt „{n} Punkte" als „points" — die Zahl
  // verschwindet, ohne dass irgendwo ein Fehler auftaucht.
  const platzhalter = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',')
  const schief = schluessel.filter(k => platzhalter(k) !== platzhalter(texte[k]))
  check('Platzhalter überleben die Übersetzung', schief.length === 0, schief.join(' | '))

  // Server-Meldungen laufen über einen stabilen Code, nicht über ihren Wortlaut.
  check('Server-Codes sind eingetragen',
    schluessel.some(k => k.startsWith('fehler.')) &&
    typeof texte['fehler.reward_reduced'] === 'string')
}

// ── t() ist nirgends Pflicht, aber der Weg ist vorbereitet ──────────────
console.log('\n── Textdurchlauf')
{
  const { readdirSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const wurzel = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

  let verpackt = 0
  for (const ort of ['client/core', 'client/engine', 'client']) {
    for (const n of readdirSync(join(wurzel, ort))) {
      if (!n.endsWith('.js') || n.includes('.test.')) continue
      const p = join(wurzel, ort, n)
      if (!statSync(p).isFile()) continue
      verpackt += (readFileSync(p, 'utf8').match(/\bt\(\s*['"]/g) || []).length
    }
  }
  // Kein Zielwert, nur eine Untergrenze: Sie fällt auf, wenn jemand den
  // Katalog-Weg beim Umbauen versehentlich wieder herausnimmt.
  check('die Oberfläche läuft über den Katalog', verpackt > 120, verpackt + ' Aufrufe')

  const i18n = readFileSync(new URL('../client/core/i18n.js', import.meta.url), 'utf8')
  // Ohne Eintrag den SCHLÜSSEL zurückgeben — dadurch ist eine nicht übersetzte
  // Stelle kein leerer Knopf, sondern einfach Deutsch.
  check('ohne Eintrag kommt der Satz selbst zurück', /out = roh/.test(i18n))
  check('Deutsch braucht keine Datei', /if \(ziel === 'de'\)/.test(i18n))
  // Eine fremde Sprache, die nicht lädt, darf nicht in eine halb leere
  // Oberfläche führen.
  check('eine kaputte Sprachdatei fällt auf Deutsch zurück', /zustand.aktiv = 'de'/.test(i18n))
}


// ── t() muss auch da sein, wo es benutzt wird ───────────────────────────
// Ein fehlender Import ist hier ein LAUFZEIT-Fehler, den nichts vorher meldet:
// Webpack darf `t` nicht beanstanden, weil es ein globaler Bezeichner sein
// könnte. Aufgefallen ist es erst im Browser — „t is not defined", und die
// halbe Ansicht blieb leer. Deshalb diese Prüfung.
console.log('\n── Übersetzer-Import')
{
  const { readdirSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const wurzel = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

  const ohneImport = []
  const verdeckt = []
  for (const ort of ['client/core', 'client/engine', 'client']) {
    for (const n of readdirSync(join(wurzel, ort))) {
      if (!n.endsWith('.js') || n.includes('.test.')) continue
      const p = join(wurzel, ort, n)
      if (!statSync(p).isFile()) continue
      const quelle = readFileSync(p, 'utf8')
      const zeilen = quelle.split(/\r?\n/).filter(z => {
        const x = z.trim()
        return !(x.startsWith('//') || x.startsWith('*') || x.startsWith('/*'))
      })
      if (!zeilen.some(z => /(^|[^.\w])t\(\s*['"]/.test(z))) continue
      const kurz = `${ort}/${n}`
      if (!/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*['"][^'"]*i18n\.js['"]/.test(quelle)) ohneImport.push(kurz)
      // Eine lokale Variable `t` verdeckt den Übersetzer im ganzen Block —
      // heute vielleicht harmlos, beim nächsten Text in derselben Funktion nicht.
      if (zeilen.some(z => /\b(const|let|var|function)\s+t\b/.test(z))) verdeckt.push(kurz)
    }
  }
  check('jede Datei mit t() importiert es auch', ohneImport.length === 0, ohneImport.join(' | '))
  check('nichts verdeckt den Übersetzer', verdeckt.length === 0, verdeckt.join(' | '))

  // Ein bloßes `t` OHNE Klammern ist fast immer ein Rest: In ProfileDialog
  // stand `t === 'group'` — der Vergleich mit der Übersetzer-FUNKTION, also
  // immer falsch, und der Zweig lief nie. Die Deklarations-Prüfung oben fand
  // ihn nicht, weil dort nichts deklariert wurde.
  const alsWert = []
  for (const ort of ['client/core', 'client/engine', 'client']) {
    for (const n of readdirSync(join(wurzel, ort))) {
      if (!n.endsWith('.js') || n.includes('.test.')) continue
      const p = join(wurzel, ort, n)
      if (!statSync(p).isFile()) continue
      const q = readFileSync(p, 'utf8')
      if (!/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*['"][^'"]*i18n\.js['"]/.test(q)) continue
      q.split(/\r?\n/).forEach((z, nr) => {
        const x = z.trim()
        if (x.startsWith('//') || x.startsWith('*') || x.startsWith('/*')) return
        if (x.startsWith('import')) return
        if (/\bt\(/.test(z)) return
        if (/(^|[^.\w$])t\s*(===|!==|==|!=|\.|\[)/.test(z)) alsWert.push(`${ort}/${n}:${nr + 1}`)
      })
    }
  }
  check('der Übersetzer wird nur aufgerufen, nicht verglichen', alsWert.length === 0, alsWert.join(' | '))
}


// ── Sprache über Bündelgrenzen ──────────────────────────────────────────
// Ajna wird in VIER Bündel gepackt; jedes bekommt seine EIGENE Instanz jedes
// Moduls. Beim ersten Anlauf lag die aktive Sprache in einer Modulvariablen —
// die Shell hatte dann eine andere als die Karte, und das Umstellen wirkte
// NUR in den Einstellungen. Derselbe Fehler wie einst beim Nachrichten-Verlauf.
console.log('\n── Sprache: ein Zustand für alle Bündel')
{
  const i18n = readFileSync(new URL('../client/core/i18n.js', import.meta.url), 'utf8')
  check('der Zustand hängt an window', /g\.__ajnaI18n/.test(i18n))
  check('und wird nicht je Modul angelegt',
    !/^let _aktiv/m.test(i18n) && !/^let _katalog/m.test(i18n))

  // Der Katalog liegt in einem eigenen Bündelstück und braucht einen Rundgang.
  // Wird darauf nicht gewartet, ist der erste Aufbau deutsch — egal was
  // eingestellt ist.
  const main = readFileSync(new URL('../client/main.js', import.meta.url), 'utf8')
  const map = readFileSync(new URL('../client/map.js', import.meta.url), 'utf8')
  const mobile = readFileSync(new URL('../client/mobile.js', import.meta.url), 'utf8')
  check('die AR-Ansicht wartet auf die Sprache', /await spracheBereit/.test(main))
  check('die Karte ebenso', /await spracheBereit/.test(map))
  check('und die Shell lädt sie selbst', /await starteSprache\(\)/.test(mobile))

  const shell = readFileSync(new URL('../client/core/MobileShell.js', import.meta.url), 'utf8')
  // Neu zeichnen wäre eine Liste, die beim nächsten neuen Fenster unvollständig
  // ist — die Oberfläche wird an vielen Stellen einmal beim Start gebaut.
  check('das Umstellen lädt die Ansicht neu', /setzeSprache\(sprachWahl\.value\)[\s\S]{0,400}location\.reload\(\)/.test(shell))
  check('und sagt das auch', /die Ansicht lädt dabei neu/.test(shell))
}


// ── Delegation: ein zweites Konto darf denselben Agent-Namen führen ─────
// Ein Betreiber, der seine Agents unter einem zweiten Konto ausrollt, bekam
// sonst für alles, was dieses Konto anlegt, ein rotes „⚠ angeblich …". Der
// Namensinhaber kann jetzt sagen, wer den Namen ebenfalls führen darf.
console.log('\n── Delegation von Agent-Namen')
{
  const { AgentFilters } = await import('../client/core/AgentFilters.js')

  const bau = (manifeste) => {
    const f = new AgentFilters({ getServers: () => [] })
    f._ownerBySource = {}
    for (const m of manifeste) {
      const src = m.source
      f._ownerBySource[src] = f._ownerBySource[src] || {}
      f._ownerBySource[src][m._origin || ''] = m
    }
    return f
  }
  const objekt = (owner) => ({ owner, _origin: 'srv', state: { source: 'overpass' } })

  const ohne = bau([{ source: 'overpass', _origin: 'srv', owner: 'inhaber', owner_sealed: true }])
  check('der Inhaber selbst gilt', ohne.provenanceOf(objekt('inhaber')).status === 'agent')
  check('ein zweites Konto ohne Delegation nicht',
    ohne.provenanceOf(objekt('zweitkonto')).status === 'mismatch')

  const mit = bau([{
    source: 'overpass', _origin: 'srv', owner: 'inhaber', owner_sealed: true,
    delegates: ['zweitkonto'],
  }])
  check('ein delegiertes Konto gilt', mit.provenanceOf(objekt('zweitkonto')).status === 'agent')
  check('ein anderes weiterhin nicht', mit.provenanceOf(objekt('fremder')).status === 'mismatch')

  // DIE Sicherheitsfrage: Gelesen wird ausschliesslich die Liste des INHABERS.
  // Wer sich im eigenen — ohnehin verworfenen — Manifest selbst delegiert,
  // gewinnt nichts.
  const angriff = bau([
    { source: 'overpass', _origin: 'srv', owner: 'inhaber', owner_sealed: true, delegates: [] },
  ])
  check('die Selbst-Delegation eines Fremdmanifests zaehlt nicht',
    angriff.provenanceOf(objekt('angreifer')).status === 'mismatch')

  // Kaputte Daten duerfen nicht plötzlich alles durchlassen.
  const murks = bau([{ source: 'overpass', _origin: 'srv', owner: 'inhaber', delegates: 'alle' }])
  check('eine unbrauchbare Liste oeffnet nichts',
    murks.provenanceOf(objekt('irgendwer')).status === 'mismatch')

  // Der Server braucht dafuer KEINEN Hook: updateRule = owner ist die Absicherung.
  const mig = readFileSync(new URL('../pocketbase/pb_migrations/1787800000_manifest_delegates.js', import.meta.url), 'utf8')
  check('die Migration begruendet, warum kein Hook noetig ist', /updateRule/.test(mig))

  const client = readFileSync(new URL('../client/core/AjnaClient.js', import.meta.url), 'utf8')
  // Ein Agent, der nichts von Delegation weiss, darf die Liste nicht loeschen.
  check('ohne Angabe bleibt die Liste unangetastet',
    /if \(Array\.isArray\(manifest\.delegates\)\)/.test(client))

  const base = readFileSync(new URL('../agents/lib/agent-base.mjs', import.meta.url), 'utf8')
  check('jeder Agent kann sie ueber die Umgebung setzen', /AJNA_DELEGATES/.test(base))
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
