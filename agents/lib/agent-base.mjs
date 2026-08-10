// agents/lib/agent-base.mjs — gemeinsamer Unterbau aller Node-Agents.
//
// Ein neuer Agent braucht damit nur noch:
//
//   import { bootAgent, envNum } from './lib/agent-base.mjs'
//   const { ajna, log, warn } = await bootAgent('mein-agent')
//   const RADIUS = envNum('MEIN_RADIUS_M', 100)
//   …Fachlogik…
//
// bootAgent erledigt in der richtigen Reihenfolge:
//   1. Geschichtete .env laden (Prozess-Env > agents/.env.<name> > Root-.env)
//   2. optional Erststart-Wizard (fehlende Pflichtwerte oder --setup, nur TTY)
//   3. HTTPS: einmaliger Re-Exec mit --use-system-ca (Caddys interne CA)
//   4. Pflicht-Env prüfen (AJNA_USER/PASS + opts.require)
//   5. AjnaManager anlegen + einloggen (+ optional connect())
//   6. Standard-SIGINT-Handler (abschaltbar für eigene Aufräumlogik)
//
// ABGRENZUNG: Hier liegt nur Node-Spezifisches (fs/env/process/Re-Exec).
// Browserfähige Logik (Geo-Mathe, PB-Zugriffe, Manifeste, …) gehört nach
// client/core — die Agents nutzen dieselbe Library per Node (AjnaManager & Co).

import { loadAgentEnv, agentEnvPath } from './env.mjs'
import { maybeReexecWithSystemCa } from './system-ca.mjs'
import { EventSource } from 'eventsource'
// PB-SDK öffnet bei connect()/refreshObjects() eine Realtime-SSE über
// globalThis.EventSource — in Node je nach Version nicht verfügbar → Polyfill.
if (typeof globalThis.EventSource !== 'function') globalThis.EventSource = EventSource

import { AjnaManager } from '../../client/core/AjnaManager.js'

/** Fehlermeldung + Exit 1 — einheitliches Sterben für alle Agents. */
export function die(msg) { console.error(`✗ ${msg}`); process.exit(1) }

// ─── Env-Parser ───────────────────────────────────────────────────────────
// Konvention: unset/leer → Default. Gesetzt, aber unbrauchbar → sofort die()
// mit klarer Meldung (statt still NaN durch die Fachlogik zu schleifen).

/** String-Wert; leerer String bleibt leer (bewusst ?? statt ||). */
export const envStr = (key, def = '') => process.env[key] ?? def

/** Fließkommazahl (auch für Ganzzahlen ok, solange kein Radix-Thema). */
export function envNum(key, def) {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return def
  const v = parseFloat(raw)
  if (!Number.isFinite(v)) die(`${key}="${raw}" ist keine Zahl`)
  return v
}

/** Ganzzahl (Basis 10). */
export function envInt(key, def) {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return def
  const v = parseInt(raw, 10)
  if (!Number.isFinite(v)) die(`${key}="${raw}" ist keine Ganzzahl`)
  return v
}

/** Schalter: 1/true/yes/on (case-insensitiv) = an, alles andere = aus. */
export function envBool(key, def = false) {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return def
  return /^(1|true|yes|on)$/i.test(raw)
}

/** Agent-Manifest publishen — best effort (Fehler nur warnen, nie sterben). */
export async function publishManifest(ajna, manifest, warn = console.warn) {
  try { await ajna.upsertAgentManifest(manifest); return true }
  catch (err) { warn('Manifest-Upsert fehlgeschlagen:', err?.message || err); return false }
}

/**
 * Gemeinsamer Agent-Bootstrap.
 *
 * @param {string} name  Agent-Name: bestimmt agents/.env.<name> und den
 *                       Log-Prefix (opts.tag überschreibt letzteren).
 * @param {object} [opts]
 * @param {string}   [opts.tag]      Log-Prefix (Default: name)
 * @param {string[]} [opts.require]  zusätzliche Pflicht-Env-Keys
 * @param {boolean}  [opts.login=true]    AJNA_USER/PASS verlangen + einloggen
 * @param {boolean}  [opts.connect=false] nach Login ajna.connect() (Objekt-
 *                                        Cache + Realtime-Subscription)
 * @param {boolean}  [opts.sigint=true]   Standard-SIGINT-Handler (Log + Exit 0);
 *                                        false für eigene Aufräumlogik
 * @param {{need: string[], run: () => Promise<{exit?: boolean}|void>}} [opts.setup]
 *   Erststart-Wizard: läuft bei --setup oder wenn einer der `need`-Keys fehlt.
 *   Ohne TTY: fehlende Keys → Exit 1 mit Hinweis; nur --setup → ignoriert.
 *   `run()` schreibt die Agent-.env und setzt process.env (siehe env.mjs);
 *   gibt es { exit: true } zurück (z. B. Übergabe an pm2), endet der Prozess.
 * @returns {Promise<{ajna: AjnaManager, url: string, log: Function, warn: Function}>}
 */
export async function bootAgent(name, opts = {}) {
  const tag = opts.tag || name
  const log = (...a) => console.log(`[${tag}]`, ...a)
  const warn = (...a) => console.warn(`[${tag}]`, ...a)

  loadAgentEnv(name)

  if (opts.setup) {
    const wantSetup = process.argv.includes('--setup')
    const missing = (opts.setup.need || []).filter(k => !process.env[k])
    if (wantSetup || missing.length) {
      if (!process.stdin.isTTY) {
        if (missing.length) {
          console.error(`✗ Konfiguration unvollständig (${agentEnvPath(name)} fehlt/leer): ${missing.join(', ')}`)
          console.error(`  Interaktiv einrichten:  node ${process.argv[1]} --setup`)
          process.exit(1)
        }
        // --setup ohne TTY (z. B. via pm2): ignorieren, normal starten.
      } else {
        const res = await opts.setup.run()
        if (res?.exit) process.exit(0)
      }
    }
    // --setup nicht in den System-CA-Re-Exec (unten) mitschleppen — der Wizard
    // lief bereits; im Kind-Prozess würde er sonst ein zweites Mal starten.
    process.argv = process.argv.filter(a => a !== '--setup')
  }

  const url = process.env.AJNA_URL || 'http://127.0.0.1:8090'
  // Muss VOR dem ersten HTTPS-Zugriff laufen; der Re-Exec startet das ganze
  // Skript neu, alles bis hierher läuft dann (billig) doppelt.
  maybeReexecWithSystemCa(url)

  const doLogin = opts.login !== false
  const required = [...(doLogin ? ['AJNA_USER', 'AJNA_PASS'] : []), ...(opts.require || [])]
  const absent = required.filter(k => !process.env[k])
  if (absent.length) die(`Fehlende Konfiguration: ${absent.join(', ')} (agents/.env.${name}, Root-.env oder Env)`)

  const ajna = new AjnaManager(url)
  if (doLogin) {
    try { await ajna.login(process.env.AJNA_USER, process.env.AJNA_PASS) }
    catch (err) { die(`Ajna-Login fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`) }
    log(`eingeloggt als ${ajna.currentUser()?.email || process.env.AJNA_USER} @ ${url}`)
  }
  if (opts.connect) await ajna.connect()

  if (opts.sigint !== false) {
    process.on('SIGINT',  () => { console.log(`\n[${tag}] beende.`); process.exit(0) })
    // pm2/systemd stoppen per SIGTERM — ohne Handler stürbe der Agent zwar
    // auch, aber ohne Log-Zeile und mit Exit-Code ≠ 0.
    process.on('SIGTERM', () => { console.log(`[${tag}] beende (SIGTERM).`); process.exit(0) })
  }

  return { ajna, url, log, warn }
}
