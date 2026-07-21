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
  set textContent(v) { this._text = v }, get textContent() { return this._text },
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

const failed = results.filter(r => !r.ok)
console.log(`\n${'═'.repeat(60)}`)
console.log(`UI: ${results.length - failed.length} bestanden, ${failed.length} fehlgeschlagen`)
if (failed.length) {
  console.log('\nFehlgeschlagen:')
  for (const f of failed) console.log('  ❌ ' + f.name)
  process.exit(1)
}
console.log('✅ alles grün')
