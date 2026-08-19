#!/usr/bin/env node
//
// tests/run-geo.mjs — Cache-Verhalten der Geo-API (server/geo.js).
//
//   npm run test:geo        (braucht KEINEN laufenden Stack)
//
// Warum als eigene Suite: Der Cache ist die einzige Verteidigung gegen die
// öffentlichen Overpass-Instanzen, und die sind regelmäßig minutenlang nicht
// erreichbar. Genau dann darf die Kulisse nicht verschwinden. Gegen den echten
// Overpass ließe sich das nicht prüfen — sein Ausfall ist ja der Testfall.
// Deshalb ein eigener Mini-Overpass, den wir an- und ausschalten können.
//
// Geprüft wird:
//   • Erstabruf geht ans Netz, Antwort landet im Speicher UND auf Platte
//   • Zweitabruf kommt aus dem Speicher, ohne Netz
//   • Nach Neustart kommt sie von Platte (der Grund für den Platten-Cache)
//   • Fällt Overpass aus, wird ein ABGELAUFENER Eintrag ausgeliefert statt 502
//   • Ohne jeden Cache bleibt es beim ehrlichen 502
//   • Gleichzeitige gleiche Anfragen lösen EINEN Overpass-Aufruf aus

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const ergebnisse = []
const check = (name, ok, detail = '') => {
  ergebnisse.push({ name, ok })
  console.log(`   ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const warte = (ms) => new Promise(r => setTimeout(r, ms))

// ── Mini-Overpass ────────────────────────────────────────────────────────
let overpassAntworten = true
let overpassAufrufe = 0
let overpassVerzoegerung = 0

const ANTWORT = {
  elements: [
    { type: 'way', id: 1, tags: { building: 'yes' },
      geometry: [{ lat: 50.0, lon: 7.0 }, { lat: 50.001, lon: 7.001 }] },
  ],
}

const fake = createServer(async (req, res) => {
  overpassAufrufe++
  if (overpassVerzoegerung) await warte(overpassVerzoegerung)
  if (!overpassAntworten) { res.writeHead(504); res.end('overloaded'); return }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(ANTWORT))
})
await new Promise(r => fake.listen(0, '127.0.0.1', r))
const fakeUrl = `http://127.0.0.1:${fake.address().port}/api/interpreter`

// ── Express mit eigenem Cache-Ordner ─────────────────────────────────────
const cacheDir = await mkdtemp(join(tmpdir(), 'ajna-geo-test-'))
let apiPort = 0
let api = null

async function apiStarten(extra = {}) {
  const port = apiPort || (apiPort = 3100 + (process.pid % 400))
  api = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      AJNA_GEO_AUTH: 'anonymous',        // Auth ist hier nicht der Prüfgegenstand
      AJNA_GEO_OVERPASS: fakeUrl,
      AJNA_GEO_CACHE_DIR: cacheDir,
      AJNA_GEO_TIMEOUT_MS: '4000',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  api.stdout.on('data', () => {})
  api.stderr.on('data', () => {})
  // Auf Erreichbarkeit warten statt blind zu schlafen.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ajnaapi/geo/_info`)
      if (r.ok) return port
    } catch { /* noch nicht oben */ }
    await warte(250)
  }
  throw new Error('Express nicht gestartet')
}

async function apiStoppen() {
  if (!api) return
  const tot = new Promise(r => api.once('exit', r))
  api.kill()
  await Promise.race([tot, warte(3000)])
  api = null
}

const hole = async (port, lat = 50.0, lon = 7.0) => {
  const r = await fetch(`http://127.0.0.1:${port}/ajnaapi/geo/buildings?lat=${lat}&lon=${lon}&radius=200`)
  return { status: r.status, body: await r.json().catch(() => null) }
}

try {
  console.log('\n── Geo-Cache: Erstabruf und Speicher')
  let port = await apiStarten()

  const a = await hole(port)
  check('Erstabruf geht ans Netz', a.status === 200 && a.body?.source === 'overpass', `source=${a.body?.source}`)
  check('Features kommen an', (a.body?.features || []).length === 1)
  const nachErst = overpassAufrufe

  const b = await hole(port)
  check('Zweitabruf kommt aus dem Speicher', b.body?.source === 'cache', `source=${b.body?.source}`)
  check('und fragt Overpass NICHT erneut', overpassAufrufe === nachErst)

  const dateien = await readdir(cacheDir)
  check('Antwort liegt auf Platte', dateien.length === 1, `${dateien.length} Datei(en)`)

  console.log('\n── Geo-Cache: überlebt den Neustart')
  await apiStoppen()
  port = await apiStarten()
  const vorNeustart = overpassAufrufe
  const c = await hole(port)
  check('nach Neustart von Platte statt aus dem Netz',
    c.body?.source === 'cache-disk', `source=${c.body?.source}`)
  check('kein Overpass-Aufruf nötig', overpassAufrufe === vorNeustart)

  console.log('\n── Geo-Cache: Notnagel bei Ausfall')
  await apiStoppen()
  // TTL auf 1 ms: der Platten-Eintrag gilt als abgelaufen und MUSS neu geholt
  // werden — genau dann fällt Overpass aus.
  port = await apiStarten({ AJNA_GEO_TTL_MS: '1' })
  overpassAntworten = false
  const d = await hole(port)
  check('abgelaufener Eintrag wird ausgeliefert statt 502',
    d.status === 200 && d.body?.source === 'cache-stale', `status=${d.status} source=${d.body?.source}`)
  check('Alter wird mitgeteilt', Number.isFinite(d.body?.staleMinutes))
  check('Features sind weiterhin da', (d.body?.features || []).length === 1)

  console.log('\n── Geo-Cache: ohne Cache ehrlich scheitern')
  const e = await hole(port, 48.0, 11.0)     // andere Gegend, nichts gespeichert
  check('unbekannte Gegend bei Ausfall → 502', e.status === 502, `status=${e.status}`)
  check('mit Begründung', typeof e.body?.error === 'string' && /overpass/i.test(e.body.error))

  console.log('\n── Geo-Cache: gleichzeitige Anfragen werden gebündelt')
  await apiStoppen()
  await rm(cacheDir, { recursive: true, force: true })
  port = await apiStarten()
  overpassAntworten = true
  overpassVerzoegerung = 400          // lange genug, dass sich die Anfragen überlappen
  const vorher = overpassAufrufe
  const viele = await Promise.all([1, 2, 3, 4].map(() => hole(port, 51.5, 9.5)))
  overpassVerzoegerung = 0
  check('alle vier Antworten sind gültig', viele.every(x => x.status === 200 && x.body?.features?.length === 1))
  check('aber nur EIN Overpass-Aufruf', overpassAufrufe - vorher === 1, `${overpassAufrufe - vorher} Aufruf(e)`)
} finally {
  await apiStoppen()
  fake.close()
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {})
}

const fehler = ergebnisse.filter(r => !r.ok)
console.log(`\n${'═'.repeat(60)}`)
console.log(`Geo-Cache: ${ergebnisse.length - fehler.length} bestanden, ${fehler.length} fehlgeschlagen`)
if (fehler.length) {
  console.log('\nFehlgeschlagen:')
  for (const f of fehler) console.log(`  ❌ ${f.name}`)
  process.exit(1)
}
console.log('✅ alles grün')
