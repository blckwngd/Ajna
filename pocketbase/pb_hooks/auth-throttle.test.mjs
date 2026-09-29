// Tests für pocketbase/pb_hooks/auth-throttle.js — die Zählweise, die
// Agenten-Schübe von Durchprobieren unterscheidet.
//
// WARUM DAS HIER GEHT, OBWOHL ES EIN PB-HOOK IST: Die Zähllogik hängt an nichts
// als `app.store()`. Ein Doppel mit vier Methoden genügt — kein Server, kein
// Neustart, keine Wartezeit. Der Hook selbst (`auth-throttle.pb.js`) ist dünn
// genug, dass ihn eine Sichtprüfung trägt; die Regeln stehen hier.
//
// DER HOOK IST CommonJS, dieses Projekt ist ESM (`"type": "module"`). Ein
// schlichtes `require()` scheitert daran, weil Node die `.js` dann als Modul
// liest. Also wird die Datei so ausgeführt, wie PocketBase es tut: Quelltext
// lesen, in eine Funktion mit `module`/`exports`/`require` wickeln, aufrufen.
// Nebenbei prüft das mit, dass die Datei überhaupt als CommonJS trägt.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function ladeHook(pfad) {
  const quelle = readFileSync(new URL(pfad, import.meta.url), 'utf8')
  const modul = { exports: {} }
  // `require` im Hook zeigt auf Geschwisterdateien; hier braucht es keine.
  new Function('module', 'exports', 'require', '__hooks', quelle)(
    modul, modul.exports, () => ({}), '.')
  return modul.exports
}

const { lockedFor, countFailure, clearFailures, prune, KEY_PREFIX } = ladeHook('./auth-throttle.js')

/** Ein `app`-Doppel mit dem Store, den die Funktionen benutzen. */
function appDoppel() {
  const daten = new Map()
  const store = {
    get: (k) => daten.get(k),
    set: (k, v) => daten.set(k, v),
    remove: (k) => daten.delete(k),
    has: (k) => daten.has(k),
    length: () => daten.size,
    getAll: () => Object.fromEntries(daten),
  }
  return { store: () => store, _daten: daten }
}

const CFG = { windowMs: 600_000, lockMs: 900_000, lockAddressMs: 120_000 }
const JETZT = 1_000_000

test('unter der Grenze passiert nichts', () => {
  const app = appDoppel()
  for (let i = 1; i <= 4; i++) countFailure(app, 'id:a', 5, JETZT, CFG, CFG.lockMs)
  assert.equal(lockedFor(app, 'id:a', JETZT), 0)
})

test('mit dem fünften Fehlversuch wird gesperrt', () => {
  const app = appDoppel()
  for (let i = 1; i <= 5; i++) countFailure(app, 'id:a', 5, JETZT, CFG, CFG.lockMs)
  assert.equal(lockedFor(app, 'id:a', JETZT), 900)
})

test('eine erfolgreiche Anmeldung löscht den Zähler', () => {
  // DAS ist der Punkt, an dem sich Agent-Schub und Angriff trennen. Ohne diese
  // Zeile sperrte sich jeder Agent nach ein paar Neustarts selbst aus.
  const app = appDoppel()
  for (let i = 1; i <= 4; i++) countFailure(app, 'id:a', 5, JETZT, CFG, CFG.lockMs)
  clearFailures(app, 'id:a')
  for (let i = 1; i <= 4; i++) countFailure(app, 'id:a', 5, JETZT, CFG, CFG.lockMs)
  assert.equal(lockedFor(app, 'id:a', JETZT), 0, 'nach dem Zurücksetzen zählt es von vorn')
})

test('ein abgelaufenes Fenster fängt von vorn an', () => {
  // Wer vorletzte Woche zweimal danebentippte, ist heute nicht halb gesperrt.
  const app = appDoppel()
  for (let i = 1; i <= 4; i++) countFailure(app, 'id:a', 5, JETZT, CFG, CFG.lockMs)
  const spaeter = JETZT + CFG.windowMs + 1
  const e = countFailure(app, 'id:a', 5, spaeter, CFG, CFG.lockMs)
  assert.equal(e.count, 1)
  assert.equal(lockedFor(app, 'id:a', spaeter), 0)
})

test('die Sperre läuft ab', () => {
  const app = appDoppel()
  for (let i = 1; i <= 5; i++) countFailure(app, 'id:a', 5, JETZT, CFG, CFG.lockMs)
  assert.ok(lockedFor(app, 'id:a', JETZT) > 0)
  assert.equal(lockedFor(app, 'id:a', JETZT + CFG.lockMs + 1), 0)
})

test('Konten sperren sich nicht gegenseitig', () => {
  const app = appDoppel()
  for (let i = 1; i <= 5; i++) countFailure(app, 'id:a', 5, JETZT, CFG, CFG.lockMs)
  assert.ok(lockedFor(app, 'id:a', JETZT) > 0)
  assert.equal(lockedFor(app, 'id:b', JETZT), 0)
})

test('die Adress-Sperre ist deutlich kürzer als die Konto-Sperre', () => {
  // Fünfzehn Minuten für ein Konto, das jemand beackert, sind angemessen.
  // Fünfzehn Minuten für alle hinter einem gemeinsamen WLAN sind es nicht.
  const app = appDoppel()
  for (let i = 1; i <= 50; i++) countFailure(app, 'ip:1.2.3.4', 50, JETZT, CFG, CFG.lockAddressMs)
  const adresse = lockedFor(app, 'ip:1.2.3.4', JETZT)
  assert.equal(adresse, 120)
  assert.ok(adresse * 7 < CFG.lockMs / 1000, 'Adresse deutlich kürzer gesperrt als ein Konto')
})

test('prune räumt Abgelaufenes weg und lässt Laufendes stehen', () => {
  const app = appDoppel()
  for (let i = 1; i <= 5; i++) countFailure(app, 'id:frisch', 5, JETZT, CFG, CFG.lockMs)
  app.store().set(KEY_PREFIX + 'id:alt', { count: 1, first: JETZT - 7200_000, until: 0 })
  assert.equal(app.store().length(), 2)
  const uebrig = prune(app, JETZT)
  assert.equal(uebrig, 1)
  assert.ok(app._daten.has(KEY_PREFIX + 'id:frisch'))
  assert.ok(!app._daten.has(KEY_PREFIX + 'id:alt'))
})

test('kaputte Einträge werfen nicht, sie fliegen raus', () => {
  const app = appDoppel()
  app.store().set(KEY_PREFIX + 'id:mist', 'kein Objekt')
  assert.equal(lockedFor(app, 'id:mist', JETZT), 0)
  prune(app, JETZT)
  assert.equal(app.store().length(), 0)
})
