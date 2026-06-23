#!/usr/bin/env node
// Wartet, bis der Stack (Caddy → PocketBase) erreichbar ist, bevor ein Agent
// startet. Wird in `npm run stack:all` vor jeden Agent gehängt, damit die
// Agents nicht gegen ein noch nicht hochgefahrenes Backend laufen.
//
// Bewusst KEIN fetch(): dessen Keep-Alive-Socket lässt process.exit() auf
// Windows mit einer libuv-Assertion crashen (UV_HANDLE_CLOSING). Stattdessen
// rohe https-Requests mit `agent:false` (keine Verbindungs-Pools) → sauberer
// Exit. TLS-Verifikation aus (lokale interne Caddy-CA).

import https from 'node:https'

const HOST = process.env.AJNA_WAIT_HOST || 'localhost'
const PORT = parseInt(process.env.AJNA_WAIT_PORT || '443', 10)
const PATH = process.env.AJNA_WAIT_PATH || '/api/health'
const TIMEOUT_MS = parseInt(process.env.AJNA_WAIT_TIMEOUT_MS || '90000', 10)

function probe() {
  return new Promise(resolve => {
    const req = https.get(
      { host: HOST, port: PORT, path: PATH, agent: false, rejectUnauthorized: false, timeout: 2000 },
      res => { res.resume(); resolve(res.statusCode === 200) }
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

const start = Date.now()
while (Date.now() - start < TIMEOUT_MS) {
  if (await probe()) { console.log(`[wait] Stack bereit (https://${HOST}:${PORT}${PATH})`); process.exit(0) }
  await new Promise(r => setTimeout(r, 1000))
}
console.error(`[wait] Timeout nach ${TIMEOUT_MS} ms — Stack nicht erreichbar`)
process.exit(1)
