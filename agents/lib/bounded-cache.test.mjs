// Tests für agents/lib/bounded-cache.mjs.
//
// Die Uhr wird hereingegeben, damit Verfall ohne Warten prüfbar ist. Was hier
// zählt, ist nicht „der Cache merkt sich etwas" — das ist die leichte Hälfte —
// sondern dass er unter Druck eine OBERGRENZE einhält. Genau das hat
// `world-director` nicht getan, und daran ist ein 2-GB-Server gestorben.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BoundedCache, boundedCache } from './bounded-cache.mjs'

/** Eine Uhr, die man von Hand weiterdreht. */
const uhr = (start = 1_000_000) => {
  let t = start
  return { jetzt: () => t, weiter: (ms) => { t += ms } }
}

// ─── Das Grundsätzliche ───────────────────────────────────────────────────

test('speichert und gibt zurück', () => {
  const c = new BoundedCache({ maxEntries: 4 })
  c.set('a', 1).set('b', { tief: true })
  assert.equal(c.get('a'), 1)
  assert.deepEqual(c.get('b'), { tief: true })
  assert.equal(c.get('fehlt'), undefined)
  assert.equal(c.size, 2)
})

test('has und peek verraten dasselbe wie get, ohne Nebenwirkung', () => {
  const c = new BoundedCache({ maxEntries: 4 })
  c.set('a', 1)
  assert.equal(c.has('a'), true)
  assert.equal(c.has('b'), false)
  assert.equal(c.peek('a'), 1)
  assert.equal(c.hits, 0, 'peek zählt keinen Treffer')
})

test('ein Wert, der wie „leer" aussieht, bleibt unterscheidbar', () => {
  // 0, '' und false sind gültige Werte. Nur `undefined` heisst „nicht da".
  const c = new BoundedCache({ maxEntries: 4 })
  c.set('null', 0).set('leer', '').set('falsch', false)
  assert.equal(c.get('null'), 0)
  assert.equal(c.get('leer'), '')
  assert.equal(c.get('falsch'), false)
  assert.equal(c.has('null'), true)
})

// ─── Die Obergrenze ───────────────────────────────────────────────────────

test('DIE OBERGRENZE HÄLT, auch wenn man sie überrennt', () => {
  // Das ist der Punkt des ganzen Moduls. Ohne diese Zusicherung ist jede
  // Speicherrechnung für den VPS geraten.
  const c = new BoundedCache({ maxEntries: 10 })
  for (let i = 0; i < 1000; i++) c.set(`zelle-${i}`, { gross: 'x'.repeat(100) })
  assert.equal(c.size, 10)
  assert.equal(c.evictions, 990)
})

test('verdrängt wird der am längsten UNBENUTZTE, nicht der älteste', () => {
  // Eine Zelle, durch die die Figuren dauernd laufen, soll einen Ausflug in
  // die Vorstadt überleben.
  const c = new BoundedCache({ maxEntries: 3 })
  c.set('heimat', 1).set('b', 2).set('c', 3)
  c.get('heimat')              // benutzt → wird jung
  c.set('d', 4)                // verdrängt 'b'
  assert.equal(c.get('heimat'), 1, 'die benutzte Zelle ist noch da')
  assert.equal(c.get('b'), undefined, 'die unbenutzte ist weg')
  assert.deepEqual(c.keys().sort(), ['c', 'd', 'heimat'])
})

test('der gerade geschriebene Eintrag wird nie selbst verdrängt', () => {
  const c = new BoundedCache({ maxEntries: 1 })
  c.set('a', 1)
  c.set('b', 2)
  assert.equal(c.get('b'), 2)
  assert.equal(c.get('a'), undefined)
  assert.equal(c.size, 1)
})

test('dasselbe Schlüsselwort zweimal wächst nicht', () => {
  const c = new BoundedCache({ maxEntries: 5 })
  for (let i = 0; i < 50; i++) c.set('immer-gleich', i)
  assert.equal(c.size, 1)
  assert.equal(c.get('immer-gleich'), 49)
  assert.equal(c.evictions, 0, 'Überschreiben ist keine Verdrängung')
})

test('VERFALLENES GEHT VOR BENUTZTEM, wenn Platz gebraucht wird', () => {
  // Etwas Abgelaufenes wegzuwerfen kostet nichts; etwas Gültiges wegzuwerfen
  // ist ein Verlust. Also erst aufräumen, dann verdrängen.
  const u = uhr()
  const c = new BoundedCache({ maxEntries: 3, ttlMs: 1000, now: u.jetzt })
  c.set('alt1', 1).set('alt2', 2)
  u.weiter(1500)                // alt1 und alt2 sind verfallen
  c.set('frisch', 3)
  c.get('frisch')
  c.set('neu', 4)               // Platz da: die verfallenen gehen
  assert.equal(c.get('frisch'), 3, 'das Gültige steht noch')
  assert.equal(c.get('neu'), 4)
  assert.equal(c.evictions, 0, 'niemand musste verdrängt werden')
  assert.ok(c.expirations >= 2)
})

// ─── Verfall ──────────────────────────────────────────────────────────────

test('ein verfallener Eintrag wird nicht mehr ausgegeben', () => {
  const u = uhr()
  const c = new BoundedCache({ maxEntries: 4, ttlMs: 1000, now: u.jetzt })
  c.set('a', 1)
  u.weiter(999)
  assert.equal(c.get('a'), 1, 'eine Millisekunde vor Schluss gilt er noch')
  u.weiter(1)
  assert.equal(c.get('a'), undefined)
  assert.equal(c.has('a'), false)
  assert.equal(c.size, 0, 'und er ist beim Lesen gleich mit weggeräumt')
})

test('ttlMs 0 heisst „verfällt nicht" — die Obergrenze gilt trotzdem', () => {
  const u = uhr()
  const c = new BoundedCache({ maxEntries: 2, ttlMs: 0, now: u.jetzt })
  c.set('a', 1)
  u.weiter(100 * 365 * 24 * 3600 * 1000)
  assert.equal(c.get('a'), 1)
  c.set('b', 2); c.set('c', 3)
  assert.equal(c.size, 2)
})

test('Schreiben frischt das Alter auf', () => {
  const u = uhr()
  const c = new BoundedCache({ maxEntries: 4, ttlMs: 1000, now: u.jetzt })
  c.set('a', 1)
  u.weiter(900)
  c.set('a', 2)
  u.weiter(900)
  assert.equal(c.get('a'), 2, 'die Frist läuft ab dem letzten Schreiben')
})

test('LESEN frischt das Alter NICHT auf', () => {
  // Sonst würde ein gern gelesener Eintrag nie erneuert, und der Cache liefert
  // beliebig alte Daten als wären sie frisch. Lesen ordnet nur die Nutzung um.
  const u = uhr()
  const c = new BoundedCache({ maxEntries: 4, ttlMs: 1000, now: u.jetzt })
  c.set('a', 1)
  u.weiter(900); c.get('a')
  u.weiter(200)
  assert.equal(c.get('a'), undefined, 'nach 1100 ms ist er fällig')
})

test('prune räumt alles Verfallene auf einmal weg', () => {
  const u = uhr()
  const c = new BoundedCache({ maxEntries: 100, ttlMs: 1000, now: u.jetzt })
  for (let i = 0; i < 10; i++) c.set(`a${i}`, i)
  u.weiter(1500)
  for (let i = 0; i < 3; i++) c.set(`neu${i}`, i)
  assert.equal(c.prune(), 10)
  assert.equal(c.size, 3)
  assert.equal(c.prune(), 0, 'zweimal aufräumen findet nichts mehr')
})

// ─── onEvict ──────────────────────────────────────────────────────────────

test('onEvict nennt den Grund, warum ein Eintrag geht', () => {
  const u = uhr()
  const gruende = []
  const c = new BoundedCache({
    maxEntries: 2, ttlMs: 1000, now: u.jetzt,
    onEvict: (k, v, grund) => gruende.push(`${k}:${grund}`),
  })
  c.set('a', 1); c.set('b', 2)
  c.set('a', 9)                       // ersetzt
  c.set('c', 3)                       // verdrängt den unbenutztesten
  u.weiter(2000); c.get('c')          // verfallen
  assert.ok(gruende.includes('a:replaced'), gruende.join(','))
  assert.ok(gruende.some(g => g.endsWith(':evicted')), gruende.join(','))
  assert.ok(gruende.some(g => g.endsWith(':expired')), gruende.join(','))
})

test('derselbe Wert erneut geschrieben meldet kein replaced', () => {
  const gruende = []
  const c = new BoundedCache({ maxEntries: 4, onEvict: (k, v, g) => gruende.push(g) })
  const wert = { a: 1 }
  c.set('x', wert); c.set('x', wert)
  assert.deepEqual(gruende, [])
})

test('delete und clear rufen onEvict NICHT — das ist eine Absicht', () => {
  // Wer löscht, weiss es schon. onEvict ist für das, was der Cache von selbst
  // tut; sonst könnte man Verdrängung nicht von Aufräumen unterscheiden.
  const gruende = []
  const c = new BoundedCache({ maxEntries: 4, onEvict: (k, v, g) => gruende.push(g) })
  c.set('a', 1).set('b', 2)
  assert.equal(c.delete('a'), true)
  assert.equal(c.delete('a'), false)
  c.clear()
  assert.deepEqual(gruende, [])
  assert.equal(c.size, 0)
})

// ─── Falsche Bedienung ────────────────────────────────────────────────────

test('eine unsinnige Obergrenze wird abgelehnt, nicht stillschweigend geheilt', () => {
  // Ein Cache mit maxEntries 0 oder NaN wäre genau der Fehler, den dieses
  // Modul verhindern soll — er fiele erst Wochen später als Speicherfresser auf.
  for (const schlecht of [0, -1, NaN, Infinity, undefined === null ? 1 : 'zehn']) {
    assert.throws(() => new BoundedCache({ maxEntries: schlecht }), /maxEntries/)
  }
  assert.throws(() => new BoundedCache({ ttlMs: -1 }), /ttlMs/)
  assert.throws(() => new BoundedCache({ ttlMs: NaN }), /ttlMs/)
})

test('ohne Angaben gibt es trotzdem eine Grenze', () => {
  const c = new BoundedCache()
  assert.ok(c.maxEntries >= 1 && Number.isFinite(c.maxEntries))
  assert.equal(c.ttlMs, 0)
})

test('die Kurzform tut dasselbe', () => {
  const c = boundedCache({ maxEntries: 2 })
  assert.ok(c instanceof BoundedCache)
  c.set('a', 1)
  assert.equal(c.get('a'), 1)
})

// ─── Für das Log ──────────────────────────────────────────────────────────

test('stats sagt in einer Zeile, ob der Cache seine Arbeit tut', () => {
  const c = new BoundedCache({ maxEntries: 2 })
  c.set('a', 1)
  c.get('a'); c.get('b')
  const s = c.stats()
  assert.match(s, /1\/2 Einträge/)
  assert.match(s, /50 % Treffer/)
})

test('stats auf einem leeren Cache rechnet nicht durch Null', () => {
  assert.match(new BoundedCache().stats(), /0 % Treffer \(0\/0\)/)
})
