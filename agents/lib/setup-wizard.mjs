// Wiederverwendbare Setup-Wizard-Bausteine für Agenten (nur Node-Bordmittel).
//
// Liefert: interaktive Prompts (sichtbar/verdeckt/Auswahl/Bestätigung),
// Ajna-Instanz-Erkennung (lokale Ports proben + Ajna-Fingerprint), Caddy-
// Helfer (Domains aus der Caddyfile, Zertifikatssuche im Caddy-Datenverzeichnis)
// und pm2-Erkennung/-Registrierung. Agent-spezifische Flows (z. B.
// ha-setup.mjs) komponieren daraus ihren Fragenkatalog.

import { existsSync, readFileSync, readdirSync, statSync, accessSync, constants } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import readline from 'node:readline/promises'
import { Writable } from 'node:stream'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'

const AGENTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
export const REPO_ROOT = resolve(AGENTS_DIR, '..')

// ─── Prompts ──────────────────────────────────────────────────────────────

export function makeRl() {
  // Output über einen stummschaltbaren Wrapper: readline echot Eingaben über
  // seinen output-Stream — bei rl._muted = true wird das Echo unterdrückt
  // (verdeckte Passwort-Eingabe). Raw-Mode-Basteleien mit eigenem Echo sind
  // NICHT zuverlässig: readline echot parallel weiter (Zeichen + Sternchen).
  const output = new Writable({
    write(chunk, enc, cb) {
      if (!rl._muted) process.stdout.write(chunk, enc)
      cb()
    },
  })
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true })
  rl._muted = false
  rl.on('SIGINT', () => { process.stdout.write('\n'); process.exit(1) })
  return rl
}

/** Frage mit Default (Enter = Default übernehmen). */
export async function ask(rl, question, def = '') {
  const suffix = def ? ` [${def}]` : ''
  const a = (await rl.question(`${question}${suffix}: `)).trim()
  return a || def
}

/** Ja/Nein-Frage. */
export async function confirm(rl, question, def = true) {
  const a = (await rl.question(`${question} ${def ? '[J/n]' : '[j/N]'}: `)).trim().toLowerCase()
  if (!a) return def
  return ['j', 'ja', 'y', 'yes'].includes(a)
}

/** Auswahl aus einer Liste; gibt den Index zurück. */
export async function choose(rl, question, options, defIndex = 0) {
  console.log(question)
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`))
  const a = (await rl.question(`Auswahl [${defIndex + 1}]: `)).trim()
  const n = a ? parseInt(a, 10) - 1 : defIndex
  return (Number.isInteger(n) && n >= 0 && n < options.length) ? n : defIndex
}

/** Verdeckte Eingabe (Passwörter) — Echo komplett aus (kein Sternchen-Leak). */
export async function askHidden(rl, question) {
  process.stdout.write(`${question}: `)
  rl._muted = true
  try {
    const v = await rl.question('')
    return v.trim()
  } finally {
    rl._muted = false
    process.stdout.write('\n')
  }
}

/** URL-sicheres Zufalls-Passwort. */
export const randomSecret = (bytes = 18) => randomBytes(bytes).toString('base64url')

// ─── HTTP-Probe (auch gegen selbstsignierte lokale Zertifikate) ───────────

export function httpGet(url, { timeoutMs = 4000, insecure = false } = {}) {
  const attempt = (family) => new Promise((res) => {
    try {
      const u = new URL(url)
      const mod = u.protocol === 'https:' ? https : http
      const req = mod.request(u, { method: 'GET', timeout: timeoutMs,
        ...(family ? { family } : {}),
        ...(insecure ? { rejectUnauthorized: false } : {}) }, (r) => {
        let body = ''
        r.on('data', (c) => { if (body.length < 65536) body += c })
        r.on('end', () => res({ status: r.statusCode, body }))
      })
      req.on('timeout', () => { req.destroy(); res({ status: 0, error: 'Timeout' }) })
      req.on('error', (e) => res({ status: 0, error: e?.code || e?.message || 'Netzfehler' }))
      req.end()
    } catch (e) { res({ status: 0, error: e?.message || 'ungültige URL' }) }
  })
  // Status 0 = gar keine HTTP-Antwort (DNS/TCP/TLS/Timeout); dann einmal
  // IPv4-only nachfassen: kaputte/injizierte AAAA-Records lassen Node je nach
  // Version hängen, während curl per Happy Eyeballs still auf IPv4 ausweicht.
  return attempt().then(r => (r.status !== 0 ? r
    : attempt(4).then(r4 => (r4.status !== 0 ? r4 : { ...r, error: `${r.error} (auch via IPv4: ${r4.error})` }))))
}

// ─── Ajna-Instanz-Erkennung ───────────────────────────────────────────────

/**
 * Probt Kandidaten-Endpunkte und erkennt Ajna am anonym lesbaren
 * objects-Endpoint (nacktes PocketBase antwortet dort 404/403).
 *
 * Kandidaten (in dieser Reihenfolge, dedupliziert):
 *   1. `extra` — z. B. AJNA_URL aus der geschichteten .env (auf einem VPS
 *      hinter Caddy steht dort die echte URL; Ports raten greift dann nicht)
 *   2. Domains aus der Caddyfile → https://<domain>
 *   3. Standard-Entwicklungs-Endpunkte
 * @param {string[]} [extra]  Zusätzliche URLs, zuerst geprobt
 * @returns {Promise<Array<{url:string, source:'env'|'caddy'|'default', health:boolean, isAjna:boolean}>>}
 */
export async function probeLocalAjna(extra = []) {
  const seen = new Set()
  const candidates = []
  const add = (url, source) => {
    const u = String(url || '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(u) || seen.has(u.toLowerCase())) return
    seen.add(u.toLowerCase())
    candidates.push({ url: u, source })
  }
  for (const u of extra) add(u, 'env')
  for (const d of caddyDomains().domains) add(`https://${d}`, 'caddy')
  add('http://127.0.0.1:8090', 'default')
  add('https://localhost', 'default')
  add('https://127.0.0.1', 'default')
  const found = []
  for (const { url, source } of candidates) {
    const health = await httpGet(`${url}/api/health`, { insecure: true })
    if (!health || health.status !== 200) {
      console.log(`[probe] ${url} (${source}) → health: ${health?.error || `HTTP ${health?.status}`}`)
      continue
    }
    const objects = await httpGet(`${url}/api/collections/objects/records?perPage=1`, { insecure: true })
    const isAjna = objects?.status === 200
    console.log(`[probe] ${url} (${source}) → health ok, objects: ${isAjna ? 'ok' : (objects?.error || `HTTP ${objects?.status}`)}${isAjna ? '' : ' → kein Ajna-Fingerprint'}`)
    found.push({ url, source, health: true, isAjna })
  }
  return found
}

// ─── Caddy-Helfer ─────────────────────────────────────────────────────────

/** Öffentliche Domains aus der Caddyfile — best effort. Sucht erst im Repo
 *  (Caddyfile.prod/Caddyfile), dann beim System-Caddy (/etc/caddy). */
export function caddyDomains() {
  const files = [
    resolve(REPO_ROOT, 'Caddyfile.prod'),
    resolve(REPO_ROOT, 'Caddyfile'),
    ...(process.platform !== 'win32' ? ['/etc/caddy/Caddyfile'] : []),
  ]
  for (const path of files) {
    if (!existsSync(path)) continue
    let text = ''
    try { text = readFileSync(path, 'utf8') } catch { continue }   // z. B. /etc/caddy ohne Leserecht
    const domains = new Set()
    let depth = 0
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim()
      if (!line) continue
      if (depth === 0 && line.endsWith('{')) {
        for (const tok of line.slice(0, -1).split(',').map(s => s.trim()).filter(Boolean)) {
          const host = tok.replace(/^https?:\/\//, '').split(':')[0]
          // example.* herausfiltern: sonst liefert das committete Template
          // (demo.example.com) eine Phantom-Domain, wenn Caddyfile.prod nur
          // localhost-Sites enthält.
          if (host.includes('.') && !/localhost|127\.0\.0\.1|\.local$|(^|\.)example\.(com|org|net)$/i.test(host)) domains.add(host)
        }
      }
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
      if (depth < 0) depth = 0
    }
    if (domains.size) return { file: path, domains: [...domains] }
  }
  return { file: null, domains: [] }
}

/** Sucht Caddys Zertifikat für eine Domain in den üblichen Datenverzeichnissen. */
export function findCaddyCert(domain) {
  const roots = [
    process.env.APPDATA && join(process.env.APPDATA, 'Caddy'),
    join(os.homedir(), '.local', 'share', 'caddy'),
    '/var/lib/caddy/.local/share/caddy',
    join(os.homedir(), 'Library', 'Application Support', 'Caddy'),
  ].filter(Boolean)
  for (const root of roots) {
    const certDir = join(root, 'certificates')
    if (!existsSync(certDir)) continue
    // certificates/<issuer>/<domain>/<domain>.{crt,key}
    let issuers = []
    try { issuers = readdirSync(certDir) } catch { continue }
    for (const issuer of issuers) {
      const dir = join(certDir, issuer, domain)
      const crt = join(dir, `${domain}.crt`), key = join(dir, `${domain}.key`)
      try {
        if (statSync(crt).isFile() && statSync(key).isFile()) {
          let readable = true
          try { accessSync(crt, constants.R_OK); accessSync(key, constants.R_OK) } catch { readable = false }
          return { crt, key, readable, issuer }
        }
      } catch {}
    }
  }
  return null
}

// ─── pm2 ──────────────────────────────────────────────────────────────────

// Windows installiert pm2 als pm2.cmd — direkt aufrufen statt shell:true
// (vermeidet die DEP0190-Warnung und Argument-Injection über die Shell).
const PM2 = process.platform === 'win32' ? 'pm2.cmd' : 'pm2'

export function pm2Available() {
  try { execFileSync(PM2, ['-v'], { stdio: 'pipe' }); return true }
  catch { return false }
}

/** Registriert ein Script bei pm2 (start + save). Wirft bei Fehlern. */
export function pm2Register({ name, script, args = [] }) {
  execFileSync(PM2, ['start', script, '--name', name, '--cwd', REPO_ROOT,
    ...(args.length ? ['--', ...args] : [])], { stdio: 'inherit' })
  execFileSync(PM2, ['save'], { stdio: 'inherit' })
}
