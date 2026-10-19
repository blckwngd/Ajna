// Tests für agents/lib/memory-report.mjs.
//
// Geprüft wird nicht, WIE VIEL Speicher Node gerade braucht — das ist keine
// Aussage, die ein Test treffen kann. Geprüft wird, dass die Meldung das sagt,
// worauf sich jemand im Ernstfall verlässt: eine Marke wird gemeldet, und sie
// wird nicht zehnmal gemeldet, bis niemand mehr hinsieht.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { memoryUsage, formatMemory, heapLimit, startMemoryReport } from './memory-report.mjs'

/** Dieses Modul als URL — für die Kindprozesse weiter unten. */
const HIER = new URL('./memory-report.mjs', import.meta.url).href

test('memoryUsage liefert Zahlen in MB, keine Bytes', () => {
  const u = memoryUsage()
  for (const k of ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']) {
    assert.ok(Number.isFinite(u[k]), `${k} ist keine Zahl: ${u[k]}`)
    assert.ok(u[k] >= 0, `${k} negativ`)
  }
  assert.ok(u.rss > 5 && u.rss < 100000, `RSS ${u.rss} sieht nicht wie MB aus`)
  assert.ok(u.heapUsed <= u.heapTotal + 1, 'benutzter Heap über dem gesamten')
})

test('formatMemory ist eine Zeile, die man lesen kann', () => {
  const s = formatMemory({ rss: 180.4, heapUsed: 90.1, heapTotal: 120, external: 1, arrayBuffers: 0 })
  assert.equal(s, 'RSS 180.4 MB · Heap 90.1/120 MB')
})

test('kleine externe Mengen verstopfen die Zeile nicht', () => {
  const klein = formatMemory({ rss: 50, heapUsed: 10, heapTotal: 20, external: 2, arrayBuffers: 0 })
  const gross = formatMemory({ rss: 50, heapUsed: 10, heapTotal: 20, external: 40, arrayBuffers: 0 })
  assert.ok(!klein.includes('extern'))
  assert.match(gross, /extern 40 MB/)
})

test('heapLimit sagt entweder eine Grenze oder ehrlich null', () => {
  const l = heapLimit()
  assert.ok(l === null || (Number.isFinite(l) && l > 0), `heapLimit: ${l}`)
})

// ─── Die Meldung ──────────────────────────────────────────────────────────

test('report schreibt eine Speicherzeile', () => {
  const zeilen = []
  const r = startMemoryReport({ log: (m) => zeilen.push(m), intervalMs: 1e9 })
  r.report()
  r.stop()
  assert.equal(zeilen.length, 1)
  assert.match(zeilen[0], /^\[speicher\] RSS [\d.]+ MB · Heap/)
})

test('die erste Meldung nennt keinen Zuwachs aus der Luft', () => {
  // Beim ersten Mal gibt es keinen Vergleichswert. Eine Zeile „+0 MB seit dem
  // Start" wäre nicht falsch, aber „+180 MB" wäre es — der Startwert ist die
  // Grundlinie, nicht null.
  const zeilen = []
  const r = startMemoryReport({ log: (m) => zeilen.push(m), intervalMs: 1e9 })
  r.report()
  r.stop()
  assert.ok(!/\+\d{3,} MB seit dem Start/.test(zeilen[0]), zeilen[0])
})

test('extra hängt die eigenen Zahlen des Aufrufers an', () => {
  const zeilen = []
  const r = startMemoryReport({
    log: (m) => zeilen.push(m), intervalMs: 1e9,
    extra: () => '24/24 Einträge · 91 % Treffer',
  })
  r.report()
  r.stop()
  assert.match(zeilen[0], /24\/24 Einträge · 91 % Treffer/)
})

// ─── Die Marke ────────────────────────────────────────────────────────────

test('DIE MARKE WIRD GEMELDET, sobald sie überschritten ist', () => {
  const warnungen = []
  const r = startMemoryReport({
    log: () => {}, warn: (m) => warnungen.push(m),
    intervalMs: 1e9, warnAtMb: 1,     // garantiert überschritten
  })
  r.report()
  r.stop()
  assert.equal(warnungen.length, 1)
  assert.match(warnungen[0], /ÜBER DER MARKE/)
  assert.match(warnungen[0], /trifft es den ganzen Server/)
})

test('die Marke wird NICHT bei jeder Meldung wiederholt', () => {
  // Eine Warnung, die alle zehn Minuten gleich lautet, wird weggefiltert und
  // warnt dann niemanden mehr.
  const warnungen = []
  const r = startMemoryReport({
    log: () => {}, warn: (m) => warnungen.push(m), intervalMs: 1e9, warnAtMb: 1,
  })
  r.report(); r.report(); r.report()
  r.stop()
  assert.equal(warnungen.length, 1)
})

test('ohne Marke wird nicht gewarnt', () => {
  const warnungen = []
  const r = startMemoryReport({
    log: () => {}, warn: (m) => warnungen.push(m), intervalMs: 1e9, warnAtMb: 0,
  })
  r.report()
  r.stop()
  assert.deepEqual(warnungen, [])
})

test('eine unerreichbare Marke schweigt', () => {
  const warnungen = []
  const r = startMemoryReport({
    log: () => {}, warn: (m) => warnungen.push(m), intervalMs: 1e9, warnAtMb: 1e9,
  })
  r.report()
  r.stop()
  assert.deepEqual(warnungen, [])
})

// ─── Der Takt ─────────────────────────────────────────────────────────────

test('stop hört auf zu melden', async () => {
  const zeilen = []
  const r = startMemoryReport({ log: (m) => zeilen.push(m), intervalMs: 10 })
  await new Promise(res => setTimeout(res, 60))
  r.stop()
  const nachStop = zeilen.length
  await new Promise(res => setTimeout(res, 60))
  assert.equal(zeilen.length, nachStop, 'nach stop kam noch etwas')
  assert.ok(nachStop >= 2, `nur ${nachStop} Meldungen im Takt`)
})

test('DER TAKT HÄLT DEN PROZESS NICHT WACH', () => {
  // Sonst beendet sich kein Agent mehr von selbst und `npm test` hängt. Das
  // lässt sich nur an einem echten Prozess prüfen: läuft der Takt referenziert,
  // kehrt dieser Aufruf nie zurück — mit `unref` beendet sich das Kind sofort.
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { startMemoryReport } from ${JSON.stringify(HIER)}
    startMemoryReport({ log: () => {}, intervalMs: 3600000 })
  `], { timeout: 15000, encoding: 'utf8' })
  assert.equal(r.status, 0, `Kind endete mit ${r.status}: ${r.stderr}`)
  assert.notEqual(r.signal, 'SIGTERM', 'das Kind lief in die Frist — der Takt hält wach')
})

test('ein referenzierter Takt hält den Prozess SEHR WOHL wach', () => {
  // Gegenprobe: ohne diesen Test könnte `unref` wirkungslos sein und der Test
  // oben bestünde trotzdem, weil ein Node-Prozess ohne offene Handles immer
  // endet. Hier muss das Kind in die Frist laufen.
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { startMemoryReport } from ${JSON.stringify(HIER)}
    startMemoryReport({ log: () => {}, intervalMs: 3600000, unref: false })
  `], { timeout: 3000, encoding: 'utf8' })
  assert.ok(r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT',
    `erwartet: Kind läuft weiter. Bekommen: status=${r.status} signal=${r.signal}`)
})
