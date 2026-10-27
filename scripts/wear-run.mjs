#!/usr/bin/env node
// Build the Wear OS app (android/wear) and install it on the WATCH.
//
//   npm run wear:run                 the only connected watch
//   npm run wear:run -- <serial>     a specific device (see `adb devices`)
//
// Picks the device by serial so the watch app never lands on the phone.
// A watch is connected over Wi-Fi debugging: Settings → Developer options →
// Wireless debugging, then `adb pair` / `adb connect <ip>:<port>`.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const androidDir = join(root, 'android')
const isWin = process.platform === 'win32'
const APP_ID = 'de.blckwngd.ajna.wear'

function findAdb() {
  const local = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe')
  if (local && existsSync(local)) return local
  return 'adb'
}
const adb = findAdb()

function devices() {
  const r = spawnSync(adb, ['devices', '-l'], { encoding: 'utf8' })
  return (r.stdout || '').split('\n').slice(1).map(l => l.trim()).filter(l => /\bdevice\b/.test(l))
    .map(l => ({ serial: l.split(/\s+/)[0], line: l }))
}

function isWatch(serial) {
  const r = spawnSync(adb, ['-s', serial, 'shell', 'getprop', 'ro.build.characteristics'], { encoding: 'utf8' })
  return /watch/.test(r.stdout || '')
}

let serial = process.argv[2]
if (!serial) {
  const watches = devices().filter(d => isWatch(d.serial))
  if (watches.length !== 1) {
    console.error(watches.length ? `[wear-run] Mehrere Uhren — Serial angeben:\n${watches.map(w => '  ' + w.line).join('\n')}`
      : '[wear-run] Keine Uhr per adb verbunden (Drahtlos-Debugging: adb pair / adb connect).')
    process.exit(2)
  }
  serial = watches[0].serial
}

const gradlew = join(androidDir, isWin ? 'gradlew.bat' : 'gradlew')
const build = spawnSync(gradlew, ['-p', androidDir, ':wear:assembleDebug', '--console=plain'], { stdio: 'inherit', shell: isWin })
if (build.status !== 0) process.exit(build.status ?? 1)
const apk = join(androidDir, 'wear', 'build', 'outputs', 'apk', 'debug', 'wear-debug.apk')
const inst = spawnSync(adb, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' })
if (inst.status !== 0) process.exit(inst.status ?? 1)
spawnSync(adb, ['-s', serial, 'shell', 'monkey', '-p', APP_ID, '-c', 'android.intent.category.LAUNCHER', '1'], { stdio: 'inherit' })
console.log(`\n[wear-run] Fertig — Ajna läuft auf ${serial}.`)
