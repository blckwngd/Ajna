#!/usr/bin/env node
// Schiebt Caddys interne Root-CA aufs angeschlossene Android-Gerät. Danach am
// Gerät installieren, damit der DEBUG-Build (network_security_config →
// debug-overrides → user-CAs) lokalen HTTPS-Endpunkten mit Caddys interner CA
// vertraut (z. B. https://<rechner-hostname> aus der vorbereiteten Caddyfile).
//
//   npm run android:trust-caddy
//   → dann: Gerät → Einstellungen → Sicherheit → Verschlüsselung &
//     Anmeldedaten → Zertifikat installieren → CA-Zertifikat → caddy-root.crt
//
// Einmalig nötig (CA bleibt installiert, bis sie entfernt wird).

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { homedir, platform } from 'node:os'

const CA_SUB = join('pki', 'authorities', 'local', 'root.crt')

function findCaddyCa() {
  const c = []
  if (process.env.APPDATA) c.push(join(process.env.APPDATA, 'Caddy', CA_SUB))
  if (process.env.XDG_DATA_HOME) c.push(join(process.env.XDG_DATA_HOME, 'caddy', CA_SUB))
  const h = homedir()
  c.push(join(h, '.local', 'share', 'caddy', CA_SUB))
  c.push(join(h, 'Library', 'Application Support', 'Caddy', CA_SUB))
  c.push(join(h, 'AppData', 'Roaming', 'Caddy', CA_SUB))
  return c.find(existsSync) || null
}

function findAdb() {
  const exe = platform() === 'win32' ? 'adb.exe' : 'adb'
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  const cands = []
  if (sdk) cands.push(join(sdk, 'platform-tools', exe))
  if (process.env.LOCALAPPDATA) cands.push(join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', exe))
  const h = homedir()
  cands.push(join(h, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', exe))
  cands.push(join(h, 'Library', 'Android', 'sdk', 'platform-tools', exe))
  cands.push(join(h, 'Android', 'Sdk', 'platform-tools', exe))
  return cands.find(existsSync) || 'adb'  // Fallback: aus PATH
}

const ca = findCaddyCa()
if (!ca) { console.error('✗ Caddy-Root-CA nicht gefunden — Caddy mindestens einmal gestartet?'); process.exit(1) }
const adb = findAdb()
const dest = '/sdcard/Download/caddy-root.crt'

console.log(`[trust-caddy] CA:  ${ca}`)
const devs = spawnSync(adb, ['devices'], { encoding: 'utf8' })
if (!/\tdevice\b/.test(devs.stdout || '')) {
  console.error('✗ Kein Gerät verbunden (adb devices leer). USB anstecken + USB-Debugging erlauben.')
  process.exit(1)
}
const r = spawnSync(adb, ['push', ca, dest], { stdio: 'inherit' })
if (r.status !== 0) { console.error('✗ adb push fehlgeschlagen.'); process.exit(r.status ?? 1) }

console.log(`\n✓ CA aufs Gerät kopiert: ${dest}`)
console.log('Jetzt am Gerät installieren:')
console.log('  Einstellungen → Sicherheit → Verschlüsselung & Anmeldedaten')
console.log('  → Zertifikat installieren → CA-Zertifikat → "caddy-root.crt" (in Downloads).')
console.log('Danach App neu starten → https://<rechner-hostname> wird akzeptiert.')
