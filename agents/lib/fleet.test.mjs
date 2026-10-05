// Tests für agents/lib/fleet.mjs.
//
// Schwerpunkt sind die drei Fallen aus dem Dateikopf — sie sind der Grund,
// warum es die Bibliothek gibt. Jede davon hat in einem der Agents schon
// einmal Dubletten oder verschwundene Objekte erzeugt.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Fleet } from './fleet.mjs'

/** Ein AjnaManager-Doppel, das mitschreibt. */
function ajnaDoppel({ createFehler = 0 } = {}) {
  let nr = 0, fehlerUebrig = createFehler
  const protokoll = []
  return {
    protokoll,
    async createObject(data) {
      protokoll.push(['create', data])
      if (fehlerUebrig > 0) { fehlerUebrig--; throw new Error('Serverfehler') }
      return { id: 'obj' + (++nr), ...data }
    },
    async updateObject(id, patch) { protokoll.push(['update', id, patch]); return { id } },
    async deleteObject(id) { protokoll.push(['delete', id]); return true },
  }
}

const bau = (ajna, opts = {}) => new Fleet(ajna, {
  type: 'ship', source: 'probe', keyField: 'mmsi',
  updateIntervalMs: 1000, staleMs: 10_000,
  log: () => {}, warn: () => {}, ...opts,
})

const SICHT = { name: 'Rhenus', lat: 50.4, lon: 7.5, headingDeg: 90 }

test('die erste Sichtung legt an, die zweite ändert', async () => {
  const ajna = ajnaDoppel()
  const f = bau(ajna)
  assert.equal(await f.seen('211', SICHT, 1000), 'created')
  assert.equal(await f.seen('211', { ...SICHT, lat: 50.41 }, 5000), 'updated')
  assert.deepEqual(ajna.protokoll.map(p => p[0]), ['create', 'update'])
})

test('Kennung und Quelle stehen immer im Zustand', async () => {
  const ajna = ajnaDoppel()
  await bau(ajna).seen('211', { ...SICHT, state: { speed: 12 } }, 1000)
  const [, data] = ajna.protokoll[0]
  assert.equal(data.state.mmsi, '211')
  assert.equal(data.state.source, 'probe')
  assert.equal(data.state.speed, 12)
  assert.equal(data.type, 'ship')
})

test('FALLE 1: zwei gleichzeitige Sichtungen ergeben EIN Objekt', async () => {
  // Ohne die vorab belegte Stelle sähen beide „noch nicht bekannt" — und in
  // der Welt stünden zwei Schiffe mit derselben MMSI.
  const ajna = ajnaDoppel()
  const f = bau(ajna)
  const [a, b] = await Promise.all([f.seen('211', SICHT, 1000), f.seen('211', SICHT, 1000)])
  assert.equal(ajna.protokoll.filter(p => p[0] === 'create').length, 1)
  assert.deepEqual([a, b].sort(), ['busy', 'created'])
  assert.equal(f.size, 1)
})

test('FALLE 2: nach einem gescheiterten Anlegen wird es erneut versucht', async () => {
  // Bliebe die Stelle belegt, erschiene dieses Schiff bis zum Neustart nie —
  // ohne dass irgendwo ein Fehler auffiele.
  const ajna = ajnaDoppel({ createFehler: 1 })
  const f = bau(ajna)
  assert.equal(await f.seen('211', SICHT, 1000), 'failed')
  assert.equal(f.size, 0, 'die Stelle ist wieder frei')
  assert.equal(await f.seen('211', SICHT, 2000), 'created')
})

test('FALLE 3: Übernommenes gilt als eben gesehen', async () => {
  // Sonst räumt der erste Durchlauf nach einem Neustart alles weg, was vorher
  // da war — eine Sekunde nach dem Start.
  const ajna = ajnaDoppel()
  const f = bau(ajna)
  const n = f.adopt([{ id: 'alt1', type: 'ship', name: 'Alt', state: { mmsi: '999', source: 'probe' } }], 1000)
  assert.equal(n, 1)
  assert.equal(await f.sweep(1500), 0)
  assert.equal(f.objectIdOf('999'), 'alt1')
})

test('übernommen wird nur, was zu dieser Flotte gehört', async () => {
  // Zwei Agents unter einem Konto dürfen sich nicht gegenseitig die Objekte
  // wegnehmen.
  const f = bau(ajnaDoppel())
  const n = f.adopt([
    { id: 'a', type: 'ship', state: { mmsi: '1', source: 'probe' } },
    { id: 'b', type: 'aircraft', state: { mmsi: '2', source: 'probe' } },   // anderer Typ
    { id: 'c', type: 'ship', state: { mmsi: '3', source: 'fremd' } },       // andere Quelle
    { id: 'd', type: 'ship', state: { source: 'probe' } },                  // ohne Kennung
  ])
  assert.equal(n, 1)
  assert.ok(f.has('1'))
})

test('die Drossel hält den Schreibtakt ein', async () => {
  const ajna = ajnaDoppel()
  const f = bau(ajna)
  await f.seen('211', SICHT, 1000)
  assert.equal(await f.seen('211', SICHT, 1500), 'throttled')
  assert.equal(await f.seen('211', SICHT, 2100), 'updated')
})

test('der Name wird nur geschrieben, wenn er sich ändert', async () => {
  // Jede Änderung löst eine Realtime-Nachricht an alle Clients aus. Denselben
  // Namen mitzuschicken heisst, allen etwas zu erzählen, das sie schon wissen.
  const ajna = ajnaDoppel()
  const f = bau(ajna)
  await f.seen('211', SICHT, 1000)
  await f.seen('211', SICHT, 3000)
  const [, , patch1] = ajna.protokoll[1]
  assert.ok(!('name' in patch1))
  await f.seen('211', { ...SICHT, name: 'Rhenus II' }, 5000)
  const [, , patch2] = ajna.protokoll[2]
  assert.equal(patch2.name, 'Rhenus II')
})

test('eine Sichtung ohne brauchbare Position wird verworfen', async () => {
  const ajna = ajnaDoppel()
  const f = bau(ajna)
  assert.equal(await f.seen('211', { name: 'x', lat: NaN, lon: 7 }, 1000), 'failed')
  assert.equal(await f.seen('211', { name: 'x' }, 1000), 'failed')
  assert.equal(ajna.protokoll.length, 0)
})

test('sweep entfernt, was lange nicht mehr gesehen wurde', async () => {
  const ajna = ajnaDoppel()
  const f = bau(ajna)
  await f.seen('211', SICHT, 1000)
  await f.seen('212', SICHT, 1000)
  await f.seen('212', SICHT, 8000)
  assert.equal(await f.sweep(12_000), 1, 'nur das ältere')
  assert.ok(!f.has('211'))
  assert.ok(f.has('212'))
})

test('sweep kann einzelne verschonen', async () => {
  const ajna = ajnaDoppel()
  const f = bau(ajna)
  await f.seen('211', SICHT, 1000)
  assert.equal(await f.sweep(99_000, (key) => key === '211'), 0)
  assert.ok(f.has('211'))
})

test('drop entfernt sofort — für Quellen, die sich verabschieden', async () => {
  const ajna = ajnaDoppel()
  const f = bau(ajna)
  await f.seen('211', SICHT, 1000)
  assert.equal(await f.drop('211'), true)
  assert.equal(f.size, 0)
  assert.equal(ajna.protokoll.at(-1)[0], 'delete')
  assert.equal(await f.drop('211'), false, 'zweimal löschen ist kein Fehler')
})

test('ein bereits serverseitig gelöschtes Objekt wird still hingenommen', async () => {
  let gewarnt = 0
  const ajna = ajnaDoppel()
  ajna.deleteObject = async () => { throw new Error('The requested resource was not found.') }
  const f = bau(ajna, { warn: () => { gewarnt++ } })
  await f.seen('211', SICHT, 1000)
  assert.equal(await f.drop('211'), false)
  assert.equal(gewarnt, 0, 'ein 404 beim Löschen ist der Normalfall, keine Warnung wert')
})

test('der Kurs wird in die Blickrichtung der Szene umgerechnet', async () => {
  const ajna = ajnaDoppel()
  await bau(ajna).seen('211', { ...SICHT, headingDeg: 0 }, 1000)
  const [, data] = ajna.protokoll[0]
  assert.equal(typeof data.rotation.y, 'number')
  // Ohne Kurs bleibt die Drehung weg, statt 0 zu behaupten.
  const ajna2 = ajnaDoppel()
  await bau(ajna2).seen('211', { name: 'x', lat: 1, lon: 2 }, 1000)
  assert.ok(!('rotation' in ajna2.protokoll[0][1]))
})

test('Fleet ohne Pflichtangaben wird gar nicht erst gebaut', () => {
  assert.throws(() => new Fleet({}, { type: 'ship' }), /type, source and keyField/)
})

// ─── FALLE 4: Waisen ──────────────────────────────────────────────────────
//
// GEMESSEN AM 05.10.2026: In der Entwicklungsdatenbank lagen 2549 tote
// C-ITS-Objekte — 79 % der ganzen Welt —, obwohl der Agent auf 300 gedeckelt
// war. Ein Objekt, das die Flotte vergisst, löscht niemand mehr; und weil der
// frei gewordene Platz sofort ein neues zuliess, vermehrte sich der Fehler
// selbst. Beide Wege dorthin stehen unten.
//
// Diese Fälle brauchen ein Doppel mit BREMSE: Sie treten auf, WÄHREND ein
// createObject unterwegs ist. `ajnaDoppel` oben antwortet sofort.

/** Wie ajnaDoppel, aber der Zeitpunkt der Antwort ist steuerbar. */
function ajnaMitBremse() {
  let nr = 0
  const objekte = new Map()
  const offen = []
  const loeschFehler = { an: false }
  return {
    objekte, loeschFehler,
    createFertig: () => { const f = offen.shift(); if (f) f(); return !!f },
    createObject: (data) => new Promise((res) => offen.push(() => {
      const id = 'obj' + (++nr)
      objekte.set(id, data)
      res({ id, ...data })
    })),
    async updateObject(id, patch) { return { id, ...patch } },
    async deleteObject(id) {
      if (loeschFehler.an) throw new Error('Serverfehler beim Löschen')
      if (!objekte.has(id)) throw new Error('not found')
      objekte.delete(id)
    },
  }
}

const bauBremse = (ajna, opts = {}) => new Fleet(ajna, {
  type: 'cits', source: 'cits', keyField: 'mac',
  updateIntervalMs: 0, staleMs: 10_000,
  log: () => {}, warn: () => {}, ...opts,
})
const SICHT4 = { name: 'Flüchtig', lat: 50.4, lon: 7.5 }
const tick = () => new Promise(r => setTimeout(r, 0))

test('FALLE 4: Abmeldung während des Anlegens hinterlässt keine Waise', async () => {
  // Der Fehler: `drop()` warf den Slot weg, solange `objectId` noch null war.
  // Das Anlegen lief durch und schrieb die ID auf einen Slot, den die Map
  // nicht mehr kannte — kein `sweep()` fand das Objekt je wieder.
  const ajna = ajnaMitBremse()
  const f = bauBremse(ajna)

  const p = f.seen('aa', SICHT4)
  await tick()
  assert.equal(f.size, 1, 'Platz ist reserviert')
  await f.drop('aa')                 // Abmeldung mitten im Anlegen
  ajna.createFertig()
  assert.equal(await p, 'dropped')
  await tick()

  assert.equal(ajna.objekte.size, 0, `${ajna.objekte.size} Objekt(e) verwaist auf dem Server`)
  assert.equal(f.size, 0)
})

test('nach so einer Abmeldung lässt sich derselbe Schlüssel neu anlegen', async () => {
  const ajna = ajnaMitBremse()
  const f = bauBremse(ajna)
  const p = f.seen('aa', SICHT4)
  await tick(); await f.drop('aa'); ajna.createFertig(); await p; await tick()

  const p2 = f.seen('aa', { ...SICHT4, name: 'Wieder da' })
  ajna.createFertig()
  assert.equal(await p2, 'created')
  assert.equal(ajna.objekte.size, 1)
})

test('FALLE 4: ein fehlgeschlagenes Löschen gilt NICHT als erledigt', async () => {
  // Der zweite Weg zur Waise: Der Slot verschwand auch dann, wenn der Server
  // abgelehnt hatte. Das Objekt blieb liegen, der Agent vergass es.
  const ajna = ajnaMitBremse()
  const f = bauBremse(ajna)
  const p = f.seen('aa', SICHT4); ajna.createFertig(); await p

  ajna.loeschFehler.an = true
  assert.equal(await f.drop('aa'), false)
  assert.equal(f.size, 1, 'der Agent muss es weiter kennen')
  assert.equal(ajna.objekte.size, 1)

  ajna.loeschFehler.an = false
  assert.equal(await f.drop('aa'), true)
  assert.equal(f.size, 0)
  assert.equal(ajna.objekte.size, 0)
})

test('der Aufräumlauf holt nach, was beim Löschen scheiterte', async () => {
  const ajna = ajnaMitBremse()
  const f = bauBremse(ajna, { staleMs: 1000 })
  const p = f.seen('aa', SICHT4, 0); ajna.createFertig(); await p

  ajna.loeschFehler.an = true
  assert.equal(await f.sweep(5000), 0, 'nichts entfernt, weil der Server streikte')
  assert.equal(f.size, 1, 'aber weiterhin bekannt')

  ajna.loeschFehler.an = false
  assert.equal(await f.sweep(6000), 1)
  assert.equal(ajna.objekte.size, 0)
})

test('eine Obergrenze bleibt eine Obergrenze — auch über viele Zyklen', async () => {
  // DAS SCHADENSBILD IM KLEINEN: Jede Waise gab ihren Platz frei. Bei 300
  // erlaubten Objekten entstanden so über 2500. Zwanzig Runden mit je einer
  // Abmeldung mitten im Anlegen dürfen null Objekte hinterlassen.
  const ajna = ajnaMitBremse()
  const f = bauBremse(ajna)
  for (let i = 0; i < 20; i++) {
    const p = f.seen('k' + i, SICHT4)
    await tick()
    await f.drop('k' + i)
    ajna.createFertig()
    await p
  }
  await tick()
  assert.equal(ajna.objekte.size, 0, `${ajna.objekte.size} Waisen nach 20 Runden`)
  assert.equal(f.size, 0)
})
