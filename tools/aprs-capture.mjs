#!/usr/bin/env node
// aprs-capture.mjs — record raw APRS-IS packets to a file.
//
// WHY A SEPARATE TOOL. The parser in `agents/lib/aprs.mjs` was written against
// the APRS 1.01 specification, not against packets from the air, because port
// 14580 is not reachable from every network. A recording made somewhere it IS
// reachable closes that gap: `APRS_REPLAY=<datei> npm run aprs` pushes it
// through the same code path as the live stream, and the file is the raw
// material for tests that no specification example can replace.
//
// The connection is receive-only (passcode -1); nothing is transmitted.
//
//   node tools/aprs-capture.mjs                       # 90 s um Koblenz
//   node tools/aprs-capture.mjs --out=graz.txt --lat=47.07 --lon=15.44 \
//        --radius=100 --seconds=300 --call=DL1ABC

import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const OUT = path.resolve(arg('out', 'aprs-capture.txt'))
const HOST = arg('host', 'rotate.aprs2.net')
const PORT = Number(arg('port', 14580))
const LAT = Number(arg('lat', 50.4297))
const LON = Number(arg('lon', 7.4608))
const RADIUS = Number(arg('radius', 150))
const SEKUNDEN = Number(arg('seconds', 90))
// Wer ein Rufzeichen hat, nimmt es. Ohne eines bleibt die Verbindung ebenfalls
// nur empfangend — aber eine erkennbare Kennung ist höflicher als ein fremdes
// Rufzeichen.
const CALL = String(arg('call', 'N0CALL')).toUpperCase()

const zeilen = []
const arten = new Map()

const sock = net.createConnection({ host: HOST, port: PORT })
sock.setTimeout(20_000)

sock.on('connect', () => {
  console.error(`verbunden mit ${HOST}:${PORT}`)
  sock.write(`user ${CALL} pass -1 vers ajna-capture 1.0 `
    + `filter r/${LAT}/${LON}/${Math.round(RADIUS)}\r\n`)
  console.error(`Filter r/${LAT}/${LON}/${Math.round(RADIUS)} · ${SEKUNDEN} s`)
})

let rest = ''
sock.on('data', (buf) => {
  rest += buf.toString('latin1')       // APRS ist nicht zwingend UTF-8
  const teile = rest.split(/\r?\n/)
  rest = teile.pop()
  for (const z of teile) {
    if (!z) continue
    if (z.startsWith('#')) { console.error('[server]', z.slice(0, 90)); continue }
    zeilen.push(z)
    // Das erste Zeichen der Nutzlast sagt die Art des Pakets — die Verteilung
    // zeigt auf einen Blick, ob der Mitschnitt die interessanten Formen enthält
    // (`` ` `` = MIC-E, `!=@/` = Position, `;` = Objekt, `_` = Wetter).
    const i = z.indexOf(':')
    const art = i >= 0 ? z[i + 1] : '?'
    arten.set(art, (arten.get(art) || 0) + 1)
  }
})

sock.on('timeout', () => {
  console.error('Zeitüberschreitung — ist Port 14580 in diesem Netz offen?')
  fertig(1)
})
sock.on('error', (err) => {
  console.error(`Fehler: ${err?.code || err?.message || '(ohne Meldung)'}`)
  console.error('Port 14580 ist in manchen Netzen gesperrt. Andere Häfen: 14579, 10152.')
  fertig(1)
})

let raus = false
function fertig(code = 0) {
  if (raus) return
  raus = true
  if (zeilen.length) {
    fs.writeFileSync(OUT, zeilen.join('\n') + '\n', 'latin1')
    console.error(`\n${zeilen.length} Pakete nach ${OUT}`)
    console.error('Nutzlast-Kennzeichen:')
    for (const [a, n] of [...arten].sort((x, y) => y[1] - x[1])) {
      console.error(`  ${JSON.stringify(a).padEnd(6)} ${n}`)
    }
    console.error(`\nNachspielen:  APRS_REPLAY=${OUT} npm run aprs`)
  } else {
    console.error('\nKein einziges Paket — nichts geschrieben.')
  }
  try { sock.destroy() } catch {}
  process.exit(code)
}

setTimeout(() => fertig(0), SEKUNDEN * 1000)
