import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blickfeld, beschreibeBlickfeld, sektor, richtungsWort, neueBlickrichtung, lokal, peilung } from './blickfeld.mjs'

const HERE = { lat: 50.3569, lon: 7.5890 }
// a point N metres north / east of HERE
const bei = (n, e) => ({ lat: HERE.lat + n / 111_320, lon: HERE.lon + e / (111_320 * Math.cos(HERE.lat * Math.PI / 180)) })

test('local metres and bearings are right-handed and north-based', () => {
  const p = lokal(HERE.lat, HERE.lon, bei(100, 0).lat, bei(100, 0).lon)
  assert.ok(Math.abs(p.z - 100) < 0.01 && Math.abs(p.x) < 0.01)
  assert.equal(Math.round(peilung(lokal(HERE.lat, HERE.lon, bei(0, 50).lat, bei(0, 50).lon))), 90)
  assert.equal(richtungsWort(0), 'Norden'); assert.equal(richtungsWort(89), 'Osten'); assert.equal(richtungsWort(315), 'Nordwesten'); assert.equal(richtungsWort(359), 'Norden')
})

test('sectors: in front, half right, right, behind — and the mirror', () => {
  assert.equal(sektor(0), 'vorn'); assert.equal(sektor(-20), 'vorn')
  assert.equal(sektor(45), 'halb rechts'); assert.equal(sektor(-45), 'halb links')
  assert.equal(sektor(90), 'rechts'); assert.equal(sektor(-100), 'links')
  assert.equal(sektor(130), 'schräg hinten rechts'); assert.equal(sektor(179), 'hinten'); assert.equal(sektor(-179), 'hinten')
})

test('the view: what is in front is seen, what is behind is named as out of view', () => {
  const b = blickfeld({
    self: { ...HERE, headingDeg: 0 },
    objects: [
      { id: 'truhe', name: 'Truhe', ...bei(12, 0), size: { h: 1 } },
      { id: 'bank', name: 'Bank', ...bei(-15, 0), size: { h: 0.9 } },
      { id: 'weit', name: 'Turm', ...bei(300, 0), size: { h: 20 } },
    ],
  })
  assert.equal(b.richtung, 'Norden')
  const truhe = b.eintraege.find(e => e.id === 'truhe')
  assert.equal(truhe.sichtbar, true); assert.equal(truhe.sektor, 'vorn'); assert.equal(truhe.distM, 12)
  const bank = b.eintraege.find(e => e.id === 'bank')
  assert.equal(bank.imBlick, false); assert.equal(bank.sektor, 'hinten')
  assert.ok(!b.eintraege.some(e => e.id === 'weit'), 'beyond maxM it is not part of the view')
  const text = beschreibeBlickfeld(b)
  assert.match(text, /^Du blickst nach Norden \(0°\)\./)
  assert.match(text, /Im Blick: Truhe \[truhe\] 12 m vorn/)
  assert.match(text, /Außerhalb des Blicks: Bank \[bank\] 15 m hinten/)
})

test('a building between figure and object hides it — unless it is too low or beside the line', () => {
  // a 10 m × 10 m house, 8 m tall, centred 20 m north
  const haus = { name: 'Haus', hoehe: 8, coordinates: [bei(15, -5), bei(15, 5), bei(25, 5), bei(25, -5)].map(p => [p.lat, p.lon]) }
  const spieler = { id: 'p', name: 'Andreas', ...bei(40, 0), size: { h: 1.8 } }
  const hinter = blickfeld({ self: { ...HERE, headingDeg: 0 }, objects: [spieler], buildings: [haus] })
  assert.equal(hinter.eintraege[0].sichtbar, false)
  assert.equal(hinter.eintraege[0].verdecktVon, 'Haus')
  assert.match(beschreibeBlickfeld(hinter), /Verdeckt: Andreas \[p\] 40 m vorn, hinter Haus/)
  // the same house, but only a 1 m wall: the line of sight passes above it
  const mauer = { ...haus, name: 'Mauer', hoehe: 1 }
  assert.equal(blickfeld({ self: { ...HERE, headingDeg: 0 }, objects: [spieler], buildings: [mauer] }).eintraege[0].sichtbar, true)
  // the house beside the line: not in the way
  const daneben = { ...haus, coordinates: [bei(15, 10), bei(15, 20), bei(25, 20), bei(25, 10)].map(p => [p.lat, p.lon]) }
  assert.equal(blickfeld({ self: { ...HERE, headingDeg: 0 }, objects: [spieler], buildings: [daneben] }).eintraege[0].sichtbar, true)
})

test('a big object hides a small one behind it; a small one hides nothing', () => {
  const drache = { id: 'd', name: 'Drache', ...bei(10, 0), size: { w: 6, h: 6, d: 6 } }
  const muenze = { id: 'm', name: 'Münze', ...bei(20, 0), size: { h: 0.3 } }
  const b = blickfeld({ self: { ...HERE, headingDeg: 0 }, objects: [drache, muenze] })
  assert.equal(b.eintraege.find(e => e.id === 'm').verdecktVon, 'Drache')
  const b2 = blickfeld({ self: { ...HERE, headingDeg: 0 }, objects: [{ ...muenze, ...bei(10, 0) }, { ...drache, ...bei(20, 0) }] })
  assert.equal(b2.eintraege.find(e => e.id === 'd').sichtbar, true, 'a coin does not hide a dragon')
})

test('turning the head: words and degrees', () => {
  assert.equal(neueBlickrichtung(0, 'rechts'), 90)
  assert.equal(neueBlickrichtung(0, 'links'), 270)
  assert.equal(neueBlickrichtung(45, 'um'), 225)
  assert.equal(neueBlickrichtung(10, 'Süden'), 180)
  assert.equal(neueBlickrichtung(10, 135), 135)
  assert.equal(neueBlickrichtung(10, '350'), 350)
  assert.equal(neueBlickrichtung(10, ''), 10)
  assert.equal(neueBlickrichtung(10, 'schief'), null)
})
