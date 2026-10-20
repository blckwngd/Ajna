// Tests für den Schleifenschutz in AjnaClient.refreshObjects().
//
// DER GEMELDETE FEHLER. HeimatRadars Orga-Sicht hält ihre Liste über
// `onObjectsChanged` aktuell und holte im Handler den Bestand neu. Da
// `refreshObjects()` dieses Ereignis selbst auslöst, rief sich die Kette
// sofort wieder — und der Nutzer sah bei jeder Freigabe „Die Anmeldungen
// liessen sich nicht laden". Das war der vom SDK abgebrochene Zwilling.
//
// WARUM DAS SCHLIMMER WERDEN KONNTE: Seit `requestKey: null` storniert das SDK
// nicht mehr. Ohne Single-Flight wäre aus der Fehlermeldung eine
// ENDLOSSCHLEIFE von Vollabrufen geworden — ein Fehler, der nicht mehr auffällt,
// sondern nur den Server belastet.
//
// Geprüft wird mit einem untergeschobenen `pb`: kein Netz, kein Browser.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AjnaClient } from './AjnaClient.js'

/**
 * Ein `pb`, das zählt, wie oft der Vollabruf wirklich stattfindet, und das
 * langsam genug ist, dass sich Aufrufe überlappen können.
 */
function pbStub({ verzoegerung = 20, items = [] } = {}) {
  const zaehler = { getFullList: 0, subscribe: 0 }
  return {
    zaehler,
    authStore: { isValid: true, record: { id: 'u1' } },
    baseUrl: 'http://example.invalid',
    realtime: { subscribe: async () => () => {} },
    collection() {
      return {
        getFullList: async () => {
          zaehler.getFullList++
          await new Promise(r => setTimeout(r, verzoegerung))
          return items.map(o => ({ ...o }))
        },
        subscribe: async () => { zaehler.subscribe++; return () => {} },
      }
    },
  }
}

const mach = (pb) => new AjnaClient({ id: 'srv', pb })

test('zwei gleichzeitige Aufrufe teilen EINEN Abruf', () => {
  const pb = pbStub()
  const c = mach(pb)
  return Promise.all([c.refreshObjects(), c.refreshObjects(), c.refreshObjects()])
    .then(() => assert.equal(pb.zaehler.getFullList, 1, `${pb.zaehler.getFullList} Abrufe`))
})

test('alle Aufrufer bekommen dasselbe Ergebnis', async () => {
  const pb = pbStub({ items: [{ id: 'a', type: 'x' }, { id: 'b', type: 'y' }] })
  const c = mach(pb)
  const [a, b] = await Promise.all([c.refreshObjects(), c.refreshObjects()])
  assert.equal(a.length, 2)
  assert.deepEqual(a.map(o => o.id), b.map(o => o.id))
})

test('DER RÜCKRUF IM EREIGNIS LÄUFT NICHT IM KREIS', () => {
  // Genau der gemeldete Fall: der Handler holt im `objectsChanged` neu.
  // Ohne Single-Flight liefe das endlos (oder würde storniert).
  const pb = pbStub()
  const c = mach(pb)
  let tiefe = 0
  c.onObjectsChanged(() => {
    if (tiefe++ > 50) throw new Error('Endlosschleife')
    c.refreshObjects().catch(() => {})
  })
  return c.refreshObjects().then(() => {
    assert.ok(pb.zaehler.getFullList <= 2,
      `${pb.zaehler.getFullList} Abrufe — der Kreis ist nicht geschlossen`)
  })
})

test('nach dem Abschluss ist ein NEUER Abruf wieder möglich', async () => {
  const pb = pbStub({ verzoegerung: 1 })
  const c = mach(pb)
  await c.refreshObjects()
  await c.refreshObjects()
  assert.equal(pb.zaehler.getFullList, 2, 'der zweite Aufruf muss wirklich holen')
})

test('ein Fehler bleibt ein Fehler und blockiert nichts', async () => {
  let erster = true
  const pb = pbStub()
  const c = mach(pb)
  const echt = pb.collection
  pb.collection = () => ({
    ...echt(),
    getFullList: async () => {
      if (erster) { erster = false; throw new Error('Netz weg') }
      pb.zaehler.getFullList++
      return []
    },
    subscribe: async () => () => {},
  })
  await assert.rejects(() => c.refreshObjects(), /Netz weg/)
  // Der Platz muss wieder frei sein — sonst hinge der Client nach einem
  // einzigen Netzfehler dauerhaft an einer abgelehnten Zusage.
  await c.refreshObjects()
  assert.equal(pb.zaehler.getFullList, 1)
})

test('das Abo wird nur einmal eingerichtet', async () => {
  const pb = pbStub({ verzoegerung: 1 })
  const c = mach(pb)
  await c.refreshObjects()
  await c.refreshObjects()
  assert.equal(pb.zaehler.subscribe, 1)
})
