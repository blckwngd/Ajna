// Wer führt einen Agentennamen? — die Regel, an der die Inhaltsfilter hängen.
//
// Der Fehler, den diese Tests festnageln: `created` war auf gewachsenen
// Instanzen leer (das Feld kam per Migration dazu, PocketBase füllt Autodate
// nicht nach). Die Entscheidung fiel dadurch nach Datensatz-ID — also nach
// einem Zufallsstring. Ein totes Konto hielt so fünf von acht Namen, und die
// Filter griffen nicht mehr.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anspruchsZeit, beanspruchtFrueher } from './AgentFilters.js'

const m = (o) => ({ id: 'zzz', source: 'poi', ...o })

test('anspruchsZeit nimmt created, wenn es da ist', () => {
  assert.equal(anspruchsZeit(m({ created: '2026-01-01 10:00', updated: '2026-09-01 10:00' })),
    '2026-01-01 10:00')
})

test('anspruchsZeit weicht auf updated aus, wenn created leer ist', () => {
  // Genau der Fall auf einer gewachsenen Instanz.
  assert.equal(anspruchsZeit(m({ created: '', updated: '2026-08-28 22:47' })), '2026-08-28 22:47')
  assert.equal(anspruchsZeit(m({ updated: '2026-08-28 22:47' })), '2026-08-28 22:47')
})

test('anspruchsZeit sagt "unbekannt" statt zu raten', () => {
  assert.equal(anspruchsZeit(m({})), '')
  assert.equal(anspruchsZeit(null), '')
})

test('der ältere Anspruch gewinnt', () => {
  const alt = m({ id: 'zzz', created: '2026-01-01 10:00' })
  const neu = m({ id: 'aaa', created: '2026-09-01 10:00' })
  assert.equal(beanspruchtFrueher(alt, neu), true, 'alt schlägt neu')
  assert.equal(beanspruchtFrueher(neu, alt), false, 'neu schlägt alt NICHT')
})

test('die Datensatz-ID entscheidet NICHT, solange Zeiten verfügbar sind', () => {
  // DIE FALLE: Früher gewann hier 'aaa' gegen 'zzz' — obwohl 'zzz' drei
  // Wochen älter war. Genau so hielt ein totes Konto seine Namen.
  const altOhneCreated = m({ id: 'zzz', created: '', updated: '2026-08-28 22:47' })
  const neuOhneCreated = m({ id: 'aaa', created: '', updated: '2026-09-18 07:06' })
  assert.equal(beanspruchtFrueher(altOhneCreated, neuOhneCreated), true,
    'der ältere updated-Stand gewinnt, nicht die kleinere ID')
  assert.equal(beanspruchtFrueher(neuOhneCreated, altOhneCreated), false)
})

test('gemischt: ein datiertes Manifest gegen ein undatiertes', () => {
  // Ohne jede Zeitangabe gilt ein Eintrag als "so alt wie möglich". Das ist die
  // sichere Seite: Ein Name wird dadurch nicht übernehmbar, sondern höchstens
  // zu treu gehalten.
  const ohne = m({ id: 'aaa' })
  const mit = m({ id: 'bbb', created: '2020-01-01 00:00' })
  assert.equal(beanspruchtFrueher(ohne, mit), true)
  assert.equal(beanspruchtFrueher(mit, ohne), false)
})

test('bei exakt gleicher Zeit entscheidet die ID — stabil, nicht zufällig', () => {
  const a = m({ id: 'aaa', created: '2026-05-05 12:00' })
  const b = m({ id: 'bbb', created: '2026-05-05 12:00' })
  assert.equal(beanspruchtFrueher(a, b), true)
  assert.equal(beanspruchtFrueher(b, a), false)
  // Und die Reihenfolge ist umkehrungsfest: genau einer gewinnt.
  assert.notEqual(beanspruchtFrueher(a, b), beanspruchtFrueher(b, a))
})
